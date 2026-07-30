import { describe, expect, test } from "bun:test";
import { parseSearchQueryPatterns } from "../src/search-query.ts";

describe("parseSearchQueryPatterns", () => {
  test("returns serializable OR clauses containing AND patterns", () => {
    const parsed = parseSearchQueryPatterns('foo bar\n"buz   qux "', {
      caseSensitive: false,
      regex: false,
    });

    expect(parsed).toEqual({
      clauses: [
        [
          { text: "foo", source: RegExp.escape("foo"), flags: "vi", error: null },
          { text: "bar", source: RegExp.escape("bar"), flags: "vi", error: null },
        ],
        [
          {
            text: "buz qux",
            source: `${RegExp.escape("buz")}\\s+${RegExp.escape("qux")}`,
            flags: "vi",
            error: null,
          },
        ],
      ],
      hasError: false,
    });
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  test("keeps each regex line unchanged and reports errors serializably", () => {
    const parsed = parseSearchQueryPatterns("foo bar\n(", {
      caseSensitive: true,
      regex: true,
    });

    expect(parsed.clauses[0]).toEqual([
      { text: "foo bar", source: "foo bar", flags: "v", error: null },
    ]);
    expect(parsed.clauses[1]![0]!.error).toBeString();
    expect(parsed.hasError).toBe(true);
  });
});
