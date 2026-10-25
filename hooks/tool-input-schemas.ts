// The JSON Schemas of the ccmsg tools' inputs, as the model is shown them,
// derived from the valibot schemas the module reads the inputs with
// (DR-0038 §1). The module imports this as a Bun macro: it runs when the
// module is bundled, and the bundle carries the schemas as literals, without
// the converter (`just build-hooks`).
import { type JsonSchema, toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";
import { LaunchInputSchema } from "@ccmsg/protocol/launch";
import {
  PeersToolInputSchema,
  SayToolInputSchema,
  SendToolInputSchema,
} from "@ccmsg/protocol/peer-tools";

/** What valibot checks beyond the shape (a text that is not only whitespace,
 * a send that names somebody) has no JSON Schema here; the handler answers
 * it in text. */
function inputSchemaOf(schema: v.GenericSchema): JsonSchema {
  return toJsonSchema(schema, { errorMode: "ignore" });
}

/** What `launch`'s fields mean, as the model reads them. Which type requires,
 * allows or refuses each field is added from the schema (`whenText`). */
const LAUNCH_FIELDS: Record<string, string> = {
  type: "new: a new session. continue: the newest session in cwd, continued. resume: the session resume_session_id names, continued under its own id. fork: a new session holding a copy of the history of resume_session_id (up to resume_at when given).",
  cwd: "The directory the session starts in, an absolute path. continue looks for the newest session there.",
  name: "The session's name (claude --name). The launch command chooses when absent.",
  prompt: "The session's first prompt. The launch command chooses when absent.",
  model: "claude --model. The launch command chooses when absent.",
  effort: "claude --effort. The launch command chooses when absent.",
  resume_session_id: "The id of the session to continue or copy (claude --resume).",
  resume_at:
    "The uuid of the transcript record the fork copies up to (claude --resume-session-at). The tip when absent.",
};

/** `a`, `a or b`, `a, b or c`. */
function orList(words: readonly string[]): string {
  const last = words.at(-1) ?? "";
  return words.length <= 1 ? last : `${words.slice(0, -1).join(", ")} or ${last}`;
}

/** Which of the types require, allow and refuse a field, in words; empty when
 * every type requires it or every type allows it. */
function whenText(key: string, required: string[], optional: string[], refused: string[]): string {
  if (optional.length === 0 && refused.length === 0) return "";
  if (required.length === 0 && refused.length === 0) return "";
  return [
    required.length > 0 ? `Required when ${key} is ${orList(required)}.` : "",
    optional.length > 0 ? `Optional when ${key} is ${orList(optional)}.` : "",
    refused.length > 0 ? `Not accepted when ${key} is ${orList(refused)}.` : "",
  ]
    .filter((s) => s !== "")
    .join(" ");
}

/** The options of a variant on `key` folded into one object schema: the union
 * of their properties, `key` an enum of the options' values, required only
 * what every option requires, and each field's description saying which
 * options require, allow and refuse it.
 *
 * Design rationale: one object rather than the variant's own conversion (a
 * top-level `oneOf`). Claude Code leaves a registered tool whose input schema
 * has a top-level `oneOf` or `anyOf` out of the session's tools, as one the
 * Anthropic API does not take (docs/findings/2026-10-25-launch-tool-input-schema.md).
 * What the fold loses (which fields each type requires and refuses) is said
 * in the descriptions, and the handler reads the input with the variant. A
 * field whose schema differs between options, or one `descriptions` does not
 * describe, fails the bundle rather than be shown one option's shape. */
export function foldedVariantSchema(
  key: string,
  options: readonly v.GenericSchema[],
  descriptions: Record<string, string>,
): JsonSchema {
  const converted = options.map((option) => {
    const schema = inputSchemaOf(option);
    const tag = schema.properties?.[key];
    if (typeof tag !== "object" || typeof tag.const !== "string") {
      throw new Error(`an option of the variant has no string literal ${key}`);
    }
    return { tag: tag.const, schema };
  });
  const tags = converted.map((c) => c.tag);
  const fields = new Map<string, JsonSchema>();
  for (const { schema } of converted) {
    for (const [name, field] of Object.entries(schema.properties ?? {})) {
      if (name === key) continue;
      if (typeof field !== "object") throw new Error(`field ${name} has no schema`);
      const seen = fields.get(name);
      if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(field)) {
        throw new Error(`field ${name} differs between the options of the variant`);
      }
      fields.set(name, field);
    }
  }
  const names = [key, ...fields.keys()];
  const undescribed = names.filter((name) => descriptions[name] === undefined);
  const unknown = Object.keys(descriptions).filter((name) => !names.includes(name));
  if (undescribed.length > 0 || unknown.length > 0) {
    throw new Error(
      `descriptions do not match the fields: undescribed ${undescribed.join(", ")}; unknown ${unknown.join(", ")}`,
    );
  }
  const properties: Record<string, JsonSchema> = {
    [key]: { type: "string", enum: tags, description: descriptions[key] },
  };
  const required = [key];
  for (const [name, field] of fields) {
    const by = (test: (schema: JsonSchema) => boolean): string[] =>
      converted.filter((c) => test(c.schema)).map((c) => c.tag);
    const present = (schema: JsonSchema): boolean => schema.properties?.[name] !== undefined;
    const needed = (schema: JsonSchema): boolean => schema.required?.includes(name) === true;
    const requiredIn = by((s) => needed(s));
    const optionalIn = by((s) => present(s) && !needed(s));
    const refusedIn = by((s) => !present(s));
    if (requiredIn.length === converted.length) required.push(name);
    const when = whenText(key, requiredIn, optionalIn, refusedIn);
    const meaning = descriptions[name] ?? "";
    properties[name] = { ...field, description: when === "" ? meaning : `${meaning} ${when}` };
  }
  return {
    $schema: converted[0]?.schema.$schema,
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function toolInputSchemas(): {
  send: JsonSchema;
  say: JsonSchema;
  peers: JsonSchema;
  launch: JsonSchema;
} {
  return {
    send: inputSchemaOf(SendToolInputSchema),
    say: inputSchemaOf(SayToolInputSchema),
    peers: inputSchemaOf(PeersToolInputSchema),
    launch: foldedVariantSchema("type", LaunchInputSchema.options, LAUNCH_FIELDS),
  };
}
