// ```svg のコードブロック (DR-0010 §12): 既定は中身を data URL にした
// `<img>` で図として見せ、タブでコードの表示に切り替えられる。SVG として
// 読めない中身は img の error でコードの表示に落ちる。svg 以外の言語の
// コードブロックは今までどおりコードの塊。
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { MarkdownView } from "../src/client/markdown-view.tsx";
import { SvgFigure } from "../src/client/components/SvgFigure.tsx";
import { svgDataUrl, svgFigure } from "../src/client/svg-figure.ts";
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

async function mountMarkdown(source: string): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  mounted.push(root);
  await act(() => render(h(MarkdownView, { source }), root));
  return root;
}

function fence(lang: string, body: string): string {
  return "前の段落\n\n```" + lang + "\n" + body + "\n```\n\n後の段落\n";
}

function figureOf(root: HTMLElement): HTMLImageElement {
  return instanceOf(root.querySelector("img.md-figure-img"), HTMLImageElement, "the figure");
}

function tab(root: HTMLElement, label: string): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>(".md-figure-tabs [role=tab]")).find(
    (el) => el.querySelector(".md-figure-tab-label")?.getAttribute("data-label") === label,
  );
  return defined(found, `the ${label} tab`);
}

const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">' +
  "<title>円 & 四角</title>" +
  '<circle cx="40" cy="40" r="30" fill="teal"/><text x="80" y="45">日本語 #1 %</text></svg>';

describe("```svg code block", () => {
  test("is shown as an img whose data URL holds the block's text as it is", async () => {
    const root = await mountMarkdown(fence("svg", CIRCLE));
    const img = figureOf(root);
    const src = defined(img.getAttribute("src"), "the src");
    const prefix = "data:image/svg+xml;charset=utf-8,";
    expect(src.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(src.slice(prefix.length))).toBe(CIRCLE);
    expect(src).toBe(svgDataUrl(CIRCLE));
    // A raw `#` would end the data URL at a fragment, a raw `%` corrupt it.
    const encoded = src.slice(prefix.length);
    expect(encoded).not.toMatch(/[#<> "]/);
    expect(encoded).not.toMatch(/%(?![0-9A-F]{2})/);
    expect(root.querySelector("pre.md-code")).toBeNull();
  });

  test("the img's alt is the root <title>, else a generic name", async () => {
    expect(figureOf(await mountMarkdown(fence("svg", CIRCLE))).alt).toBe("円 & 四角");
    const untitled = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
    expect(figureOf(await mountMarkdown(fence("svg", untitled))).alt).toBe("SVG の図");
  });

  test("the fence language is matched case-insensitively", async () => {
    const root = await mountMarkdown(fence("SVG", CIRCLE));
    expect(figureOf(root).alt).toBe("円 & 四角");
  });

  test("the source tab switches to the highlighted source and the render tab back", async () => {
    const root = await mountMarkdown(fence("svg", CIRCLE));
    expect(tab(root, "描画").getAttribute("aria-selected")).toBe("true");
    await act(() => tab(root, "ソース").click());
    expect(root.querySelector("img.md-figure-img")).toBeNull();
    const pre = defined(root.querySelector(".md-figure pre.md-code"), "the code block");
    expect(pre.textContent).toBe(CIRCLE);
    expect(tab(root, "ソース").getAttribute("aria-selected")).toBe("true");
    await act(() => tab(root, "描画").click());
    expect(figureOf(root).alt).toBe("円 & 四角");
  });

  test("an img that fails to load falls back to the source and says why, with the render tab disabled", async () => {
    const broken = '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg';
    const root = await mountMarkdown(fence("svg", broken));
    const img = figureOf(root);
    await act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(root.querySelector("img.md-figure-img")).toBeNull();
    expect(
      defined(root.querySelector(".md-figure pre.md-code"), "the code block").textContent,
    ).toBe(broken);
    const figureTab = tab(root, "描画");
    expect(figureTab.getAttribute("aria-disabled")).toBe("true");
    expect(figureTab.tagName).toBe("SPAN");
    expect(defined(root.querySelector(".md-figure-note"), "the reason").textContent).toBe(
      "この SVG は描画できないのでソースを表示している",
    );
  });

  test("tab labels are not DOM text (search and copied selections see only the content)", async () => {
    const root = await mountMarkdown(fence("svg", CIRCLE));
    expect(root.textContent).toBe("前の段落\n後の段落\n");
    await act(() => tab(root, "ソース").click());
    expect(root.textContent).toBe(`前の段落\n${CIRCLE}後の段落\n`);
  });

  test("other languages stay plain code blocks", async () => {
    for (const lang of ["xml", "html", "", "svgz"]) {
      const root = await mountMarkdown(fence(lang, CIRCLE));
      expect(root.querySelector("img")).toBeNull();
      expect(root.querySelector(".md-figure")).toBeNull();
      expect(defined(root.querySelector("pre.md-code"), "the code block").textContent).toBe(CIRCLE);
    }
  });
});

describe("SvgFigure", () => {
  test("draws `code` as an img, and the source tab shows the same code", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mounted.push(root);
    await act(() => render(h(SvgFigure, { code: CIRCLE }), root));
    expect(figureOf(root).getAttribute("src")).toBe(svgDataUrl(CIRCLE));
    await act(() => tab(root, "ソース").click());
    expect(defined(root.querySelector(".md-figure pre.md-code"), "the source").textContent).toBe(
      CIRCLE,
    );
  });

  test("one copy button for the whole box, outside it", async () => {
    const root = await mountMarkdown(fence("svg", CIRCLE));
    const frame = defined(root.querySelector(".code-copy-frame"), "the copy frame");
    expect(frame.querySelector(":scope > .md-figure")).not.toBeNull();
    expect(root.querySelectorAll(".code-copy-btn").length).toBe(1);
    await act(() => tab(root, "ソース").click());
    expect(root.querySelectorAll(".code-copy-btn").length).toBe(1);
  });
});

describe("svgFigure", () => {
  test("adds the SVG namespace a root <svg> left out (img reads SVG as XML)", () => {
    const bare = '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>';
    const src = svgFigure(bare, "SVG").src;
    expect(src).toBe(
      svgDataUrl(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>',
      ),
    );
  });

  test("keeps a root that already declares its namespace as written", () => {
    expect(svgFigure(CIRCLE, "SVG").src).toBe(svgDataUrl(CIRCLE));
  });

  test("sized only when the root has a length width", () => {
    expect(svgFigure(CIRCLE, "SVG").sized).toBe(true);
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    expect(svgFigure(`<svg ${ns} viewBox="0 0 4 3"/>`, "SVG").sized).toBe(false);
    expect(svgFigure(`<svg ${ns} width="100%" viewBox="0 0 4 3"/>`, "SVG").sized).toBe(false);
  });

  test("unparsable text still becomes a data URL of the text as it is", () => {
    const broken = "<svg><rect></svg";
    expect(svgFigure(broken, "SVG")).toEqual({
      src: svgDataUrl(broken),
      alt: "SVG の図",
      sized: false,
    });
  });
});
