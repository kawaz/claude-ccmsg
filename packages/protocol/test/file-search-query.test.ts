// The Files-pane path query grammar. Lives in protocol because the daemon's
// tree walk and the client's external-file filter both run it — these tests
// are the shared contract, not one side's behavior.
import { describe, expect, test } from "bun:test";
import {
  fileSearchQueryIsEmpty,
  matchesFileSearchQuery,
  parseFileSearchQuery,
} from "../src/file-search-query.ts";

describe("parseFileSearchQuery", () => {
  test("splits on whitespace runs and lower-cases", () => {
    expect(parseFileSearchQuery("Foo  BAR")).toEqual({ include: ["foo", "bar"], exclude: [] });
  });

  test("treats a full-width space as a separator (JS \\s covers it)", () => {
    expect(parseFileSearchQuery("foo　bar").include).toEqual(["foo", "bar"]);
  });

  test("empty / whitespace-only yields no terms", () => {
    expect(parseFileSearchQuery("")).toEqual({ include: [], exclude: [] });
    expect(parseFileSearchQuery("   ")).toEqual({ include: [], exclude: [] });
  });

  test("a leading '-' makes the word an exclusion", () => {
    expect(parseFileSearchQuery("package -node_modules")).toEqual({
      include: ["package"],
      exclude: ["node_modules"],
    });
  });

  test("'+' escapes the next character's special meaning: '+-x' searches the literal '-x'", () => {
    // The point of the escape: hyphens are common in real file names
    // (`file-search.ts`), so "-" being an operator must not make them
    // unsearchable.
    expect(parseFileSearchQuery("+-word")).toEqual({ include: ["-word"], exclude: [] });
  });

  test("'++x' searches the literal '+x' (one '+' is consumed, the rest is literal)", () => {
    expect(parseFileSearchQuery("++word")).toEqual({ include: ["+word"], exclude: [] });
  });

  test("'+' before an ordinary word is a no-op escape", () => {
    expect(parseFileSearchQuery("+word")).toEqual({ include: ["word"], exclude: [] });
  });

  test("a lone '-' or '+' is the literal character, not an operator missing its operand", () => {
    // A path component that *is* a hyphen has to be reachable somehow, and an
    // operator with nothing to operate on has no other useful reading.
    expect(parseFileSearchQuery("-")).toEqual({ include: ["-"], exclude: [] });
    expect(parseFileSearchQuery("+")).toEqual({ include: ["+"], exclude: [] });
    expect(parseFileSearchQuery("src -")).toEqual({ include: ["src", "-"], exclude: [] });
  });

  test("only the first character is a prefix — an interior '-' stays literal", () => {
    expect(parseFileSearchQuery("file-search")).toEqual({
      include: ["file-search"],
      exclude: [],
    });
    expect(parseFileSearchQuery("-file-search")).toEqual({
      include: [],
      exclude: ["file-search"],
    });
  });

  test("several includes and excludes accumulate in order", () => {
    expect(parseFileSearchQuery("a -b c -d")).toEqual({
      include: ["a", "c"],
      exclude: ["b", "d"],
    });
  });

  test("exclusion terms are lower-cased like includes", () => {
    expect(parseFileSearchQuery("-TEST").exclude).toEqual(["test"]);
  });
});

describe("matchesFileSearchQuery", () => {
  const q = parseFileSearchQuery;

  test("single word matches a substring anywhere in the path", () => {
    expect(matchesFileSearchQuery("src/components/FileTree.tsx", q("compo"))).toBe(true);
    expect(matchesFileSearchQuery("src/utils.ts", q("compo"))).toBe(false);
  });

  test("multiple words are ANDed, and may match in any order", () => {
    expect(matchesFileSearchQuery("src/components/FileTree.tsx", q("compo tsx"))).toBe(true);
    expect(matchesFileSearchQuery("src/components/FileTree.tsx", q("tsx compo"))).toBe(true);
    expect(matchesFileSearchQuery("src/components/FileTree.tsx", q("compo md"))).toBe(false);
  });

  test("words may match across a path separator", () => {
    // "webui compo tsx" style queries rely on matching the whole path, not
    // per-segment: "components/File" spans a segment boundary.
    expect(matchesFileSearchQuery("src/components/FileTree.tsx", q("components/file"))).toBe(true);
  });

  test("matching is case-insensitive in both directions", () => {
    expect(matchesFileSearchQuery("src/components/FileTree.tsx", q("FileTree"))).toBe(true);
    expect(matchesFileSearchQuery("src/README.md", q("readme"))).toBe(true);
    expect(matchesFileSearchQuery("src/readme.md", q("README"))).toBe(true);
  });

  test("an exclusion term drops a path that would otherwise match", () => {
    expect(matchesFileSearchQuery("packages/webui/package.json", q("package.json"))).toBe(true);
    expect(matchesFileSearchQuery("packages/webui/package.json", q("package.json -webui"))).toBe(
      false,
    );
    expect(matchesFileSearchQuery("packages/daemon/package.json", q("package.json -webui"))).toBe(
      true,
    );
  });

  test("exclusion beats inclusion when one term is a substring of another's match", () => {
    // "test" is present in the path *because* "src/test" is; the exclusion is
    // evaluated against the whole path, not against the leftover after the
    // includes matched, so the path is dropped.
    expect(matchesFileSearchQuery("src/test/util.ts", q("util -test"))).toBe(false);
  });

  test("the escaped form matches a literal hyphen rather than excluding", () => {
    expect(matchesFileSearchQuery("src/file-search.ts", q("+-search"))).toBe(true);
    expect(matchesFileSearchQuery("src/file-search.ts", q("-search"))).toBe(false);
  });

  test("no include terms match nothing, even with exclusions present", () => {
    // An exclude-only query is "everything except X" — a full walk whose
    // result cap fills with whatever the traversal reached first, which is not
    // an answer to anything the user asked. See the parser's doc comment.
    expect(matchesFileSearchQuery("anything/at/all", q(""))).toBe(false);
    expect(matchesFileSearchQuery("anything/at/all", q("-nope"))).toBe(false);
  });
});

describe("fileSearchQueryIsEmpty", () => {
  test("true when there is nothing to include", () => {
    expect(fileSearchQueryIsEmpty(parseFileSearchQuery(""))).toBe(true);
    expect(fileSearchQueryIsEmpty(parseFileSearchQuery("  "))).toBe(true);
    expect(fileSearchQueryIsEmpty(parseFileSearchQuery("-only -exclusions"))).toBe(true);
  });

  test("false as soon as one include term exists", () => {
    expect(fileSearchQueryIsEmpty(parseFileSearchQuery("a"))).toBe(false);
    expect(fileSearchQueryIsEmpty(parseFileSearchQuery("a -b"))).toBe(false);
    // A lone "-" is a literal, so it counts as something to include.
    expect(fileSearchQueryIsEmpty(parseFileSearchQuery("-"))).toBe(false);
  });
});
