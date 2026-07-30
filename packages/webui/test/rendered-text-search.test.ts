import { describe, expect, test } from "bun:test";
import { parseSearchQuery } from "../src/client/in-view-search.ts";
import {
  collectRenderedTextSpans,
  projectRangeToTextNodes,
} from "../src/client/rendered-text-search.ts";

describe("projectRangeToTextNodes", () => {
  test("matches and highlights text across adjacent rendered elements", () => {
    // Rendered DOM shape: text("m25: <") + code(text("FILE>"));
    // query "m25: <FI" spans both text nodes without changing either element.
    const words = parseSearchQuery('"m25: <FI"', { caseSensitive: false, regex: false }).words;
    expect(collectRenderedTextSpans(["m25: <", "FILE>"], words)).toEqual({
      matched: true,
      spans: [
        { nodeIndex: 0, start: 0, end: 6, colorIndex: 0 },
        { nodeIndex: 1, start: 0, end: 2, colorIndex: 0 },
      ],
    });
  });

  test("projects a range beginning and ending inside different nodes", () => {
    // Each projected offset remains local to its Text node so DOM Range
    // endpoints can preserve the rendered inline structure.
    expect(projectRangeToTextNodes([3, 4, 5], 2, 9)).toEqual([
      { nodeIndex: 0, start: 2, end: 3 },
      { nodeIndex: 1, start: 0, end: 4 },
      { nodeIndex: 2, start: 0, end: 2 },
    ]);
  });

  test("keeps a folded match while omitting its invisible highlight spans", () => {
    // Search navigation must still know that the folded unit matches, but a
    // CSS Highlight Range must not target its hidden Text node: Chromium can
    // otherwise paint the stale rectangle over the following visible message.
    const words = parseSearchQuery("TARGET", { caseSensitive: false, regex: false }).words;
    expect(collectRenderedTextSpans(["prefix TARGET suffix"], words, [false])).toEqual({
      matched: true,
      spans: [],
    });
  });

  test("restores highlight spans when the folded match becomes visible again", () => {
    // Reopening details reuses the same query and must recreate the Range at
    // the original offsets rather than requiring a query edit or another fold cycle.
    const words = parseSearchQuery("TARGET", { caseSensitive: false, regex: false }).words;
    expect(collectRenderedTextSpans(["prefix TARGET suffix"], words, [true])).toEqual({
      matched: true,
      spans: [{ nodeIndex: 0, start: 7, end: 13, colorIndex: 0 }],
    });
  });
});

describe("collectRenderedTextSpans with closed folds out of scope", () => {
  const words = (text: string) =>
    parseSearchQuery(text, { caseSensitive: false, regex: false }).words;

  test("drops a match that lives entirely behind a closed fold", () => {
    // The 📁 toggle's whole point: with it off, a hit the reader cannot see
    // must not appear in "[N/M]" — and since `matched` gates the ranges, it
    // paints nothing either.
    expect(
      collectRenderedTextSpans(["prefix TARGET suffix"], words("TARGET"), [false], false),
    ).toEqual({ matched: false, spans: [] });
  });

  test("keeps a match in visible text while a sibling node is folded away", () => {
    expect(
      collectRenderedTextSpans(
        ["hidden TARGET", " visible TARGET"],
        words("TARGET"),
        [false, true],
        false,
      ),
    ).toEqual({
      matched: true,
      spans: [{ nodeIndex: 1, start: 9, end: 15, colorIndex: 0 }],
    });
  });

  test("does not splice visible text across a folded gap into a phantom match", () => {
    // "foo" and "bar" are never adjacent on screen — the hidden node between
    // them stands in as a newline so `foobar` cannot match.
    expect(
      collectRenderedTextSpans(
        ["foo", "HIDDEN", "bar"],
        words("foobar"),
        [true, false, true],
        false,
      ),
    ).toEqual({ matched: false, spans: [] });
  });

  test("requires every AND clause to be satisfied by visible text alone", () => {
    // "alpha" is on screen but "beta" is folded away, so the unit does not
    // satisfy the query as the reader sees it.
    expect(
      collectRenderedTextSpans(["alpha", "beta"], words("alpha\nbeta"), [true, false], false),
    ).toEqual({ matched: false, spans: [] });
    // Same query, same text, closed folds back in scope: it counts again.
    expect(
      collectRenderedTextSpans(["alpha", "beta"], words("alpha\nbeta"), [true, false], true)
        .matched,
    ).toBe(true);
  });

  test("counting hidden text is the default", () => {
    expect(collectRenderedTextSpans(["TARGET"], words("TARGET"), [false]).matched).toBe(true);
  });
});
