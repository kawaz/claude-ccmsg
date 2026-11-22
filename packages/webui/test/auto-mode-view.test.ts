// Where the built-in defaults of a section of the Status tab's autoMode hold
// (DR-0063 §1, §6): the daemon puts `$defaults` first in every section the
// project has entries in, so they hold then, and otherwise unless the user's
// list is written without `$defaults` — over the project's entries (some /
// none) × the user's list ((a) with $defaults / (b) entries without it /
// (c) not written), and a user's settings that do not read.
import { describe, expect, test } from "bun:test";
import type { UserAutoMode } from "@ccmsg/protocol";
import { builtinApplies, entryRows } from "../src/client/auto-mode-view.ts";

/** The user's side as the daemon reads it (readUserAutoMode): `$defaults`
 * left out of the lists, and the lists written without it named. */
const USERS: Record<"a" | "b" | "c", UserAutoMode> = {
  a: { config_dir_name: ".claude-x", autoMode: { soft_deny: ["u"] }, defaults_dropped: [] },
  b: {
    config_dir_name: ".claude-x",
    autoMode: { soft_deny: ["u1", "u2"] },
    defaults_dropped: ["soft_deny"],
  },
  c: { config_dir_name: ".claude-x", autoMode: {}, defaults_dropped: [] },
};

describe("the six cases of a section (DR-0063 §10)", () => {
  const cases: [entries: boolean, who: "a" | "b" | "c", applies: boolean][] = [
    [true, "a", true],
    [true, "b", true],
    [true, "c", true],
    [false, "a", true],
    [false, "b", false],
    [false, "c", true],
  ];
  for (const [entries, who, applies] of cases) {
    test(`entries ${entries ? "some" : "none"}, user (${who})`, () => {
      expect(builtinApplies(entries ? ["p"] : [], USERS[who], "soft_deny")).toBe(applies);
    });
  }

  // The user's list of another section does not decide this one.
  test("only the section's own list counts", () => {
    expect(builtinApplies([], USERS.b, "allow")).toBe(true);
  });

  // What the user writes is not known: only the project's entries decide it.
  test("a user's settings that do not read leave it unknown, unless the project has entries", () => {
    const unreadable: UserAutoMode = { unavailable: "settings.json が読めない: x" };
    expect(builtinApplies(["p"], unreadable, "allow")).toBe(true);
    expect(builtinApplies([], unreadable, "allow")).toBeUndefined();
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
