// The agy tool's calls (DR-0066 §3): which fields go with which call, read
// from the one object the model writes.
import { describe, expect, test } from "bun:test";
import { AgyFieldsSchema, AgyIdSchema, agyMark, readAgyCall } from "../src/agy.ts";
import { parseWith } from "../src/parse.ts";

/** The call `input` makes, or why it is none: the fields read by the tool's
 * object, then by the row of §3's table they make. */
function call(input: Record<string, unknown>) {
  const fields = parseWith(AgyFieldsSchema, input);
  if (!fields.ok) return fields;
  return readAgyCall(fields.value);
}

describe("readAgyCall: the rows of §3's table", () => {
  test("a new run takes prompt and model, and effort, cwd, dirs and verbose besides", () => {
    const read = call({
      op: "run",
      prompt: "p",
      model: "gemini-3.8-flash",
      effort: "low",
      cwd: "/w",
      dirs: [{ path: "/d", write: true }],
      verbose: true,
    });
    expect(read).toEqual({
      ok: true,
      value: {
        op: "run",
        run: {
          prompt: "p",
          model: "gemini-3.8-flash",
          effort: "low",
          cwd: "/w",
          dirs: [{ path: "/d", write: true }],
          verbose: true,
        },
      },
    });
  });

  test("a new run without model is refused (K2): effort is optional, model is not", () => {
    expect(call({ op: "run", prompt: "p" }).ok).toBe(false);
    expect(call({ op: "run", prompt: "p", model: "m" }).ok).toBe(true);
  });

  test("a run that goes on refuses model, effort, cwd and dirs rather than drop them (K4)", () => {
    expect(call({ op: "run", agyid: "c1", prompt: "p" })).toEqual({
      ok: true,
      value: { op: "run", run: { agyid: "c1", prompt: "p" } },
    });
    for (const extra of [
      { model: "m" },
      { effort: "low" },
      { cwd: "/w" },
      { dirs: [] },
      { seq: 1 },
    ]) {
      const read = call({ op: "run", agyid: "c1", prompt: "p", ...extra });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.failure.summary).toContain(Object.keys(extra)[0] ?? "");
    }
  });

  test("status of one conversation takes seq and verbose; without agyid it takes nothing", () => {
    expect(call({ op: "status", agyid: "c1", seq: 3, verbose: true })).toEqual({
      ok: true,
      value: { op: "status", status: { agyid: "c1", seq: 3, verbose: true } },
    });
    expect(call({ op: "status" })).toEqual({ ok: true, value: { op: "status", status: null } });
    expect(call({ op: "status", verbose: true }).ok).toBe(false);
    expect(call({ op: "status", seq: 1 }).ok).toBe(false);
  });

  test("abort takes the agyid alone", () => {
    expect(call({ op: "abort", agyid: "c1" })).toEqual({
      ok: true,
      value: { op: "abort", abort: { agyid: "c1" } },
    });
    expect(call({ op: "abort" }).ok).toBe(false);
    expect(call({ op: "abort", agyid: "c1", verbose: true }).ok).toBe(false);
  });

  test("a prompt or model of no text, a relative cwd, a seq below 1 are refused", () => {
    expect(call({ op: "run", prompt: "", model: "m" }).ok).toBe(false);
    expect(call({ op: "run", prompt: "p", model: "" }).ok).toBe(false);
    expect(call({ op: "run", prompt: "p", model: "m", cwd: "w" }).ok).toBe(false);
    expect(call({ op: "status", agyid: "c1", seq: 0 }).ok).toBe(false);
    expect(call({ op: "status", agyid: "c1", seq: 1.5 }).ok).toBe(false);
  });

  test("dirs' write is required", () => {
    expect(call({ op: "run", prompt: "p", model: "m", dirs: [{ path: "/d" }] }).ok).toBe(false);
  });
});

describe("AgyIdSchema: only what the daemon uses the id for (§4)", () => {
  test("takes agy's ids of any shape", () => {
    for (const id of ["0b9f1c2e-6a4f-4c43-9c1b-1f0e4b3c2a10", "c1", "x".repeat(250)]) {
      expect(parseWith(AgyIdSchema, id).ok).toBe(true);
    }
  });

  test("refuses an empty id, a slash, a control character and more than 250 bytes", () => {
    for (const id of [
      "",
      "a/b",
      "a\nb",
      "a\u0000b",
      "a\u007fb",
      "x".repeat(251),
      "あ".repeat(84),
    ]) {
      expect(parseWith(AgyIdSchema, id).ok).toBe(false);
    }
  });
});

test("the mark names the conversation (K11)", () => {
  expect(agyMark("c1")).toBe("agyid:c1 から:");
});
