// 編集領域の増分トークン化 (editor-syntax.ts、DR-0051 §3): 編集のたびに変わった
// 行の片から作り直し、文法の状態が前回と一致した所で打ち切る。結果は本文を
// 最初から全部トークン化したものと同じでなければならない。
import { beforeAll, describe, expect, test } from "bun:test";
import type { GrammarState } from "shiki/core";
import {
  grammarStatesEqual,
  loadBlockTokenizer,
  type BlockTokenizer,
  type SyntaxToken,
} from "../src/client/highlight.ts";
import {
  IncrementalSyntax,
  lineStartOffsets,
  visibleLineRange,
  type SyntaxEngine,
} from "../src/client/editor-syntax.ts";
import { defined } from "./helpers.ts";

let tokenize: BlockTokenizer;
beforeAll(async () => {
  tokenize = defined(await loadBlockTokenizer("tsx"), "the tsx tokenizer");
  // bun 1.4.2 では、プロセスで最初の 2 テーマのトークン化だけ light の色が
  // 途中から変わる (同じコードの 2 回目以降と違う)。node と Chromium / WebKit
  // では起きない。比べる 2 つの結果の片方だけがこれを踏まないよう、先に 1 回
  // 捨てるトークン化をしておく。
  tokenize(SAMPLE, undefined);
});

/** 片をトークン化した回数と行数を数える engine */
function countingEngine(): { engine: SyntaxEngine<GrammarState>; lines: () => number } {
  let lines = 0;
  return {
    engine: {
      tokenize: (code, state) => {
        lines += code.split("\n").length;
        return tokenize(code, state);
      },
      statesEqual: grammarStatesEqual,
    },
    lines: () => lines,
  };
}

/** 全行を済ませた後の、本文の先頭からの位置に直したトークン */
function absoluteTokens(syntax: IncrementalSyntax<GrammarState>): string[] {
  const starts = lineStartOffsets(syntax.lines);
  return syntax.blocksIn(0, syntax.lines.length).flatMap((block) =>
    block.tokens.map((token: SyntaxToken) => {
      const base = defined(starts[block.start], "the block's first line");
      return `${base + token.start}-${base + token.end}:${token.paint.light}/${token.paint.dark}`;
    }),
  );
}

function fullyTokenized(text: string): string[] {
  const syntax = new IncrementalSyntax<GrammarState>({ tokenize, statesEqual: grammarStatesEqual });
  syntax.reset(text);
  syntax.runWhile(() => true);
  return absoluteTokens(syntax);
}

const SAMPLE = Array.from(
  { length: 120 },
  (_, i) => `export const value${i} = compute(${i}, "label ${i}"); // item ${i}`,
).join("\n");

function at(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`${needle} not in the text`);
  return index;
}

describe("増分トークン化は全体のトークン化と一致する", () => {
  // 編集の種類ごと: 1 文字・改行・行の削除・先頭や末尾・後ろ全体の状態を変える
  // コメントの開閉・複数行の貼り付け
  const edits: [string, (text: string) => string][] = [
    ["行の中ほどに 1 文字", (t) => t.slice(0, at(t, "value50")) + "x" + t.slice(at(t, "value50"))],
    [
      "行の中ほどで改行",
      (t) => t.slice(0, at(t, "compute(60")) + "\n" + t.slice(at(t, "compute(60")),
    ],
    ["先頭に 1 行足す", (t) => `import { a } from "b";\n${t}`],
    ["末尾に 1 行足す", (t) => `${t}\nconst tail = 1;`],
    [
      "10 行消す",
      (t) => t.slice(0, at(t, "export const value30")) + t.slice(at(t, "export const value40")),
    ],
    [
      "/* を開いて閉じない (後ろ全部がコメントになる)",
      (t) =>
        t.slice(0, at(t, "export const value10")) + "/* " + t.slice(at(t, "export const value10")),
    ],
    [
      "文字列を閉じない",
      (t) =>
        t.slice(0, at(t, "export const value70")) +
        "const s = `" +
        t.slice(at(t, "export const value70")),
    ],
    [
      "複数行の貼り付け",
      (t) =>
        t.slice(0, at(t, "export const value90")) +
        "function f() {\n  return 1;\n}\n" +
        t.slice(at(t, "export const value90")),
    ],
    ["全部消す", () => ""],
  ];

  test.each(edits)("%s", (_label, edit) => {
    const syntax = new IncrementalSyntax<GrammarState>({
      tokenize,
      statesEqual: grammarStatesEqual,
    });
    syntax.reset(SAMPLE);
    syntax.runWhile(() => true);
    const edited = edit(SAMPLE);
    syntax.edit(edited);
    syntax.runWhile(() => true);
    expect(absoluteTokens(syntax)).toEqual(fullyTokenized(edited));
  });

  test("編集を続けて重ねても一致する (途中で後ろの行が済んでいなくても)", () => {
    const syntax = new IncrementalSyntax<GrammarState>({
      tokenize,
      statesEqual: grammarStatesEqual,
    });
    syntax.reset(SAMPLE);
    syntax.runWhile(() => true);
    // コメントを開いて、後ろが済む前に別の所を編集し、コメントを閉じる
    let text =
      SAMPLE.slice(0, at(SAMPLE, "export const value10")) +
      "/* " +
      SAMPLE.slice(at(SAMPLE, "export const value10"));
    syntax.edit(text);
    syntax.runUntil(20, () => true);
    text = text.slice(0, at(text, "value100")) + "y" + text.slice(at(text, "value100"));
    syntax.edit(text);
    syntax.runUntil(30, () => true);
    text =
      text.slice(0, at(text, "export const value40")) +
      "*/ " +
      text.slice(at(text, "export const value40"));
    syntax.edit(text);
    syntax.runWhile(() => true);
    expect(absoluteTokens(syntax)).toEqual(fullyTokenized(text));
  });
});

