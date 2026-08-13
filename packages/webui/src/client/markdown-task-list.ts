/** GFM task-list toggling against the *source text* (kawaz r55, markdown
 * preview checkbox interaction).
 *
 * The preview renders from mdast, but a click has to write back to the file,
 * and the write reads that file fresh — so the tree the user clicked describes
 * a source that may already have moved. `position.start.offset` names a
 * character in the *rendered* source, which is exactly the coordinate that
 * goes stale, so it cannot be the write coordinate no matter how accurate it
 * is.
 *
 * So a click is turned into a **content anchor** (`anchorTaskLine`): the full
 * source text of the clicked item's line, plus the ordinal ("the Nth task
 * item in this document") it was rendered at. The write then re-locates that
 * line in a freshly-read source (`resolveTaskLine`) by *content* first and
 * ordinal only as a tie-breaker, so an unrelated edit elsewhere in the file —
 * an AI rewriting the paragraph above, which is routine for the arbitration
 * queue this feature exists to serve — moves the anchored line without
 * invalidating the click.
 *
 * Every way the anchor can fail to name exactly one still-unchanged line
 * (gone, changed, or several indistinguishable candidates) refuses the write
 * rather than picking one: writing the wrong line is a silent corruption of
 * the user's file, and is strictly worse than an error the user can retry.
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

/** What the user clicked, in terms that survive edits elsewhere in the file.
 *
 * `line` is the item's entire source line as rendered — it carries both the
 * item's identity (bullet, indent, text) and the state the preview was
 * showing, so re-locating it and verifying it is unchanged are the same
 * comparison. `ordinal` is only kept to break ties between lines that are
 * textually indistinguishable. */
export interface TaskAnchor {
  ordinal: number;
  line: string;
}

/** The anchored line with its state character normalized away: what makes two
 * source lines "the same task item in different states". Re-locating matches
 * on this, then compares the raw text, so an item whose box was flipped by
 * someone else is reported as a conflict on *that* item instead of quietly
 * re-locating onto a different item that happens to read identically. */
function taskIdentity(line: string): string | null {
  const m = TASK_LINE_RE.exec(line);
  if (!m) return null;
  const head = m[1]!;
  return head + " " + line.slice(head.length + 1);
}

/** Capture the clicked item as an anchor, or refuse.
 *
 * `expected` is the state the preview displayed. It is checked against the
 * source line the ordinal lands on: a mismatch means the render and the scan
 * disagree about the numbering (`taskStatesAlign` should have prevented
 * interaction entirely), so no anchor is produced. */
export function anchorTaskLine(
  source: string,
  ordinal: number,
  expected: boolean,
): TaskAnchor | null {
  const lineIndex = findTaskLines(source)[ordinal];
  if (lineIndex === undefined) return null;
  const line = source.split("\n")[lineIndex]!;
  const m = TASK_LINE_RE.exec(line);
  if (!m) return null; // unreachable: findTaskLines used the same test
  if ((m[2] !== " ") !== expected) return null;
  return { ordinal, line };
}

/** The same item's anchor as it reads *after* being toggled to `next` — what
 * re-anchors an optimistic UI update so it can be undone item-by-item.
 *
 * Undoing by restoring a whole-document snapshot would also undo any toggle
 * the user made in the meantime; anchoring the undo to the one item keeps
 * concurrent clicks independent. */
export function toggledAnchor(anchor: TaskAnchor, next: boolean): TaskAnchor {
  const head = TASK_LINE_RE.exec(anchor.line)![1]!;
  return {
    ordinal: anchor.ordinal,
    line: head + (next ? "x" : " ") + anchor.line.slice(head.length + 1),
  };
}

