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
    const words = parseSearchQuery("m25: <FI", { caseSensitive: false, regex: false }).words;
    expect(collectRenderedTextSpans(["m25: <", "FILE>"], words)).toEqual({
      matched: true,
      spans: [
        { nodeIndex: 0, start: 0, end: 6, colorIndex: 0 },
        { nodeIndex: 1, start: 0, end: 2, colorIndex: 0 },
      ],
    });
  });

  test("projects a range beginning and ending inside different nodes", () => {
    expect(projectRangeToTextNodes([3, 4, 5], 2, 9)).toEqual([
      { nodeIndex: 0, start: 2, end: 3 },
      { nodeIndex: 1, start: 0, end: 4 },
      { nodeIndex: 2, start: 0, end: 2 },
    ]);
  });
});
