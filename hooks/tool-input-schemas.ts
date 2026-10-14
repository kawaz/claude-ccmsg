// The JSON Schemas of the ccmsg tools' inputs, as the model is shown them,
// derived from the valibot schemas the module reads the inputs with
// (DR-0038 §1). The module imports this as a Bun macro: it runs when the
// module is bundled, and the bundle carries the schemas as literals, without
// the converter (`just build-hooks`).
import { toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";
import {
  PeersToolInputSchema,
  SayToolInputSchema,
  SendToolInputSchema,
} from "@ccmsg/protocol/peer-tools";

/** What valibot checks beyond the shape (a text that is not only whitespace,
 * a send that names somebody) has no JSON Schema here; the handler answers
 * it in text. */
function inputSchemaOf(schema: v.GenericSchema): object {
  return toJsonSchema(schema, { errorMode: "ignore" });
}

export function toolInputSchemas(): { send: object; say: object; peers: object } {
  return {
    send: inputSchemaOf(SendToolInputSchema),
    say: inputSchemaOf(SayToolInputSchema),
    peers: inputSchemaOf(PeersToolInputSchema),
  };
}
