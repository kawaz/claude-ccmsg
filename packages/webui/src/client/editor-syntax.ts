// 編集領域の増分トークン化 (DR-0051 §3)。
//
// 本文を一定行数の片 (ブロック) に分け、片ごとに「前の片の終わりの文法の
// 状態」から続けてトークン化した結果を持つ。編集があったら、変わった最初の行を
// 含む片からトークン化し直し、変更範囲より後ろで前回の片の境目に着地して文法の
// 状態が前回と同じなら、そこから後ろは前回の結果を使い回して打ち切る。
//
// トークン化し直しを一度に全部はやらない。呼び出し側が時間を区切って、表示中
// の行までを先に (`runUntil`)、残りを後から (`runWhile`) 進める。文法の状態は
// 前の行から順にしか決まらないので、先に済ませられるのは「表示中の行まで」で
// あって「表示中の行だけ」ではない。まだ済んでいない行は前回の結果 (残り片) で
// 塗るので、コメントを閉じる `*/` を消した直後のように後ろ全体が変わる時も、
// 後ろの行は古い色のまま順に塗り替わる。
//
// 文法の状態の型 S と、トークン化・状態の比較は外から渡す (本番は
// highlight.ts の `loadBlockTokenizer` / `grammarStatesEqual`)。
import type { SyntaxToken } from "./highlight.ts";

/** 片 1 つの行数。小さいほど 1 打鍵で作り直す行が減り、片ごとの呼び出しの
 * 手間が増える。10 行で 1 打鍵あたりのトークン化が 5000 行のファイルでも数 ms
 * (DR-0051 §2)。 */
export const SYNTAX_BLOCK_LINES = 10;

export interface SyntaxEngine<S> {
  tokenize(
    code: string,
    startState: S | undefined,
  ): { tokens: SyntaxToken[]; endState: S | undefined };
  statesEqual(a: S | undefined, b: S | undefined): boolean;
}

/** 片 1 つ分のトークン。`tokens` の offset は片の先頭の行の頭からの位置。 */
export interface SyntaxBlock<S> {
  /** 先頭の行の番号 (0 始まり) */
  start: number;
  lineCount: number;
  startState: S | undefined;
  endState: S | undefined;
  tokens: SyntaxToken[];
}

function splitEditorLines(text: string): string[] {
  return text.split("\n");
}

export class IncrementalSyntax<S> {
  readonly #engine: SyntaxEngine<S>;
  readonly #blockLines: number;
  #lines: string[] = [];
  /** 行 [0, #cursor) をトークン化し終えた片。隙間なく並ぶ。 */
  #done: SyntaxBlock<S>[] = [];
  #cursor = 0;
  /** 前回の結果のうち、まだ使えるか確かめていない片 (今の行番号に読み替え
   * 済み)。#cursor より後ろにあり、行の中身は変わっていない。 */
  #rest: SyntaxBlock<S>[] = [];

  constructor(engine: SyntaxEngine<S>, blockLines: number = SYNTAX_BLOCK_LINES) {
    this.#engine = engine;
    this.#blockLines = blockLines;
  }

  get lines(): readonly string[] {
    return this.#lines;
  }

  /** トークン化し直す行が残っているか */
  get pending(): boolean {
    return this.#cursor < this.#lines.length;
  }

  /** 本文を丸ごと入れ替える (前回の結果は捨てる)。 */
  reset(text: string): void {
    this.#lines = splitEditorLines(text);
    this.#done = [];
    this.#cursor = 0;
    this.#rest = [];
  }

