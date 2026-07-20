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
    words: parsed.groups.flatMap((group, clauseIndex) =>
      group.map((pattern) => ({
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

/** Matches when every non-errored AND clause has at least one matching OR
 * alternative. Callers gate on `!hasError` while the user is editing an
 * invalid regular expression. */
export function unitMatchesQuery(text: string, words: readonly SearchWord[]): boolean {
  const clauses = new Map<number, SearchWord[]>();
  for (const word of words) {
    if (word.error !== null) continue;
    const clause = clauses.get(word.clauseIndex);
    if (clause) clause.push(word);
    else clauses.set(word.clauseIndex, [word]);
  }
  if (clauses.size === 0) return false;
  return [...clauses.values()].every((clause) =>
    clause.some((word) => wordRegExp(word, false).test(text)),
  );
}

export interface HighlightRange {
  start: number;
  end: number;
  colorIndex: number;
}

/**
 * Enumerates every word's matches in `text` and resolves overlaps into a
 * single non-overlapping, sorted list. Highlight colors are assigned per AND
 * line, so all OR alternatives from the same line share a color. A qualifying
 * unit shows every alternative that appears in its text.
 *
 * Overlap resolution (DR text doesn't specify — the two toggles are
 * documented as independent AND-clauses, not "must not overlap", so two
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
