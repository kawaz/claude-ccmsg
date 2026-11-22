// TeX の数式 (DR-0010 §14): 書き方は GitHub (細部は pandoc)、描くのは Temml の
// MathML を DOMPurify に通したもの。描く部品は最初の数式で読み込まれ、それまで
// は TeX の文字のまま出る。
//
// 描く部品は MathTypesetLoaderContext で差し替える: happy-dom の MathML の要素は
// DOMPurify の in-place のサニタイズを通らない ("root node is forbidden")。
// Temml と DOMPurify の実物は e2e (markdown-math.e2e.ts) が実ブラウザで確かめる。
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { PhrasingContent, RootContent } from "mdast";
import { MarkdownView, parseMarkdownSource } from "../src/client/markdown-view.tsx";
import { MathTypesetLoaderContext, type MathTypeset } from "../src/client/math-render.tsx";
import type { MathTree, TypesetResult } from "../src/client/math-typeset.ts";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";

withDom();

const MATHML = "http://www.w3.org/1998/Math/MathML";

const mounted: HTMLElement[] = [];
afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(() => render(null, root));
    root.remove();
  }
});

/** A stand-in for Temml: `\\bad` fails, `\\eqn` carries an equation number
 * (Temml's `mtext > span.tml-eqn`), anything else is one `mi` holding the TeX,
 * with the TeX kept as the annotation. */
const fakeTypeset: MathTypeset = (tex, display): TypesetResult => {
  if (tex.includes("\\bad")) return { ok: false, message: "Undefined control sequence: \\bad" };
  const body: (MathTree | string)[] = [{ tag: "mi", attrs: [], children: [tex] }];
  if (tex.includes("\\eqn")) {
    body.push({
      tag: "mtext",
      attrs: [],
      children: [{ tag: "span", attrs: [["class", "tml-eqn"]], children: [] }],
    });
  }
  return {
    ok: true,
    tree: {
      tag: "math",
      attrs: display ? [["display", "block"]] : [],
      children: [
        {
          tag: "semantics",
          attrs: [],
          children: [
            { tag: "mrow", attrs: [], children: body },
            { tag: "annotation", attrs: [["encoding", "application/x-tex"]], children: [tex] },
          ],
        },
      ],
    },
  };
};

type Loader = () => Promise<MathTypeset | null>;
const readyLoader: Loader = () => Promise.resolve(fakeTypeset);

async function mount(
  source: string,
  { restricted = false, loader = readyLoader }: { restricted?: boolean; loader?: Loader } = {},
): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  mounted.push(root);
  await act(async () => {
    render(
      h(
        MathTypesetLoaderContext.Provider,
        { value: loader },
        h(MarkdownView, { source, restricted }),
      ),
      root,
    );
    await Promise.resolve();
  });
  return root;
}

/** A compact picture of the parsed tree: text as JSON, math as M(form:tex),
 * block math as BLOCK(tex), other nodes as type[children]. */
function shape(source: string): string {
  const show = (node: RootContent | PhrasingContent): string => {
    switch (node.type) {
      case "text":
        return JSON.stringify(node.value);
      case "inlineMath":
        return `M(${node.form}:${node.value})`;
      case "math":
        return `BLOCK(${node.value.trim()})`;
      default:
        return "children" in node
          ? `${node.type}[${node.children.map(show).join(" ")}]`
          : node.type;
    }
  };
  return parseMarkdownSource(source).children.map(show).join(" | ");
}

describe("math syntax", () => {
  test("inline $…$ follows pandoc's rule", () => {
    expect(shape("a $x$ b")).toBe('paragraph["a " M(inline:x) " b"]');
    expect(shape("$5 and $10")).toBe('paragraph["$5 and $10"]');
    expect(shape("$ x$")).toBe('paragraph["$ x$"]');
    expect(shape("$x $")).toBe('paragraph["$x $"]');
    expect(shape("$x$1")).toBe('paragraph["$x$1"]');
    expect(shape("$x$。")).toBe('paragraph[M(inline:x) "。"]');
    expect(shape("$a\\$b$")).toBe("paragraph[M(inline:a\\$b)]");
  });

  test("\\$ is a dollar, and code is left alone", () => {
    expect(shape("\\$x$")).toBe('paragraph["$x$"]');
    expect(shape("`$x$`")).toBe("paragraph[inlineCode]");
    expect(shape("```\n$x$\n```")).toBe("code");
  });

  test("$`…`$ reads up to the first `$", () => {
    expect(shape("$`a*b`$ c")).toBe('paragraph[M(backtick:a*b) " c"]');
  });

  test("math does not cross a line, except a paragraph that is one $$…$$", () => {
    expect(shape("$x\ny$")).toBe('paragraph["$x\\ny$"]');
    expect(shape("$$x$$ in text")).toBe('paragraph[M(display:x) " in text"]');
    expect(shape("$$\nx\n$$")).toBe("BLOCK(x)");
    expect(shape("$$x$$")).toBe("BLOCK(x)");
    expect(shape("text\n$$\nx\n$$")).toBe('paragraph["text\\n$$\\nx\\n$$"]');
    expect(shape("> $$\n> a\n> $$")).toBe("blockquote[BLOCK(a)]");
  });

  test("a tight list item's $$…$$ across lines is not math (GitHub)", () => {
    expect(shape("- $$\n  a\n  $$")).toBe('list[listItem[paragraph["$$\\na\\n$$"]]]');
  });

  test("blank content is not math", () => {
    expect(shape("$$ $$")).toBe('paragraph["$$ $$"]');
    expect(shape("$` `$")).toBe('paragraph["$` `$"]');
  });

  test("a * or _ inside math does not close emphasis opened outside it", () => {
    expect(shape("*a $x*y$ b*")).toBe('paragraph[emphasis["a " M(inline:x*y) " b"]]');
    expect(shape("_a $x_1$ b_")).toBe('paragraph[emphasis["a " M(inline:x_1) " b"]]');
  });

  test("tag-like text inside math is TeX, not a protected tag", () => {
    expect(shape("$a<b>c$")).toBe("paragraph[M(inline:a<b>c)]");
  });
});

