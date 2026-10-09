// The wire's requests (client -> daemon), as one schema (DR-0038).
//
// A client (the CLI, the webui, a session) writes one JSON request per line
// to the daemon's socket or WebSocket. Each request names its operation in
// `op` and carries the correlation id the reply echoes (`request_id`). The
// shape of every op is a schema in a request-*.ts file beside this one, by
// topic; this file joins them into the one request a line holds and reads a
// line with it, so the daemon handles a typed request or a typed reason it
// cannot.
//
// A field the daemon does not read is left out of the typed request rather
// than refused (`v.object`, not `v.strictObject`). ccmsg owns both ends of the
// wire, and the clients and the daemon of one host change together (DR-0002
// §4): what a client of another build may send is checked once, by hello's
// `protocol`, which refuses a client of another generation with a reply that
// says so. Refusing unknown fields would answer that client's hello, which may
// carry a field this daemon has never heard of, with a field error instead of
// the generation it speaks. The fields the daemon reads are all typed, so a
// field it does not read can do nothing.
import * as v from "valibot";
import { JsonTextSchema, type ParseFailure, parseWith } from "./parse.ts";
import { HelloRequestSchema } from "./request-sessions.ts";
import { PROTOCOL_VERSION, UNANNOUNCED_PROTOCOL_VERSION } from "./version.ts";
import {
  ArchiveRoomRequestSchema,
  CreateRoomRequestSchema,
  InviteRequestSchema,
  KickRequestSchema,
  LeaveRequestSchema,
  NextRoomRequestSchema,
  PostRequestSchema,
  ReadRequestSchema,
  ReplyRequestSchema,
  RoomHistoryRequestSchema,
  RoomsRequestSchema,
  SayReadRequestSchema,
  SayRequestSchema,
  SetTitleRequestSchema,
  SubscribeRequestSchema,
} from "./request-rooms.ts";
import {
  AgentsRequestSchema,
  DirTreeRequestSchema,
  ForkOriginRequestSchema,
  MessageSendRequestSchema,
  NotifyRequestSchema,
  PeersRequestSchema,
  SessionDumpFileRequestSchema,
  SessionEnvRequestSchema,
  SessionErrorsRequestSchema,
  SessionInputRequestSchema,
  SessionKillRequestSchema,
  SessionLaunchRequestSchema,
  SessionLauncherConfigRequestSchema,
  SessionRenameRequestSchema,
  SessionSearchRequestSchema,
  SessionStatusRequestSchema,
  SessionStatusSubscribeRequestSchema,
  SessionStatusUnsubscribeRequestSchema,
  SidecarReplyRequestSchema,
} from "./request-sessions.ts";
import {
  FsCreateRequestSchema,
  FsDeleteRequestSchema,
  FsEditRequestSchema,
  FsFindRequestSchema,
  FsListRequestSchema,
  FsListWorkspaceRequestSchema,
  FsReadExternalRequestSchema,
  FsReadRequestSchema,
  FsReadWorkspaceRequestSchema,
  FsStatBatchRequestSchema,
  FsWriteRequestSchema,
  SandboxGrantRequestSchema,
  SandboxRevokeRequestSchema,
} from "./request-files.ts";
import {
  ClientTraceRequestSchema,
  TranscriptReadRequestSchema,
  TranscriptSubscribeRequestSchema,
  TranscriptUnsubscribeRequestSchema,
} from "./request-transcripts.ts";
import {
  LlmStatsRequestSchema,
  LlmStatusRequestSchema,
  LlmUsageRequestSchema,
  PingRequestSchema,
  ShutdownRequestSchema,
  TranslateRequestSchema,
} from "./request-host.ts";

export * from "./request-rooms.ts";
export * from "./request-sessions.ts";
export * from "./request-files.ts";
export * from "./request-transcripts.ts";
export * from "./request-host.ts";

/** Correlation envelope every request carries (DR-0029 addendum). The daemon
 * echoes `request_id` on the matching reply, so a client pairs request and
 * reply by id and never by arrival order — which is what lets the daemon run
 * the requests of one connection concurrently instead of through a FIFO.
 *
 * Uniqueness only has to hold among one connection's in-flight requests; a
 * monotonic counter per socket is enough, and ids may be reused once settled.
 * Reject-before-dispatch failures that cannot name a request (unparseable
 * JSON, missing `op`, missing `request_id`) are the one class of reply that
 * carries no id — a client can only log those, never settle a caller with
 * them.
 *
 * A missing id is a `bad_request`, with no path that serves the older protocol
 * instead: breaking those clients was the deliberate choice (DR-0029 追補 /
 * DR-0002 §4 設計意図), and a `subscribe` predating this envelope is fixed by
 * restarting it. */
