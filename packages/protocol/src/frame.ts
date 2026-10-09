// Reading one line the daemon wrote to a client (DR-0038).
//
// A line is a push of the daemon's own (`ev`), a delivered storage event
// (`type`) or a reply to a request (`ok`): one schema, the union of the three,
// reads it. A line that is none of them is a failure, and nothing more is read
// from it.
//
// What a reply holds depends on the op it answers, and the line does not name
// the op: only the asker knows it, by the reply's `request_id`. So the frame
// hands back a reader the asker calls with its op, which reads the reply with
// that op's schema.
import * as v from "valibot";
import { JsonTextSchema, type ParseFailure, type Parsed, parseWith } from "./parse.ts";
import type { RequestOp } from "./request.ts";
import { ErrorResponseSchema, RESPONSE_SCHEMAS, type ReplyOf } from "./response.ts";
import { DeliveredEventSchema, PushStreamEventSchema, type StreamEvent } from "./stream-event.ts";

/** One line from the daemon, as a client reads it.
 *
 * - `reply`: an answer to a request. `requestId` is the request it names, or
 *   undefined for a reply that names none (the answer to a line whose frame the
 *   daemon could not read). `reply(op)` reads it as the answer to a
 *   request of `op`: the op's success reply or an ErrorResponse, without the
 *   envelope
 * - `event`: a push or a delivered storage event
 * - `invalid`: the line is not JSON, or none of the three */
export type DaemonFrame =
  | {
      readonly kind: "reply";
      readonly requestId: string | undefined;
      readonly reply: <Op extends RequestOp>(op: Op) => Parsed<ReplyOf<Op>>;
    }
  | { readonly kind: "event"; readonly event: StreamEvent }
  | { readonly kind: "invalid"; readonly failure: ParseFailure };

/** A reply, before it is read as the answer to an op. */
const ReplyEnvelopeSchema = v.object({
  ok: v.boolean(),
  request_id: v.optional(v.string()),
});

/** Every kind of line the daemon writes. */
const DaemonLineSchema = v.union([
  PushStreamEventSchema,
  DeliveredEventSchema,
  ReplyEnvelopeSchema,
]);

/** Read one line the daemon wrote. */
export function readDaemonFrame(line: string): DaemonFrame {
  const json = parseWith(JsonTextSchema, line);
  if (!json.ok) return { kind: "invalid", failure: json.failure };
  const decoded = json.value;
  const read = parseWith(DaemonLineSchema, decoded);
  if (!read.ok) return { kind: "invalid", failure: read.failure };
  const frame = read.value;
  if (!("ok" in frame)) return { kind: "event", event: frame };
  return {
    kind: "reply",
    requestId: frame.request_id,
    reply: <Op extends RequestOp>(op: Op): Parsed<ReplyOf<Op>> =>
      frame.ok ? parseWith(RESPONSE_SCHEMAS[op], decoded) : parseWith(ErrorResponseSchema, decoded),
  };
}
