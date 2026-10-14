// The sidecar's request and reply lines (DR-0035 §3) as their schemas say
// them (DR-0038): what the module runs, what it does not, and what a reply in
// transit must carry.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import {
  DescribeResultSchema,
  PromptSendResultSchema,
  readSidecarRequest,
  SessionFactsSchema,
  SessionFactsTextSchema,
  SIDECAR_OP_NAMES,
  SIDECAR_OPS,
  SidecarReplySchema,
  sidecarRunId,
  SidecarRunIdSchema,
} from "../src/sidecar.ts";

const line = (value: object): string => JSON.stringify(value);

describe("readSidecarRequest", () => {
  test("a prompt.send keeps its text as given", () => {
    expect(
      readSidecarRequest(line({ v: 1, op: "prompt.send", id: "1", args: { text: " a\n" } })),
    ).toEqual({
      ok: true,
      value: { v: 1, op: "prompt.send", id: "1", args: { text: " a\n" } },
    });
  });

  test("a describe takes args {}", () => {
    expect(readSidecarRequest(line({ v: 1, op: "describe", id: "d", args: {} }))).toEqual({
      ok: true,
      value: { v: 1, op: "describe", id: "d", args: {} },
    });
  });

  // Not a request of this version, of an op the module runs, with that op's
  // args: a failure, whichever part does not fit.
  for (const text of [
    "not json",
    "[1]",
    line({ v: 1, op: "describe", args: {} }),
    line({ v: 1, op: "describe", id: "", args: {} }),
    line({ v: 1, op: "describe", id: 1, args: {} }),
    line({ v: 2, op: "prompt.send", id: "q", args: { text: "x" } }),
    line({ op: "describe", id: "q", args: {} }),
    line({ v: 1, op: "prompt.peek", id: "q", args: {} }),
    line({ v: 1, op: "prompt.send", id: "q" }),
    line({ v: 1, op: "prompt.send", id: "q", args: { text: " \n\t" } }),
    line({ v: 1, op: "prompt.send", id: "q", args: { text: 1 } }),
    line({ v: 1, op: "describe", id: "q", args: { x: 1 } }),
    line({ v: 1, op: "describe", id: "q", args: [] }),
  ]) {
    test(`${text} is a failure`, () => {
      expect(readSidecarRequest(text).ok).toBe(false);
    });
  }

  test("a failure says what was read", () => {
    expect(readSidecarRequest(line({ v: 2, op: "describe", id: "q", args: {} }))).toMatchObject({
      failure: { summary: "v: Invalid type: Expected 1 but received 2" },
    });
  });
});

test("every op has its schemas, and describe lists them all", () => {
  expect(Object.keys(SIDECAR_OPS).toSorted()).toEqual([...SIDECAR_OP_NAMES].toSorted());
});

describe("SidecarReplySchema (a reply in transit)", () => {
  // The result is the op's, read where the request was made.
  test("an ok reply keeps its result as given, whatever its shape", () => {
    expect(parseWith(SidecarReplySchema, { id: "a", ok: true, result: { x: 1 } })).toEqual({
      ok: true,
      value: { id: "a", ok: true, result: { x: 1 } },
    });
    expect(parseWith(SidecarReplySchema, { id: "a", ok: true, result: null })).toEqual({
      ok: true,
      value: { id: "a", ok: true, result: null },
    });
  });

  for (const [name, value] of [
    ["not an object", "x"],
    ["an array", [{ id: "a", ok: true, result: 1 }]],
    ["no id", { ok: true, result: 1 }],
    ["an empty id", { id: "", ok: true, result: 1 }],
    ["ok neither true nor false", { id: "a", ok: "yes", result: 1 }],
    ["ok without a result", { id: "a", ok: true }],
    ["a failure without an error", { id: "a", ok: false }],
    ["an error code nobody defined", { id: "a", ok: false, error: { code: "x", message: "" } }],
    ["an error without a message", { id: "a", ok: false, error: { code: "internal" } }],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(parseWith(SidecarReplySchema, value).ok).toBe(false);
    });
  }
});

