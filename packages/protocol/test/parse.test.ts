// The boundary helpers every reader of outside JSON goes through (DR-0038):
// a typed value or a typed failure, never a throw.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { errorText, JsonTextSchema, jsonText, parseWith } from "../src/parse.ts";

const Point = v.object({ x: v.number(), y: v.number() });
const PointText = jsonText(Point);

describe("parseWith", () => {
  test("a value of the shape is the typed value", () => {
    expect(parseWith(Point, { x: 1, y: 2 })).toEqual({ ok: true, value: { x: 1, y: 2 } });
  });

  test("a value not of the shape is a failure naming each issue by its path", () => {
    const read = parseWith(Point, { x: "1" });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.issues.map((i) => i.path)).toEqual(["x", "y"]);
    expect(read.failure.summary).toBe(
      'x: Invalid type: Expected number but received "1"; y: Invalid key: Expected "y" but received undefined',
    );
  });

  test("an issue with the value itself has the empty path, and the summary no prefix", () => {
    const read = parseWith(Point, null);
    expect(read).toEqual({
      ok: false,
      failure: {
        issues: [{ path: "", message: "Invalid type: Expected Object but received null" }],
        summary: "Invalid type: Expected Object but received null",
      },
    });
  });
});

describe("jsonText", () => {
  test("JSON text of the shape is the typed value", () => {
    expect(parseWith(PointText, '{"x":1,"y":2}')).toEqual({ ok: true, value: { x: 1, y: 2 } });
  });

  // Not JSON at all is a failure like a wrong shape, not a throw.
  test("text that is not JSON is a failure", () => {
    const read = parseWith(PointText, "{");
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.summary).toStartWith("Invalid JSON");
  });

  test("JSON of another shape is a failure", () => {
    expect(parseWith(PointText, "[1,2]").ok).toBe(false);
  });
});

describe("JsonTextSchema", () => {
  test("decodes JSON text without reading its shape", () => {
    expect(parseWith(JsonTextSchema, '[1,{"a":null}]')).toEqual({
      ok: true,
      value: [1, { a: null }],
    });
    expect(parseWith(JsonTextSchema, "{").ok).toBe(false);
  });
});

describe("errorText", () => {
  test("names an Error and says only the type of anything else", () => {
    expect(errorText(new TypeError("bad"))).toBe("TypeError: bad");
    expect(errorText({ toString: null })).toBe("a thrown object");
    expect(errorText("x")).toBe("a thrown string");
    expect(errorText(undefined)).toBe("a thrown undefined");
  });
});
