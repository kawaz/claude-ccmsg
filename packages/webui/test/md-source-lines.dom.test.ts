// The lines in the source of what a file's markdown preview draws (DR-0062
// P26): the blocks of the preview carry them, and a point is on the lines of
// the innermost block it is in.
// 何を保証するか:
//   - sourceLines の描画は、段落・見出し・箇条書きの項目・表の行・引用・コードブロック
//     に元の行の範囲 (data-md-line / data-md-end-line) を持たせる。sourceLines の
//     無い描画 (TL の吹き出し) は持たない
//   - 点の行は、それを含む最も内側の塊の行: 段落は段落の行、入れ子の項目はその項目自身の
//     行、表のセルは行の行、引用の中の段落は段落の行
//   - 行ごとに描かれたコードの中の点は、コードの始まりの行 (囲みのフェンスの次の行) から
//     数えたその 1 行。フェンスの無い (字下げの) コードは始まりの行がコード
//   - どの塊にも無い点は null
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { MarkdownView } from "../src/client/markdown-view.tsx";
import { mdSourceLinesOf } from "../src/client/md-source-lines.ts";
import { withDom } from "./dom.ts";

withDom();

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

async function mount(source: string, sourceLines: boolean): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await act(() => render(h(MarkdownView, { source, sourceLines }), root));
  return root;
}

/** The text node holding `words` below `root`. */
function textOf(root: Element, words: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data.includes(words)) return node;
  }
  throw new Error(`no ${words}`);
}

const SOURCE = [
  "# 見出し", // 1
  "", // 2
  "段落の一行目", // 3
  "段落の二行目", // 4
  "", // 5
  "- 項目 A", // 6
  "  - 入れ子の項目", // 7
  "- 項目 B", // 8
  "", // 9
  "| 列 1 | 列 2 |", // 10
  "| --- | --- |", // 11
  "| セル a | セル b |", // 12
  "", // 13
  "> 引用の段落", // 14
  "", // 15
  "```ts", // 16
  "const a = 1;", // 17
  "```", // 18
].join("\n");

describe("the lines of the preview's blocks", () => {
  test("a point is on the lines of the innermost block it is in", async () => {
    const root = await mount(SOURCE, true);
    const lines = (words: string) => mdSourceLinesOf(textOf(root, words), root);
    expect(lines("見出し")).toEqual({ line: 1, endLine: 1 });
    expect(lines("段落の二行目")).toEqual({ line: 3, endLine: 4 });
    expect(lines("入れ子の項目")).toEqual({ line: 7, endLine: 7 });
    expect(lines("項目 B")).toEqual({ line: 8, endLine: 8 });
    expect(lines("セル b")).toEqual({ line: 12, endLine: 12 });
    expect(lines("列 1")).toEqual({ line: 10, endLine: 10 });
    expect(lines("引用の段落")).toEqual({ line: 14, endLine: 14 });
    // The code block drawn whole (before its coloring): the block's lines.
    expect(lines("const a")).toEqual({ line: 16, endLine: 18 });
  });

  test("a Timeline bubble's markdown carries no lines", async () => {
    const root = await mount(SOURCE, false);
    expect(root.querySelector("[data-md-line]")).toBeNull();
    expect(root.querySelector("[data-md-code-line]")).toBeNull();
    expect(mdSourceLinesOf(textOf(root, "段落の二行目"), root)).toBeNull();
  });

  test("in a code block drawn a line a line, a point is on its one line", () => {
    const root = document.createElement("div");
    const block = (first: number) => {
      const box = document.createElement("div");
      box.setAttribute("data-md-line", String(first));
      box.setAttribute("data-md-end-line", String(first + 4));
      box.setAttribute("data-md-code-line", String(first + 1));
      const code = document.createElement("code");
      for (const text of ["one\n", "two\n", "three"]) {
        const line = document.createElement("span");
        line.className = "md-code-line";
        line.append(text);
        code.append(line);
      }
      box.append(code);
      return box;
    };
    root.append(block(20));
    expect(mdSourceLinesOf(textOf(root, "one"), root)).toEqual({ line: 21, endLine: 21 });
    expect(mdSourceLinesOf(textOf(root, "three"), root)).toEqual({ line: 23, endLine: 23 });
    // Outside every block.
    const loose = document.createElement("p");
    loose.append("ばらの文");
    root.append(loose);
    expect(mdSourceLinesOf(textOf(root, "ばらの文"), root)).toBeNull();
  });

  test("an indented code block's first line is code", async () => {
    const root = await mount(["前の段落", "", "    indented();", "    more();"].join("\n"), true);
    const box = root.querySelector("[data-md-code-line]");
    expect(box?.getAttribute("data-md-code-line")).toBe("3");
    expect(box?.getAttribute("data-md-line")).toBe("3");
  });
});
