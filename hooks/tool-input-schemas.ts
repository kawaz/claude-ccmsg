// The JSON Schemas of the ccmsg tools' inputs, as the model is shown them,
// derived from the valibot schemas the module reads the inputs with
// (DR-0038 §1). The module imports this as a Bun macro: it runs when the
// module is bundled, and the bundle carries the schemas as literals, without
// the converter (`just build-hooks`).
import { type JsonSchema, toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";
import { LaunchToolFieldsSchema } from "@ccmsg/protocol/launch";
import {
  PeersToolInputSchema,
  SayToolInputSchema,
  SendToolInputSchema,
} from "@ccmsg/protocol/peer-tools";

/** What valibot checks beyond the shape (a text that is not only whitespace,
 * a send that names somebody, which of launch's options go together) has no
 * JSON Schema here; the handler answers it in text. The `$schema` the
 * converter adds says nothing the model uses, so it is left out. */
function inputSchemaOf(schema: v.GenericSchema): JsonSchema {
  const { $schema: _dialect, ...shape } = toJsonSchema(schema, { errorMode: "ignore" });
  return shape;
}

/** What `launch`'s fields mean, as the model reads them, with the
 * combinations the handler refuses (LaunchInputSchema's checks) said in
 * words, since a JSON Schema of one object cannot say them. */
const LAUNCH_FIELDS: Record<string, string> = {
  cwd: "The directory the session starts in, an absolute path. continue looks for the newest session there.",
  model:
    "claude --model. Required when neither continue nor resume is given (a new session); otherwise the launch command chooses when absent.",
  effort:
    "claude --effort. Required when neither continue nor resume is given (a new session); otherwise the launch command chooses when absent.",
  continue: "claude --continue: continue the newest session in cwd. Not with resume.",
  resume:
    "claude --resume: the id of the session to continue, under its own id (or, with fork_session, to copy). Not with continue.",
  fork_session:
    "claude --fork-session: start a new session holding a copy of the history of the session continue or resume names. Needs continue or resume.",
  name: "claude --name: the session's name. The launch command chooses when absent.",
  prompt: "The session's first prompt. The launch command chooses when absent.",
};

/** An object schema with a description on each field. A field `descriptions`
 * does not describe, or a description of no field, fails the bundle rather
 * than show the model an undescribed or stale field. */
export function describedObjectSchema(
  schema: v.GenericSchema,
  descriptions: Record<string, string>,
): JsonSchema {
  const converted = inputSchemaOf(schema);
  const fields = Object.entries(converted.properties ?? {});
  const names = fields.map(([name]) => name);
  const undescribed = names.filter((name) => descriptions[name] === undefined);
  const unknown = Object.keys(descriptions).filter((name) => !names.includes(name));
  if (undescribed.length > 0 || unknown.length > 0) {
    throw new Error(
      `descriptions do not match the fields: undescribed ${undescribed.join(", ")}; unknown ${unknown.join(", ")}`,
    );
  }
  const properties: Record<string, JsonSchema> = {};
  for (const [name, field] of fields) {
    if (typeof field !== "object") throw new Error(`field ${name} has no schema`);
    properties[name] = { ...field, description: descriptions[name] };
  }
  return { ...converted, properties };
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
    launch: describedObjectSchema(LaunchToolFieldsSchema, LAUNCH_FIELDS),
  };
}
