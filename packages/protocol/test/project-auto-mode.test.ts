// The hand-editable file of each project's autoMode, and the change a write
// asks for (DR-0063 §2, §7).
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import {
  AUTO_MODE_ENTRY_MAX_LENGTH,
  AutoModeSettingsTextSchema,
  ProjectAutoModeChangeSchema,
  ProjectAutoModeFileTextSchema,
} from "../src/project-auto-mode.ts";

describe("ProjectAutoModeFileTextSchema", () => {
  // A section is its entries alone: the project only adds, and the daemon
  // puts `$defaults` in (DR-0063 §1, §2).
  test("a section is a list of entries, trimmed; one not written has none", () => {
    const read = parseWith(
      ProjectAutoModeFileTextSchema,
      JSON.stringify({
        projects: {
          "repo:github.com/o/r": { allow: ["  run the tests\n"], soft_deny: [] },
          "cwd:/work/scratch": {},
        },
      }),
    );
    expect(read).toEqual({
      ok: true,
      value: {
        projects: {
          "repo:github.com/o/r": {
            environment: [],
            allow: ["run the tests"],
            soft_deny: [],
            hard_deny: [],
          },
          "cwd:/work/scratch": { environment: [], allow: [], soft_deny: [], hard_deny: [] },
        },
      },
    });
  });

  // What a hand edit gets wrong is a failure, not a guess: the daemon then
  // refuses to start rather than drop the person's entries (DR-0063 §4).
  test("text that is not of the file's shape does not read", () => {
    for (const text of [
      "{",
      JSON.stringify({}),
      JSON.stringify({ projects: { "github.com/o/r": {} } }),
      JSON.stringify({ projects: { "cwd:relative": {} } }),
      JSON.stringify({ projects: { "repo:github.com/o/r": { deny: [] } } }),
      JSON.stringify({ projects: { "repo:github.com/o/r": { allow: ["$defaults"] } } }),
      JSON.stringify({ projects: { "repo:github.com/o/r": { allow: [" "] } } }),
      JSON.stringify({
        projects: {
          "repo:github.com/o/r": { allow: ["x".repeat(AUTO_MODE_ENTRY_MAX_LENGTH + 1)] },
        },
      }),
      // A section is not an object with a check and entries.
      JSON.stringify({ projects: { "repo:github.com/o/r": { allow: { entries: ["x"] } } } }),
      JSON.stringify({ projects: { "repo:github.com/o/r": { allow: { defaults: false } } } }),
    ]) {
      expect(parseWith(ProjectAutoModeFileTextSchema, text).ok).toBe(false);
    }
  });
});

describe("ProjectAutoModeChangeSchema", () => {
  // The two forms of a write (DR-0063 §7): an entry's text, appended, or
  // replacing the entry at `index` that is still `before`.
  test("reads an append and a replacement", () => {
    for (const change of [{ text: "" }, { index: 2, before: "old", text: "new" }]) {
      expect(parseWith(ProjectAutoModeChangeSchema, change)).toEqual({ ok: true, value: change });
    }
  });

  test("a mix of the forms, an index without what it was, or a check does not read", () => {
    for (const change of [
      {},
      { defaults: false },
      { defaults: true, text: "x" },
      { index: 0, text: "x" },
      { before: "x", text: "y" },
      { index: 0, before: "x" },
    ]) {
      expect(parseWith(ProjectAutoModeChangeSchema, change).ok).toBe(false);
    }
  });
});

describe("AutoModeSettingsTextSchema", () => {
  // The user settings are read as far as autoMode's lists go; the rest of
  // the file, and autoMode's other keys, are not ccmsg's (DR-0063 §9).
  test("reads the lists as written and leaves the rest out", () => {
    const read = parseWith(
      AutoModeSettingsTextSchema,
      JSON.stringify({
        model: "opus",
        autoMode: { classifyAllShell: true, soft_deny: ["$defaults", "x"], allow: [] },
      }),
    );
    expect(read).toEqual({
      ok: true,
      value: { autoMode: { soft_deny: ["$defaults", "x"], allow: [] } },
    });
    expect(parseWith(AutoModeSettingsTextSchema, JSON.stringify({})).ok).toBe(true);
    expect(
      parseWith(AutoModeSettingsTextSchema, JSON.stringify({ autoMode: { allow: [1] } })).ok,
    ).toBe(false);
  });
});
