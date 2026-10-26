// The wire's replies (daemon -> client), by the op each answers (DR-0038).
//
// The daemon answers every request with one reply carrying back its
// `request_id`: either the op's own success shape (`ok: true`, a schema in a
// response-*.ts file beside this one, by topic) or an ErrorResponse
// (`ok: false`). This file joins them by op, so a client that knows which op
// it asked reads the reply with that op's schema (frame.ts).
import * as v from "valibot";
import type { Output } from "./parse.ts";
import type { RequestOp } from "./request.ts";
import type { ErrorResponse } from "./response-error.ts";
import {
  FsCreateResponseSchema,
  FsDeleteResponseSchema,
  FsEditResponseSchema,
  FsFindResponseSchema,
  FsListResponseSchema,
  FsReadResponseSchema,
  FsStatBatchResponseSchema,
  FsWriteResponseSchema,
  SandboxGrantResponseSchema,
  SandboxRevokeResponseSchema,
} from "./response-files.ts";
import {
  LlmKeepalivePauseResponseSchema,
  LlmStatsResponseSchema,
  LlmStatusResponseSchema,
  LlmUsageResponseSchema,
  PingResponseSchema,
  ShutdownResponseSchema,
  TranslateResponseSchema,
} from "./response-host.ts";
import {
  ReadResponseSchema,
  RoomHistoryResponseSchema,
  RoomsResponseSchema,
} from "./response-rooms.ts";
import { SessionLaunchResponseSchema } from "./launch.ts";
import { PeerListResponseSchema, SendMessageResponseSchema } from "./peer-tools.ts";
import {
  PermitAttachmentReadResponseSchema,
  PermitRequestReadResponseSchema,
  PermitRequestResponseSchema,
} from "./permit-request.ts";
import {
  UserMessageResponseSchema,
  AgentsResponseSchema,
  DirTreeResponseSchema,
  ForkOriginResponseSchema,
  HelloResponseSchema,
  NotifyResponseSchema,
  PeersResponseSchema,
  SayReadResponseSchema,
  SayResponseSchema,
  SessionDumpFileResponseSchema,
  SessionEnvResponseSchema,
  SessionErrorsResponseSchema,
  UserPromptResponseSchema,
  RequestOverrideResponseSchema,
  SessionKillResponseSchema,
  SessionRestartResponseSchema,
  SessionLauncherConfigResponseSchema,
  SessionRenameResponseSchema,
  SessionSearchResponseSchema,
  SessionStatusResponseSchema,
  SessionStatusSubscribeResponseSchema,
  SessionStatusUnsubscribeResponseSchema,
  SidecarHelloResponseSchema,
  SessionFactsResponseSchema,
  SidecarReplyResponseSchema,
  SubscribeAckSchema,
} from "./response-sessions.ts";
import {
  ClientTraceResponseSchema,
  TranscriptReadResponseSchema,
  TranscriptSubscribeResponseSchema,
  TranscriptUnsubscribeResponseSchema,
} from "./response-transcripts.ts";

export * from "./response-rooms.ts";
export * from "./response-sessions.ts";
export * from "./response-files.ts";
export * from "./response-transcripts.ts";
export * from "./response-host.ts";
export * from "./response-error.ts";

/** Each op's success reply. An op that answers with the same shape as
 * another names the same schema (fs_read_external, fs_read_workspace and
 * fs_read; fs_list_workspace and fs_list; session_status_subscribe and
 * session_status). */
export const RESPONSE_SCHEMAS = {
  hello: HelloResponseSchema,
  user_message: UserMessageResponseSchema,
  send_message: SendMessageResponseSchema,
  peer_list: PeerListResponseSchema,
  say: SayResponseSchema,
  say_read: SayReadResponseSchema,
  permit_request: PermitRequestResponseSchema,
  permit_request_read: PermitRequestReadResponseSchema,
  permit_attachment_read: PermitAttachmentReadResponseSchema,
  subscribe: SubscribeAckSchema,
  read: ReadResponseSchema,
  room_history: RoomHistoryResponseSchema,
  rooms: RoomsResponseSchema,
  peers: PeersResponseSchema,
  notify: NotifyResponseSchema,
  dir_tree: DirTreeResponseSchema,
  session_launch: SessionLaunchResponseSchema,
  session_kill: SessionKillResponseSchema,
  session_restart: SessionRestartResponseSchema,
  session_rename: SessionRenameResponseSchema,
  user_prompt: UserPromptResponseSchema,
  request_override: RequestOverrideResponseSchema,
  sidecar_reply: SidecarReplyResponseSchema,
  sidecar_hello: SidecarHelloResponseSchema,
  session_facts: SessionFactsResponseSchema,
  session_env: SessionEnvResponseSchema,
  session_launcher_config: SessionLauncherConfigResponseSchema,
  llm_usage: LlmUsageResponseSchema,
  llm_stats: LlmStatsResponseSchema,
  llm_status: LlmStatusResponseSchema,
  llm_keepalive_pause: LlmKeepalivePauseResponseSchema,
  fs_list: FsListResponseSchema,
  fs_read: FsReadResponseSchema,
  fs_read_external: FsReadResponseSchema,
  fs_list_workspace: FsListResponseSchema,
  fs_read_workspace: FsReadResponseSchema,
  fs_write: FsWriteResponseSchema,
  fs_create: FsCreateResponseSchema,
  fs_delete: FsDeleteResponseSchema,
  fs_edit: FsEditResponseSchema,
  fs_stat_batch: FsStatBatchResponseSchema,
  fs_find: FsFindResponseSchema,
  sandbox_grant: SandboxGrantResponseSchema,
  sandbox_revoke: SandboxRevokeResponseSchema,
  transcript_read: TranscriptReadResponseSchema,
  session_search: SessionSearchResponseSchema,
  fork_origin: ForkOriginResponseSchema,
  session_dump_file: SessionDumpFileResponseSchema,
  agents: AgentsResponseSchema,
  transcript_subscribe: TranscriptSubscribeResponseSchema,
  transcript_unsubscribe: TranscriptUnsubscribeResponseSchema,
  client_trace: ClientTraceResponseSchema,
  session_status: SessionStatusResponseSchema,
  session_status_subscribe: SessionStatusSubscribeResponseSchema,
  session_status_unsubscribe: SessionStatusUnsubscribeResponseSchema,
  session_errors: SessionErrorsResponseSchema,
  ping: PingResponseSchema,
  translate: TranslateResponseSchema,
  shutdown: ShutdownResponseSchema,
} as const satisfies { readonly [Op in RequestOp]: v.GenericSchema };

/** The success reply to a request of `Op`, without the correlation envelope. */
export type ResponseOf<Op extends RequestOp> = Output<(typeof RESPONSE_SCHEMAS)[Op]>;

/** Either reply a request of `Op` can get. */
export type ReplyOf<Op extends RequestOp> = ResponseOf<Op> | ErrorResponse;

/** Every reply shape, before the correlation envelope. */
export type ResponseBody = ResponseOf<RequestOp> | ErrorResponse;

/** A reply on the wire: one of the bodies above, carrying back the
 * `request_id` of the request it answers.
 *
 * Optional in the type, required in the daemon's behaviour: the id is missing
 * only where no request could be identified (see RequestEnvelope) or where the
 * peer is a daemon predating the correlation envelope, and both are cases a
 * client handles as "cannot settle anyone", not as a normal reply. */
export type Response = ResponseBody & { request_id?: string };
