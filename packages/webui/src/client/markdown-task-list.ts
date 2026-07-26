/** GFM task-list toggling against the *source text* (kawaz r55, markdown
 * preview checkbox interaction).
 *
 * The preview renders from mdast, but a click has to write back to the file,
 * and mdast cannot say which source characters to touch: `@mizchi/markdown`
 * reports `position.start.offset` in **code points**, not UTF-16 units (a
 * document containing an astral char — `👺`, which QUESTIONS.md uses for
 * every arbitration marker — shifts every later offset), and list items
 * inside a blockquote come back with `offset: 0`. Both were confirmed against
 * the real parser, so offsets are unusable as write coordinates here.
 *
 * Instead the click carries an **ordinal**: "the Nth task item in this
 * document". `findTaskLines` recomputes that same ordering straight from the
 * source, and `toggleTaskLine` additionally refuses to write unless the line
 * it lands on currently holds the state the UI was displaying — so an
 * ordinal that drifted (renderer and scanner disagreeing about what counts
 * as a task item) fails closed instead of flipping an unrelated line.
 */

/** A task-list line: any blockquote prefix (`>` runs, which the parser
 * descends into and counts), optional indent, a bullet (`-`/`*`/`+`) or an
 * ordered marker (`1.`/`1)`), whitespace, then `[ ]`/`[x]`/`[X]`, then either
 * end of line or a space. The trailing `(?= |$)` mirrors the parser, which
 * declines `- [ ]a` (no separating space) but accepts a bare `- [ ]`. A tab
 * after the bracket is likewise declined by the parser, so `[ \t]` is
 * deliberately not used there.
 *
 * Groups: 1 = everything up to and including `[`, 2 = the state character. */
const TASK_LINE_RE = /^((?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\](?= |$)/;

/** Fence opener/closer for the code regions the scan must skip: a ``` or ~~~
 * run, optionally indented, matching CommonMark's "closer must be at least as
 * long and of the same character" rule. Skipping these is what keeps the
 * scanner's ordering identical to the parser's — a `- [ ] x` written inside a
 * ```markdown example (QUESTIONS.md's template section does exactly this) is
 * code to the parser and must not consume an ordinal. */
const FENCE_RE = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(`{3,}|~{3,})/;

/** Source line indices (0-based) of every task-list item, in document order.
 *
 * This is a line scanner, not a block parser, so it cannot always agree with
 * the real parser: whether a 4-space-indented `- [ ] x` is an indented code
 * block or a nested list item depends on the enclosing block context, which
 * only a full parse resolves. `taskStatesAlign` below is how that gap is made
 * safe — the caller compares this scan against the parsed tree and only
 * offers interaction when the two agree exactly. */
export function findTaskLines(source: string): number[] {
  const lines = source.split("\n");
  const out: number[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]!.length >= fence.length && fenceMatch[1]![0] === fence[0]) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    if (TASK_LINE_RE.test(line)) out.push(i);
  }
  return out;
}

/** The checked state of each task line the scanner found, in document order.
 * Compared against the parser's own sequence by `taskStatesAlign`. */
export function scanTaskStates(source: string): boolean[] {
  const lines = source.split("\n");
  return findTaskLines(source).map((i) => TASK_LINE_RE.exec(lines[i]!)![2] !== " ");
}

/** True when the line scan and the parsed tree see the same task items in the
 * same order with the same states — the precondition for treating an ordinal
 * as a shared coordinate between the render and the write.
 *
 * Documents where they disagree (indented-code ambiguity, or any future
 * parser divergence) simply render as today: no interactive checkboxes. That
 * is the fail-closed direction — the alternative, trusting an ordinal the two
 * sides number differently, would flip the wrong line in the user's file. */
export function taskStatesAlign(scanned: readonly boolean[], parsed: readonly boolean[]): boolean {
  return scanned.length === parsed.length && scanned.every((v, i) => v === parsed[i]);
}

export type ToggleTaskResult =
  | { ok: true; source: string }
  /** The ordinal names no line, or the line it names is not in the state the
   * preview was showing — the source moved under the render. */
  | { ok: false; reason: "stale" };

/**
 * Flip the `ordinal`-th task item to `next`, rewriting only that line's single
 * state character and leaving every other byte — including the rest of the
 * clicked line, and the file's trailing-newline convention — exactly as found.
 *
 * `expected` is the checked state the preview displayed for that item; a
 * mismatch means the file changed (or the ordinals drifted) since it was
 * rendered, and the write is refused rather than applied to whatever is there
 * now. The daemon's `expected_mtime`/`expected_size` lock catches the same
 * class of race one layer down; this check is what keeps a *self-consistent
 * but differently-parsed* document from being silently mis-edited.
 */
export function toggleTaskLine(
  source: string,
  ordinal: number,
  expected: boolean,
  next: boolean,
): ToggleTaskResult {
  const taskLines = findTaskLines(source);
  const lineIndex = taskLines[ordinal];
  if (lineIndex === undefined) return { ok: false, reason: "stale" };

  const lines = source.split("\n");
  const line = lines[lineIndex]!;
  const m = TASK_LINE_RE.exec(line);
  if (!m) return { ok: false, reason: "stale" }; // unreachable: findTaskLines used the same test
  const current = m[2] !== " ";
  if (current !== expected) return { ok: false, reason: "stale" };

  const head = m[1]!;
  lines[lineIndex] = head + (next ? "x" : " ") + line.slice(head.length + 1);
  return { ok: true, source: lines.join("\n") };
}
