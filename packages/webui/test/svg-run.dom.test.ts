// 「実行」of a ```svg block (DR-0067 §3), mounted: the box gets a third
// section only when hello reported `sandbox_available` (and the app is
// there); pressing it asks `sandbox_grant_svg` for the text the img draws
// (`xmlns` added) and opens a new tab the way the preview does, and nothing is
// asked before it is pressed. The selection stays on 描画. A block the img
// cannot draw and a block over FS_READ_MAX_BYTES cannot be pressed, and say
// why. That the tab runs the script is svg-run.e2e.ts's.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { FS_READ_MAX_BYTES, type ReplyOf } from "@ccmsg/protocol";
import { SVG_RUN_TITLE, SVG_RUN_UNRENDERABLE } from "../src/client/components/SvgFigure.tsx";
import { MarkdownView } from "../src/client/markdown-view.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined, stubProperty } from "./helpers.ts";
import { Mounted } from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
let restores: Array<() => void> = [];
/** What window.open was called with. */
let opened: unknown[][] = [];

beforeEach(() => {
  opened = [];
  restores = [
    stubProperty(window, "open", {
      value: (...args: unknown[]) => {
        opened.push(args);
        return null;
      },
      configurable: true,
      writable: true,
    }),
  ];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

const FIGURE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>図</title><script>1</script></svg>';
const BARE = '<svg width="10" height="10"><title>図</title></svg>';
const GRANTED: ReplyOf<"sandbox_grant_svg"> = {
  ok: true,
  gid: "abc",
  token: "tok",
  url: "https://ccmsg-files-abc.sandbox.test/tok/figure.svg",
  exp: 1,
};

function fence(lang: string, body: string): string {
  return "```" + lang + "\n" + body + "\n```\n";
}

/** The box mounted inside the app, with `sandbox_available` as given; the
 * texts sandbox_grant_svg was asked for are collected, and `replied` settles
 * once the last one has been answered. */
async function mountWith(
  source: string,
  {
    available = true,
    reply = GRANTED,
  }: { available?: boolean; reply?: ReplyOf<"sandbox_grant_svg"> } = {},
): Promise<{ root: HTMLElement; asked: string[]; replied: () => Promise<unknown> }> {
  const store = createStore(initialState());
  store.dispatch({ type: "sandbox/availability", available });
  const asked: string[] = [];
  let last: Promise<unknown> = Promise.resolve();
  const ws: WsHandle = {
    ...createWsClient(() => {}),
    sandboxGrantSvg: (content) => {
      asked.push(content);
      const answered = Promise.resolve(reply);
      last = answered;
      return answered;
    },
  };
  const root = await mounted.mount(store, ws, h(MarkdownView, { source }));
  return { root, asked, replied: () => last };
}

function labelsOf(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(".md-figure-tabs [role=tab] .md-figure-tab-label")).map(
    (el) => el.getAttribute("data-label") ?? "",
  );
}

function tab(root: HTMLElement, label: string): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>(".md-figure-tabs [role=tab]")).find(
    (el) => el.querySelector(".md-figure-tab-label")?.getAttribute("data-label") === label,
  );
  return defined(found, `the ${label} tab`);
}

describe("実行 of a ```svg block", () => {
  test("is a third section when the sandbox origin is there, and asks nothing until pressed", async () => {
    const { root, asked } = await mountWith(fence("svg", FIGURE));
    expect(labelsOf(root)).toEqual(["描画", "ソース", "実行"]);
    expect(tab(root, "実行").getAttribute("title")).toBe(SVG_RUN_TITLE);
    expect(tab(root, "実行").tagName).toBe("BUTTON");
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("pressing it opens a tab and asks for the text, and the choice stays on 描画", async () => {
    const { root, asked, replied } = await mountWith(fence("svg", FIGURE));
    await act(async () => {
      tab(root, "実行").click();
      await replied();
    });
    expect(asked).toEqual([FIGURE]);
    // The preview's way (sandbox-open.ts): an empty tab opened on the click,
    // the URL once granted. window.open returned null here (as a popup
    // blocker does), so the URL goes to a second open. That a real browser
    // ends with one tab is sandbox-open.e2e.ts's.
    expect(opened).toEqual([
      ["", "_blank"],
      [GRANTED.url, "_blank", "noopener,noreferrer"],
    ]);
    expect(tab(root, "描画").getAttribute("aria-selected")).toBe("true");
    expect(tab(root, "実行").getAttribute("aria-selected")).toBe("false");
    expect(root.querySelector("img.md-figure-img")).not.toBeNull();
  });

  test("a block without xmlns is asked for as drawn, with the namespace added", async () => {
    const { root, asked } = await mountWith(fence("svg", BARE));
    await act(() => tab(root, "実行").click());
    expect(asked).toEqual([
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>図</title></svg>',
    ]);
  });

  test("a refused grant says why in the box", async () => {
    const { root, replied } = await mountWith(fence("svg", FIGURE), {
      reply: { ok: false, error: { code: "sandbox_not_configured", msg: "not configured" } },
    });
    await act(async () => {
      tab(root, "実行").click();
      await replied();
    });
    expect(defined(root.querySelector(".md-figure-note"), "the note").textContent).toBe(
      "not configured",
    );
    expect(root.querySelector("img.md-figure-img")).not.toBeNull();
  });

  test("a block the img cannot draw cannot be pressed, and says why", async () => {
    const { root, asked } = await mountWith(fence("svg", FIGURE));
    const img = defined(root.querySelector("img.md-figure-img"), "the figure");
    await act(() => {
      img.dispatchEvent(new Event("error"));
    });
    const run = tab(root, "実行");
    expect(run.tagName).toBe("SPAN");
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(run.getAttribute("title")).toBe(SVG_RUN_UNRENDERABLE);
    await act(() => run.click());
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("a block over FS_READ_MAX_BYTES (as UTF-8 bytes) cannot be pressed, and says why", async () => {
    // Under the limit in characters, over it in bytes.
    const filler = "あ".repeat(Math.floor(FS_READ_MAX_BYTES / 3) + 1);
    const big = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><desc>${filler}</desc></svg>`;
    const { root, asked } = await mountWith(fence("svg", big));
    const run = tab(root, "実行");
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(run.getAttribute("title")).toBe(
      `この SVG は ${String(Math.floor(FS_READ_MAX_BYTES / 1024))}KB を超えるので実行できない`,
    );
    await act(() => run.click());
    expect(asked).toEqual([]);
  });

  test("there is no 実行 without the sandbox origin", async () => {
    const { root } = await mountWith(fence("svg", FIGURE), { available: false });
    expect(labelsOf(root)).toEqual(["描画", "ソース"]);
  });

  test("there is no 実行 outside the app (the catalog, a unit render)", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(MarkdownView, { source: fence("svg", FIGURE) }), root));
    expect(labelsOf(root)).toEqual(["描画", "ソース"]);
    await act(() => render(null, root));
    root.remove();
  });

  test("math has no 実行", async () => {
    const { root } = await mountWith(fence("math", "x^2"));
    expect(labelsOf(root)).toEqual(["描画", "ソース"]);
  });
});