export type ResolveTaskResult =
  | { ok: true; lineIndex: number }
  /** No task line in the current source is the anchored item — it was deleted,
   * or edited beyond recognition. */
  | { ok: false; reason: "gone" }
  /** The anchored item is still there but its box no longer holds the state
   * the preview showed: someone else toggled exactly this item. */
  | { ok: false; reason: "conflict" }
  /** Several task lines are indistinguishable from the anchor and the ordinal
   * does not land on any of them, so which one the user clicked is unknowable.
   * QUESTIONS.md's `- [ ] a: …` option notation makes duplicates realistic. */
  | { ok: false; reason: "ambiguous" };

/** Find the anchored item in `source`, which may have been rewritten since the
 * anchor was taken.
 *
 * Matching is by content, not position, so edits to *other* lines — the ones
 * that make a whole-file lock reject an otherwise-valid click — are simply
 * invisible here: the anchored line keeps its identity wherever it moved to.
 * The ordinal is consulted only when content alone leaves a choice.
 */
export function resolveTaskLine(source: string, anchor: TaskAnchor): ResolveTaskResult {
  const identity = taskIdentity(anchor.line);
  if (identity === null) return { ok: false, reason: "gone" };

  const lines = source.split("\n");
  const taskLines = findTaskLines(source);
  const matches = taskLines.filter((i) => taskIdentity(lines[i]!) === identity);
  if (matches.length === 0) return { ok: false, reason: "gone" };

  let lineIndex: number;
  if (matches.length === 1) {
    lineIndex = matches[0]!;
  } else {
    // Duplicates: the render-time ordinal is the only remaining evidence, and
    // it is trustworthy only if it still lands on one of the candidates.
    const atOrdinal = taskLines[anchor.ordinal];
    if (atOrdinal === undefined || !matches.includes(atOrdinal)) {
      return { ok: false, reason: "ambiguous" };
    }
    lineIndex = atOrdinal;
  }

  // Identity matched, so this is the user's item; a raw-text mismatch can only
  // be the state character, i.e. a real concurrent toggle of this very item.
  if (lines[lineIndex] !== anchor.line) return { ok: false, reason: "conflict" };
  return { ok: true, lineIndex };
}

/** The ordinal the anchored item occupies in `source` *now* — the coordinate
 * the renderer numbers checkboxes by, so it is what attaches a message to the
 * item's own row on screen.
 *
 * The anchor's own `ordinal` is the one the click was rendered at and can be
 * stale by the time a failed write comes back, so it is re-derived from the
 * item's current position rather than trusted. `null` whenever the item can no
 * longer be named exactly (`resolveTaskLine`'s refusals), which is the caller's
 * signal that there is no row to point at.
 */
export function locateTaskOrdinal(source: string, anchor: TaskAnchor): number | null {
  const found = resolveTaskLine(source, anchor);
  if (!found.ok) return null;
  const ordinal = findTaskLines(source).indexOf(found.lineIndex);
  return ordinal < 0 ? null : ordinal;
}

export type ToggleTaskResult =
  | { ok: true; source: string }
  | { ok: false; reason: "gone" | "conflict" | "ambiguous" };

/**
 * Flip the anchored task item to `next`, rewriting only that line's single
 * state character and leaving every other byte — including the rest of the
 * anchored line, and the file's trailing-newline convention — exactly as
 * found.
 *
 * `source` is expected to be a *fresh* read rather than the one the preview
 * was rendered from: that is what lets an unrelated concurrent edit pass
 * through instead of blocking the user's click. The daemon's
 * `expected_mtime`/`expected_size` lock, taken from that same fresh read,
 * remains the backstop for anything that lands between the read and the write.
 */
export function toggleTaskLine(
  source: string,
  anchor: TaskAnchor,
  next: boolean,
): ToggleTaskResult {
  const found = resolveTaskLine(source, anchor);
  if (!found.ok) return found;

  const lines = source.split("\n");
  const line = lines[found.lineIndex]!;
  const head = TASK_LINE_RE.exec(line)![1]!;
  lines[found.lineIndex] = head + (next ? "x" : " ") + line.slice(head.length + 1);
  return { ok: true, source: lines.join("\n") };
}
