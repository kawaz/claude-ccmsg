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

export const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(JsonValueSchema),
    JsonObjectSchema,
  ]),
);

export const JsonObjectSchema: v.GenericSchema<JsonObject> = v.record(v.string(), JsonValueSchema);
