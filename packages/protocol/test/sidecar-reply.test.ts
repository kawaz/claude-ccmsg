// parseSidecarReply (DR-0035 §3): the one check the CLI that carries a reply
// and the daemon that takes it both apply.
import { describe, expect, test } from "bun:test";
import { parseSidecarReply } from "../src/index.ts";

describe("parseSidecarReply", () => {
  test("an ok reply keeps its result as given, whatever its shape", () => {
    expect(parseSidecarReply({ id: "a", ok: true, result: { outcome: "accepted" } })).toEqual({
      id: "a",
      ok: true,
      result: { outcome: "accepted" },
    });
    expect(parseSidecarReply({ id: "a", ok: true, result: null })).toEqual({
      id: "a",
      ok: true,
      result: null,
    });
  });

  test("a failed reply keeps code and message, and nothing else", () => {
    expect(
      parseSidecarReply({
        id: "a",
        ok: false,
        error: { code: "unknown_op", message: "no op x", extra: 1 },
      }),
    ).toEqual({ id: "a", ok: false, error: { code: "unknown_op", message: "no op x" } });
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
      expect(parseSidecarReply(value)).toHaveProperty("invalid");
    });
  }
});
