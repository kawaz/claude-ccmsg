// The JSON Schemas of the ccmsg tools' inputs, as the model is shown them,
// derived from the valibot schemas the module reads the inputs with
// (DR-0038 §1). The module imports this as a Bun macro: it runs when the
// module is bundled, and the bundle carries the schemas as literals, without
// the converter (`just build-hooks`).
//
// The schemas are kept to what a call needs to be written (DR-0039 §3, "mods
// の tool の作り方"): each field's type, an enum's values, which fields are
// required, and a few words only on a field whose name does not say what it
// holds. Every finer rule (a minimum length, a pattern, a range, which fields
// go together) stays in the valibot schema the handler reads the input with,
// and a call that breaks one is answered in text. How to use the tools is the
// skill's to say, by their full names.
import { type JsonSchema, toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";
import { LaunchToolFieldsSchema } from "@ccmsg/protocol/launch";
import {
  PeersToolInputSchema,
  SayToolInputSchema,
  SendToolInputSchema,
} from "@ccmsg/protocol/peer-tools";

/** A field as the model is shown it: its type, and an enum's values. */
function fieldShape(field: JsonSchema): JsonSchema {
  return {
    ...(field.type !== undefined ? { type: field.type } : {}),
    ...(field.enum !== undefined ? { enum: field.enum } : {}),
  };
}

/** The object `schema` reads, as the model is shown it: each field's type and
 * enum, what is required, and whether other fields are refused, with
 * `descriptions` on the fields named there. A description of a field the
 * object does not have fails the bundle rather than describe nothing. */
export function toolInputSchemaOf(
  schema: v.GenericSchema,
  descriptions: Readonly<Record<string, string>> = {},
): JsonSchema {
  const converted = toJsonSchema(schema, { errorMode: "ignore" });
  const fields = Object.entries(converted.properties ?? {});
  const unknown = Object.keys(descriptions).filter(
    (name) => !fields.some(([field]) => field === name),
  );
  if (unknown.length > 0) throw new Error(`descriptions of no field: ${unknown.join(", ")}`);
  const properties: Record<string, JsonSchema> = {};
  for (const [name, field] of fields) {
    if (typeof field !== "object") throw new Error(`field ${name} has no schema`);
    const description = descriptions[name];
    properties[name] = {
      ...fieldShape(field),
      ...(description !== undefined ? { description } : {}),
    };
  }
  return {
    type: "object",
    properties,
    ...(converted.required !== undefined && converted.required.length > 0
      ? { required: converted.required }
      : {}),
    ...(converted.additionalProperties !== undefined
      ? { additionalProperties: converted.additionalProperties }
      : {}),
  };
}

export function toolInputSchemas(): {
  send: JsonSchema;
  say: JsonSchema;
  peers: JsonSchema;
  launch: JsonSchema;
} {
  return {
    send: toolInputSchemaOf(SendToolInputSchema, { agent_id: "Running subagent's id" }),
    say: toolInputSchemaOf(SayToolInputSchema),
    peers: toolInputSchemaOf(PeersToolInputSchema),
    launch: toolInputSchemaOf(LaunchToolFieldsSchema, { resume: "Session id to resume" }),
  };
}
