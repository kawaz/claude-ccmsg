// The tools' input schemas as the model is shown them (DR-0039 §3, "mods の
// tool の作り方"; DR-0018 §3.7): derived from the schemas the handlers read
// the inputs with, each field its type (and an enum's values) alone, a few
// words only where a field's name does not say what it holds. It runs when
// the module is bundled, so a description of no field fails the bundle.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { toolInputSchemaOf, toolInputSchemas } from "./tool-input-schemas.ts";

describe("toolInputSchemaOf", () => {
  const S = v.strictObject({
    id: v.pipe(v.string(), v.regex(/^[0-9a-f]+$/), v.minLength(8)),
    on: v.optional(v.boolean()),
    level: v.optional(v.picklist(["low", "high"])),
    count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  });

  // The finer rules stay in the valibot schema the handler reads with.
  test("keeps each field's type and enum, and drops every finer rule", () => {
    expect(toolInputSchemaOf(S)).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        on: { type: "boolean" },
        level: { enum: ["low", "high"], type: "string" },
        count: { type: "integer" },
      },
      required: ["id"],
    });
  });

  test("puts a description on the fields named, and none elsewhere", () => {
    expect(toolInputSchemaOf(S, { id: "Record id" }).properties).toMatchObject({
      id: { type: "string", description: "Record id" },
      on: { type: "boolean" },
    });
    expect(toolInputSchemaOf(S, { id: "Record id" }).properties?.on).not.toHaveProperty(
      "description",
    );
  });

  test("a description of no field fails", () => {
    expect(() => toolInputSchemaOf(S, { nothing: "x" })).toThrow(
      "descriptions of no field: nothing",
    );
  });

  // The type of a list is what it holds; the list's own rules (a length, a
  // check) stay in the valibot schema, as each item's do.
  test("shows a list field with its items' type, and drops the list's rules", () => {
    const L = v.object({
      paths: v.optional(
        v.pipe(
          v.array(v.pipe(v.string(), v.minLength(1))),
          v.maxLength(3),
          v.check((list) => new Set(list).size === list.length),
        ),
      ),
      levels: v.array(v.picklist(["low", "high"])),
    });
    expect(toolInputSchemaOf(L)).toEqual({
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        levels: { type: "array", items: { enum: ["low", "high"], type: "string" } },
      },
      required: ["levels"],
    });
  });

  // A schema with no required field says nothing of it.
  test("no required field leaves required out", () => {
    expect(toolInputSchemaOf(v.object({ a: v.optional(v.string()) }))).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });
});

describe("toolInputSchemas", () => {
  // Claude Code drops a tool whose schema has a top-level oneOf / anyOf
  // (docs/findings/2026-10-25-launch-tool-input-schema.md), and a model
  // reading the schema has no use for its metadata.
  test("every tool's schema is one object, with no oneOf, anyOf or metadata", () => {
    for (const schema of Object.values(toolInputSchemas())) {
      expect(schema.type).toBe("object");
      for (const key of ["oneOf", "anyOf", "$schema", "$id", "title", "additionalProperties"]) {
        expect(schema).not.toHaveProperty(key);
      }
    }
  });

  test("launch: claude's options without the fork point, cwd required", () => {
    const schema = toolInputSchemas().launch;
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "cwd",
      "model",
      "effort",
      "continue",
      "resume",
      "fork_session",
      "name",
      "prompt",
    ]);
    expect(schema.required).toEqual(["cwd"]);
  });
});
