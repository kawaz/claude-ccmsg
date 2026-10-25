// The tools' input schemas as the model is shown them (DR-0018 §3.7,
// DR-0039 §3): derived from the schemas the handlers read the inputs with,
// each field described. It runs when the module is bundled, so a field left
// undescribed fails the bundle.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { describedObjectSchema, toolInputSchemas } from "./tool-input-schemas.ts";

describe("describedObjectSchema", () => {
  const S = v.strictObject({ x: v.string(), y: v.optional(v.boolean()) });

  test("puts each description on its field and keeps the rest of the shape", () => {
    expect(describedObjectSchema(S, { x: "An x.", y: "A y." })).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        x: { type: "string", description: "An x." },
        y: { type: "boolean", description: "A y." },
      },
      required: ["x"],
      additionalProperties: false,
    });
  });

  test("descriptions must describe the fields, no more and no fewer", () => {
    expect(() => describedObjectSchema(S, { x: "An x." })).toThrow("undescribed y; unknown ");
    expect(() => describedObjectSchema(S, { x: "An x.", y: "A y.", w: "A w." })).toThrow(
      "unknown w",
    );
  });
});

describe("toolInputSchemas: launch", () => {
  // Claude Code drops a tool whose schema has a top-level oneOf / anyOf
  // (docs/findings/2026-10-25-launch-tool-input-schema.md): launch's is one
  // flat object, claude's options as fields, without the fork point.
  test("is one flat object of claude's options, cwd required, no resume_session_at", () => {
    const schema = toolInputSchemas().launch;
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("anyOf");
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
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.continue).toMatchObject({ type: "boolean" });
    expect(schema.properties?.fork_session).toMatchObject({ type: "boolean" });
  });
});
