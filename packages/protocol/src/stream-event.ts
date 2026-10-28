// What the daemon pushes to a subscribed connection unasked (daemon ->
// client), as schemas (DR-0038): ephemeral, never persisted, told apart by
// `ev`.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): see response-rooms.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import { PermitRequestRecordSchema } from "./permit-request.ts";
import {
  RequestOverrideStateSchema,
  RequestOverrideTargetSchema,
  RequestValuesSchema,
} from "./request-override.ts";
import { ClaudeVersionSchema, LlmStatusReportSchema } from "./response-host.ts";
import { AgentInfoSchema, PeerInfoSchema } from "./response-sessions.ts";
import { SessionErrorEntrySchema, SessionStatusSnapshotSchema } from "./session-status.ts";

/** One say the person has not read (DR-0045 §7): a `say` tool call on the
 * main thread of a live session, by the id of its tool_use. */
export const UnreadSaySchema = v.object({
  session_id: v.string(),
  /** The tool_use's id: what `say_read` names. */
  tool_use_id: v.string(),
  /** The time of the transcript row that made the call. */
  ts: v.string(),
});
export type UnreadSay = Output<typeof UnreadSaySchema>;

/** Every say the person has not read, oldest first (user-role subscribers
 * only, same webui-only posture as ev:"peers"). Sent at subscribe time, even
 * when empty, and again whenever the set changes: always the full set, so a
 * tab replaces what it held. Never sent to a session: the session that spoke
 * knows it spoke, and reading is the person's gesture. */
export const SayUnreadStreamEventSchema = v.object({
  ev: v.literal("say_unread"),
  says: v.array(UnreadSaySchema),
});
export type SayUnreadStreamEvent = Output<typeof SayUnreadStreamEventSchema>;

/** Every request for permission the daemon holds, oldest first (DR-0040 §5,
 * user-role subscribers only, like ev:"say_unread"). Sent at subscribe time, even
 * when empty, so a tab that reconnects to a restarted daemon drops what the
 * old one held. */
export const PermitRequestsStreamEventSchema = v.object({
  ev: v.literal("permit_requests"),
  requests: v.array(PermitRequestRecordSchema),
});
export type PermitRequestsStreamEvent = Output<typeof PermitRequestsStreamEventSchema>;

/** One request for permission the daemon has just recorded, or just marked
 * read, to the same subscribers; a tab puts it in place of the one of the
 * same id, or adds it. One rather than the whole set as ev:"say_unread" sends:
 * only a request's `read` ever changes, so the catch-up above and these
 * single records are all a tab needs. */
export const PermitRequestStreamEventSchema = v.object({
  ev: v.literal("permit_request"),
  request: PermitRequestRecordSchema,
});
export type PermitRequestStreamEvent = Output<typeof PermitRequestStreamEventSchema>;

/** The overrides of every session the daemon knows them of (DR-0041 §5,
 * user-role subscribers only, like ev:"permit_requests"): what each session's
 * main-thread requests are sent with, as its hooks module last reported.
 * Sent at subscribe time, even when empty, so a tab that reconnects to a
 * restarted daemon drops what the old one held. */
export const RequestOverridesStreamEventSchema = v.object({
  ev: v.literal("request_overrides"),
  sessions: v.array(v.object({ session_id: v.string(), ...RequestOverrideStateSchema.entries })),
});
export type RequestOverridesStreamEvent = Output<typeof RequestOverridesStreamEventSchema>;

/** One override of a session whose values just changed, to the same
 * subscribers: a person changed it (request_override), the module learned
 * the session's own values (its start, `/model` or `/effort` typed in the
 * terminal), or a one-shot override ended with its turn (`target: "once"`,
 * both values null). Sent only when the values change, so every tab holds
 * the same state. */
export const RequestOverrideStreamEventSchema = v.object({
  ev: v.literal("request_override"),
  session_id: v.string(),
  target: RequestOverrideTargetSchema,
  ...RequestValuesSchema.entries,
});
export type RequestOverrideStreamEvent = Output<typeof RequestOverrideStreamEventSchema>;

export const RestartingStreamEventSchema = v.object({
  ev: v.literal("restarting"),
  reason: v.optional(v.string()),
});
export type RestartingStreamEvent = Output<typeof RestartingStreamEventSchema>;

/** Push update of the agents rows (user-role subscribers only). Emitted when
 * the rows, or what the sessions' hooks modules say of them, change. */
export const AgentsStreamEventSchema = v.object({
  ev: v.literal("agents"),
  agents: v.array(AgentInfoSchema),
  polled_at: v.string(),
});
export type AgentsStreamEvent = Output<typeof AgentsStreamEventSchema>;