describe("作り直す範囲", () => {
  test("1 文字の編集は、その行の片だけを作り直して後ろは使い回す", () => {
    const { engine, lines } = countingEngine();
    const syntax = new IncrementalSyntax(engine, 10);
    syntax.reset(SAMPLE);
    syntax.runWhile(() => true);
    const before = lines();
    syntax.edit(SAMPLE.replace("value55 =", "value55x ="));
    syntax.runWhile(() => true);
    expect(lines() - before).toBe(10);
  });

  test("文法の状態が変わり続ける編集は、変わった所から末尾まで作り直す", () => {
    const { engine, lines } = countingEngine();
    const syntax = new IncrementalSyntax(engine, 10);
    syntax.reset(SAMPLE);
    syntax.runWhile(() => true);
    const before = lines();
    syntax.edit(`/* ${SAMPLE}`);
    syntax.runWhile(() => true);
    expect(lines() - before).toBe(120);
  });

  test("runUntil は指定の行まで済ませて止まり、残りは pending のまま", () => {
    const syntax = new IncrementalSyntax<GrammarState>(
      { tokenize, statesEqual: grammarStatesEqual },
      10,
    );
    syntax.reset(SAMPLE);
    syntax.runUntil(25, () => true);
    expect(syntax.pending).toBe(true);
    expect(syntax.blocksIn(0, 120).map((block) => block.start)).toEqual([0, 10, 20]);
  });

  test("済んでいない行は前回の結果で塗れる (後ろ全体が変わる編集の直後)", () => {
    const syntax = new IncrementalSyntax<GrammarState>(
      { tokenize, statesEqual: grammarStatesEqual },
      10,
    );
    syntax.reset(SAMPLE);
    syntax.runWhile(() => true);
    const lastBlockBefore = defined(syntax.blocksIn(110, 120)[0], "the last block");
    syntax.edit(`/* ${SAMPLE}`);
    syntax.runUntil(10, () => true);
    const lastBlockNow = defined(syntax.blocksIn(110, 120)[0], "the last block");
    expect(lastBlockNow.tokens).toBe(lastBlockBefore.tokens);
  });

  test("keepGoing が偽になったら途中でも止まる (時間の上限)", () => {
    const { engine, lines } = countingEngine();
    const syntax = new IncrementalSyntax(engine, 10);
    syntax.reset(SAMPLE);
    let budget = 3;
    syntax.runWhile(() => budget-- > 0);
    expect(lines()).toBe(30);
    expect(syntax.pending).toBe(true);
  });
});

describe("visibleLineRange", () => {
  test("表示中の行に前後の余白を足す", () => {
    expect(
      visibleLineRange({
        scrollTop: 400,
        clientHeight: 200,
        paddingTop: 0,
        lineHeight: 20,
        lineCount: 1000,
        margin: 5,
      }),
    ).toEqual([15, 35]);
  });

  test("先頭と末尾で行の範囲に収める", () => {
    expect(
      visibleLineRange({
        scrollTop: 0,
        clientHeight: 200,
        paddingTop: 10,
        lineHeight: 20,
        lineCount: 8,
        margin: 20,
      }),
    ).toEqual([0, 8]);
  });

  test("行の高さや表示の高さが取れない時は全行", () => {
    expect(
      visibleLineRange({
        scrollTop: 0,
        clientHeight: 0,
        paddingTop: 0,
        lineHeight: Number.NaN,
        lineCount: 50,
        margin: 20,
      }),
    ).toEqual([0, 50]);
  });
});
