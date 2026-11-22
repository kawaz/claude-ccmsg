// What a section of the Status tab's autoMode says (DR-0063 §1, §6): whether
// the built-in defaults hold, and the sentence of why, over the project's
// entries (some / none) × its check (on / off) × the user's list ((a) with
// $defaults / (b) entries without it / (c) not written).
import { describe, expect, test } from "bun:test";
import type { AutoModeSection, UserAutoMode } from "@ccmsg/protocol";
import {
  builtinApplies,
  entryRows,
  resultText,
  userListState,
  userStateText,
  type UserListState,
} from "../src/client/auto-mode-view.ts";

const USER_DEFAULTS = "ユーザの設定に $defaults があるので組み込みは効いています";
const PROJECT_DEFAULTS = "プロジェクトの $defaults で組み込みが効いています";
const NOBODY = "どの設定もこのセクションを書いていないので組み込みが効いています";
const NO_EFFECT = "項目が無いのでチェックを外しても変わりません";
const USER_ONLY =
  "ユーザの設定が $defaults なしで書いているので組み込みは効いていません (ユーザの項目だけ)";
const CHECK_NEEDS_ENTRIES = "チェックはプロジェクトに項目がある時に効きます";
const OFF = "組み込みは効いていません";

const user = (soft_deny: readonly string[] | undefined): UserAutoMode => ({
  config_dir_name: ".claude-x",
  autoMode: soft_deny === undefined ? {} : { soft_deny },
});
const USERS: Record<"a" | "b" | "c", UserListState> = {
  a: userListState(user(["$defaults", "u"]), "soft_deny"),
  b: userListState(user(["u1", "u2"]), "soft_deny"),
  c: userListState(user(undefined), "soft_deny"),
};
const project = (entries: boolean, defaults: boolean): AutoModeSection => ({
  defaults,
  entries: entries ? ["p"] : [],
});

describe("the twelve cases of a section (DR-0063 §10)", () => {
  const cases: [
    entries: boolean,
    defaults: boolean,
    who: "a" | "b" | "c",
    applies: boolean,
    text: string,
  ][] = [
    [true, true, "a", true, USER_DEFAULTS],
    [true, true, "b", true, PROJECT_DEFAULTS],
    [true, true, "c", true, PROJECT_DEFAULTS],
    [true, false, "a", true, USER_DEFAULTS],
    [true, false, "b", false, OFF],
    [true, false, "c", false, OFF],
    [false, true, "a", true, USER_DEFAULTS],
    [false, true, "b", false, `${USER_ONLY}。${CHECK_NEEDS_ENTRIES}`],
    [false, true, "c", true, NOBODY],
    [false, false, "a", true, USER_DEFAULTS],
    [false, false, "b", false, USER_ONLY],
    [false, false, "c", true, `${NOBODY}。${NO_EFFECT}`],
  ];
  for (const [entries, defaults, who, applies, text] of cases) {
    test(`entries ${entries ? "some" : "none"}, check ${defaults ? "on" : "off"}, user (${who})`, () => {
      const section = project(entries, defaults);
      expect(builtinApplies(section, USERS[who])).toBe(applies);
      expect(resultText(section, USERS[who])).toBe(text);
    });
  }
});

describe("the user's side", () => {
  test("its four states, an empty list being as one not written", () => {
    expect(userStateText(USERS.a)).toBe("ユーザ: $defaults あり");
    expect(userStateText(USERS.b)).toBe("ユーザ: $defaults なし (2 件)");
    expect(userStateText(USERS.c)).toBe("ユーザ: 書いていない");
    expect(userStateText(userListState(user([]), "soft_deny"))).toBe("ユーザ: 書いていない");
    const unreadable = userListState({ unavailable: "config dir が分からない" }, "soft_deny");
    expect(userStateText(unreadable)).toBe("ユーザ: 読めない");
  });

  // What the user writes is not known: only the project's own $defaults
  // decides it.
  // The project's own $defaults decides it whatever the user writes: the
  // sentence and whether the built-in layer shows agree.
  test("a user's settings that do not read leave the result unknown, unless the project's $defaults decides it", () => {
    const unreadable = userListState({ unavailable: "settings.json が読めない: x" }, "allow");
    expect(resultText(project(true, true), unreadable)).toBe(PROJECT_DEFAULTS);
    expect(builtinApplies(project(true, true), unreadable)).toBe(true);
    for (const [entries, defaults] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(resultText(project(entries, defaults), unreadable)).toBe(
        "ユーザの設定が読めないので結果は分かりません",
      );
      expect(builtinApplies(project(entries, defaults), unreadable)).toBeUndefined();
    }
  });
});

describe("entryRows: where an edit stands as the entries change under it (DR-0063 §6)", () => {
  const edit = (index: number, before: string, count: number) => ({
    id: 1,
    index,
    before,
    count,
    conflicted: false,
  });

  test("with its entry: in place, and found by its text when entries before it come or go", () => {
    expect(entryRows(["a", "b"], [edit(1, "b", 2)])).toEqual([
      { kind: "entry", index: 0, text: "a" },
      { kind: "edit", edit: edit(1, "b", 2), index: 1, changed: undefined },
    ]);
    expect(entryRows(["b"], [edit(1, "b", 2)])).toEqual([
      { kind: "edit", edit: edit(1, "b", 2), index: 0, changed: undefined },
    ]);
  });

  test("over an entry another page changed, when as many entries are there as it began with", () => {
    expect(entryRows(["theirs", "b"], [edit(0, "a", 2)])).toEqual([
      { kind: "edit", edit: edit(0, "a", 2), index: 0, changed: "theirs" },
      { kind: "entry", index: 1, text: "b" },
    ]);
  });

  // Fewer or more entries: whether the one at its index is its entry
  // changed or another one moved there is not known, so it is not put over
  // an entry it was not opened on.
  test("after the entries when its entry is gone", () => {
    expect(entryRows(["b"], [edit(0, "a", 2)])).toEqual([
      { kind: "entry", index: 0, text: "b" },
      { kind: "edit", edit: edit(0, "a", 2), index: undefined, changed: undefined },
    ]);
  });
});
