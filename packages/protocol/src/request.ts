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
import { JsonTextSchema, type ParseFailure, parseWith, type Output } from "./parse.ts";
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
 * A line whose frame does not read (not JSON, no `request_id`, no `op`) is the
 * one class of reply that carries no id — a client can only log those, never
 * settle a caller with them.
 *
 * A missing id is a `bad_request`, with no path that serves the older protocol
 * instead: breaking those clients was the deliberate choice (DR-0029 追補 /
 * DR-0002 §4 設計意図), and a `subscribe` predating this envelope is fixed by
 * restarting it. */
export const RequestEnvelopeSchema = v.object({
  request_id: v.pipe(v.string(), v.nonEmpty("Expected a request id, not an empty string")),
});
export type RequestEnvelope = Output<typeof RequestEnvelopeSchema>;

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
export type RequestBody = Output<typeof RequestBodySchema>;

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

// A line is read in two layers, each once. The frame is the wire's framing:
// the correlation id a reply is sent under and the op the line names. The
// request is the op's shape, read from the same decoded value. A line whose
// frame does not read has no id to answer under; a line whose frame reads but
// whose request does not is answered under its id, so the asker is settled.

/** The frame every request line has, whatever its op. */
export const RequestFrameSchema = v.object({
  ...RequestEnvelopeSchema.entries,
  op: v.string(),
});
export type RequestFrame = Output<typeof RequestFrameSchema>;

/** A request of this generation, or a hello of another, with its correlation
 * id. */
const RequestSchema = v.intersect([RequestBodySchema, RequestEnvelopeSchema]);

/** One request line, as read:
 *
 * - `request`: the typed request
 * - `invalid_request`: the frame reads but the request does not (an op this
 *   daemon does not serve, a field of another type); answered under
 *   `frame.request_id`
 * - `invalid_frame`: not JSON, or no `request_id` / `op`; answered under no id */
export type RequestRead =
  | { readonly kind: "request"; readonly request: Request }
  | {
      readonly kind: "invalid_request";
      readonly frame: RequestFrame;
      readonly failure: ParseFailure;
    }
  | { readonly kind: "invalid_frame"; readonly failure: ParseFailure };

/** Read one request line: its frame, then its request. A sender's value can
 * hold any number of wrong parts, so each read stops at the first. */
export function readRequest(line: string): RequestRead {
  const json = parseWith(JsonTextSchema, line);
  if (!json.ok) return { kind: "invalid_frame", failure: json.failure };
  const decoded = json.value;
  const frame = parseWith(RequestFrameSchema, decoded, { firstIssue: true });
  if (!frame.ok) return { kind: "invalid_frame", failure: frame.failure };
  const request = parseWith(RequestSchema, decoded, { firstIssue: true });
  return request.ok
    ? { kind: "request", request: request.value }
    : { kind: "invalid_request", frame: frame.value, failure: request.failure };
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