describe("the ops' results", () => {
  test("prompt.send: an outcome, with a reason the module gives when not delivered", () => {
    for (const result of [
      { outcome: "accepted" },
      { outcome: "unconfirmed" },
      { outcome: "not_delivered", reason: "dialog" },
      { outcome: "not_delivered", reason: "session_changed" },
    ] as const) {
      expect(parseWith(PromptSendResultSchema, result)).toEqual({ ok: true, value: result });
    }
    for (const result of [
      null,
      { outcome: "delivered" },
      { outcome: "not_delivered" },
      // The daemon's own conclusion, never the module's.
      { outcome: "not_delivered", reason: "no_module" },
    ]) {
      expect(parseWith(PromptSendResultSchema, result).ok).toBe(false);
    }
  });

  test("describe: versions and ops, the ccmsg version when known", () => {
    expect(parseWith(DescribeResultSchema, { v: [1], ops: ["describe"] }).ok).toBe(true);
    expect(parseWith(DescribeResultSchema, { v: [1], ops: [], version: "1.2.3" }).ok).toBe(true);
    expect(parseWith(DescribeResultSchema, { v: ["1"], ops: [] }).ok).toBe(false);
    expect(parseWith(DescribeResultSchema, { v: [1], ops: [], version: 1 }).ok).toBe(false);
  });

  // The facts are whole each time and stamped with when the module put them
  // together; a part it does not know yet is absent, never zeroed.
  test("session.facts: a stamp, and the parts the module knows", () => {
    for (const facts of [
      { at: 1 },
      { at: 1_791_955_713_123, model: "claude-opus-5-5[1m]" },
      { at: 2, model: "m", context: { window: 1_000_000, at: 2 } },
      { at: 3, api_error: { kind: "rate_limit", text: "API Error: 429", at: 3 } },
      { at: 4, effort: "xhigh", context: { window: 200_000, tokens: 0, at: 4 } },
      // Claude Code names the kinds: one this ccmsg does not know is kept.
      { at: 3, api_error: { kind: "some_new_kind", at: 3 } },
    ]) {
      expect(parseWith(SessionFactsSchema, facts)).toEqual({ ok: true, value: facts });
    }
    for (const facts of [
      {},
      { at: 0 },
      { at: 1.5 },
      { at: 1, model: "" },
      { at: 1, context: { window: 0, at: 1 } },
      { at: 1, context: { at: 1 } },
      { at: 1, context: { window: 200_000 } },
      { at: 1, api_error: { kind: "", at: 1 } },
      { at: 1, effort: "" },
      { at: 1, context: { window: 1, tokens: -1, at: 1 } },
      { at: 1, context: { window: 1, tokens: 1.5, at: 1 } },
      { at: 1, api_error: { text: "x", at: 1 } },
    ]) {
      expect(parseWith(SessionFactsSchema, facts).ok).toBe(false);
    }
  });

  test("session.facts is asked with no arguments", () => {
    expect(readSidecarRequest(line({ v: 1, op: "session.facts", id: "f", args: {} }))).toEqual({
      ok: true,
      value: { v: 1, op: "session.facts", id: "f", args: {} },
    });
    expect(
      readSidecarRequest(line({ v: 1, op: "session.facts", id: "f", args: { x: 1 } })).ok,
    ).toBe(false);
  });

  // What `ccmsg sidecar facts` reads on standard input.
  test("the facts as text are JSON of that shape", () => {
    expect(parseWith(SessionFactsTextSchema, '{"at":3,"model":"m"}')).toEqual({
      ok: true,
      value: { at: 3, model: "m" },
    });
    expect(parseWith(SessionFactsTextSchema, "{").ok).toBe(false);
  });
});

describe("the run id", () => {
  // Drawn once per module load: the load time, then random digits, so two
  // runs of a session loaded in the same millisecond still differ.
  test("is the start time and random digits, in the run id's own shape", () => {
    const startedAt = 1_791_955_713_123;
    const id = sidecarRunId(startedAt, 0.5);
    expect(id.startsWith(startedAt.toString(36))).toBe(true);
    expect(sidecarRunId(startedAt, 0.25)).not.toBe(id);
    for (const random of [0, 0.5, 0.999_999_999]) {
      expect(parseWith(SidecarRunIdSchema, sidecarRunId(startedAt, random)).ok).toBe(true);
    }
  });

  // It becomes part of a socket name, so nothing that can climb or split a
  // path is one.
  test("is lowercase letters and digits only, and not long", () => {
    for (const bad of ["", "../x", "a.b", "A1", "a b", "z".repeat(17)]) {
      expect(parseWith(SidecarRunIdSchema, bad).ok).toBe(false);
    }
    expect(parseWith(SidecarRunIdSchema, "z".repeat(16)).ok).toBe(true);
  });
});
