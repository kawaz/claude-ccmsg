// in-view-search unit tests (DR-0022): query parsing, AND matching,
// highlight-range enumeration/overlap-resolution, and the shared 1-based
// looping index nav used by both the search "[N/M]" counter and the 👤
// user-turn nav.
import { describe, expect, test } from "bun:test";
import {
  collectHighlightRanges,
  loopNextIndex,
  loopPrevIndex,
  parseSearchQuery,
  splitTextForHighlight,
  unitMatchesQuery,
  type SearchWord,
} from "../src/client/in-view-search.ts";

describe("parseSearchQuery", () => {
  // 改行区切りで複数ワードになる (DR-0022 §2.1) — 素直な 1 行 1 ワード。
  test("splits a multiline query into one word per non-blank line", () => {
    const q = parseSearchQuery("foo\nbar\nbaz", { caseSensitive: false, regex: false });
    expect(q.words.map((w) => w.text)).toEqual(["foo", "bar", "baz"]);
    expect(q.hasError).toBe(false);
  });

  test("plain mode uses whitespace OR within a line and newline AND between lines", () => {
    const oneLine = parseSearchQuery("foo bar", { caseSensitive: false, regex: false });
    expect(oneLine.words.map((word) => [word.text, word.clauseIndex])).toEqual([
      ["foo", 0],
      ["bar", 0],
    ]);
    expect(unitMatchesQuery("foo only", oneLine.words)).toBe(true);
    expect(unitMatchesQuery("bar only", oneLine.words)).toBe(true);
    expect(unitMatchesQuery("neither", oneLine.words)).toBe(false);

    const multiline = parseSearchQuery("foo bar\nbuz", { caseSensitive: false, regex: false });
    expect(unitMatchesQuery("foo and buz", multiline.words)).toBe(true);
    expect(unitMatchesQuery("bar and buz", multiline.words)).toBe(true);
    expect(unitMatchesQuery("foo only", multiline.words)).toBe(false);
  });

  test("double quotes keep a phrase together and normalize internal whitespace", () => {
    const q = parseSearchQuery('"foo   bar "\nbuz', { caseSensitive: false, regex: false });
    expect(q.words.map((word) => word.text)).toEqual(["foo bar", "buz"]);
    expect(unitMatchesQuery("foo\t \nbar and buz", q.words)).toBe(true);
    expect(unitMatchesQuery("foo between bar and buz", q.words)).toBe(false);
  });

  test("plain mode trims repeated whitespace between alternatives", () => {
    const q = parseSearchQuery("foo   bar \n  buz", { caseSensitive: false, regex: false });
    expect(q.words.map((word) => [word.text, word.clauseIndex])).toEqual([
      ["foo", 0],
      ["bar", 0],
      ["buz", 1],
    ]);
  });

  test("regex mode keeps each line as one pattern without trimming spaces", () => {
    const q = parseSearchQuery("foo bar\nbuz", { caseSensitive: false, regex: true });
    expect(q.words.map((word) => [word.text, word.clauseIndex])).toEqual([
      ["foo bar", 0],
      ["buz", 1],
    ]);
    expect(unitMatchesQuery("foo bar and buz", q.words)).toBe(true);
    expect(unitMatchesQuery("foo or bar and buz", q.words)).toBe(false);

    const spaced = parseSearchQuery(" foo ", { caseSensitive: false, regex: true });
    expect(spaced.words[0]!.text).toBe(" foo ");
    expect(unitMatchesQuery("x foo y", spaced.words)).toBe(true);
    expect(unitMatchesQuery("foo", spaced.words)).toBe(false);
  });

  // "空行無視" (DR-0022 §2.1): blank lines contribute no AND clause at all,
  // not an empty-string word (which would otherwise match everything and
  // silently defeat the AND filter — see the module doc comment on why this
  // interpretation was chosen over "keep as empty word").
  test("drops blank lines entirely, including whitespace-only lines", () => {
    const q = parseSearchQuery("foo\n\n   \nbar\n", { caseSensitive: false, regex: false });
    expect(q.words.map((w) => w.text)).toEqual(["foo", "bar"]);
  });

  // Each line is trimmed before becoming a word, so incidental leading/
  // trailing whitespace from pasted text doesn't become part of the pattern.
  test("trims surrounding whitespace on each line", () => {
    const q = parseSearchQuery("  foo  \n\tbar\t", { caseSensitive: false, regex: false });
    expect(q.words.map((w) => w.text)).toEqual(["foo", "bar"]);
  });

  // colorIndex cycles across SEARCH_PALETTE_SIZE (6) words so a long query
  // never runs out of distinct colors — word 6 (index 6) reuses word 0's
  // color.
  test("colorIndex cycles through the palette for queries longer than it", () => {
    const q = parseSearchQuery("a\nb\nc\nd\ne\nf\ng", { caseSensitive: false, regex: false });
    expect(q.words.map((w) => w.colorIndex)).toEqual([0, 1, 2, 3, 4, 5, 0]);
  });

  // Non-regex ("plain") mode escapes regex metacharacters so a literal word
  // like "a.b" only matches that exact substring, not "a" + any-char + "b".
  test("plain mode escapes regex metacharacters (literal match only)", () => {
    const q = parseSearchQuery("a.b", { caseSensitive: false, regex: false });
    expect(unitMatchesQuery("xxa.bxx", q.words)).toBe(true);
    expect(unitMatchesQuery("xxaXbxx", q.words)).toBe(false);
  });

  // Regex mode compiles each line individually — one malformed line (an
  // unbalanced "(" here) is marked with an error and excluded from matching,
  // but does not prevent the other, valid lines from parsing (DR-0022 §3:
  // "不正 regex はその行をエラー扱いで返す").
  test("regex mode isolates a per-line compile error without dropping other lines", () => {
    const q = parseSearchQuery("foo(\nbar", { caseSensitive: false, regex: true });
    expect(q.words).toHaveLength(2);
    expect(q.words[0]!.error).not.toBeNull();
    expect(q.words[1]!.error).toBeNull();
    expect(q.hasError).toBe(true);
  });

  // A syntactically valid regex line matches as a real pattern (not escaped)
  // in regex mode — "f.o" matches "foo" via the wildcard.
  test("regex mode compiles a valid pattern and matches non-literally", () => {
    const q = parseSearchQuery("f.o", { caseSensitive: false, regex: true });
    expect(unitMatchesQuery("xfooX", q.words)).toBe(true);
  });

  // caseSensitive toggles the "i" regex flag for both modes.
  test("caseSensitive controls case folding in both plain and regex mode", () => {
    const insensitive = parseSearchQuery("Foo", { caseSensitive: false, regex: false });
    const sensitive = parseSearchQuery("Foo", { caseSensitive: true, regex: false });
    expect(unitMatchesQuery("xfooX", insensitive.words)).toBe(true);
    expect(unitMatchesQuery("xfooX", sensitive.words)).toBe(false);
    expect(unitMatchesQuery("xFooX", sensitive.words)).toBe(true);
  });
});

