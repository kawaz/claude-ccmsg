// The sidecar's request and reply lines (DR-0035 §3) as their schemas say
// them (DR-0038): what the module runs, what it refuses with which code, and
// what a reply in transit must carry.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import {
  DescribeResultSchema,
  PromptSendResultSchema,
  readSidecarRequest,
  SIDECAR_OP_NAMES,
  SIDECAR_OPS,
  SidecarReplySchema,
} from "../src/sidecar.ts";

const line = (value: object): string => JSON.stringify(value);

describe("readSidecarRequest", () => {
  test("a prompt.send keeps its text as given", () => {
    expect(
      readSidecarRequest(line({ v: 1, op: "prompt.send", id: "1", args: { text: " a\n" } })),
    ).toEqual({
      ok: true,
      request: { v: 1, op: "prompt.send", id: "1", args: { text: " a\n" } },
    });
  });

  test("a describe takes args {}", () => {
    expect(readSidecarRequest(line({ v: 1, op: "describe", id: "d", args: {} }))).toEqual({
      ok: true,
      request: { v: 1, op: "describe", id: "d", args: {} },
    });
  });

  // Fields the line does not define are left out, not refused: a newer
  // daemon's addition to the envelope does not stop an older module.
  test("fields beside v, op, id and args, or beside text, are left out", () => {
    expect(
      readSidecarRequest(
        line({ v: 1, op: "prompt.send", id: "1", args: { text: "a", at: 2 }, trace: "t" }),
      ),
    ).toEqual({ ok: true, request: { v: 1, op: "prompt.send", id: "1", args: { text: "a" } } });
  });

  // Without an id there is nothing to name in a reply.
  for (const [name, text] of [
    ["not JSON", "not json"],
    ["an array", "[1]"],
    ["no id", line({ v: 1, op: "describe", args: {} })],
    ["an empty id", line({ v: 1, op: "describe", id: "", args: {} })],
    ["an id that is not a string", line({ v: 1, op: "describe", id: 1, args: {} })],
  ] as const) {
    test(`${name} cannot be answered`, () => {
      const read = readSidecarRequest(text);
      expect(read.ok).toBe(false);
      expect(read).toHaveProperty("id", undefined);
    });
  }

  // The first thing that does not fit decides the code: version, then op,
  // then args.
  for (const [code, value] of [
    ["unsupported_version", { v: 2, op: "prompt.send", id: "q", args: { text: "x" } }],
    ["unsupported_version", { op: "describe", id: "q", args: {} }],
    ["unsupported_version", { v: { toString: null }, op: "nope", id: "q", args: {} }],
    ["unknown_op", { v: 1, op: "prompt.peek", id: "q", args: {} }],
    ["unknown_op", { v: 1, id: "q", args: {} }],
    ["invalid_args", { v: 1, op: "prompt.send", id: "q" }],
    ["invalid_args", { v: 1, op: "prompt.send", id: "q", args: {} }],
    ["invalid_args", { v: 1, op: "prompt.send", id: "q", args: { text: " \n\t" } }],
    ["invalid_args", { v: 1, op: "prompt.send", id: "q", args: { text: 1 } }],
    ["invalid_args", { v: 1, op: "describe", id: "q" }],
    ["invalid_args", { v: 1, op: "describe", id: "q", args: { x: 1 } }],
    ["invalid_args", { v: 1, op: "describe", id: "q", args: [] }],
  ] as const) {
    test(`${line(value)} is ${code}`, () => {
      const read = readSidecarRequest(line(value));
      expect(read).toMatchObject({ ok: false, id: "q", code });
    });
  }

  test("a refusal says what was read", () => {
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

  test("a failed reply keeps code and message, and nothing else", () => {
    expect(
      parseWith(SidecarReplySchema, {
        id: "a",
        ok: false,
        error: { code: "unknown_op", message: "no op x", extra: 1 },
      }),
    ).toEqual({
      ok: true,
      value: { id: "a", ok: false, error: { code: "unknown_op", message: "no op x" } },
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
});
