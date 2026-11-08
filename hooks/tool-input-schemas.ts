// The JSON Schemas of the ccmsg tools' inputs, as the model is shown them,
// derived from the valibot schemas the module reads the inputs with
// (DR-0038 §1). The module imports this as a Bun macro: it runs when the
// module is bundled, and the bundle carries the schemas as literals, without
// the converter (`just build-hooks`).
//
// The schemas are kept to what a call needs to be written (DR-0039 §3, "mods
// の tool の作り方"): each field's type (an array's with its items' type), an enum's values, which fields are
// required, and a few words only on a field whose name does not say what it
// holds. No schema metadata (`$schema`, `additionalProperties` …). Every finer rule (a minimum length, a pattern, a range, which fields
// go together) stays in the valibot schema the handler reads the input with,
// and a call that breaks one is answered in text. How to use the tools is the
// skill's to say, by their full names.
import { type JsonSchema, toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";
import { LaunchFieldsSchema } from "@ccmsg/protocol/launch";
import {
  PeersToolInputSchema,
  SayToolInputSchema,
  SendToolInputSchema,
} from "@ccmsg/protocol/peer-tools";
import { PermitToolInputSchema } from "@ccmsg/protocol/permit-request";

/** A field as the model is shown it: its type, an enum's values, an
 * array's items and an object's fields shaped the same way (the type of a
 * list is what it holds, of an object its fields and which are required). */
function fieldShape(field: JsonSchema): JsonSchema {
  const items = field.items;
  const options = objectOptions(field);
  if (options !== null) return objectsShape(options);
  return {
    ...(field.type !== undefined ? { type: field.type } : {}),
    ...(field.enum !== undefined ? { enum: field.enum } : {}),
    ...(typeof items === "object" && !Array.isArray(items) ? { items: fieldShape(items) } : {}),
    ...(field.properties !== undefined ? objectShape(field) : {}),
  };
}

/** An object's fields, each shaped as fieldShape does, and which of them are
 * required. */
function objectShape(field: JsonSchema): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [name, inner] of Object.entries(field.properties ?? {})) {
    if (typeof inner !== "object") throw new Error(`field ${name} has no schema`);
    properties[name] = fieldShape(inner);
  }
  return {
    properties,
    ...(field.required !== undefined && field.required.length > 0
      ? { required: field.required }
      : {}),
  };
}

/** The options of a field that is one of several objects (a valibot union of
 * objects, `anyOf` in JSON Schema), or null when it is not that. */
function objectOptions(field: JsonSchema): JsonSchema[] | null {
  const options = field.anyOf;
  if (options === undefined || options.length === 0) return null;
  const objects = options.filter(
    (option): option is JsonSchema => typeof option === "object" && option.properties !== undefined,
  );
  return objects.length === options.length ? objects : null;
}

/** One of several objects, shown as one object: every option's fields, and
 * as required only what every option requires. Which fields go together is
 * a rule of the handler's schema, like the other combinations it keeps. */
function objectsShape(options: readonly JsonSchema[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const option of options) Object.assign(properties, objectShape(option).properties);
  const required = (options[0]?.required ?? []).filter((name) =>
    options.every((option) => option.required?.includes(name) === true),
  );
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** The object `schema` reads, as the model is shown it: each field's type and
 * enum and what is required, with `descriptions` on the fields named there.
 * Nothing else: keys that mean nothing to a model reading the schema in its
 * context (`$schema`, `$id`, `title`, `additionalProperties`) are left out,
 * and the handler's schema refuses a field it does not take. A description of a field the
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
  };
}

export function toolInputSchemas(): {
  send: JsonSchema;
  say: JsonSchema;
  peers: JsonSchema;
  launch: JsonSchema;
  permit: JsonSchema;
} {
  return {
    send: toolInputSchemaOf(SendToolInputSchema, { agent_id: "Running subagent's id" }),
    say: toolInputSchemaOf(SayToolInputSchema, { text: "日本語" }),
    peers: toolInputSchemaOf(PeersToolInputSchema),
    launch: toolInputSchemaOf(LaunchFieldsSchema, { resume: "Session id to resume" }),
    permit: toolInputSchemaOf(PermitToolInputSchema, {
      voice: "日本語",
      project_permissions:
        "完全一致形を推奨 (完全一致形の allow は classifier を通らない)。Edit / Read / Write は絶対パスで書く (~/ は効かない)",
    }),
  };
}