  /** 編集後の本文を渡す。変わった行より後ろの前回の結果は、使い回せるかを
   * 後で確かめる候補として残す。 */
  edit(text: string): void {
    const next = splitEditorLines(text);
    const prev = this.#lines;
    const common = Math.min(next.length, prev.length);
    let first = 0;
    while (first < common && next[first] === prev[first]) first += 1;
    if (first === next.length && next.length === prev.length) return;
    let suffix = 0;
    while (
      suffix < common - first &&
      next[next.length - 1 - suffix] === prev[prev.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const delta = next.length - prev.length;
    const prevChangedEnd = prev.length - suffix;

    let kept = 0;
    while (kept < this.#done.length) {
      const block = this.#done[kept];
      if (block === undefined || block.start + block.lineCount > first) break;
      kept += 1;
    }
    const candidates = [...this.#done.slice(kept), ...this.#rest]
      .filter((block) => block.start >= prevChangedEnd)
      .map((block) => ({ ...block, start: block.start + delta }));

    this.#lines = next;
    this.#done = this.#done.slice(0, kept);
    const last = this.#done.at(-1);
    this.#cursor = last === undefined ? 0 : last.start + last.lineCount;
    this.#rest = candidates;
  }

  /** `line` 行目より前を済ませるまで、`keepGoing()` が真の間進める
   * (表示中の行を先に塗るため)。 */
  runUntil(line: number, keepGoing: () => boolean): void {
    while (this.pending && this.#cursor < line && keepGoing()) this.#advance();
  }

  /** `keepGoing()` が真の間進める (時間を区切った残りの処理)。 */
  runWhile(keepGoing: () => boolean): void {
    while (this.pending && keepGoing()) this.#advance();
  }

  /** 行 [firstLine, endLine) に掛かる片。済んだ片と、まだ確かめていない
   * 前回の片の両方を返す (後者は古い色で塗るため)。 */
  blocksIn(firstLine: number, endLine: number): SyntaxBlock<S>[] {
    const overlaps = (block: SyntaxBlock<S>) =>
      block.start < endLine && block.start + block.lineCount > firstLine;
    return [...this.#done.filter(overlaps), ...this.#rest.filter(overlaps)];
  }

  #advance(): void {
    while (this.#rest[0] !== undefined && this.#rest[0].start < this.#cursor) this.#rest.shift();
    const startState = this.#done.at(-1)?.endState;
    const next = this.#rest[0];
    if (
      next !== undefined &&
      next.start === this.#cursor &&
      this.#engine.statesEqual(startState, next.startState)
    ) {
      // 前回の片の頭で文法の状態が一致した: そこから続く前回の片は全部使える。
      // 続いている (前の片の終わりの状態をそのまま次が受け継いでいる) 間だけ取る。
      let previous: SyntaxBlock<S> | undefined;
      while (this.#rest[0] !== undefined) {
        const block = this.#rest[0];
        if (
          previous !== undefined &&
          (block.start !== previous.start + previous.lineCount ||
            block.startState !== previous.endState)
        ) {
          break;
        }
        this.#done.push(block);
        this.#rest.shift();
        previous = block;
      }
      const last = this.#done.at(-1);
      this.#cursor = last === undefined ? 0 : last.start + last.lineCount;
      return;
    }
    let count = Math.min(this.#blockLines, this.#lines.length - this.#cursor);
    // 前回の片の頭にちょうど着地するように切る (着地しないと使い回せない)
    if (next !== undefined && next.start > this.#cursor)
      count = Math.min(count, next.start - this.#cursor);
    const code = this.#lines.slice(this.#cursor, this.#cursor + count).join("\n");
    const { tokens, endState } = this.#engine.tokenize(code, startState);
    this.#done.push({ start: this.#cursor, lineCount: count, startState, endState, tokens });
    this.#cursor += count;
    // 済んだ行に重なった前回の片は捨てる (塗る時に済んだ片と二重にしない)
    while (this.#rest[0] !== undefined && this.#rest[0].start < this.#cursor) this.#rest.shift();
  }
}

/** 各行の頭の位置 (本文の先頭からの UTF-16 offset)。 */
export function lineStartOffsets(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/** 表示中の行の範囲 [first, end) に前後 `margin` 行を足したもの。行の高さが
 * 取れない (レイアウトが無い) 時は全行。 */
export function visibleLineRange(view: {
  scrollTop: number;
  clientHeight: number;
  paddingTop: number;
  lineHeight: number;
  lineCount: number;
  margin: number;
}): [number, number] {
  const { scrollTop, clientHeight, paddingTop, lineHeight, lineCount, margin } = view;
  if (!(lineHeight > 0) || !(clientHeight > 0)) return [0, lineCount];
  const first = Math.floor((scrollTop - paddingTop) / lineHeight) - margin;
  const end = Math.ceil((scrollTop - paddingTop + clientHeight) / lineHeight) + margin;
  return [Math.max(0, first), Math.min(lineCount, Math.max(0, end))];
}
