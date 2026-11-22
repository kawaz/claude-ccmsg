// ```mermaid のコードブロック (DR-0010 §13): 描けるまではソースと「描画中」、
// 描けたら結果の SVG を ```svg と同じ箱で img の図にし、描けなければソースの
// まま理由を出す。mermaid の読み込みと描画は MermaidRendererContext で差し
// 替える (実物の描画は e2e が確かめる)。
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { MarkdownView } from "../src/client/markdown-view.tsx";
import {
  MermaidRendererContext,
  renderMermaid,
  type MermaidResult,
} from "../src/client/mermaid-render.ts";
import { svgDataUrl } from "../src/client/svg-figure.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf } from "./helpers.ts";

withDom();

const mounted: HTMLElement[] = [];
afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(() => render(null, root));
    root.remove();
  }
});

/** A renderer whose answers the test gives, one per call, in call order. */
function fakeRenderer() {
  const calls: { code: string; answer: (result: MermaidResult) => void }[] = [];
  const renderer = (code: string) =>
    new Promise<MermaidResult>((resolve) => {
      calls.push({ code, answer: resolve });
    });
  return { calls, renderer };
}

async function mount(
  source: string,
  renderer: (code: string) => Promise<MermaidResult>,
): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  mounted.push(root);
  await act(() =>
    render(
      h(MermaidRendererContext.Provider, { value: renderer }, h(MarkdownView, { source })),
      root,
    ),
  );
  return root;
}

const CODE = "graph LR\n  a --> b";
const FENCE = "```mermaid\n" + CODE + "\n```\n";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><title>a から b</title><rect width="10" height="10"/></svg>';

/** Answer a call and let the block take the answer in. */
async function answer(
  call: { answer: (result: MermaidResult) => void },
  result: MermaidResult,
): Promise<void> {
  await act(async () => {
    call.answer(result);
    await Promise.resolve();
  });
}

function tab(root: HTMLElement, label: string): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>(".md-figure-tabs [role=tab]")).find(
    (el) => el.querySelector(".md-figure-tab-label")?.getAttribute("data-label") === label,
  );
  return defined(found, `the ${label} tab`);
}

function note(root: HTMLElement): string | null {
  return root.querySelector(".md-figure-note")?.textContent ?? null;
}

function sourceText(root: HTMLElement): string | null {
  return root.querySelector(".md-figure pre.md-code")?.textContent ?? null;
}

describe("```mermaid code block", () => {
  test("shows the source and says it is drawing until the diagram is there", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(FENCE, renderer);
    expect(calls.map((c) => c.code)).toEqual([CODE]);
    expect(sourceText(root)).toBe(CODE);
    expect(note(root)).toBe("mermaid で描画中…");
    expect(tab(root, "描画").getAttribute("aria-disabled")).toBe("true");
    expect(root.querySelector("img")).toBeNull();
  });

  test("a drawn diagram is an img of the SVG mermaid made, with the source a tab away", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(FENCE, renderer);
    await answer(defined(calls[0], "the call"), { ok: true, svg: SVG });
    const img = instanceOf(root.querySelector("img.md-figure-img"), HTMLImageElement, "the figure");
    expect(img.getAttribute("src")).toBe(svgDataUrl(SVG));
    expect(img.alt).toBe("a から b");
    expect(note(root)).toBeNull();
    expect(sourceText(root)).toBeNull();
    await act(() => tab(root, "ソース").click());
    expect(sourceText(root)).toBe(CODE);
    expect(root.querySelector("img")).toBeNull();
  });

  test("a diagram mermaid cannot draw stays the source, with mermaid's reason", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(FENCE, renderer);
    const reason = "図を描画できない: Parse error on line 2";
    await answer(defined(calls[0], "the call"), { ok: false, reason });
    expect(note(root)).toBe(reason);
    expect(defined(root.querySelector(".md-figure-note-error"), "the error note")).toBeTruthy();
    expect(sourceText(root)).toBe(CODE);
    expect(tab(root, "描画").getAttribute("aria-disabled")).toBe("true");
  });

  test("an SVG from mermaid that the img cannot load falls back to the source", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(FENCE, renderer);
    await answer(defined(calls[0], "the call"), { ok: true, svg: "<svg><g></svg" });
    const img = instanceOf(root.querySelector("img.md-figure-img"), HTMLImageElement, "the figure");
    expect(img.alt).toBe("mermaid の図");
    await act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(note(root)).toBe("この mermaid は描画できないのでソースを表示している");
    expect(sourceText(root)).toBe(CODE);
  });

  test("an answer for text the block no longer holds is not shown", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = document.createElement("div");
    document.body.append(root);
    mounted.push(root);
    const view = (source: string) =>
      h(MermaidRendererContext.Provider, { value: renderer }, h(MarkdownView, { source }));
    await act(() => render(view(FENCE), root));
    const next = "graph TD\n  x --> y";
    await act(() => render(view("```mermaid\n" + next + "\n```\n"), root));
    await answer(defined(calls[0], "the first call"), { ok: true, svg: SVG });
    expect(root.querySelector("img")).toBeNull();
    expect(sourceText(root)).toBe(next);
    expect(calls.map((c) => c.code)).toEqual([CODE, next]);
  });
});

describe("renderMermaid", () => {
  test("says mermaid cannot be loaded when its entry does not load", async () => {
    // No daemon serves /assets/ here, so the dynamic import fails.
    expect(await renderMermaid(CODE)).toEqual({
      ok: false,
      reason: "図を描画できない (mermaid を読み込めない)",
    });
  });
});