describe("math rendering", () => {
  test("shows the TeX until the parts are loaded, then MathML", async () => {
    let finish: (typeset: MathTypeset) => void = () => {};
    const loader: Loader = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const root = await mount("a $x^2$ b", { loader });
    expect(defined(root.querySelector(".md-math-pending"), "pending").textContent).toBe("x^2");
    await act(async () => {
      finish(fakeTypeset);
      await Promise.resolve();
    });
    const math = defined(root.querySelector(".md-math math"), "the math element");
    expect(math.namespaceURI).toBe(MATHML);
    expect(root.querySelector(".md-math-pending")).toBeNull();
  });

  test("when the parts cannot be loaded, every formula says so", async () => {
    const root = await mount("a $x$ b", { loader: () => Promise.resolve(null) });
    expect(root.querySelector(".md-math-error-msg")?.textContent).toBe(
      "数式を描画できない: 数式の描画の部品を読み込めない",
    );
  });

  test("inline math is drawn in the text, display math on a line of its own", async () => {
    const root = await mount("a $x$ b\n\n$$\\frac{1}{2}$$\n\nc $$y$$ d");
    const inline = defined(root.querySelector("p > span.md-math:not(.md-math-display)"), "inline");
    expect(defined(inline.querySelector("math"), "math").getAttribute("display")).toBeNull();
    const block = defined(root.querySelector("div.md-math.md-math-display"), "block");
    expect(defined(block.querySelector("math"), "math").getAttribute("display")).toBe("block");
    expect(root.querySelector("p > span.md-math.md-math-display")).not.toBeNull();
  });

  test("the TeX is trimmed, and MathML elements are made in the MathML namespace", async () => {
    const root = await mount("$$\n  a+b  \n$$");
    const annotation = defined(root.querySelector("annotation"), "the annotation");
    expect(annotation.textContent).toBe("a+b");
    expect(annotation.namespaceURI).toBe(MATHML);
    expect(annotation.getAttribute("encoding")).toBe("application/x-tex");
  });

  test("a formula that cannot be drawn shows its TeX as code with the reason", async () => {
    const root = await mount("x $\\bad$ y");
    const error = defined(root.querySelector(".md-math-error"), "the error");
    expect(defined(error.querySelector("code"), "code").textContent).toBe("\\bad");
    expect(error.querySelector(".md-math-error-msg")?.textContent).toBe(
      "数式を描画できない: Undefined control sequence: \\bad",
    );
  });

  test("equation numbers count from the top of each document", async () => {
    const doc = "$$\\eqn a$$\n\n```math\n\\eqn b\n```\n\nand $$\\eqn c$$\n";
    const numbers = (root: HTMLElement) =>
      Array.from(root.querySelectorAll("mtext")).map((el) => el.textContent ?? "");
    expect(numbers(await mount(doc))).toEqual(["(1)", "(2)", "(3)"]);
    expect(numbers(await mount(doc))).toEqual(["(1)", "(2)", "(3)"]);
  });

  test("a ```math block is drawn in the figure box, with its TeX a tab away", async () => {
    const root = await mount("```math\nE = mc^2\n```\n");
    const box = defined(root.querySelector(".md-figure"), "the box");
    expect(box.querySelector(".md-figure-view math")).not.toBeNull();
    const sourceTab = defined(
      Array.from(box.querySelectorAll<HTMLElement>("[role=tab]")).find(
        (el) => el.querySelector("[data-label]")?.getAttribute("data-label") === "ソース",
      ),
      "the source tab",
    );
    await act(() => sourceTab.click());
    expect(box.querySelector("pre.md-code")?.textContent).toBe("E = mc^2");
  });

  test("a ```math block that cannot be drawn stays its source, with the reason", async () => {
    const root = await mount("```math\n\\bad\n```\n");
    expect(root.querySelector(".md-figure-note-error")?.textContent).toBe(
      "数式を描画できない: Undefined control sequence: \\bad",
    );
    expect(root.querySelector(".md-figure pre.md-code")?.textContent).toBe("\\bad");
  });

  test("a user's message (restricted) does not draw math", async () => {
    const root = await mount("$x^2$", { restricted: true });
    expect(root.querySelector("math")).toBeNull();
    expect(root.textContent).toContain("$x^2$");
  });
});
