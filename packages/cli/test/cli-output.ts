// Reading what the CLI prints, for tests that run the real `ccmsg`: each
// line is read with the schema of what it is (a daemon reply, or one of the
// CLI's own answers), and a field the schema does not name fails the read.
import {
  type JsonObject,
  JsonObjectSchema,
  jsonText,
  JsonTextSchema,
  type Output,
  parseWith,
  RESPONSE_SCHEMAS,
  type RequestOp,
  type ResponseOf,
} from "@ccmsg/protocol";
import * as v from "valibot";
import { servedReply } from "../../daemon/test/helpers.ts";

/** `out` read with `schema`, which has to name every field the CLI printed:
 * a field it left out would read as absent, and a test asserting that field
 * absent would hold whatever the CLI printed. */
export function printed<S extends v.GenericSchema>(schema: S, out: string): Output<S> {
  const raw = parseWith(JsonTextSchema, out);
  if (!raw.ok) throw new Error(`the CLI printed no JSON: ${out}`);
  const read = parseWith(schema, raw.value);
  if (!read.ok) throw new Error(`the CLI printed something else: ${read.failure.summary}: ${out}`);
  if (!Bun.deepEquals(read.value, raw.value)) {
    throw new Error(`the CLI printed fields outside its schema: ${out}`);
  }
  return read.value;
}

/** What the CLI printed for a request of `op` the daemon served: its reply,
 * whole. */
export function served<Op extends RequestOp>(op: Op, out: string): ResponseOf<Op> {
  const reply = servedReply(op, out);
  printed(RESPONSE_SCHEMAS[op], out);
  return reply;
}

/** What `status` and `daemon start|stop` print: whether a daemon runs and,
 * when one does, its ping answer (`daemon stop` says only that it stopped
 * one). The fields the tests read are listed and the rest let through. */
export const CliStatusSchema = v.looseObject({
  running: v.optional(v.boolean()),
  version: v.optional(v.string()),
  pid: v.optional(v.number()),
  ok: v.optional(v.boolean()),
  started: v.optional(v.boolean()),
  stopped: v.optional(v.boolean()),
  restarted: v.optional(v.boolean()),
});

/** What a direct message (`post` or `reply` to a session) prints once it is
 * delivered. */
export const CliDeliveredSchema = v.object({ delivered: v.literal(true), mid: v.string() });

const JsonObjectTextSchema = jsonText(JsonObjectSchema);

/** A line of `subscribe`'s output read as a JSON object, or nothing when it
 * is not one (a line written for a person, not a program). */
export function jsonObjectLine(line: string): JsonObject | undefined {
  const read = parseWith(JsonObjectTextSchema, line);
  return read.ok ? read.value : undefined;
}
