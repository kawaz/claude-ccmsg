// Prose paths and bare URLs, end to end through the probe: a body's absolute /
// `~/` paths are asked about over fs_stat_batch, and only the ones the daemon
// confirms become links — in a markdown body (assistant text, thinking) and in
// a user's plain text alike. Bare URLs link without asking anything.
import { afterEach, describe, expect, test } from "bun:test";
import { h, options, render, type ComponentChild, type VNode } from "preact";
import { act } from "preact/test-utils";
import type { ErrorResponse, FsStatEntry } from "@ccmsg/protocol";
import {
  configureFilePathExistenceCache,
  _resetFilePathCacheForTests,
} from "../src/client/filepath-existence-cache.ts";
import { LinkedMarkdownView, LinkedPlainText } from "../src/client/filepath-linker.tsx";
import type { FilePathResolveCtx } from "../src/client/filepath-ref.ts";
import { SessionFilePathCtxContext } from "../src/client/components/timeline/context.ts";
import { SegmentView } from "../src/client/components/timeline/segments.tsx";
import { withDom } from "./dom.ts";
import { stubProperty } from "./helpers.ts";

withDom();

let container: HTMLElement | null = null;

afterEach(async () => {
  _resetFilePathCacheForTests();
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

const ctx: FilePathResolveCtx = { sid: "S1", cwd: "/repo" };
const unavailable: ErrorResponse = { ok: false, error: { code: "unavailable", msg: "test" } };

/** A daemon that knows exactly `files` (absolute or `~/`), recording what it
 * was asked. */
function installDaemon(files: readonly string[]): string[] {
  const asked: string[] = [];
  configureFilePathExistenceCache(async (_sid, paths) => {
    asked.push(...paths);
    return paths.map((p): FsStatEntry | null =>
      files.includes(p) ? { kind: "external", path: p } : null,
    );
  });
  return asked;
}

async function mount(node: ComponentChild): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await act(() => render(node, root));
  // Let the probe's microtask flush and the fake daemon answer.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return root;
}

function links(root: HTMLElement): { cls: string; text: string; href: string }[] {
  return [...root.querySelectorAll("a")].map((a) => ({
    cls: a.className,
    text: a.textContent ?? "",
    href: a.getAttribute("href") ?? "",
  }));
}

describe("prose paths through the probe", () => {
  test("a markdown body links the paths the daemon confirms, and only those", async () => {
    const asked = installDaemon(["/tmp/d/DESIGN.md", "~/notes/x.md"]);
    const root = await mount(
      h(LinkedMarkdownView, {
        source: "see /tmp/d/DESIGN.md, ~/notes/x.md and /tmp/missing.md",
        ctx,
      }),
    );
    expect(asked.sort()).toEqual(["/tmp/d/DESIGN.md", "/tmp/missing.md", "~/notes/x.md"]);
    expect(links(root).map((l) => [l.cls, l.text])).toEqual([
      ["md-prose-file-link", "/tmp/d/DESIGN.md"],
      ["md-prose-file-link", "~/notes/x.md"],
    ]);
    expect(root.textContent).toBe("see /tmp/d/DESIGN.md, ~/notes/x.md and /tmp/missing.md");
  });

  // `[label](path#place)`: the place inside the file is the link's own, and
  // rides as the href's fragment in a markdown body and in plain text alike.
  test("a markdown link's #fragment stays on the href", async () => {
    installDaemon(["/repo/docs/questions/3344.md"]);
    const source = "[👺3344-Q3](docs/questions/3344.md#3344-Q3) と [行](docs/questions/3344.md#L3)";
    const body = await mount(h(LinkedMarkdownView, { source, ctx }));
    const hrefs = links(body).map((l) => new URL(l.href, "http://localhost"));
    expect(hrefs.map((url) => url.hash)).toEqual(["#3344-Q3", ""]);
    expect(hrefs.map((url) => url.searchParams.get("path"))).toEqual([
      "docs/questions/3344.md",
      "docs/questions/3344.md",
    ]);
    expect(hrefs[1]?.searchParams.get("lines")).toBe("3-3");
  });

  test("a plain-text link's #fragment stays on the href", async () => {
    installDaemon(["/repo/docs/questions/3344.md"]);
    const text = "[👺3344-Q3](/repo/docs/questions/3344.md#3344-Q3)";
    const body = await mount(h(LinkedPlainText, { text, ctx }));
    const [link] = links(body);
    expect(link?.text).toBe("👺3344-Q3");
    expect(new URL(link?.href ?? "", "http://localhost").hash).toBe("#3344-Q3");
  });

  test("a user's plain text links URLs and confirmed paths, verbatim otherwise", async () => {
    const asked = installDaemon(["/tmp/d/DESIGN.md"]);
    const text = "**読んで** /tmp/d/DESIGN.md と https://ex.com/a。/tmp/missing.md";
    const root = await mount(h(LinkedPlainText, { text, ctx }));
    expect(asked.sort()).toEqual(["/tmp/d/DESIGN.md", "/tmp/missing.md"]);
    expect(links(root).map((l) => [l.cls, l.text])).toEqual([
      ["md-prose-file-link", "/tmp/d/DESIGN.md"],
      ["", "https://ex.com/a"],
    ]);
    expect(root.textContent).toBe(text);
  });

  test("a [label](path) in a user's text links as its label once confirmed", async () => {
    const asked = installDaemon(["/tmp/d/DESIGN.md"]);
    const root = await mount(
      h(LinkedPlainText, { text: "[設計](/tmp/d/DESIGN.md) と [無い](/tmp/missing.md)", ctx }),
    );
    expect(asked.sort()).toEqual(["/tmp/d/DESIGN.md", "/tmp/missing.md"]);
    expect(links(root).map((l) => [l.cls, l.text])).toEqual([["md-path-link", "設計"]]);
    expect(root.textContent).toBe("設計 と [無い](/tmp/missing.md)");
  });

  test("with no session to ask, paths stay text while URLs still link", async () => {
    const asked = installDaemon(["/tmp/d/DESIGN.md"]);
    const root = await mount(
      h(LinkedPlainText, { text: "/tmp/d/DESIGN.md https://ex.com/a", ctx: undefined }),
    );
    expect(asked).toEqual([]);
    expect(links(root).map((l) => l.href)).toEqual(["https://ex.com/a"]);
  });

  // The user surface of the Timeline: a user turn's text segment.
  test("a user turn in the Timeline renders through the plain-text linker", async () => {
    installDaemon(["/tmp/d/DESIGN.md"]);
    const root = await mount(
      h(
        SessionFilePathCtxContext.Provider,
        { value: ctx },
        h(SegmentView, {
          segment: { kind: "text", role: "user", text: "# 見出しではない /tmp/d/DESIGN.md" },
          translationAvailability: {
            host: false,
            browser: false,
            hostRequest: async () => unavailable,
          },
          ts: null,
          foldGroupOpen: false,
          searchKey: "0-0",
          searchCtx: undefined,
        }),
      ),
    );
    expect(root.querySelector("h1")).toBeNull();
    expect(links(root).map((l) => [l.cls, l.text])).toEqual([
      ["md-prose-file-link", "/tmp/d/DESIGN.md"],
    ]);
    expect(root.textContent).toBe("# 見出しではない /tmp/d/DESIGN.md");
  });
});

// 何を保証するか: 本文の markdown を作り直すのは、その本文のリンクが変わる時
// だけ。daemon の答えが別の本文のパスのものなら、この本文は描き直さない (TL
// の吹き出しが千個あっても、答えが届くたびに全部を parse し直さない)。呼ぶ側が
// 同じ値の ctx を作り直して渡しても作り直さない。作り直しは inline code の
// `code` の vnode が作られた数で数える (preact の options.vnode は vnode が
// 作られるたびに呼ばれる)。
describe("what builds a body's markdown again", () => {
  const built: string[] = [];
  let restore: (() => void) | null = null;

  function countCodeVnodes(): void {
    const previous = options.vnode?.bind(options);
    restore = stubProperty(options, "vnode", {
      configurable: true,
      enumerable: true,
      writable: true,
      value(vnode: VNode) {
        const children: unknown = vnode.props.children;
        if (vnode.type === "code" && typeof children === "string") built.push(children);
        previous?.(vnode);
      },
    });
  }

  afterEach(() => {
    restore?.();
    restore = null;
    built.length = 0;
  });

  /** A body whose only inline code is `path`. */
  const body = (path: string) => `see \`${path}\` here`;

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  test("an answer for another body's path builds only that body again", async () => {
    installDaemon(["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"]);
    countCodeVnodes();
    const root = await mount(
      h("div", null, [
        h(LinkedMarkdownView, { key: "a", source: body("src/a.ts"), ctx }),
        h(LinkedMarkdownView, { key: "b", source: body("src/b.ts"), ctx }),
      ]),
    );
    expect(links(root).map((l) => l.text)).toEqual(["src/a.ts", "src/b.ts"]);
    built.length = 0;

    await act(() =>
      render(
        h("div", null, [
          h(LinkedMarkdownView, { key: "a", source: body("src/a.ts"), ctx }),
          h(LinkedMarkdownView, { key: "b", source: body("src/b.ts"), ctx }),
          h(LinkedMarkdownView, { key: "c", source: body("src/c.ts"), ctx }),
        ]),
        root,
      ),
    );
    await settle();
    expect(links(root).map((l) => l.text)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    // c is built (as code, and again when its answer made it a link); a and b
    // are not.
    expect(built).toContain("src/c.ts");
    expect(built.filter((code) => code !== "src/c.ts")).toEqual([]);
  });

  test("a new ctx with the same fields builds nothing again", async () => {
    installDaemon(["/repo/src/a.ts"]);
    countCodeVnodes();
    const root = await mount(h(LinkedMarkdownView, { source: body("src/a.ts"), ctx }));
    built.length = 0;
    await act(() =>
      render(h(LinkedMarkdownView, { source: body("src/a.ts"), ctx: { ...ctx } }), root),
    );
    await settle();
    expect(built).toEqual([]);
    expect(links(root).map((l) => l.text)).toEqual(["src/a.ts"]);
  });

  test("a ctx with another cwd builds the body again", async () => {
    installDaemon(["/repo/src/a.ts", "/other/src/a.ts"]);
    countCodeVnodes();
    const root = await mount(h(LinkedMarkdownView, { source: body("src/a.ts"), ctx }));
    built.length = 0;
    await act(() =>
      render(
        h(LinkedMarkdownView, { source: body("src/a.ts"), ctx: { ...ctx, cwd: "/other" } }),
        root,
      ),
    );
    await settle();
    expect(built.length).toBeGreaterThan(0);
    expect(
      links(root).map((l) => new URL(l.href, "http://localhost").searchParams.get("path")),
    ).toEqual(["/other/src/a.ts"]);
  });
});
