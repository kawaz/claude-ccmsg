// The words a filter box keeps (DR-0043 §9): how a kept word's pill shows it
// and which Files list a session's box has.
// 何を保証するか:
//   - ピルに見せる語は 5 文字以下ならそのまま、6 文字以上なら頭の 5 文字 + `…`。数えるのは
//     見た目の 1 文字 (grapheme) で、絵文字や結合文字を途中で切らない。`|` も 1 文字
//   - Files の一覧は repository (`host/owner/name`) ごと、無ければ cwd ごとで、どちらも無ければ無い
import { describe, expect, test } from "bun:test";
import { fileSavedFiltersId, savedFilterLabel } from "../src/client/saved-filters.ts";

describe("savedFilterLabel", () => {
  test("a word of up to five characters shows as is", () => {
    expect(savedFilterLabel("")).toBe("");
    expect(savedFilterLabel("a")).toBe("a");
    expect(savedFilterLabel("ccmsg")).toBe("ccmsg");
  });

  test("a word of six characters or more shows its first five and …", () => {
    expect(savedFilterLabel("ccmsgs")).toBe("ccmsg…");
    expect(savedFilterLabel("frontend")).toBe("front…");
  });

  test("an OR of words counts its | as a character", () => {
    expect(savedFilterLabel("a|b")).toBe("a|b");
    expect(savedFilterLabel("ab|cd")).toBe("ab|cd");
    expect(savedFilterLabel("ab|cde")).toBe("ab|cd…");
    expect(savedFilterLabel("frontend|backend")).toBe("front…");
  });

  test("an emoji or a letter with its marks is one character, never cut", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(savedFilterLabel(`${family}abcd`)).toBe(`${family}abcd`);
    expect(savedFilterLabel(`${family}abcde`)).toBe(`${family}abcd…`);
    expect(savedFilterLabel("abcd🇯🇵x")).toBe("abcd🇯🇵…");
    const marked = "é";
    expect(savedFilterLabel(`${marked.repeat(6)}`)).toBe(`${marked.repeat(5)}…`);
    expect(savedFilterLabel("がぎぐげご")).toBe("がぎぐげご");
  });
});

describe("fileSavedFiltersId", () => {
  const repository = { host: "github.com", owner: "o", name: "r", url: "https://github.com/o/r" };

  test("a repository's list is by host/owner/name, whatever the cwd", () => {
    expect(fileSavedFiltersId(repository, "/a")).toBe("files:repo:github.com/o/r");
    expect(fileSavedFiltersId(repository, null)).toBe("files:repo:github.com/o/r");
    expect(fileSavedFiltersId({ ...repository, owner: "group/sub" }, "/a")).toBe(
      "files:repo:github.com/group/sub/r",
    );
  });

  test("with no repository, the cwd's; with neither, none", () => {
    expect(fileSavedFiltersId(undefined, "/notes")).toBe("files:cwd:/notes");
    expect(fileSavedFiltersId(undefined, null)).toBeNull();
    expect(fileSavedFiltersId(undefined, "")).toBeNull();
  });
});
