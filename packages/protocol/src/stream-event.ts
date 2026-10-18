// What the daemon pushes to a subscribed connection unasked (daemon ->
// client), as schemas (DR-0038): ephemeral, never persisted, told apart by
// `ev`.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): see response-rooms.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import { LlmStatusReportSchema } from "./response-host.ts";
import { AgentInfoSchema, PeerInfoSchema } from "./response-sessions.ts";
import { SessionErrorEntrySchema, SessionStatusSnapshotSchema } from "./session-status.ts";

/** Who a notify came from, daemon-stamped from the connection identity
 * (DR-0003 §7). The receiver uses this to tell a self-notify (own session —
 * actionable, e.g. a justfile push signal) from a peer-notify (another agent —
 * must NOT auto-execute even if the text looks like a shell command). Only
 * role + sid, no session metadata. `gateway` marks a relay of an automated
 * event from llm-gateway (the prompt-cache keepalive marker) — not a person
 * and not a peer session, so a reader must not take it for user input. */
export const NotifyFromSchema = v.variant("role", [
  v.object({ role: v.literal("user") }),
  v.object({ role: v.literal("session"), sid: v.string() }),
  v.object({ role: v.literal("gateway") }),
]);
export type NotifyFrom = Output<typeof NotifyFromSchema>;

export const NotifyStreamEventSchema = v.object({
  ev: v.literal("notify"),
  text: v.string(),
  from: NotifyFromSchema,
});
export type NotifyStreamEvent = Output<typeof NotifyStreamEventSchema>;

/** One `ccmsg say` as the daemon holds it: which session made the speakers
 * talk, with what, and whether the person watching has acked it. With several
 * sessions running, macOS `say` alone is anonymous. Held in daemon memory
 * only (DR-0036 §3): a restarted daemon starts with none, unread ones
 * included. */
export const SayRecordSchema = v.object({
  /** `<instance id>/<n>`, unique across daemon restarts (a fresh instance id
   * per daemon process), so an ack from a tab that has not yet caught up with
   * a restart cannot land on a different say. The ack target `say_read`
   * names. */
  id: v.string(),
  /** sid of the session that spoke (the `say` caller's own). */
  sid: v.string(),
  /** The argv `ccmsg say` forwarded to `/usr/bin/say`, joined by spaces —
   * verbatim, options included. Empty when the caller piped text on stdin
   * (the CLI must not consume that stream to peek at it). */
  text: v.string(),
  ts: v.string(),
  /** Set by `say_read`; never cleared. */
  read: v.boolean(),
});
export type SayRecord = Output<typeof SayRecordSchema>;

/** Every say record the daemon holds, oldest first (user-role subscribers
 * only, same webui-only posture as ev:"peers"). Sent at subscribe time and
 * again whenever a say is recorded or acked — always the full set, so a tab
 * that reconnects to a restarted daemon replaces what it held with the new
 * daemon's (possibly empty) set instead of keeping says that no longer
 * exist. Never sent to a session: the session that spoke already knows it
 * spoke, and the ack is the person's gesture, so either would only spend
 * agent context. */
export const SaysStreamEventSchema = v.object({
  ev: v.literal("says"),
  says: v.array(SayRecordSchema),
});
export type SaysStreamEvent = Output<typeof SaysStreamEventSchema>;

export const RestartingStreamEventSchema = v.object({
  ev: v.literal("restarting"),
  reason: v.optional(v.string()),
});
export type RestartingStreamEvent = Output<typeof RestartingStreamEventSchema>;

/** Sent to an older session-role subscribe stream when a newer `subscribe` for
 * the same sid arrives. Two live subscribe streams for one session double every
 * notification, so the daemon keeps the newest (the deliberate start) and tells
 * the older one to exit. `sid` is the session both streams share. */
export const SubscribeSupersededStreamEventSchema = v.object({
  ev: v.literal("subscribe_superseded"),
  sid: v.string(),
});
export type SubscribeSupersededStreamEvent = Output<typeof SubscribeSupersededStreamEventSchema>;

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

/** Sent to a single session whose last turn stopped on a harness API error,
 * when the host's network comes back. It carries no room and no seq: the point
 * is the delivery itself, which reaches the session's `subscribe` stream and
 * re-prompts it — the same effect as a human typing one character into the
 * stalled session. Sessions that are not stopped on an error never receive it,
 * and one recovery produces at most one of these per stopped session. */
export const NetworkOnlineStreamEventSchema = v.object({
  ev: v.literal("net_online"),
  /** Why the session is being woken and what to do, in one line. */
  text: v.string(),
  /** Timestamp of the API-error row this wake is for, so a session (or a log
   * reader) can tell which stall it answers. */
  error_ts: v.string(),
});
export type NetworkOnlineStreamEvent = Output<typeof NetworkOnlineStreamEventSchema>;

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

/** Every push, told apart by `ev`. */
export const StreamEventSchema = v.variant("ev", [
  NotifyStreamEventSchema,
  SaysStreamEventSchema,
  RestartingStreamEventSchema,
  SubscribeSupersededStreamEventSchema,
  AgentsStreamEventSchema,
  PeersStreamEventSchema,
  TranscriptStreamEventSchema,
  SessionStatusStreamEventSchema,
  SessionErrorsStreamEventSchema,
  NetworkOnlineStreamEventSchema,
  LlmRequestsStreamEventSchema,
  LlmStatusStreamEventSchema,
]);
export type StreamEvent = Output<typeof StreamEventSchema>;
