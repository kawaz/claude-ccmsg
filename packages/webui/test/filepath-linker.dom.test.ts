// Prose paths and bare URLs, end to end through the probe: a body's absolute /
// `~/` paths are asked about over fs_stat_batch, and only the ones the daemon
// confirms become links — in a markdown body (assistant text, thinking) and in
// a user's plain text alike. Bare URLs link without asking anything.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render, type ComponentChild } from "preact";
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