/** Push update of the connected-session list (user-role subscribers only,
 * same shape the `peers` op returns). Emitted whenever a session registers
 * (hello), fully disconnects, or updates its hello metadata — so the webui's
 * member-connectivity display (chip greying) and session list stay live
 * without manual refresh (issue 2026-07-12-peers-live-update-protocol). */
export const PeersStreamEventSchema = v.object({
  ev: v.literal("peers"),
  peers: v.array(PeerInfoSchema),
});
export type PeersStreamEvent = Output<typeof PeersStreamEventSchema>;

/** Appended transcript lines for a session the subscriber asked to follow via
 * transcript_subscribe (DR-0009 live-tail addendum). Only complete jsonl lines
 * are delivered; byte offsets line up with transcript_read paging so a client
 * can stitch tail events onto a paged view without re-reading. */
export const TranscriptStreamEventSchema = v.object({
  ev: v.literal("transcript"),
  sid: v.string(),
  lines: v.array(v.string()),
  start: v.number(),
  end: v.number(),
  size: v.number(),
});
export type TranscriptStreamEvent = Output<typeof TranscriptStreamEventSchema>;

/** One upstream LLM request as the gateway observed it (its
 * `event: request` SSE payload, minus the fields ccmsg has no use for).
 * `session_id` is the Claude Code session id the gateway read off the
 * request header, which is the same identifier ccmsg keys sessions by — that
 * shared key is what lets a browser tab put a countdown on a session row.
 * Requests the gateway could not attribute to a session are dropped by the
 * daemon and never appear here. */
export const LlmRequestInfoSchema = v.object({
  /** Epoch MILLISECONDS (the gateway's own unit for every instant it states,
   * kept verbatim so the two sides never disagree about a converted value) at
   * which the upstream response headers arrived. This is the instant the
   * prompt cache TTL starts running, not when the request was sent. */
  ts: v.number(),
  /** ccmsg sid (`X-Claude-Code-Session-Id`). Never empty. */
  session_id: v.string(),
  /** Conversation-series id: the gateway's 8-hex digest of the first system
   * prompt block. A session's subagents travel under the SAME session_id but a
   * DIFFERENT prefix, and their cache entries are genuinely separate — so a
   * cache window belongs to (session_id, prefix), never to session_id alone.
   * Empty string when the gateway reports no prefix; those events collapse to
   * one unnamed series per session.
   *
   * NOTE: prefixes are not globally unique — two different sessions can share
   * one (identical leading system block), which is why the pair is the key. */
  prefix: v.string(),
  /** True for the session's primary series: the one whose cache window the
   * session's own turns keep alive, as opposed to a subagent's. The daemon
   * decides this — from `origin` when the gateway states it, otherwise from
   * the series it saw first for the sid — so every client agrees on which
   * ring to draw. */
  main: v.boolean(),
  /** Whose turn issued the request, as the gateway read it off the request's
   * `metadata.user_id`. As the gateway states it: "main" / "sub" / "unknown" /
   * "oneshot" today, an open set — consumers only ever test for "main", and
   * `main` above stays the thing clients read: it is the verdict, this is one
   * of its inputs. */
  origin: v.optional(v.string()),
  /** Epoch ms at which this series' prompt cache goes cold, as the gateway
   * computed it (`ts` + the cache TTL it actually asked for, 5m or 1h).
   * Absent when the request cached nothing, in which case the window closed
   * the moment it opened. A keepalive ping arrives as another request event
   * on the same series, so a live window's end keeps moving. */
  cache_expires_at: v.optional(v.number()),
  /** Length of the cache the gateway asked for, in seconds (3600 for the
   * hour-long cache the keepalive strategy is built around). A LENGTH, so the
   * unit is in the name — every instant beside it is epoch ms. */
  cache_ttl_secs: v.optional(v.number()),
  /** True while no keepalive is sent for this series: as the gateway states
   * it, or set by the daemon on the session's events after an
   * `llm_keepalive_pause` until the session's next request (the gateway
   * announces nothing on a pause). The chain the event projects
   * (`next_keepalive_at` / `cache_until`) is then not going to be sent. */
  cache_paused: v.optional(v.boolean()),
  /** Epoch ms of the real request that started the current keepalive chain —
   * the same value on the request itself and on every marker's return trip,
   * which is what makes it usable as the chain's fixed origin while `ts` and
   * `cache_expires_at` walk forward. */
  cache_since: v.optional(v.number()),
  /** Position in the keepalive chain: 0 on the real request, k on the k-th
   * marker's return. */
  cache_count: v.optional(v.number()),
  /** Epoch ms the gateway plans to send the next marker at. Absent when it
   * plans none. */
  next_keepalive_at: v.optional(v.number()),
  /** Epoch ms the keepalive chain is projected to end at (the last planned
   * marker + the cache TTL), with `cache_until_count` the number of markers
   * that takes. A projection recomputed per event, so the newest event's
   * value wins outright rather than being merged with an older one. */
  cache_until: v.optional(v.number()),
  cache_until_count: v.optional(v.number()),
  /** Epoch ms past which keeping the cache warm costs more than rebuilding
   * it, with `cache_breakeven_count` the marker count that reaches it.
   * Omitted for models whose price the gateway does not know. */
  cache_breakeven_until: v.optional(v.number()),
  cache_breakeven_count: v.optional(v.number()),
  /** Present only on a marker's return trip: "applied" / "late" / "foreign"
   * as the gateway judged it. Absent on an ordinary request, which is how the
   * two are told apart. */
  keepalive: v.optional(v.string()),
  ns: v.optional(v.string()),
  model: v.optional(v.string()),
  credential: v.optional(v.string()),
  status: v.optional(v.number()),
});
export type LlmRequestInfo = Output<typeof LlmRequestInfoSchema>;

