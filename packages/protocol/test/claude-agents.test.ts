// `claude agents --json` read by its schemas (DR-0038 §3). The rows are the
// shapes observed on 2026-10-11, with names and paths replaced.
import { describe, expect, test } from "bun:test";
import { ClaudeAgentsAllTextSchema, ClaudeAgentsTextSchema, parseWith } from "../src/index.ts";

const RUNNING = {
  pid: 14997,
  cwd: "/repo",
  kind: "interactive",
  startedAt: 1791538669545,
  sessionId: "68236664-de13-42d1-9fe3-1540aee48b04",
  name: "main",
  status: "busy",
};

/** A finished background session, which only `--all` lists: no process, so
 * no pid. */
const FINISHED = {
  id: "5b537ed3",
  cwd: "/repo",
  kind: "background",
  startedAt: 1786414087894,
  sessionId: "5b537ed3-db9f-40ae-9b9e-3d70271fb15f",
  state: "done",
};

describe("ClaudeAgentsTextSchema", () => {
  test("reads running rows and lets fields it does not list through", () => {
    const read = parseWith(ClaudeAgentsTextSchema, JSON.stringify([{ ...RUNNING, extra: 1 }]));
    expect(read).toEqual({ ok: true, value: [{ ...RUNNING, extra: 1 }] });
  });

  test("a row without a pid fails the listing", () => {
    expect(parseWith(ClaudeAgentsTextSchema, JSON.stringify([RUNNING, FINISHED])).ok).toBe(false);
  });

  test("output that is not an array of rows fails", () => {
    for (const text of ["not json", "{}", JSON.stringify([1])]) {
      expect(parseWith(ClaudeAgentsTextSchema, text).ok).toBe(false);
    }
  });
});

describe("ClaudeAgentsAllTextSchema", () => {
  test("reads finished rows without a pid beside running ones", () => {
    const read = parseWith(ClaudeAgentsAllTextSchema, JSON.stringify([FINISHED, RUNNING]));
    expect(read.ok && read.value.map((row) => row.pid)).toEqual([undefined, RUNNING.pid]);
  });

  test("a pid that is not a number fails the listing", () => {
    const text = JSON.stringify([{ sessionId: "s", pid: "4242" }]);
    expect(parseWith(ClaudeAgentsAllTextSchema, text).ok).toBe(false);
  });
});
