// In-view keyword search (DR-0022) — pure query-parsing / match-enumeration /
// index-navigation layer, kept free of preact/DOM so it's unit-testable in
// isolation (same split as transcript-model.ts's fold logic vs Timeline.tsx's
// rendering). Timeline.tsx and FileViewer.tsx both consume this module: the
// former maps it over Segment text, the latter over file lines.

/** Number of distinct highlight colors in the palette (app.css defines
 * `--search-color-1` .. `--search-color-N`, one pair per theme). Word N (0-
 * indexed) gets `colorIndex = N % SEARCH_PALETTE_SIZE`, so a query longer than
 * the palette cycles colors rather than running out. */
export const SEARCH_PALETTE_SIZE = 6;

export interface SearchQueryOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/** One AND-clause word from the query (DR-0022 §2.1: "改行区切り・空行無視で
 * 複数ワード AND"). `source`/`flags` are the RegExp constructor args this
 * word matches with — in plain (non-regex) mode `source` is the word with
 * regex metacharacters escaped, so the same match/highlight machinery works
 * for both modes without a separate code path. */
export interface SearchWord {
  /** The line as typed (each line trimmed, blank lines dropped before this
   * point — see parseSearchQuery). */
  readonly text: string;
  /** Cycles 0..SEARCH_PALETTE_SIZE-1 across the query's words, in order. */
  readonly colorIndex: number;
  /** Regex mode only: the compile error message when `text` isn't a valid
   * pattern. A word with an error never contributes matches (treated as
   * "matches nothing") — see unitMatchesQuery/collectHighlightRanges. */
  readonly error: string | null;
  readonly source: string;
  readonly flags: string;
}

export interface ParsedSearchQuery {
  readonly words: SearchWord[];
  /** True if any word failed to compile (regex mode only) — callers surface
   * this as an inline error rather than silently dropping the bad line. */
  readonly hasError: boolean;
}

// Escapes regex metacharacters so a plain-mode word is matched literally.
function escapeForLiteralMatch(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses a (possibly multiline) query into an AND-list of words (DR-0022
 * §2.1). Each non-blank line becomes one word; blank lines are dropped
 * entirely (not just trimmed to empty and kept as a no-op word) — the DR's
 * "空行無視" reads as "blank lines carry no meaning", not "an empty AND
 * clause that matches everything", so this parse never emits a word with
 * `text === ""`.
 *
 * Regex mode compiles each line individually so one malformed line doesn't
 * block the rest of the query (DR-0022 §3: "不正 regex はその行をエラー扱い
 * で返す") — a word's `error` is set instead, and it's excluded from actual
 * matching (see unitMatchesQuery) while still being shown as a chip so the
 * user can see and fix it.
 */
export function parseSearchQuery(text: string, opts: SearchQueryOptions): ParsedSearchQuery {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // "u" (unicode) always on so surrogate-pair-unsafe patterns (e.g. a lone
  // `.` matching half an emoji) don't silently misbehave; "g" so the same
  // RegExp source can be reused for both a single-shot `test()` (AND check)
  // and a `matchAll`-style enumeration (highlighting) — see wordRegExp.
  const flags = opts.caseSensitive ? "gu" : "giu";
  const words: SearchWord[] = lines.map((line, i) => {
    const colorIndex = i % SEARCH_PALETTE_SIZE;
    if (!opts.regex) {
      return { text: line, colorIndex, error: null, source: escapeForLiteralMatch(line), flags };
    }
    try {
      // Compile-only validation — the constructed RegExp itself is unused,
      // only whether it throws matters.
      new RegExp(line, flags);
      return { text: line, colorIndex, error: null, source: line, flags };
    } catch (err) {
      return {
        text: line,
        colorIndex,
        error: err instanceof Error ? err.message : String(err),
        source: line,
        flags,
      };
    }
  });
  return { words, hasError: words.some((w) => w.error !== null) };
}

// A fresh RegExp per call (never reused/mutated) so lastIndex state from one
// caller's matchAll-style loop can never bleed into another's `test()` — see
// the DR-0022 §3 "regex 安全 compile" note; this is the safety half of it.
function wordRegExp(word: SearchWord, global: boolean): RegExp {
  return new RegExp(word.source, global ? word.flags : word.flags.replace("g", ""));
}

/**
 * AND-filter over a text unit (a Timeline Segment's text, or a file line):
 * true only if every non-errored word has at least one match in `text`
 * (DR-0022 §2.1 "複数ワード AND"). Errored words are excluded from the check
 * — a query that's *entirely* invalid words is not a "matches nothing"
 * assertion about content, so callers should gate on `!hasError` before
 * relying on this for nav counts (an in-progress invalid regex shouldn't
 * silently report "0/0 matches" as if the content had none).
 */
export function unitMatchesQuery(text: string, words: readonly SearchWord[]): boolean {
  const active = words.filter((w) => w.error === null);
  if (active.length === 0) return false;
  return active.every((w) => wordRegExp(w, false).test(text));
}

export interface HighlightRange {
  start: number;
  end: number;
  colorIndex: number;
}

/**
 * Enumerates every word's matches in `text` and resolves overlaps into a
 * single non-overlapping, sorted list (DR-0022 §2.1 "ワード毎に別色で
 * ハイライト" — highlighting is per-word independent of the AND filter above:
 * a unit that fails the AND check is simply never passed to this function by
 * the caller, but within a unit that does, every word's own matches are shown
 * regardless of which word "caused" the unit to qualify).
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
