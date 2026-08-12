// In-view keyword search (DR-0022) — pure query-parsing / match-enumeration /
// index-navigation layer, kept free of preact/DOM so it's unit-testable in
// isolation (same split as transcript-model.ts's fold logic vs Timeline.tsx's
// rendering). Timeline.tsx and FileViewer.tsx both consume this module: the
// former maps it over Segment text, the latter over file lines.

import {
  parseSearchQueryPatterns,
  type SearchQueryOptions,
  type SearchQueryPattern,
} from "@ccmsg/protocol";

/** Number of distinct highlight colors in the palette. */
export const SEARCH_PALETTE_SIZE = 6;

export interface SearchWord extends SearchQueryPattern {
  readonly clauseIndex: number;
  readonly colorIndex: number;
}

export interface ParsedSearchQuery {
  readonly words: SearchWord[];
  readonly hasError: boolean;
}

/** Adds UI-only clause and palette metadata to the shared parsed structure. */
export function parseSearchQuery(text: string, opts: SearchQueryOptions): ParsedSearchQuery {
  const parsed = parseSearchQueryPatterns(text, opts);
  return {
    words: parsed.clauses.flatMap((clause, clauseIndex) =>
      clause.map((pattern) => ({
        ...pattern,
        clauseIndex,
        colorIndex: clauseIndex % SEARCH_PALETTE_SIZE,
      })),
    ),
    hasError: parsed.hasError,
  };
}

// A fresh RegExp per call (never reused/mutated) so lastIndex state from one
// caller's matchAll-style loop can never bleed into another's `test()` — see
// the DR-0022 §3 "regex 安全 compile" note; this is the safety half of it.
function wordRegExp(word: SearchWord, global: boolean): RegExp {
  return new RegExp(word.source, global ? `${word.flags}g` : word.flags);
}

/** Matches when at least one clause (= query line) has all of its AND terms
 * present. Callers gate on `!hasError` while the user is editing an invalid
 * regular expression; an errored term is dropped from its clause rather than
 * failing it, so the other clauses stay usable mid-edit (in plain mode a term
 * can never error, and in regex mode a clause holds exactly one term, so a
 * dropped term always empties its clause instead of weakening an AND). */
export function unitMatchesQuery(text: string, words: readonly SearchWord[]): boolean {
  const clauses = new Map<number, SearchWord[]>();
  for (const word of words) {
    if (word.error !== null) continue;
    const clause = clauses.get(word.clauseIndex);
    if (clause) clause.push(word);
    else clauses.set(word.clauseIndex, [word]);
  }
  if (clauses.size === 0) return false;
  return [...clauses.values()].some((clause) =>
    clause.every((word) => wordRegExp(word, false).test(text)),
  );
}

/** One searchable unit as the model sees it: the stable key its rendered
 * counterpart registers under, plus the texts that decide whether it matches.
 * Carrying the texts here is what keeps "M" independent of what is mounted —
 * the render layer's job is decoration, not counting.
 *
 * `texts` holds every spelling of the same content the reader could plausibly
 * be searching for, and a unit qualifies when any one of them satisfies the
 * query. Usually that is a single string; a thinking segment whose display has
 * been swapped for its Japanese translation carries both, so either spelling
 * counts (the alternative — counting only the transcript's original — makes a
 * query typed off the screen find nothing). AND terms must still be satisfied
 * within one text: a term from the original and a term from the translation do
 * not combine into a match. */
export interface SearchUnit {
  readonly key: string;
  readonly texts: readonly string[];
}

/** Whether any of the unit's spellings satisfies the query. */
export function unitMatches(unit: SearchUnit, words: readonly SearchWord[]): boolean {
  return unit.texts.some((text) => unitMatchesQuery(text, words));
}

/** Whitespace carries no query meaning here and does not survive markdown
 * rendering intact (a paragraph's newlines become element boundaries), so
 * comparing rendered text to source text is only meaningful without it. */
