// Any JSON value, as a schema (DR-0038 §3).
//
// For a value whose content is not decided where it is read: a value shown as
// it is (the input of a tool another program defines, a part of a row of a
// kind not known yet), or one whose shape is decided by something read
// elsewhere (a tool's result, by the tool that was called). It is still typed:
// what it holds is JSON and nothing else, so a reader goes down it by its kind
// and never meets an `unknown`.
import * as v from "valibot";

/** A JSON object, read-only. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any JSON value, read-only all the way down.
 *
 * Design rationale: a type cannot be inferred from a schema that refers to
 * itself (TypeScript reports the circularity), so the recursive type is
 * written out and the schemas are annotated with it, as with AgentTreeNode. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/** How many arrays and objects a JsonValue may nest. A schema that recurses
 * without a bound exhausts the stack on a deep enough value, and that throws
 * out of parseWith instead of failing the one value (DR-0038 §1, §3). The
 * deepest line in 3.2 million lines of real transcripts nests 16; the bound
 * leaves sixteen times that, and stays far below the depth where the stack
 * runs out. */
export const JSON_VALUE_MAX_DEPTH = 256;

const JsonScalarOptions = [v.string(), v.number(), v.boolean(), v.null()] as const;

const JsonScalarSchema = v.union(JsonScalarOptions);

/** A value that is a scalar, or an array or object of `inner`.
 *
 * Design rationale: the schema for a value is chosen by what kind of value it
 * is, rather than by a union trying each. v.record takes an array too (it is
 * an object), so a union would read an array that fails deep inside a second
 * time as a record, at every level: the work doubles per level, and past the
 * bound it never finishes. Choosing also keeps the failure the one from deep
 * inside, at its path, instead of a union's "none of these" at the top. The
 * kind is only told apart here; what the value holds is read by the schema
 * chosen. */
function holding(inner: v.GenericSchema<JsonValue>): v.GenericSchema<JsonValue> {
  const arrayOf = v.array(inner);
  const objectOf = v.record(v.string(), inner);
  return v.lazy((input) =>
    Array.isArray(input)
      ? arrayOf
      : typeof input === "object" && input !== null
        ? objectOf
        : JsonScalarSchema,
  );
}

/** The value one level below the top, built from the bottom up when the
 * module loads: past the bound only a scalar reads, and each level above
 * holds arrays and objects of the level below. A level per depth, because a
 * schema carries no count of how deep it is. */
function belowTheTop(): v.GenericSchema<JsonValue> {
  let level: v.GenericSchema<JsonValue> = v.union(
    JsonScalarOptions,
    `JSON nested deeper than ${JSON_VALUE_MAX_DEPTH} levels`,
  );
  for (let depth = JSON_VALUE_MAX_DEPTH - 1; depth >= 1; depth--) level = holding(level);
  return level;
}

const JsonValueBelowTopSchema = belowTheTop();

export const JsonValueSchema: v.GenericSchema<JsonValue> = holding(JsonValueBelowTopSchema);

export const JsonObjectSchema: v.GenericSchema<JsonObject> = v.record(
  v.string(),
  JsonValueBelowTopSchema,
);
