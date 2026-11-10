// The file preview's markdown, mounted with the options FileViewer gives it:
// an author's own anchor (`<a id="…"></a>`) is an empty element carrying the
// id where the tag was written, so `…/files?path=…#<id>` has a place to go,
// and the tag's characters are not shown.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { MarkdownView } from "../src/client/markdown-view.tsx";
import { withDom } from "./dom.ts";
import { stubProperty } from "./helpers.ts";

withDom();

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

/** The preview as FileViewer mounts it: outline and section folds on, and
 * the URL's fragment when there is one. */
async function mountPreview(source: string, fragment?: string): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await act(() =>
    render(
      h(MarkdownView, {
        source,
        tableOfContents: true,
        foldSections: true,
        ...(fragment !== undefined ? { fragment } : {}),
      }),
      root,
    ),
  );
  return root;
}

/** The ids `scrollIntoView` was called on, in order, from here on. */
function watchScrolls(): { ids: string[]; restore: () => void } {
  const ids: string[] = [];
  const restore = stubProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value(this: Element): void {
      ids.push(this.id);
    },
  });
  return { ids, restore };
}

/** Let the frame the reveal waits for run. */
async function nextFrame(): Promise<void> {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

const SOURCE = [
  "# 裁定・確認待ち一覧",
  "",
  '## <a id="3335-Q1"></a>ほげほげ',
  "",
  "本文",
  "",
  '## v0.232.6 <a id="v0.232.6"></a>',
  "",
  "- 変更点",
].join("\n");

describe("the file preview's document anchors", () => {
  test("the anchor is an element with the id, inside its heading, and its tag is not shown", async () => {
    const root = await mountPreview(SOURCE);
    const anchor = document.getElementById("3335-Q1");
    expect(anchor?.tagName).toBe("SPAN");
    expect(anchor?.textContent).toBe("");
    expect(anchor?.closest("h2")?.textContent).toBe("ほげほげ");
    expect(document.getElementById("v0.232.6")?.closest("h2")?.textContent?.trim()).toBe(
      "v0.232.6",
    );
    expect(root.textContent).not.toContain("<a");
    expect(root.textContent).not.toContain("</a>");
  });

  test("the outline lists the headings without the tag, and keeps its own ids", async () => {
    const root = await mountPreview(SOURCE);
    const entries = [...root.querySelectorAll(".md-toc a")].map((a) => [
      a.getAttribute("href"),
      a.textContent,
    ]);
    expect(entries).toEqual([
      ["#md-section-1", "1裁定・確認待ち一覧"],
      ["#md-section-1-1", "1.1ほげほげ"],
      ["#md-section-1-2", "1.2v0.232.6"],
    ]);
    // The heading keeps the outline's id; the author's is the element in it.
    expect(document.getElementById("md-section-1-1")?.tagName).toBe("H2");
    expect(
      document.getElementById("md-section-1-1")?.contains(document.getElementById("3335-Q1")),
    ).toBe(true);
  });

  // The anchor's place has to be there for a jump even while its section is
  // folded: the body stays mounted, and the heading is never hidden.
  test("an anchor in a section's body is in the document", async () => {
    await mountPreview(["## 節", "", 'text <a name="in-body"></a> more'].join("\n"));
    expect(document.getElementById("in-body")?.closest("p")?.textContent).toBe("text  more");
  });

  // The browser's own jump to a fragment runs when the URL is entered, before
  // the file is loaded and drawn; the preview goes there once it is.
  test("the URL's fragment is gone to once the document is drawn: an author's anchor, or an outline id", async () => {
    const scrolls = watchScrolls();
    try {
      await mountPreview(SOURCE, "3335-Q1");
      await nextFrame();
      expect(scrolls.ids).toEqual(["3335-Q1"]);
      scrolls.ids.length = 0;
      await mountPreview(SOURCE, "md-section-1-2");
      await nextFrame();
      expect(scrolls.ids).toEqual(["md-section-1-2"]);
    } finally {
      scrolls.restore();
    }
  });

  test("a fragment that names nothing in the document, or none, scrolls nothing", async () => {
    const scrolls = watchScrolls();
    try {
      await mountPreview(SOURCE, "no-such-place");
      await mountPreview(SOURCE, "");
      await mountPreview(SOURCE);
      await nextFrame();
      expect(scrolls.ids).toEqual([]);
    } finally {
      scrolls.restore();
    }
  });
});
