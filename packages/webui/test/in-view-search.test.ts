// in-view-search unit tests (DR-0022): query parsing, AND/OR matching,
// highlight-range enumeration/overlap-resolution, and the shared 1-based
// looping index nav used by both the search "[N/M]" counter and the 👤
// user-turn nav.
import { describe, expect, test } from "bun:test";
import {
  collectHighlightRanges,
  loopNextIndex,
  loopPrevIndex,
  matchingUnitKeysOf,
  unitMatchesOnScreen,
  parseSearchClosedFolds,
  parseSearchQuery,
  serializeSearchClosedFolds,
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

  test("plain mode uses whitespace AND within a line and newline OR between lines", () => {
    const oneLine = parseSearchQuery("foo bar", { caseSensitive: false, regex: false });
    expect(oneLine.words.map((word) => [word.text, word.clauseIndex])).toEqual([
      ["foo", 0],
      ["bar", 0],
    ]);
    expect(unitMatchesQuery("foo and bar", oneLine.words)).toBe(true);
    expect(unitMatchesQuery("foo only", oneLine.words)).toBe(false);
    expect(unitMatchesQuery("bar only", oneLine.words)).toBe(false);
    expect(unitMatchesQuery("neither", oneLine.words)).toBe(false);

    // Mixed: "(foo AND bar) OR buz".
    const multiline = parseSearchQuery("foo bar\nbuz", { caseSensitive: false, regex: false });
    expect(unitMatchesQuery("foo and bar", multiline.words)).toBe(true);
    expect(unitMatchesQuery("buz alone", multiline.words)).toBe(true);
    expect(unitMatchesQuery("foo only", multiline.words)).toBe(false);
    expect(unitMatchesQuery("bar only", multiline.words)).toBe(false);
  });

  test("double quotes keep a phrase together and normalize internal whitespace", () => {
    const q = parseSearchQuery('"foo   bar "\nbuz', { caseSensitive: false, regex: false });
    expect(q.words.map((word) => word.text)).toEqual(["foo bar", "buz"]);
    // The quoted phrase is its own clause, so it matches on its own.
    expect(unitMatchesQuery("foo\t \nbar", q.words)).toBe(true);
    expect(unitMatchesQuery("foo between bar", q.words)).toBe(false);
  });

  test("plain mode trims repeated whitespace between AND terms", () => {
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
    // One regex per line, OR-ed: either line alone qualifies.
    expect(unitMatchesQuery("foo bar, nothing else", q.words)).toBe(true);
    expect(unitMatchesQuery("buz, nothing else", q.words)).toBe(true);
    expect(unitMatchesQuery("foo or bar", q.words)).toBe(false);

    const spaced = parseSearchQuery(" foo ", { caseSensitive: false, regex: true });
    expect(spaced.words[0]!.text).toBe(" foo ");
    expect(unitMatchesQuery("x foo y", spaced.words)).toBe(true);
    expect(unitMatchesQuery("foo", spaced.words)).toBe(false);
  });

  // "空行無視" (DR-0022 §2.1): blank lines contribute no clause at all, not an
  // empty-string word (which would otherwise be a clause matching everything
  // and silently turn the whole query into a full-document hit).
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

describe("unitMatchesQuery (AND/OR semantics, DR-0022 §2.1)", () => {
  test("newline-separated words match when either one is present", () => {
    const words = parseSearchQuery("foo\nbar", { caseSensitive: false, regex: false }).words;
    expect(unitMatchesQuery("foo and bar", words)).toBe(true);
    expect(unitMatchesQuery("foo only", words)).toBe(true);
    expect(unitMatchesQuery("bar only", words)).toBe(true);
    expect(unitMatchesQuery("neither", words)).toBe(false);
  });

  test("space-separated words match only when all of them are present", () => {
    const words = parseSearchQuery("foo bar", { caseSensitive: false, regex: false }).words;
    expect(unitMatchesQuery("bar then foo", words)).toBe(true);
    expect(unitMatchesQuery("foo only", words)).toBe(false);
  });

  // A three-term clause only qualifies once the last term shows up, so a
  // partially satisfied AND can never leak through the OR.
  test("a partially satisfied clause does not qualify", () => {
    const words = parseSearchQuery("foo bar buz\nzzz", {
      caseSensitive: false,
      regex: false,
    }).words;
    expect(unitMatchesQuery("foo bar only", words)).toBe(false);
    expect(unitMatchesQuery("foo bar buz", words)).toBe(true);
    expect(unitMatchesQuery("zzz", words)).toBe(true);
  });

  // No words at all (empty query) matches nothing — there is no clause to
  // satisfy, and "everything matches an empty query" would make the search
  // bar's default (no query typed yet) look like a full-document hit.
  test("empty word list matches nothing", () => {
    expect(unitMatchesQuery("anything", [])).toBe(false);
  });

  // A word that failed to compile (regex mode) is dropped from its clause
  // rather than vacuously failing the whole query for every unit — see
  // parseSearchQuery's doc comment on why callers should still gate on
  // `!hasError` before trusting nav counts.
  test("an errored word is excluded from the check, not treated as always-false", () => {
    const q = parseSearchQuery("foo(\nbar", { caseSensitive: false, regex: true });
    expect(unitMatchesQuery("bar only, no foo", q.words)).toBe(true);
  });
});

describe("collectHighlightRanges / splitTextForHighlight", () => {
  test("enumerates matches with one color per query line", () => {
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

describe("closed-fold scope persistence", () => {
  // The toggle is stored as "1"/"0" and everything else — unset, a stale
  // value from an older build, hand-edited junk — must land on the default
  // rather than throw, so a corrupt entry can never break the search bar.
  test("defaults to searching closed folds when unset or unrecognized", () => {
    expect(parseSearchClosedFolds(null)).toBe(true);
    expect(parseSearchClosedFolds("1")).toBe(true);
    expect(parseSearchClosedFolds("")).toBe(true);
    expect(parseSearchClosedFolds("false")).toBe(true);
  });

  test('only an explicit "0" turns it off', () => {
    expect(parseSearchClosedFolds("0")).toBe(false);
  });

  test("round-trips through the serialized form", () => {
    expect(parseSearchClosedFolds(serializeSearchClosedFolds(true))).toBe(true);
    expect(parseSearchClosedFolds(serializeSearchClosedFolds(false))).toBe(false);
  });
});

// matchingUnitKeysOf (D1): the "M" in "[N/M]" and the sequence ↑/↓ walks,
// decided from unit text alone. The point of the function is that nothing it
// returns can depend on what is mounted or which folds are open — the DOM is
// not an input.
describe("matchingUnitKeysOf", () => {
  const q = (text: string) => parseSearchQuery(text, { caseSensitive: false, regex: false }).words;
  const units = [
    { key: "0-0", texts: ["alpha bravo"] },
    { key: "10-0", texts: ["bravo charlie"] },
    { key: "10-1", texts: ["nothing here"] },
    { key: "20-0", texts: ["ALPHA again"] },
  ];

  test("returns the matching keys in the order the units were given", () => {
    expect(matchingUnitKeysOf(units, q("bravo"))).toEqual(["0-0", "10-0"]);
  });

  // 大小無視 (既定) は unitMatchesQuery 側の規約をそのまま引き継ぐ。
  test("carries the query's case sensitivity through", () => {
    expect(matchingUnitKeysOf(units, q("alpha"))).toEqual(["0-0", "20-0"]);
    const cs = parseSearchQuery("alpha", { caseSensitive: true, regex: false }).words;
    expect(matchingUnitKeysOf(units, cs)).toEqual(["0-0"]);
  });

  // AND (同一行の複数語) / OR (複数行) も 1 unit ずつ評価される。
  test("applies AND within a line and OR across lines", () => {
    expect(matchingUnitKeysOf(units, q("bravo charlie"))).toEqual(["10-0"]);
    expect(matchingUnitKeysOf(units, q("charlie\nagain"))).toEqual(["10-0", "20-0"]);
  });

  test("counts a unit once however many times its text matches", () => {
    expect(matchingUnitKeysOf([{ key: "0-0", texts: ["ha ha ha"] }], q("ha"))).toEqual(["0-0"]);
  });

  // 空クエリ = 検索していない状態。0/0 を出すために空配列で返す。
  test("matches nothing when the query is empty", () => {
    expect(matchingUnitKeysOf(units, q(""))).toEqual([]);
    expect(matchingUnitKeysOf([], q("alpha"))).toEqual([]);
  });

  // 追記 (live tail) は末尾に unit が増えるだけ — 既存 unit の判定と順序は
  // 動かない。これが「追記のたびに M が揺れない」ことの根拠。
  test("is stable under appends: existing keys keep their result and order", () => {
    const appended = [...units, { key: "30-0", texts: ["bravo tail"] }];
    expect(matchingUnitKeysOf(appended, q("bravo"))).toEqual(["0-0", "10-0", "30-0"]);
  });

  // 翻訳表示された thinking は「原文」と「訳文」の 2 綴りを持つ。読者が画面で
  // 見ているのは訳文なので訳文クエリで数に入り、transcript にあるのは原文なので
  // 原文クエリでも数に入る (どちらか片方しか拾えないのが元の不整合)。
  describe("a unit carrying both an original and a translated spelling", () => {
    const translated = [
      { key: "0-0", texts: ["the daemon holds the socket", "デーモンがソケットを持つ"] },
      { key: "10-0", texts: ["unrelated"] },
    ];

    test("counts under either spelling's query", () => {
      expect(matchingUnitKeysOf(translated, q("daemon"))).toEqual(["0-0"]);
      expect(matchingUnitKeysOf(translated, q("ソケット"))).toEqual(["0-0"]);
    });

    test("counts the unit once when both spellings match", () => {
      const both = [{ key: "0-0", texts: ["socket socket", "ソケット"] }];
      expect(matchingUnitKeysOf(both, q("socket\nソケット"))).toEqual(["0-0"]);
    });

    // AND は 1 つの綴りの中で閉じる。原文の語と訳文の語をまたいで成立させると、
    // どちらの画面にも出ていない組み合わせが数に入ってしまう。
    test("does not satisfy an AND across two different spellings", () => {
      expect(matchingUnitKeysOf(translated, q("daemon ソケット"))).toEqual([]);
      expect(matchingUnitKeysOf(translated, q("daemon socket"))).toEqual(["0-0"]);
    });

    // 訳は非同期に届く: 届いた時点で綴りが 1 つ増え、M は増える方向にだけ動く。
    test("gains matches when the translation arrives, keeping the key", () => {
      const before = [{ key: "0-0", texts: ["the daemon holds the socket"] }];
      expect(matchingUnitKeysOf(before, q("ソケット"))).toEqual([]);
      expect(matchingUnitKeysOf(translated, q("ソケット"))).toEqual(["0-0"]);
      expect(matchingUnitKeysOf(before, q("daemon"))).toEqual(
        matchingUnitKeysOf([translated[0]], q("daemon")),
      );
    });
  });
});

// 📁 OFF (画面に出ているものだけ) の 1 unit 分の判定。
describe("unitMatchesOnScreen", () => {
  const q = (text: string) => parseSearchQuery(text, { caseSensitive: false, regex: false }).words;
  const plain = { key: "0-0", texts: ["alpha bravo"] };
  const translated = {
    key: "1-0",
    texts: ["the daemon holds the socket", "デーモンがソケットを持つ"],
  };

  test("decides a single-spelling unit by its visible text alone", () => {
    expect(unitMatchesOnScreen(plain, "alpha bravo", q("bravo"))).toBe(true);
    // 折り畳まれて画面に出ていない = 見えているものだけ、の答えは false。
    expect(unitMatchesOnScreen(plain, "", q("bravo"))).toBe(false);
  });

  // 訳が表示されている thinking は、画面上の文字列が訳文なので原文クエリが
  // 可視テキストに当たらない。訳文が画面に出ている以上、原文クエリでも拾う。
  test("falls back to the unit's own spellings when the translation is on screen", () => {
    expect(unitMatchesOnScreen(translated, "デーモンがソケットを持つ", q("ソケット"))).toBe(true);
    expect(unitMatchesOnScreen(translated, "デーモンがソケットを持つ", q("daemon"))).toBe(true);
  });

  // markdown 描画は段落の改行を要素境界に変えるので、空白を落とした形で
  // 「その訳文が画面に出ているか」を見る。
  test("recognises the translation through markdown's whitespace changes", () => {
    const twoParagraphs = {
      key: "2-0",
      texts: ["English one.\n\nEnglish two.", "デーモンがソケットを持つ\n\n再接続の段落"],
    };
    expect(
      unitMatchesOnScreen(twoParagraphs, "デーモンがソケットを持つ 再接続の段落", q("English")),
    ).toBe(true);
    // 訳が段落単位で届く途中 — 先頭段落だけ出ていても「画面に出ている」。
    expect(unitMatchesOnScreen(twoParagraphs, "デーモンがソケットを持つ", q("English"))).toBe(true);
  });

  // summary だけが見えている (本文は折り畳まれている) unit は、画面に出て
  // いないので拾わない — 📁 OFF の意味論はそこを変えない。
  test("excludes a translated unit whose body is folded shut", () => {
    expect(unitMatchesOnScreen(translated, "", q("daemon"))).toBe(false);
    expect(unitMatchesOnScreen(translated, "09:00:02 thinking original ja", q("daemon"))).toBe(
      false,
    );
  });

  test("excludes a query that matches neither spelling", () => {
    expect(unitMatchesOnScreen(translated, "デーモンがソケットを持つ", q("charlie"))).toBe(false);
  });
});
