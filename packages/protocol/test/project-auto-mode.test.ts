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

const NOTHING_SET = { defaults: true, entries: [] };

describe("ProjectAutoModeFileTextSchema", () => {
  // A section not written is as nothing set: $defaults goes in (the safe
  // side, DR-0063 §1), and there are no entries.
  test("an unwritten section and an unwritten field read as nothing set", () => {
    const read = parseWith(
      ProjectAutoModeFileTextSchema,
      JSON.stringify({
        projects: {
          "repo:github.com/o/r": { allow: { entries: ["  run the tests\n"] }, soft_deny: {} },
          "cwd:/work/scratch": { hard_deny: { defaults: false } },
        },
      }),
    );
    expect(read).toEqual({
      ok: true,
      value: {
        projects: {
          "repo:github.com/o/r": {
            environment: NOTHING_SET,
            allow: { defaults: true, entries: ["run the tests"] },
            soft_deny: NOTHING_SET,
            hard_deny: NOTHING_SET,
          },
          "cwd:/work/scratch": {
            environment: NOTHING_SET,
            allow: NOTHING_SET,
            soft_deny: NOTHING_SET,
            hard_deny: { defaults: false, entries: [] },
          },
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
      JSON.stringify({ projects: { "repo:github.com/o/r": { deny: {} } } }),
      JSON.stringify({
        projects: { "repo:github.com/o/r": { allow: { entries: ["$defaults"] } } },
      }),
      JSON.stringify({ projects: { "repo:github.com/o/r": { allow: { entries: [" "] } } } }),
      JSON.stringify({
        projects: {
          "repo:github.com/o/r": {
            allow: { entries: ["x".repeat(AUTO_MODE_ENTRY_MAX_LENGTH + 1)] },
          },
        },
      }),
      JSON.stringify({ projects: { "repo:github.com/o/r": { allow: { mode: "x" } } } }),
    ]) {
      expect(parseWith(ProjectAutoModeFileTextSchema, text).ok).toBe(false);
    }
  });
});

describe("ProjectAutoModeChangeSchema", () => {
  // The two forms of a write (DR-0063 §7): the check, or an entry's text,
  // appended, or replacing the entry at `index` that is still `before`.
  test("reads the check, an append and a replacement", () => {
    for (const change of [
      { defaults: false },
      { text: "" },
      { index: 2, before: "old", text: "new" },
    ]) {
      expect(parseWith(ProjectAutoModeChangeSchema, change)).toEqual({ ok: true, value: change });
    }
  });

  test("a mix of the forms, or an index without what it was, does not read", () => {
    for (const change of [
      {},
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