export const RequestEnvelopeSchema = v.object({
  request_id: v.pipe(v.string(), v.nonEmpty("Expected a request id, not an empty string")),
});
export type RequestEnvelope = v.InferOutput<typeof RequestEnvelopeSchema>;

/** Every request shape, before the correlation envelope, told apart by `op`.
 * Use `Request` (the wire form) unless you specifically mean "the body a
 * caller composes". */
export const RequestBodySchema = v.variant("op", [
  HelloRequestSchema,
  PostRequestSchema,
  ReplyRequestSchema,
  MessageSendRequestSchema,
  CreateRoomRequestSchema,
  NextRoomRequestSchema,
  SayRequestSchema,
  SayReadRequestSchema,
  SetTitleRequestSchema,
  ArchiveRoomRequestSchema,
  KickRequestSchema,
  SubscribeRequestSchema,
  ReadRequestSchema,
  RoomHistoryRequestSchema,
  RoomsRequestSchema,
  PeersRequestSchema,
  NotifyRequestSchema,
  DirTreeRequestSchema,
  SessionLaunchRequestSchema,
  SessionKillRequestSchema,
  SessionRenameRequestSchema,
  SessionInputRequestSchema,
  SidecarReplyRequestSchema,
  SessionEnvRequestSchema,
  SessionLauncherConfigRequestSchema,
  LlmUsageRequestSchema,
  LlmStatsRequestSchema,
  LlmStatusRequestSchema,
  FsListRequestSchema,
  FsReadRequestSchema,
  FsReadExternalRequestSchema,
  FsListWorkspaceRequestSchema,
  FsReadWorkspaceRequestSchema,
  FsWriteRequestSchema,
  FsCreateRequestSchema,
  FsDeleteRequestSchema,
  FsEditRequestSchema,
  FsStatBatchRequestSchema,
  FsFindRequestSchema,
  SandboxGrantRequestSchema,
  SandboxRevokeRequestSchema,
  TranscriptReadRequestSchema,
  SessionSearchRequestSchema,
  ForkOriginRequestSchema,
  SessionDumpFileRequestSchema,
  AgentsRequestSchema,
  TranscriptSubscribeRequestSchema,
  TranscriptUnsubscribeRequestSchema,
  ClientTraceRequestSchema,
  SessionStatusRequestSchema,
  SessionStatusSubscribeRequestSchema,
  SessionStatusUnsubscribeRequestSchema,
  SessionErrorsRequestSchema,
  PingRequestSchema,
  TranslateRequestSchema,
  ShutdownRequestSchema,
  LeaveRequestSchema,
  InviteRequestSchema,
]);
export type RequestBody = v.InferOutput<typeof RequestBodySchema>;

/** A request on the wire: one of the bodies above plus its correlation id.
 * The intersection distributes over the union, so `req.op` still narrows. */
export type Request = RequestBody & RequestEnvelope;

/** The ops a request can name. */
export type RequestOp = RequestBody["op"];

/** Every op, in the order the request schema lists them. */
export const REQUEST_OPS: readonly RequestOp[] = RequestBodySchema.options.map(
  (option) => option.entries.op.literal,
);

/** A request as a caller composes it: the body without the correlation
 * envelope, which the client's transport stamps on the way out. Distributive
 * so each member of the union keeps its own discriminated `op`. */
export type RequestBodyOf<T> = T extends unknown ? Omit<T, "request_id"> : never;
export type RequestInput = RequestBodyOf<Request>;

// --- reading a request line -------------------------------------------------

/** What a hello claims about the client behind it, read so that a hello of
 * any generation yields it: each claim is its value when it has the type this
 * generation gives it, and absent otherwise. It is what the daemon needs to
 * answer a hello it will not serve — which generation the client speaks, and
 * which session's client that is — before it knows the rest of the hello has
 * this generation's shape. */