/** Push of the most recent LLM request per conversation series (user-role
 * only, same webui-only posture as ev:"agents"/ev:"peers"). Always the full
 * non-expired set rather than the one request that just arrived: a client
 * that connects mid-window — a browser reload, or a tab opened after the
 * session's request was already in flight — still needs the countdown that
 * started before it was listening, and one snapshot shape serves both the
 * subscribe-time catch-up and the live update. Entries past
 * LLM_PROMPT_CACHE_TTL_MS are pruned before sending, so an empty list is a
 * legitimate "no session has a warm cache". */
export const LlmRequestsStreamEventSchema = v.object({
  ev: v.literal("llm_requests"),
  requests: v.array(LlmRequestInfoSchema),
});
export type LlmRequestsStreamEvent = Output<typeof LlmRequestsStreamEventSchema>;

/** Full recomputed snapshot pushed after a status-changing transcript event. */
export const SessionStatusStreamEventSchema = v.object({
  ...SessionStatusSnapshotSchema.entries,
  ev: v.literal("session_status"),
  sid: v.string(),
});
export type SessionStatusStreamEvent = Output<typeof SessionStatusStreamEventSchema>;

/** Push update of the set of connected sessions stopped on a harness API
 * error (user-role subscribers only, same shape the `session_errors` op
 * returns). Emitted whenever that set changes — a session hitting an error,
 * recovering from one, or disconnecting while flagged. Always the full list,
 * not a delta, so a client that missed a push still converges. */
export const SessionErrorsStreamEventSchema = v.object({
  ev: v.literal("session_errors"),
  errors: v.array(SessionErrorEntrySchema),
});
export type SessionErrorsStreamEvent = Output<typeof SessionErrorsStreamEventSchema>;

/** Unsolicited push of a freshly fetched status report (user-role subscribers
 * only, same posture as ev:"llm_requests"). Sent when the gateway's webhook
 * reports a 529 and the daemon re-reads the status endpoint: that is the
 * moment the header badge has to change, and it is the one moment a client
 * cannot anticipate. Absent entirely on a daemon with no status endpoint
 * configured, or one the gateway never posts a 529 to. */
export const LlmStatusStreamEventSchema = v.object({
  ev: v.literal("llm_status"),
  report: LlmStatusReportSchema,
});
export type LlmStatusStreamEvent = Output<typeof LlmStatusStreamEventSchema>;

/** This host's Claude Code version, just re-read by the daemon after a
 * `claude_update` (DR-0043 §8), to every user-role subscriber (same posture
 * as ev:"llm_status"): every tab and device shows the new version at once,
 * not only the one whose button was pressed. Never to a session. */
export const ClaudeVersionStreamEventSchema = v.object({
  ev: v.literal("claude_version"),
  ...ClaudeVersionSchema.entries,
});
export type ClaudeVersionStreamEvent = Output<typeof ClaudeVersionStreamEventSchema>;

/** Every push, told apart by `ev`. */
export const StreamEventSchema = v.variant("ev", [
  SayUnreadStreamEventSchema,
  PermitRequestsStreamEventSchema,
  PermitRequestStreamEventSchema,
  RequestOverridesStreamEventSchema,
  RequestOverrideStreamEventSchema,
  RestartingStreamEventSchema,
  AgentsStreamEventSchema,
  PeersStreamEventSchema,
  TranscriptStreamEventSchema,
  SessionStatusStreamEventSchema,
  SessionErrorsStreamEventSchema,
  LlmRequestsStreamEventSchema,
  LlmStatusStreamEventSchema,
  ClaudeVersionStreamEventSchema,
]);
export type StreamEvent = Output<typeof StreamEventSchema>;
