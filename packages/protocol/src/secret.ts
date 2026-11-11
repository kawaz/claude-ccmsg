// A secret value handed from the webui to a session's agent (DR-0052): the
// person pastes it in the Status tab, the daemon holds it in memory under an
// id for a while and tells the session the id, and the agent pipes it out of
// `ccmsg secret take <id>`. As schemas (DR-0038): the two ops' requests and
// replies.
//
// Imports nothing but valibot and the schema files beside it, as the other
// schema files.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import { SendMessageResultSchema } from "./peer-tools.ts";

/** How long the daemon holds a secret after it was handed in (DR-0052 §4):
 * five minutes, the span the notice names. */
export const SECRET_TTL_MS = 5 * 60 * 1000;

/** The longest value a secret may be, as a JavaScript string's length. */
export const SECRET_MAX_LENGTH = 65_536;

/** A secret's value on the wire, verbatim.
 *
 * Design rationale: every check names its own message. A refusal is written
 * into daemon.log and the reply (DR-0052 §8), and valibot's default message
 * of a check on a string's content quotes the string it refuses (`v.regex`:
 * `Expected /…/ but received "<the value>"`): a message of this schema names
 * what is wrong and nothing of the value, and a check added to it names its
 * own too. */
export const SecretValueTextSchema = v.pipe(
  v.string("Expected the secret's value as a string"),
  v.minLength(1, "Expected a secret value that is not empty"),
  v.maxLength(
    SECRET_MAX_LENGTH,
    `Expected a secret value of at most ${String(SECRET_MAX_LENGTH)} characters`,
  ),
);

/** Hand a value to the daemon for session `session_id` (user role only,
 * DR-0052 §3-§5): the webui's paste. The daemon holds it under a fresh id
 * and tells the session the id; when that notice does not arrive, it holds
 * nothing. */
export const SecretPutRequestSchema = v.object({
  op: v.literal("secret_put"),
  session_id: v.pipe(v.string(), v.nonEmpty("Expected a session id, not an empty string")),
  value: SecretValueTextSchema,
});
export type SecretPutRequest = Output<typeof SecretPutRequestSchema>;

/** The value held under `id` (user role only, DR-0052 §6): what `ccmsg secret
 * take <id>` writes to its standard output. Who asks is not checked; knowing
 * the id is what lets one take it. An id the daemon holds nothing under (it
 * expired or was never issued) is `not_found`. */
export const SecretTakeRequestSchema = v.object({
  op: v.literal("secret_take"),
  id: v.pipe(v.string(), v.nonEmpty("Expected a secret id, not an empty string")),
});
export type SecretTakeRequest = Output<typeof SecretTakeRequestSchema>;

/** secret_put's reply: what came of the notice to the session (DR-0039 §9's
 * result for it). On `not_delivered` the daemon holds nothing. `chars` is the
 * value's length in Unicode code points, as the webui says it. */
export const SecretPutResponseSchema = v.object({
  ok: v.literal(true),
  notice: SendMessageResultSchema,
  chars: v.number(),
});
export type SecretPutResponse = Output<typeof SecretPutResponseSchema>;

/** secret_take's reply: the value as it was handed in. */
export const SecretTakeResponseSchema = v.object({
  ok: v.literal(true),
  value: SecretValueTextSchema,
});
export type SecretTakeResponse = Output<typeof SecretTakeResponseSchema>;
