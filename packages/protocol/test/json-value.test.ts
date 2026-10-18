// Any JSON value as a schema reads to a bounded depth: a value nested past it
// is a failure like any other shape, not an exhausted stack thrown out of
// parseWith (DR-0038 §1), and in a transcript only its own line fails (§3).
import { describe, expect, test } from "bun:test";
import {
  JSON_VALUE_MAX_DEPTH,
  type JsonValue,
  JsonObjectSchema,
  JsonValueSchema,
} from "../src/json-value.ts";
import { parseWith } from "../src/parse.ts";
import { TranscriptRowLineSchema } from "../src/transcript-row.ts";
import { line, toolResultBlock, userContentRow, userRow } from "./transcript-rows.ts";

/** `depth` arrays, each holding the next. */
function nestedArrays(depth: number): JsonValue {
  let value: JsonValue = [];
  for (let i = 1; i < depth; i++) value = [value];
  return value;
}

/** `depth` objects, each holding the next under "a". */
function nestedObjects(depth: number): JsonValue {
  let value: JsonValue = {};
  for (let i = 1; i < depth; i++) value = { a: value };
  return value;
}

describe("JsonValueSchema", () => {
  test("reads a value nested to the bound", () => {
    expect(parseWith(JsonValueSchema, nestedArrays(JSON_VALUE_MAX_DEPTH)).ok).toBe(true);
    expect(parseWith(JsonValueSchema, nestedObjects(JSON_VALUE_MAX_DEPTH)).ok).toBe(true);
    expect(parseWith(JsonObjectSchema, nestedObjects(JSON_VALUE_MAX_DEPTH)).ok).toBe(true);
  });

  test("a value nested past the bound is a failure naming the bound", () => {
    const read = parseWith(JsonValueSchema, nestedArrays(JSON_VALUE_MAX_DEPTH + 1));
    if (read.ok) throw new Error("expected the value not to read");
    expect(read.failure.summary).toContain(`deeper than ${JSON_VALUE_MAX_DEPTH}`);
  });

  test("objects count toward the bound as arrays do", () => {
    expect(parseWith(JsonValueSchema, nestedObjects(JSON_VALUE_MAX_DEPTH + 1)).ok).toBe(false);
    expect(parseWith(JsonObjectSchema, nestedObjects(JSON_VALUE_MAX_DEPTH + 1)).ok).toBe(false);
  });

  // Deep enough to exhaust the stack of a schema that recurses without a bound.
  test("a value far past the bound fails rather than throwing", () => {
    expect(parseWith(JsonValueSchema, nestedArrays(20_000)).ok).toBe(false);
  });
});

describe("a transcript line holding a too-deep value", () => {
  test("fails alone; the lines around it read", () => {
    const deep = line(
      userContentRow([toolResultBlock("ok")], { toolUseResult: nestedArrays(20_000) }),
    );
    const reads = [line(userRow()), deep, line(userRow())].map((text) =>
      parseWith(TranscriptRowLineSchema, text),
    );
    expect(reads.map((read) => read.ok)).toEqual([true, false, true]);
  });
});
