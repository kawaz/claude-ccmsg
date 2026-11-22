// The markdown's line ends (DR-0010 §11): a heading's text and a paragraph's
// (a list item's text is one too) end in a newline text node, so the rendered
// text nodes the Timeline's search joins as they are keep a line on screen
// apart from the next one. A nested item's text does not run straight on from
// its parent's (`👺XXXX` + `Q1`), nor a heading's or a paragraph's into the
// block after it.
//
// happy-dom has no Highlight / CSS.highlights, so a minimal fake that keeps
// the registered ranges stands in for them.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseSearchQuery } from "../src/client/in-view-search.ts";
import { MarkdownView } from "../src/client/markdown-view.tsx";
import {
  highlightRenderedText,
  removeRenderedTextHighlights,
} from "../src/client/rendered-text-search.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf, stubProperty } from "./helpers.ts";

withDom();

class FakeHighlight {
  readonly ranges: AbstractRange[];
  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges;
  }
}

const registry = new Map<string, FakeHighlight>();
const restores: (() => void)[] = [];
beforeAll(() => {
  const win = defined(document.defaultView, "the window");
  restores.push(
    stubProperty(win, "Highlight", { value: FakeHighlight, configurable: true, writable: true }),
    // happy-dom's window.CSS is a fresh object on every read, so replace it whole.
    stubProperty(win, "CSS", {
      value: { highlights: registry },
      configurable: true,
      writable: true,
    }),
  );
});
afterAll(() => {
  for (const restore of restores.reverse()) restore();
});

const mounted: HTMLElement[] = [];
afterEach(async () => {
  for (const root of mounted.splice(0)) {
    removeRenderedTextHighlights(root);
    await act(() => render(null, root));
    root.remove();
  }
  await Promise.resolve();
  registry.clear();
});

async function mountMarkdown(source: string): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  mounted.push(root);
  await act(() => render(h(MarkdownView, { source }), root));
  return root;
}

/** The rendered text nodes joined as they are, the way the search reads them. */
function joinedText(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let out = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out += node.nodeValue ?? "";
  return out;
}

const NESTED_LIST = "- 👺XXXX\n  - Q1 ほげほげ？\n  - Q2 ふが？\n";

describe("line ends in the rendered text", () => {
  test("a list item's text ends its line before the nested item's text", async () => {
    const root = await mountMarkdown(NESTED_LIST);
    expect(root.querySelectorAll("li").length).toBe(3);
    expect(joinedText(root)).toBe("👺XXXX\nQ1 ほげほげ？\nQ2 ふが？\n");
  });

  test("a heading's text ends its line before the paragraph under it", async () => {
    const root = await mountMarkdown("# foo\n\nbar\n");
    expect(joinedText(root)).toBe("foo\nbar\n");
  });

  test("a paragraph's text ends its line before the next paragraph", async () => {
    const root = await mountMarkdown("foo\n\nbar\n");
    expect(joinedText(root)).toBe("foo\nbar\n");
  });

  test("a paragraph's text ends its line before the list under it", async () => {
    const root = await mountMarkdown("foo\n\n- bar\n");
    expect(joinedText(root)).toBe("foo\nbar\n");
  });

  test("a quoted paragraph ends its line before the paragraph after the quote", async () => {
    const root = await mountMarkdown("> foo\n\nbar\n");
    expect(root.querySelector("blockquote")?.textContent).toBe("foo\n");
    expect(joinedText(root)).toBe("foo\nbar\n");
  });

  test("a list item's text ends in one line end, not two", async () => {
    const root = await mountMarkdown("- foo\n");
    expect(root.querySelector("li")?.textContent).toBe("foo\n");
  });

  test("a task item's text ends its line too", async () => {
    const root = await mountMarkdown("- [ ] foo\n- [x] bar\n");
    expect(joinedText(root)).toBe("foo\nbar\n");
  });

  test("the search paints the item's own word alone, not the nested item's", async () => {
    // `\s*` also matches a newline, but it sits between 👺 and the word, and
    // the newline comes after the word, where the character class stops.
    const root = await mountMarkdown(NESTED_LIST);
    const words = parseSearchQuery("👺\\s*[A-Za-z0-9α-ωΑ-Ω\\-]{2,}", {
      caseSensitive: false,
      regex: true,
    }).words;
    expect(highlightRenderedText(root, words, () => undefined)).toBe(true);
    // The registry is synced in a microtask.
    await Promise.resolve();
    const painted = [...registry.entries()]
      .filter(([name]) => name !== "ccmsg-search-current")
      .flatMap(([, highlight]) => highlight.ranges)
      .map((range) => instanceOf(range, Range, "a highlight range").toString());
    expect(painted).toEqual(["👺XXXX"]);
  });
});
