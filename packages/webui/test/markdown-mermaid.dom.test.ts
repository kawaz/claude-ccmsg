// ```mermaid のコードブロック (DR-0010 §13): 描画を選んでいる時は、描けるまでは
// ソースと「描画中」、描けたらライトとダークの 2 通りの SVG を ```svg と同じ箱で
// img の図にし、描けなければソースのまま理由を出す。描画 / ソースと配色の
// 選択はページ全体で共通で、localStorage に残る (mermaid-prefs.ts)。mermaid の
// 読み込みと描画は MermaidRendererContext で差し替える (実物の描画は e2e が
// 確かめる)。
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { MarkdownView } from "../src/client/markdown-view.tsx";
import {
  MERMAID_THEME_KEY,
  MERMAID_VIEW_KEY,
  parseMermaidPrefs,
  setMermaidTheme,
  setMermaidView,
} from "../src/client/mermaid-prefs.ts";
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
  // 選択はページ全体の値なので、試験ごとに既定へ戻す。
  setMermaidView("render");
  setMermaidTheme("system");
  localStorage.clear();
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
const TWO_FENCES = FENCE + "\n```mermaid\ngraph TD\n  x --> y\n```\n";
const LIGHT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><title>a から b</title><rect width="10" height="10"/></svg>';
const DARK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><title>a から b</title><rect width="10" height="10" fill="#ccc"/></svg>';
const DRAWN: MermaidResult = { ok: true, svg: { light: LIGHT, dark: DARK } };

/** Answer a call and let the block take the answer in (the images are decoded
 * before they go in, a few promise turns later). */
async function answer(
  call: { answer: (result: MermaidResult) => void },
  result: MermaidResult,
): Promise<void> {
  await act(async () => {
    call.answer(result);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function tab(root: ParentNode, label: string): HTMLElement {
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

function images(root: ParentNode): HTMLImageElement[] {
  return Array.from(root.querySelectorAll("img.md-figure-img")).map((el) =>
    instanceOf(el, HTMLImageElement, "a figure"),
  );
}

function figures(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".md-figure"));
}

function colourSwitch(root: ParentNode): Element | null {
  return root.querySelector(".md-figure-bar [aria-label='図の配色']");
}

describe("```mermaid code block", () => {
  test("shows the source and says it is drawing until the diagram is there", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(FENCE, renderer);
    expect(calls.map((c) => c.code)).toEqual([CODE]);
    expect(sourceText(root)).toBe(CODE);
    expect(note(root)).toBe("mermaid で描画中…");
    // The choice (shared by every diagram) stays 描画 while this one is drawing.
    expect(tab(root, "描画").getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector("img")).toBeNull();
    expect(colourSwitch(root)).toBeNull();
  });

  test("a drawn diagram is two imgs (light and dark) of the SVGs mermaid made, with the source a tab away", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(FENCE, renderer);
    await answer(defined(calls[0], "the call"), DRAWN);
    const [light, dark] = images(root);
    const lightImg = defined(light, "the light figure");
    const darkImg = defined(dark, "the dark figure");
    expect(lightImg.getAttribute("src")).toBe(svgDataUrl(LIGHT));
    expect(lightImg.classList.contains("md-mermaid-img-light")).toBe(true);
    expect(darkImg.getAttribute("src")).toBe(svgDataUrl(DARK));
    expect(darkImg.classList.contains("md-mermaid-img-dark")).toBe(true);
    expect(lightImg.alt).toBe("a から b");
    expect(note(root)).toBeNull();
    expect(sourceText(root)).toBeNull();
    expect(tab(root, "システム").getAttribute("aria-selected")).toBe("true");
    await act(() => tab(root, "ソース").click());
    expect(sourceText(root)).toBe(CODE);
    expect(root.querySelector("img")).toBeNull();
    // The colour switch is for a drawn diagram on show.
    expect(colourSwitch(root)).toBeNull();
  });

  test("描画 / ソース chosen on one diagram applies to every diagram and is saved", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(TWO_FENCES, renderer);
    for (const call of calls) await answer(call, DRAWN);
    expect(images(root).length).toBe(4);
    const [first, second] = figures(root);
    const firstBox = defined(first, "the first diagram");
    const secondBox = defined(second, "the second diagram");
    await act(() => tab(firstBox, "ソース").click());
    expect(secondBox.querySelector("img")).toBeNull();
    expect(tab(secondBox, "ソース").getAttribute("aria-selected")).toBe("true");
    expect(localStorage.getItem(MERMAID_VIEW_KEY)).toBe("source");
    await act(() => tab(secondBox, "描画").click());
    expect(images(root).length).toBe(4);
    expect(localStorage.getItem(MERMAID_VIEW_KEY)).toBe("render");
    // Each was drawn once: switching back does not draw them again.
    expect(calls.length).toBe(2);
  });

  test("the colour chosen on one diagram applies to every diagram, is saved, and draws nothing again", async () => {
    const { calls, renderer } = fakeRenderer();
    const root = await mount(TWO_FENCES, renderer);
    for (const call of calls) await answer(call, DRAWN);
    expect(images(root).map((img) => img.dataset.mermaidTheme)).toEqual([
      "system",
      "system",
      "system",
      "system",
    ]);
    await act(() => tab(defined(figures(root)[0], "the first diagram"), "ダーク").click());
    expect(images(root).map((img) => img.dataset.mermaidTheme)).toEqual([
      "dark",
      "dark",
      "dark",
      "dark",
    ]);
    expect(
      tab(defined(figures(root)[1], "the second diagram"), "ダーク").getAttribute("aria-selected"),
    ).toBe("true");
    expect(localStorage.getItem(MERMAID_THEME_KEY)).toBe("dark");
    expect(calls.length).toBe(2);
  });

  test("with ソース chosen, nothing is drawn until 描画 is chosen", async () => {
    setMermaidView("source");
    const { calls, renderer } = fakeRenderer();
    const root = await mount(FENCE, renderer);
    expect(calls).toEqual([]);
    expect(sourceText(root)).toBe(CODE);
    expect(note(root)).toBeNull();
    expect(tab(root, "描画").getAttribute("aria-disabled")).toBeNull();
    await act(() => tab(root, "描画").click());
    expect(calls.map((c) => c.code)).toEqual([CODE]);
    expect(note(root)).toBe("mermaid で描画中…");
    await answer(defined(calls[0], "the call"), DRAWN);
    expect(images(root).length).toBe(2);
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
    await answer(defined(calls[0], "the call"), {
      ok: true,
      svg: { light: "<svg><g></svg", dark: "<svg><g></svg" },
    });
    const img = defined(images(root)[0], "the figure");
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
    await answer(defined(calls[0], "the first call"), DRAWN);
    expect(root.querySelector("img")).toBeNull();
    expect(sourceText(root)).toBe(next);
    expect(calls.map((c) => c.code)).toEqual([CODE, next]);
  });
});

describe("parseMermaidPrefs", () => {
  test("reads the saved choices", () => {
    expect(parseMermaidPrefs("source", "dark")).toEqual({ view: "source", theme: "dark" });
  });

  test("nothing saved, or a value it does not know, is the default (描画, システム)", () => {
    expect(parseMermaidPrefs(null, null)).toEqual({ view: "render", theme: "system" });
    expect(parseMermaidPrefs("picture", "sepia")).toEqual({ view: "render", theme: "system" });
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
