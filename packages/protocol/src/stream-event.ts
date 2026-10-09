// What the daemon pushes to a connection unasked (daemon -> client), as
// schemas (DR-0038). Two families share the stream, told apart by which key
// names the kind:
//
// - a push of the daemon's own (`ev`): ephemeral, never persisted
// - a delivered storage event (`type`): a room's event, with the room it
//   belongs to (`r`)
//
// A valibot variant cannot hold a variant on another key, so each family is
// its own schema; a reader picks one by whether the frame has `ev`
// (frame.ts). `StreamEvent` is the type of either.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): see response-rooms.ts.
import * as v from "valibot";
import { LlmStatusReportSchema } from "./response-host.ts";
import { AgentInfoSchema, PeerInfoSchema } from "./response-sessions.ts";
import { SessionErrorEntrySchema, SessionStatusSnapshotSchema } from "./session-status.ts";
import {
  ArchiveEventSchema,
  KindEventSchema,
  LeaveEventSchema,
  MemberEventSchema,
  MsgEventSchema,
  NextEventSchema,
  PrevEventSchema,
  SayEventSchema,
  SayReadEventSchema,
  TitleEventSchema,
} from "./storage-event.ts";

// --- delivered storage events -------------------------------------------------

/** What a storage event carries on the stream beside its own fields. */
const DeliveredEntries = {
  /** The room the event belongs to. */
  r: v.string(),
  /** `true` marks a msg emitted as a **recent-replay** at `subscribe` time:
   * the bare-default subscribe (no `since`/`since_seq` cursor for the room and
   * no `backlog: true`) additionally surfaces msgs from the last few minutes
   * that would have been live-delivered had the subscriber been present
   * (window default 3 min, `CCMSG_RECENT_REPLAY_MS` for tests). Never present
   * on live-delivered msgs or the since/backlog replay paths. */
  replay: v.optional(v.literal(true)),
};

/** The schema of a storage event as delivered: its fields and the above. */
type DeliveredSchemaOf<E extends v.ObjectEntries> = v.ObjectSchema<
  E & typeof DeliveredEntries,
  undefined
>;

function delivered<E extends v.ObjectEntries>(
  schema: v.ObjectSchema<E, undefined>,
): DeliveredSchemaOf<E> {
  return v.object({ ...schema.entries, ...DeliveredEntries });
}

/** A storage event as delivered over a subscribe stream: flattened with room
 * id. `msg` events go only to user-role subscribers (the webui); a session
 * receives room messages through peer-inject instead. */
export const DeliveredEventSchema = v.variant("type", [
  delivered(MemberEventSchema),
  delivered(LeaveEventSchema),
  delivered(MsgEventSchema),
  delivered(NextEventSchema),
  delivered(PrevEventSchema),
  delivered(TitleEventSchema),
  delivered(ArchiveEventSchema),
  delivered(KindEventSchema),
  delivered(SayEventSchema),
  delivered(SayReadEventSchema),
]);
export type DeliveredEvent = v.InferOutput<typeof DeliveredEventSchema>;

// --- the daemon's own pushes --------------------------------------------------

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
export type NotifyFrom = v.InferOutput<typeof NotifyFromSchema>;

export const NotifyStreamEventSchema = v.object({
  ev: v.literal("notify"),
  text: v.string(),
  from: NotifyFromSchema,
});
export type NotifyStreamEvent = v.InferOutput<typeof NotifyStreamEventSchema>;

export const RestartingStreamEventSchema = v.object({
  ev: v.literal("restarting"),
  reason: v.optional(v.string()),
});
export type RestartingStreamEvent = v.InferOutput<typeof RestartingStreamEventSchema>;

/** Sent to an older session-role subscribe stream when a newer `subscribe` for
 * the same sid arrives. Two live subscribe streams for one session double every
 * notification, so the daemon keeps the newest (the deliberate start) and tells
 * the older one to exit. `sid` is the session both streams share. */
export const SubscribeSupersededStreamEventSchema = v.object({
  ev: v.literal("subscribe_superseded"),
  sid: v.string(),
});
export type SubscribeSupersededStreamEvent = v.InferOutput<
  typeof SubscribeSupersededStreamEventSchema
>;