describe("unitMatchesQuery (AND semantics, DR-0022 §2.1)", () => {
  test("true only when every word has a match", () => {
    const words = parseSearchQuery("foo\nbar", { caseSensitive: false, regex: false }).words;
    expect(unitMatchesQuery("foo and bar", words)).toBe(true);
    expect(unitMatchesQuery("foo only", words)).toBe(false);
    expect(unitMatchesQuery("bar only", words)).toBe(false);
    expect(unitMatchesQuery("neither", words)).toBe(false);
  });

  // No words at all (empty query) matches nothing — there is no AND clause
  // to satisfy, and "everything matches an empty query" would make the
  // search bar's default (no query typed yet) look like a full-document hit.
  test("empty word list matches nothing", () => {
    expect(unitMatchesQuery("anything", [])).toBe(false);
  });

  // A word that failed to compile (regex mode) is excluded from the AND
  // check rather than vacuously failing the whole query for every unit —
  // see parseSearchQuery's doc comment on why callers should still gate on
  // `!hasError` before trusting nav counts.
  test("an errored word is excluded from the AND check, not treated as always-false", () => {
    const q = parseSearchQuery("foo(\nbar", { caseSensitive: false, regex: true });
    expect(unitMatchesQuery("bar only, no foo", q.words)).toBe(true);
  });
});

