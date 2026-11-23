// A quote a comment is made on inside a Timeline bubble (DR-0062 §2): the
// text chosen out of what the bubble draws, the characters around it, and
// finding it again in what is drawn now; and where the 💬 of a choice goes
// (§3).
//
// The text a bubble draws is the joined text of its drawn text, a line break
// between blocks (comment-quotes.tsx reads it out of the DOM). Offsets into
// it are hints only: a translation, a change of the markdown drawing or of
// the width changes the text, so a quote is found again by its characters.
//
// Pure, per DR-0005 §1, as comment-view.ts beside it.

/** How many characters before and after a choice a quote keeps: what the
 * block carries (`before` / `after`, DR-0062 §4), spaces folded. */
const AROUND_LENGTH = 30;

/** A choice made in a bubble's drawn text: the text chosen, the characters
 * around it (spaces folded, at most `AROUND_LENGTH` each), and where it is
 * in the drawn text. */
export interface QuoteChoice {
  text: string;
  before: string;
  after: string;
  start: number;
  end: number;
}

/** What a quote is found again by: its text, the characters around it, and
 * where it was (a hint). */
export interface QuoteKept {
  text: string;
  before?: string | undefined;
  after?: string | undefined;
  start?: number | undefined;
}

/** `text`'s characters as one sees them (a letter with its marks, an emoji
 * of several code points, is one). */
function charactersOf(text: string): string[] {
  return Array.from(new Intl.Segmenter().segment(text), (part) => part.segment);
}

function foldSpaces(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The choice of `start`..`end` in `drawn`, its spaces at either end left
 * out. Null when nothing but spaces is chosen. */
export function choiceIn(drawn: string, start: number, end: number): QuoteChoice | null {
  let from = Math.max(0, Math.min(start, end));
  let to = Math.min(drawn.length, Math.max(start, end));
  while (from < to && /\s/.test(drawn.charAt(from))) from += 1;
  while (to > from && /\s/.test(drawn.charAt(to - 1))) to -= 1;
  if (from === to) return null;
  return {
    text: drawn.slice(from, to),
    // The spaces at the ends of what is drawn are not characters around it.
    before: charactersOf(foldSpaces(drawn.slice(0, from)).trimStart())
      .slice(-AROUND_LENGTH)
      .join(""),
    after: charactersOf(foldSpaces(drawn.slice(to)).trimEnd())
      .slice(0, AROUND_LENGTH)
      .join(""),
    start: from,
    end: to,
  };
}

/** `text` without its spaces, and where each character left was in it. */
function withoutSpaces(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (/\s/.test(char)) continue;
    out += char;
    at.push(i);
  }
  return { text: out, at };
}

function indexesOf(text: string, part: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
}

/** Where `quote` is in `drawn` now (DR-0062 §2, P20), spaces and line breaks
 * not counted (the drawing joins and breaks lines its own way): where its
 * text stands between the characters it stood between, or, when those
 * changed, where its text alone stands if it stands in one place only. Of
 * several places, the nearest to where it was. Null when it is nowhere, or
 * its text alone is in several places. */
export function findQuote(drawn: string, quote: QuoteKept): { start: number; end: number } | null {
  const hay = withoutSpaces(drawn);
  const text = withoutSpaces(quote.text).text;
  if (text === "") return null;
  const before = withoutSpaces(quote.before ?? "").text;
  const after = withoutSpaces(quote.after ?? "").text;
  let places = indexesOf(hay.text, before + text + after).map((at) => at + before.length);
  if (places.length === 0) {
    places = indexesOf(hay.text, text);
    if (places.length !== 1) return null;
  }
  const near = quote.start;
  const startOf = (place: number): number => hay.at[place] ?? 0;
  const place =
    near === undefined
      ? places[0]
      : places.reduce((best, at) =>
          Math.abs(startOf(at) - near) < Math.abs(startOf(best) - near) ? at : best,
        );
  if (place === undefined) return null;
  const last = hay.at[place + text.length - 1];
  if (last === undefined) return null;
  return { start: startOf(place), end: last + 1 };
}

/** A box on the page, as getBoundingClientRect gives it. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The gap between a bubble and the 💬 put at its left. */
const LEFT_GAP = 4;

/** Where the 💬 of a choice goes (DR-0062 §3, kawaz 2026-11-23): outside the
 * bubble, at the middle of the choice's height, so that the system's menu of
 * the choice (above or below it) and the handles at its ends do not cover
 * it. Its column is the band at the right of the item (where its 「jsonl ☆」
 * are) when the button fits between the bubble and the item's right end;
 * else, when it fits at the bubble's left (a bubble on the person's side),
 * just left of the bubble; else (no room either side) the right end of the
 * item, over the bubble. Of a choice taller than what is seen, the middle of
 * what is seen of it. What is in the way in that column (`avoid`: what
 * floats over the Timeline) is not covered: the button goes to the nearest
 * place free of it, off the choice's middle if need be. The item's top right
 * controls (「jsonl ☆」, `under`) are not covered either, and the button
 * stays below them (not up in the item before). Null when none of the choice
 * is seen, or no place is free.
 * `size` is the buttons' width, `height` their height (the side of one
 * button when absent): the 💬 and the btw stand one above the other. */
export function choiceButtonPlace(input: {
  choice: readonly Box[];
  item: Box;
  bubble: Box;
  seen: Box;
  avoid?: readonly Box[];
  under?: readonly Box[];
  size: number;
  height?: number;
}): { left: number; top: number } | null {
  const { choice, item, bubble, seen, size } = input;
  const height = input.height ?? size;
  if (choice.length === 0) return null;
  const top = Math.max(Math.min(...choice.map((box) => box.top)), seen.top);
  const bottom = Math.min(Math.max(...choice.map((box) => box.bottom)), seen.bottom);
  if (bottom <= top) return null;
  const rightRoom = item.right - bubble.right;
  const leftRoom = bubble.left - item.left;
  const left =
    rightRoom >= size || leftRoom < size + LEFT_GAP
      ? item.right - size
      : bubble.left - LEFT_GAP - size;
  // The stretches of the column's height free of what is in the way.
  const blocked = [
    ...(input.avoid ?? []),
    // Field by field: a DOMRect's fields are its prototype's, not its own.
    ...(input.under ?? []).map((box) => ({
      top: Number.NEGATIVE_INFINITY,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
    })),
  ]
    .filter((box) => box.left < left + size && box.right > left && box.bottom > box.top)
    .toSorted((a, b) => a.top - b.top);
  const free: Array<{ from: number; to: number }> = [];
  let from = seen.top;
  for (const box of blocked) {
    if (box.top > from) free.push({ from, to: Math.min(box.top, seen.bottom) });
    from = Math.max(from, box.bottom);
  }
  if (from < seen.bottom) free.push({ from, to: seen.bottom });
  const want = (top + bottom) / 2 - height / 2;
  let best: number | null = null;
  for (const stretch of free) {
    if (stretch.to - stretch.from < height) continue;
    const at = Math.min(Math.max(want, stretch.from), stretch.to - height);
    if (best === null || Math.abs(at - want) < Math.abs(best - want)) best = at;
  }
  return best === null ? null : { left, top: best };
}