export const HelloClaimsSchema = v.object({
  role: v.fallback(v.optional(v.picklist(["session", "user"])), undefined),
  sid: v.fallback(v.optional(v.string()), undefined),
  client_version: v.fallback(v.optional(v.string()), undefined),
  protocol: v.fallback(v.optional(v.number()), undefined),
});
export type HelloClaims = v.InferOutput<typeof HelloClaimsSchema>;

/** The generation a hello speaks: what it announced, or — for a client from
 * before the field existed — the generation that field was introduced in. */
export function helloGeneration(hello: HelloClaims): number {
  return hello.protocol ?? UNANNOUNCED_PROTOCOL_VERSION;
}

/** One request line as the daemon reads it: the request, or why it cannot be
 * handled. A failure that names a request id can be answered as that
 * request's reply; one that names none can only be answered uncorrelated.
 *
 * - `not_json`: the line is not JSON
 * - `no_op`: the value names no op (not an object, or `op` is not a string)
 * - `no_request_id`: the request carries no id to answer under; `hello` is
 *   what it claims as a hello, when it is one, so the daemon can tell which
 *   session's client is too old to send one
 * - `unknown_op`: the op is none this daemon has
 * - `other_generation`: a hello of a generation this daemon does not speak
 *   (DR-0002 §4); the rest of it is not read, since its shape is that
 *   generation's
 * - `invalid_args`: the op's fields are not what it takes. The failure names
 *   the first field that is not, however many are */
export type RequestRead =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly reason: "not_json"; readonly failure: ParseFailure }
  | { readonly ok: false; readonly reason: "no_op"; readonly failure: ParseFailure }
  | {
      readonly ok: false;
      readonly reason: "no_request_id";
      readonly op: string;
      readonly hello: HelloClaims | undefined;
      readonly failure: ParseFailure;
    }
  | {
      readonly ok: false;
      readonly reason: "unknown_op";
      readonly requestId: string;
      readonly op: string;
      readonly failure: ParseFailure;
    }
  | {
      readonly ok: false;
      readonly reason: "other_generation";
      readonly requestId: string;
      readonly hello: HelloClaims;
      readonly generation: number;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_args";
      readonly requestId: string;
      readonly op: RequestOp;
      readonly failure: ParseFailure;
    };

const OpLineSchema = v.object({ op: v.string() });
const KnownOpLineSchema = v.object({ op: v.picklist(REQUEST_OPS) });

/** Read one request line. A line that is not a request says the first thing
 * it is not — JSON, then an op, then a request id, then an op this daemon
 * has, then (for a hello) a generation it speaks, then that op's fields —
 * which is also the order in which a reply can say more: from the request id
 * on, it is answered as that request's reply. The JSON is decoded once, and
 * the decoded value read against each schema in turn. A sender's value can
 * hold any number of wrong parts, so each read stops at the first. */
export function readRequest(line: string): RequestRead {
  const firstIssue = { firstIssue: true } as const;
  const json = parseWith(JsonTextSchema, line, firstIssue);
  if (!json.ok) return { ok: false, reason: "not_json", failure: json.failure };
  const decoded = json.value;
  const named = parseWith(OpLineSchema, decoded, firstIssue);
  if (!named.ok) return { ok: false, reason: "no_op", failure: named.failure };
  const { op } = named.value;
  const claims = op === "hello" ? parseWith(HelloClaimsSchema, decoded, firstIssue) : undefined;
  const hello = claims?.ok ? claims.value : undefined;
  const envelope = parseWith(RequestEnvelopeSchema, decoded, firstIssue);
  if (!envelope.ok) {
    return { ok: false, reason: "no_request_id", op, hello, failure: envelope.failure };
  }
  const requestId = envelope.value.request_id;
  const known = parseWith(KnownOpLineSchema, decoded, firstIssue);
  if (!known.ok) return { ok: false, reason: "unknown_op", requestId, op, failure: known.failure };
  if (hello !== undefined && helloGeneration(hello) !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "other_generation",
      requestId,
      hello,
      generation: helloGeneration(hello),
    };
  }
  const body = parseWith(RequestBodySchema, decoded, firstIssue);
  if (!body.ok) {
    return {
      ok: false,
      reason: "invalid_args",
      requestId,
      op: known.value.op,
      failure: body.failure,
    };
  }
  return { ok: true, request: { ...body.value, request_id: requestId } };
}
