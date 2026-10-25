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
      additionalProperties: false,
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
  // (docs/findings/2026-10-25-launch-tool-input-schema.md), and the model has
  // no use for the converter's dialect.
  test("every tool's schema is one object, with no oneOf, anyOf or $schema", () => {
    for (const schema of Object.values(toolInputSchemas())) {
      expect(schema.type).toBe("object");
      for (const key of ["oneOf", "anyOf", "$schema"]) expect(schema).not.toHaveProperty(key);
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