describe("collectHighlightRanges / splitTextForHighlight", () => {
  test("enumerates matches with one color per AND line", () => {
    const words = parseSearchQuery("foo fizz\nbar", {
      caseSensitive: false,
      regex: false,
    }).words;
    const ranges = collectHighlightRanges("foo fizz bar foo", words);
    expect(ranges).toEqual([
      { start: 0, end: 3, colorIndex: 0 },
      { start: 4, end: 8, colorIndex: 0 },
      { start: 9, end: 12, colorIndex: 1 },
      { start: 13, end: 16, colorIndex: 0 },
    ]);
  });

  // Two words with overlapping matches (DR text doesn't forbid this — see
  // module doc comment): the longer/earlier-starting one wins, the shorter
  // one is dropped rather than producing a nested/overlapping <mark> pair.
  test("resolves overlapping matches by keeping the earlier/longer one", () => {
    const words = parseSearchQuery("foo\noo", { caseSensitive: false, regex: false }).words;
    const ranges = collectHighlightRanges("xfoox", words);
    expect(ranges).toEqual([{ start: 1, end: 4, colorIndex: 0 }]); // "foo" (len 3) beats "oo" (len 2)
  });

  // Regex mode zero-width match ("a*" against "b") must not spin forever —
  // exec()'s lastIndex is advanced manually past it.
  test("does not infinite-loop on a zero-width regex match", () => {
    const words = parseSearchQuery("a*", { caseSensitive: false, regex: true }).words;
    const ranges = collectHighlightRanges("bbb", words);
    expect(ranges).toEqual([]);
  });

  test("splitTextForHighlight returns the whole text unhighlighted when there is no query", () => {
    expect(splitTextForHighlight("hello", [])).toEqual([{ text: "hello", colorIndex: null }]);
  });

  test("splitTextForHighlight returns the whole text unhighlighted when nothing matches", () => {
    const words = parseSearchQuery("zzz", { caseSensitive: false, regex: false }).words;
    expect(splitTextForHighlight("hello", words)).toEqual([{ text: "hello", colorIndex: null }]);
  });

  test("splitTextForHighlight interleaves plain and colored pieces in order", () => {
    const words = parseSearchQuery("foo\nbar", { caseSensitive: false, regex: false }).words;
    expect(splitTextForHighlight("xx foo yy bar zz", words)).toEqual([
      { text: "xx ", colorIndex: null },
      { text: "foo", colorIndex: 0 },
      { text: " yy ", colorIndex: null },
      { text: "bar", colorIndex: 1 },
      { text: " zz", colorIndex: null },
    ]);
  });

  test("splitTextForHighlight handles a match at the very start/end with no plain-text edges", () => {
    const words: SearchWord[] = parseSearchQuery("ab", {
      caseSensitive: false,
      regex: false,
    }).words;
    expect(splitTextForHighlight("ab", words)).toEqual([{ text: "ab", colorIndex: 0 }]);
  });
});

describe("loopNextIndex / loopPrevIndex (DR-0022 §2.2, shared by search nav and 👤 nav)", () => {
  test("next wraps from max back to 1", () => {
    expect(loopNextIndex(1, 3)).toBe(2);
    expect(loopNextIndex(2, 3)).toBe(3);
    expect(loopNextIndex(3, 3)).toBe(1); // loop
  });

  test("prev wraps from 1 back to max", () => {
    expect(loopPrevIndex(3, 3)).toBe(2);
    expect(loopPrevIndex(2, 3)).toBe(1);
    expect(loopPrevIndex(1, 3)).toBe(3); // loop
  });

  // max <= 0 (no matches / no turns loaded) has no valid 1-based position —
  // both functions return 0 rather than looping into a bogus index or
  // throwing, so an event handler can call them unconditionally.
  test("max <= 0 returns 0 without looping or throwing", () => {
    expect(loopNextIndex(0, 0)).toBe(0);
    expect(loopPrevIndex(0, 0)).toBe(0);
    expect(loopNextIndex(5, -1)).toBe(0);
  });

  test("single-element range loops to itself", () => {
    expect(loopNextIndex(1, 1)).toBe(1);
    expect(loopPrevIndex(1, 1)).toBe(1);
  });
});
