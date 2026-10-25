// The variant fold the launch tool's schema is made with (DR-0018 §3.7): one
// object the model can be shown, with what each type requires said in words.
// It runs when the module is bundled, so a variant it cannot fold fails the
// bundle.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { foldedVariantSchema } from "./tool-input-schemas.ts";

const A = v.strictObject({ kind: v.literal("a"), x: v.string(), y: v.optional(v.number()) });
const B = v.strictObject({ kind: v.literal("b"), x: v.optional(v.string()), z: v.boolean() });
const DESCRIBED = { kind: "Which.", x: "An x.", y: "A y.", z: "A z." };

describe("foldedVariantSchema", () => {
  test("folds the options into one object: the union of fields, required what all require", () => {
    expect(foldedVariantSchema("kind", [A, B], DESCRIBED)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        kind: { type: "string", enum: ["a", "b"], description: "Which." },
        x: {
          type: "string",
          description: "An x. Required when kind is a. Optional when kind is b.",
        },
        y: {
          type: "number",
          description: "A y. Optional when kind is a. Not accepted when kind is b.",
        },
        z: {
          type: "boolean",
          description: "A z. Required when kind is b. Not accepted when kind is a.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    });
  });

  test("a field every option requires is required, and said no more of", () => {
    const C = v.strictObject({ kind: v.literal("c"), x: v.string() });
    const D = v.strictObject({ kind: v.literal("d"), x: v.string() });
    expect(foldedVariantSchema("kind", [C, D], { kind: "Which.", x: "An x." })).toMatchObject({
      properties: { x: { type: "string", description: "An x." } },
      required: ["kind", "x"],
    });
  });

  test("a field whose shape differs between options fails rather than show one", () => {
    const C = v.strictObject({ kind: v.literal("c"), x: v.number() });
    expect(() => foldedVariantSchema("kind", [A, C], DESCRIBED)).toThrow(
      "field x differs between the options of the variant",
    );
  });

  test("descriptions must describe the fields, no more and no fewer", () => {
    expect(() => foldedVariantSchema("kind", [A, B], { kind: "Which.", x: "An x." })).toThrow(
      "undescribed y, z; unknown ",
    );
    expect(() => foldedVariantSchema("kind", [A, B], { ...DESCRIBED, w: "A w." })).toThrow(
      "unknown w",
    );
  });

  test("an option with no string literal under the key fails", () => {
    const loose = v.strictObject({ kind: v.string(), x: v.string() });
    expect(() => foldedVariantSchema("kind", [A, loose], DESCRIBED)).toThrow(
      "an option of the variant has no string literal kind",
    );
  });
});