/** Emitted once at `subscribe` time for every visible room that did NOT get a
 * backlog/delta replay (no `since`/`since_seq` entry for it and the request
 * didn't set `backlog: true` — issue 2026-07-17-subscribe-no-backlog-default).
 * Lets protocol consumers inspect each room's current cursor without re-flooding
 * its history. The CLI subscribe stream intentionally drops this connection
 * snapshot from stdout; other consumers may use it for their own catch-up policy.
 * Omitted entirely when every visible room got a replay instead (empty list never
 * sent). */
export const RoomCursorsStreamEventSchema = v.object({
  ev: v.literal("room_cursors"),
  rooms: v.array(v.object({ room: v.string(), last_mid: v.number() })),
});
export type RoomCursorsStreamEvent = v.InferOutput<typeof RoomCursorsStreamEventSchema>;

/** Push update of the `claude agents --json` poll result (user-role subscribers
 * only). Emitted when the merged agent list changes; the daemon polls only
 * while at least one user-role subscriber is connected. */
export const AgentsStreamEventSchema = v.object({
  ev: v.literal("agents"),
  agents: v.array(AgentInfoSchema),
  polled_at: v.string(),
});
export type AgentsStreamEvent = v.InferOutput<typeof AgentsStreamEventSchema>;

/** Push update of the connected-session list (user-role subscribers only,
 * same shape the `peers` op returns). Emitted whenever a session registers
 * (hello), fully disconnects, or updates its hello metadata — so the webui's
 * member-connectivity display (chip greying) and session list stay live
 * without manual refresh (issue 2026-07-12-peers-live-update-protocol). */
export const PeersStreamEventSchema = v.object({
  ev: v.literal("peers"),
  peers: v.array(PeerInfoSchema),
});
export type PeersStreamEvent = v.InferOutput<typeof PeersStreamEventSchema>;

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
export type TranscriptStreamEvent = v.InferOutput<typeof TranscriptStreamEventSchema>;

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
  /** True while the gateway is holding off on keepalive markers for this
   * series. Stated on every event of a series the strategy covers, so absent
   * means "not a series the gateway keeps alive", never "running". */
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
export type LlmRequestInfo = v.InferOutput<typeof LlmRequestInfoSchema>;

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
export type LlmRequestsStreamEvent = v.InferOutput<typeof LlmRequestsStreamEventSchema>;

/** Full recomputed snapshot pushed after a status-changing transcript event. */
export const SessionStatusStreamEventSchema = v.object({
  ...SessionStatusSnapshotSchema.entries,
  ev: v.literal("session_status"),
  sid: v.string(),
});
export type SessionStatusStreamEvent = v.InferOutput<typeof SessionStatusStreamEventSchema>;

/** Push update of the set of connected sessions stopped on a harness API
 * error (user-role subscribers only, same shape the `session_errors` op
 * returns). Emitted whenever that set changes — a session hitting an error,
 * recovering from one, or disconnecting while flagged. Always the full list,
 * not a delta, so a client that missed a push still converges. */
export const SessionErrorsStreamEventSchema = v.object({
  ev: v.literal("session_errors"),
  errors: v.array(SessionErrorEntrySchema),
});
export type SessionErrorsStreamEvent = v.InferOutput<typeof SessionErrorsStreamEventSchema>;

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
export type NetworkOnlineStreamEvent = v.InferOutput<typeof NetworkOnlineStreamEventSchema>;

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
export type LlmStatusStreamEvent = v.InferOutput<typeof LlmStatusStreamEventSchema>;

/** Every push of the daemon's own, told apart by `ev`. */
export const PushStreamEventSchema = v.variant("ev", [
  NotifyStreamEventSchema,
  RestartingStreamEventSchema,
  SubscribeSupersededStreamEventSchema,
  RoomCursorsStreamEventSchema,
  AgentsStreamEventSchema,
  PeersStreamEventSchema,
  TranscriptStreamEventSchema,
  SessionStatusStreamEventSchema,
  SessionErrorsStreamEventSchema,
  NetworkOnlineStreamEventSchema,
  LlmRequestsStreamEventSchema,
  LlmStatusStreamEventSchema,
]);
export type PushStreamEvent = v.InferOutput<typeof PushStreamEventSchema>;

/** Anything the daemon pushes: a delivered storage event or a push of its own. */
export type StreamEvent = DeliveredEvent | PushStreamEvent;