function condensed(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Long enough that finding it in the rendered text means the passage really
 * is the one on screen, rather than a stray character coincidence. */
const SHOWN_PARAGRAPH_MIN_LENGTH = 8;

/** Whether the rendered text carries one of the unit's alternate spellings —
 * i.e. what the reader is looking at is that substituted text, not merely the
 * unit's summary line above a collapsed body. Paragraph-wise because a
 * translation lands one paragraph at a time, so a half-translated block is
 * still legitimately "shown". */
function showsAlternateSpelling(unit: SearchUnit, visibleText: string): boolean {
  const visible = condensed(visibleText);
  return unit.texts.slice(1).some((text) =>
    text.split("\n\n").some((paragraph) => {
      const needle = condensed(paragraph);
      return needle.length >= SHOWN_PARAGRAPH_MIN_LENGTH && visible.includes(needle);
    }),
  );
}

/**
 * The 📁-off ("only what is on screen") verdict for one mounted unit, given
 * the text a reader can actually see inside it.
 *
 * The visible text is the question being asked, so it stays the primary input,
 * and a unit with a single spelling is decided by it alone — exactly as
 * before. A unit that renders a substituted spelling (a translated thinking
 * segment) is the exception: what is on screen is the translation, so a query
 * in the original finds nothing there even though the reader is looking
 * straight at the passage it names. Once the rendered text shows that
 * substituted spelling, both of the unit's spellings answer for it.
 */
export function unitMatchesOnScreen(
  unit: SearchUnit,
  visibleText: string,
  words: readonly SearchWord[],
): boolean {
  if (unitMatchesQuery(visibleText, words)) return true;
  if (unit.texts.length <= 1) return false;
  return showsAlternateSpelling(unit, visibleText) && unitMatches(unit, words);
}

/**
 * Keys of every unit matching `words`, in the order given. This is the "M" in
 * "[N/M]" and the sequence ↑/↓ walks, computed without consulting the DOM:
 * a unit counts because the transcript contains it, not because it happens to
 * be mounted or its fold happens to be open.
 *
 * Returns an empty list for an absent or wholly invalid query so callers can
 * render the counter unconditionally.
 */
export function matchingUnitKeysOf(
  units: readonly SearchUnit[],
  words: readonly SearchWord[],
): string[] {
  if (words.length === 0) return [];
  const keys: string[] = [];
  for (const unit of units) {
    if (unitMatches(unit, words)) keys.push(unit.key);
  }
  return keys;
}

export interface HighlightRange {
  start: number;
  end: number;
  colorIndex: number;
}

/**
 * Enumerates every word's matches in `text` and resolves overlaps into a
 * single non-overlapping, sorted list. Highlight colors are assigned per query
 * line, so all AND terms from the same line share a color. A qualifying unit
 * shows every term that appears in its text.
 *
 * Overlap resolution (DR text doesn't specify — the words are
 * documented as independent patterns, not "must not overlap", so two
 * words CAN legitimately match overlapping spans, e.g. "foo" and "oo"):
 * sorted by start ascending, ties broken by longer match first, then kept
 * greedily skipping any range that starts before the previous kept range's
 * end. This avoids ever needing nested <mark> elements while still showing
 * one color per overlapping region (the earlier/longer match wins) rather
 * than silently dropping the union of the shorter one entirely.
 */
export function collectHighlightRanges(
  text: string,
  words: readonly SearchWord[],
): HighlightRange[] {
  const raw: HighlightRange[] = [];
  for (const w of words) {
    if (w.error !== null) continue;
    const re = wordRegExp(w, true);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        // Zero-width match (e.g. regex mode "a*" against "b"): advance by one
        // code point so exec() can't spin at the same lastIndex forever.
        re.lastIndex += 1;
        continue;
      }
      raw.push({ start: m.index, end: m.index + m[0].length, colorIndex: w.colorIndex });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: HighlightRange[] = [];
  let cursor = 0;
  for (const r of raw) {
    if (r.start < cursor) continue;
    kept.push(r);
    cursor = r.end;
  }
  return kept;
}

export interface HighlightPiece {
  text: string;
  /** null = plain (unmatched) text, otherwise the word's palette index. */
  colorIndex: number | null;
}

/**
 * Splits `text` into an ordered run of plain/highlighted pieces, ready for a
 * render layer to map straight into text nodes / `<mark>` elements (DR-0022
 * §3: "render 時に text segment を分割して <mark> を差し込む" — this is the
 * split, callers own the JSX). Returns `[{text, colorIndex: null}]` unchanged
 * when there's no query or no matches, so callers can render its output
 * unconditionally without a separate "no highlighting" branch.
 */
export function splitTextForHighlight(
  text: string,
  words: readonly SearchWord[],
): HighlightPiece[] {
  if (words.length === 0) return [{ text, colorIndex: null }];
  const ranges = collectHighlightRanges(text, words);
  if (ranges.length === 0) return [{ text, colorIndex: null }];
  const pieces: HighlightPiece[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) pieces.push({ text: text.slice(cursor, r.start), colorIndex: null });
    pieces.push({ text: text.slice(r.start, r.end), colorIndex: r.colorIndex });
    cursor = r.end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), colorIndex: null });
  return pieces;
}

// --- 1-based looping index nav (DR-0022 §2.2) ---
//
// Shared by both the search "[N/M]" counter and the pre-existing 👤 user-turn
// nav (the DR explicitly calls for unifying the two: "👤 nav のインデックス
// 管理を § 2.2 仕様に合わせて共通化"). `max <= 0` (no matches / no turns at
// all) returns 0 rather than looping — there is no valid 1-based position to
// land on, and callers already disable the ↑/↓ buttons in that state, but the
// function stays total (never throws / never returns an out-of-range value)
// so it's safe to call unconditionally from an event handler.

/** Next index, wrapping from `max` back to `1` (DR-0022 §2.2 "1 と最大値を
 * 越えたらループ"). */
export function loopNextIndex(current: number, max: number): number {
  if (max <= 0) return 0;
  return current >= max ? 1 : current + 1;
}

/** Previous index, wrapping from `1` back to `max`. */
export function loopPrevIndex(current: number, max: number): number {
  if (max <= 0) return 0;
  return current <= 1 ? max : current - 1;
}

/** localStorage key for the Timeline search's "search inside closed folds"
 * toggle (kawaz r76m73). Global rather than per-session, for the same reason
 * as FileTree's `.gitignore` toggle: it states a reading habit ("I want the
 * count to cover the whole transcript" / "I only want what I can see"), not a
 * property of any one session. */
const CLOSED_FOLD_SCOPE_KEY = "ccmsg.inViewSearch.searchClosedFolds";

/** Defaults to on for anything but an explicit "0" — that is the behaviour the
 * Timeline has always had (a match inside a collapsed fold counts, and ↑/↓
 * expands the fold on the way to it), so an existing user's "[N/M]" does not
 * silently shrink the first time they load a build that has this toggle.
 * Garbage persisted data resolves to the default and never throws, matching
 * parseFavorites / loadRespectGitignore. */
export function parseSearchClosedFolds(raw: string | null): boolean {
  return raw !== "0";
}

export function serializeSearchClosedFolds(value: boolean): string {
  return value ? "1" : "0";
}

export { CLOSED_FOLD_SCOPE_KEY };
