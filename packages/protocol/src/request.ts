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
import { jsonText, type Parsed, parseWith } from "./parse.ts";
import {
  AnyGenerationHelloRequestSchema,
  HelloRequestSchema,
  type OtherGenerationHelloRequest,
} from "./request-sessions.ts";
import { PROTOCOL_VERSION } from "./version.ts";
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
 * A line the request schema does not read (not JSON, no op of this daemon, no
 * `request_id`, a field of another type) is the one class of reply that
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

/** Every op's request but hello's, which comes in a shape per generation. */
const OP_REQUEST_SCHEMAS = [
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
] as const;

/** Every request shape, before the correlation envelope, told apart by `op`
 * (and a hello by its generation). Use `Request` (the wire form) unless you
 * specifically mean "the body a caller composes". */
export const RequestBodySchema = v.variant("op", [
  AnyGenerationHelloRequestSchema,
  ...OP_REQUEST_SCHEMAS,
]);
export type RequestBody = v.InferOutput<typeof RequestBodySchema>;

/** A request on the wire: one of the bodies above plus its correlation id.
 * The intersection distributes over the union, so `req.op` still narrows. */
export type Request = RequestBody & RequestEnvelope;

/** The ops a request can name. */
export type RequestOp = RequestBody["op"];

/** Every op, in the order the request schema lists them. */
export const REQUEST_OPS: readonly RequestOp[] = [
  HelloRequestSchema.entries.op.literal,
  ...OP_REQUEST_SCHEMAS.map((option) => option.entries.op.literal),
];

/** A request as a caller composes it: the body without the correlation
 * envelope, which the client's transport stamps on the way out. Distributive
 * so each member of the union keeps its own discriminated `op`. A caller
 * speaks this generation, so a hello of another is not one it composes. */
export type RequestBodyOf<T> = T extends unknown ? Omit<T, "request_id"> : never;
export type RequestInput = RequestBodyOf<ServedRequest>;

/** A request the daemon serves: any but a hello of another generation. */
export type ServedRequest = Exclude<Request, OtherGenerationHelloRequest>;

// --- reading a request line -------------------------------------------------

/** One request line: a request of this generation, or a hello of another,
 * with its correlation id. */
const RequestLineSchema = jsonText(v.intersect([RequestBodySchema, RequestEnvelopeSchema]));

/** Read one request line, once, with the request schema. A line that is not
 * a request is a failure, and nothing more is read from it. A sender's value
 * can hold any number of wrong parts, so the read stops at the first. */
export function readRequest(line: string): Parsed<Request> {
  return parseWith(RequestLineSchema, line, { firstIssue: true });
}

/** Whether a request is a hello of a generation this daemon does not speak
 * (DR-0002 §4): one to refuse with the generation it speaks, not to serve. */
export function isOtherGenerationHello(
  request: Request,
): request is Exclude<Request, ServedRequest> {
  return (
    request.op === "hello" &&
    request.protocol !== undefined &&
    request.protocol !== PROTOCOL_VERSION
  );
}
