// The wire's replies to session requests (daemon -> client), as schemas
// (DR-0038): hello, the peers and messages between sessions, and what the
// person does to a session from the webui. response.ts joins them with the
// other topics' replies, by the op each answers.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): see response-rooms.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import {
  SessionErrorEntrySchema,
  SessionInputReadinessSchema,
  SessionStatusSnapshotSchema,
  SessionTurnSchema,
} from "./session-status.ts";
import { AgentAppendReasonSchema, UserPromptModuleReasonSchema } from "./sidecar.ts";
import { UNANNOUNCED_PROTOCOL_VERSION } from "./version.ts";

export const HelloResponseSchema = v.object({
  ok: v.literal(true),
  version: v.string(),
  /** The wire generation this daemon speaks (`PROTOCOL_VERSION`). A client
   * whose own generation differs never gets here — its hello is rejected —
   * so this is for display, not for the client to branch on. A reply without
   * the field comes from a daemon of generation `UNANNOUNCED_PROTOCOL_VERSION`:
   * that is the number such a daemon means, the same definition the daemon
   * applies to a hello without it, not a compatibility path. Reading it is
   * what lets `ensureDaemon` see that daemon's version and replace it. */
  protocol: v.optional(v.number(), UNANNOUNCED_PROTOCOL_VERSION),
  /** DR-0018 拡張 (issue 2026-07-21-webui-terminal-tab-embed): user role の
   * hello に対してのみ、`<configDir>/config.json` の `terminal_gateway_url`
   * トップレベルキー (http:// / https:// のみ、末尾スラッシュの有無問わず)
   * をエコーバックする。未設定 / スキーム不正 / role="session" の場合は
   * 省略。webui はこれを iframe embed の base URL として使い、未設定なら
   * Terminal タブ自体を出さない (= 設定していないユーザには存在しない機能
   * に倒す)。 */
  terminal_gateway_url: v.optional(v.string()),
  /** True when the daemon has a usable `llm_usage_url` configured, echoed to
   * user-role hellos only (same posture as terminal_gateway_url). The URL
   * itself is deliberately NOT sent: the daemon is the one that fetches it
   * (the gateway serves no CORS headers), so the browser needs to know only
   * whether the `llm_usage` op is worth offering. Absent means unconfigured,
   * and the webui then hides the usage screen entirely rather than showing a
   * menu entry that can only ever error. */
  llm_usage_available: v.optional(v.boolean()),
  /** True when the daemon has a usable `llm_stats_url` configured. Same
   * posture and same reasons as llm_usage_available, and reported separately
   * because the two endpoints are configured independently — one can be set
   * up without the other, and the webui shows only the section it can fill. */
  llm_stats_available: v.optional(v.boolean()),
  /** True when the daemon has a usable `llm_status_url` configured. Same
   * posture and same independence as the two flags above: a gateway can serve
   * quota without serving upstream status (an older build does exactly that),
   * and the webui then shows the quota screen with no service strip rather
   * than a strip that can only ever error. */
  llm_status_available: v.optional(v.boolean()),
  /** True when the daemon has a usable `llm_keepalive_pause_url` configured.
   * Same posture and same independence as the flags above: without it the
   * webui offers no way to stop a session's keepalive, rather than a button
   * that can only ever error. */
  llm_keepalive_pause_available: v.optional(v.boolean()),
  /** True when the daemon has a usable `sandbox_origin_template` configured
   * (DR-0030 §7.1), user-role hellos only. Same posture as the two flags
   * above: the template itself stays server-side (the client only ever
   * receives whole URLs from `sandbox_grant`), and an unconfigured daemon —
   * one with no canddy sandbox domain in front of it — makes the webui hide
   * the "HTML として開く" / "生ダウンロード" buttons entirely rather than
   * offer a button that can only fail. */
  sandbox_available: v.optional(v.boolean()),
  /** True when the daemon has a `session_launcher` configured, user-role
   * hellos only. Same posture as the flags above, for the webui's fork
   * affordances: a fork is a launcher template run with the fork point filled
   * in, so with no launcher configured the button could only ever lead to a
   * launch form that answers launcher_not_configured. */
  fork_available: v.optional(v.boolean()),
});
export type HelloResponse = Output<typeof HelloResponseSchema>;

/** A ccmsg client for one sid whose hello the daemon refused. Overwritten,
 * never accumulated — the offending client reconnects every few seconds, so
 * the useful reading is "still happening as of `last_seen`", not how many
 * times it tried.
 *
 * There are exactly two ways to get here, and `protocol` tells them apart:
 * present, the client announced a generation this daemon does not speak;
 * absent, it was refused before it could be read as a hello at all, for
 * sending no `request_id` (generation 1's envelope). A client merely too old
 * to announce a generation is *not* here — that is
 * `UNANNOUNCED_PROTOCOL_VERSION`, and it is served like any other client of
 * that generation. */
export const StaleClientInfoSchema = v.object({
  /** ISO time of that client's most recent attempt. */
  last_seen: v.string(),
  /** ccmsg build it reported, when it reported one. */
  version: v.optional(v.string()),
  /** Generation it announced. Absent means it never got that far: refused for
   * the missing correlation envelope. */
  protocol: v.optional(v.number()),
});
export type StaleClientInfo = Output<typeof StaleClientInfoSchema>;

export const PeerInfoSchema = v.object({
  sid: v.string(),
  repo: v.string(),
  ws: v.string(),
  cwd: v.string(),
  /** present iff the session announced a transcript the daemon accepted —
   * the webui uses this to decide whether a Timeline view is available */
  transcript_path: v.optional(v.string()),
  /** present iff the session announced a repo container the daemon accepted —
   * fs browsing is rooted here (all workspaces/worktrees visible) instead of
   * cwd, and the webui highlights the session's own workspace within it */
  repo_root: v.optional(v.string()),
  /** current branch / bookmark of the session's checkout, "" / absent if unknown */
  branch: v.optional(v.string()),
  /** ISO time this session first registered with the running daemon (stable
   * across reconnects while the daemon lives; resets on daemon restart) */
  connected_at: v.optional(v.string()),
  /** ISO time of this session's most recent request on any of its connections */
  last_activity_at: v.optional(v.string()),
  /** ISO time the *user* last put something into this session's timeline: a
   * prompt they typed, or a ccmsg room message they sent as the User admin
   * (`from: "u1"`) that the session's subscribe delivered. Distinct from
   * `last_activity_at`, which every request the session makes on its own
   * re-stamps — this one only moves when kawaz says something, which is what
   * the sidebar's default ordering wants (daemon: session-user-input.ts).
   *
   * Absent while the daemon has found none: no user-role subscriber has been
   * connected long enough to fold the transcript, the session announced no
   * readable transcript, nobody has typed into it yet, or it predates the
   * `origin`/`promptSource` fields the fold reads. Clients sort a peer without
   * it after every peer that has one rather than treating it as epoch. */
  last_user_input_at: v.optional(v.string()),
  /** ccmsg build of the client that last hello'd for this sid, when it
   * announced one (`HelloRequest.client_version`). */
  client_version: v.optional(v.string()),
  /** Wire generation that client announced (`HelloRequest.protocol`). Absent
   * for a client that predates the field, which means
   * `UNANNOUNCED_PROTOCOL_VERSION` rather than "unknown" — it is left absent
   * instead of filled in so a display can say "版数不明" for such a client
   * without inventing a generation it never mentioned. */
  protocol: v.optional(v.number()),
  /** Set while the daemon has seen a client for this sid whose hello it
   * refused. The session itself is fine — some *other* ccmsg process of the
   * same session (typically a long-lived `ccmsg subscribe` started before an
   * upgrade) is the stale one, and it is invisible otherwise: it retries
   * forever, its hello is refused every time, and nothing in the UI moves.
   * Cleared by any hello from that sid the daemon accepts. */
  stale_client: v.optional(StaleClientInfoSchema),
  /** Whether a person's input can reach this session now
   * (SessionInputReadiness), on the `peers` reply and the `ev:"peers"` push
   * alike, so a client knows it for a session it follows no status of (one
   * with no transcript yet, or seen only on its Terminal tab). Absent until
   * the daemon has judged it once. */
  input_readiness: v.optional(SessionInputReadinessSchema),
});
export type PeerInfo = Output<typeof PeerInfoSchema>;

export const PeersResponseSchema = v.object({
  ok: v.literal(true),
  peers: v.array(PeerInfoSchema),
});
export type PeersResponse = Output<typeof PeersResponseSchema>;

export const SubscribeAckSchema = v.object({
  ok: v.literal(true),
  subscribed: v.literal(true),
});
export type SubscribeAck = Output<typeof SubscribeAckSchema>;

export const NotifyResponseSchema = v.object({
  ok: v.literal(true),
  delivered: v.number(),
});
export type NotifyResponse = Output<typeof NotifyResponseSchema>;

export const SayResponseSchema = v.object({
  ok: v.literal(true),
  /** `id` of the SayRecord the daemon now holds — the ack target a later
   * `say_read` names. */
  id: v.string(),
});
export type SayResponse = Output<typeof SayResponseSchema>;

export const SayReadResponseSchema = v.object({
  ok: v.literal(true),
  /** echo of the acked SayRecord's id */
  id: v.string(),
});
export type SayReadResponse = Output<typeof SayReadResponseSchema>;

/** The fields of one cwd-picker entry beside its children. */
const DirTreeEntryFieldsSchema = v.object({
  path: v.string(),
  is_dir: v.literal(true),
});

/** One directory-only cwd-picker entry. `children` absent means the depth
 * boundary was reached and the UI may lazily fetch this path.
 *
 * Design rationale: a type cannot be inferred from a schema that refers to
 * itself (TypeScript reports the circularity), so the recursive part — and
 * only it — is written as an interface that the schema is annotated with.
 * Every other field is the inferred type of DirTreeEntryFieldsSchema. */
export interface DirTreeEntry extends Output<typeof DirTreeEntryFieldsSchema> {
  readonly children?: readonly DirTreeEntry[];
}
export const DirTreeEntrySchema: v.GenericSchema<DirTreeEntry> = v.object({
  ...DirTreeEntryFieldsSchema.entries,
  children: v.optional(v.array(v.lazy(() => DirTreeEntrySchema))),
});

export const DirTreeResponseSchema = v.object({
  ok: v.literal(true),
  entries: v.array(DirTreeEntrySchema),
});
export type DirTreeResponse = Output<typeof DirTreeResponseSchema>;

/** One launch parameter a template declares: the shell variable name its
 * command may read, and the value the form opens with. The declaration is the
 * only source of truth for which variables exist — the launcher shell defines
 * exactly the declared ones (nothing else), and the webui renders one input per
 * declaration, in declaration order. */
export const LauncherParamSchema = v.object({
  /** A shell identifier (`[A-Za-z_][A-Za-z0-9_]*`), unique within one template.
   * Reaches the command as `$NAME`. Names the webui knows get a dedicated
   * widget (CWD a directory picker, MODEL/EFFORT a dropdown, PROMPT a
   * textarea); any other name gets a plain text input. */
  name: v.string(),
  /** The form's initial value, and what its "default" button restores. Empty
   * string is the normal "user fills this in" case. */
  default: v.string(),
});
export type LauncherParam = Output<typeof LauncherParamSchema>;

/** One template as seen by a client: the parsed template minus `shell`, which
 * is a daemon-side execution detail the form has no use for. */
export const SessionLauncherConfigTemplateSchema = v.object({
  name: v.string(),
  command: v.string(),
  params: v.array(LauncherParamSchema),
});
export type SessionLauncherConfigTemplate = Output<typeof SessionLauncherConfigTemplateSchema>;

/** session_launcher_config reply — see its request doc comment.
 * `templates` is the configured recipe list in config order, each carrying its
 * shell command template verbatim (no variable substitution — `$CWD` and every
 * other declared parameter stay literal) plus the parameter declaration that
 * tells the form which inputs to render, in which order, with which initial
 * values; the webui surfaces the chosen template's command as an editable
 * textarea per DR-0018 §3.2, and sends the edited value
 * back via SessionLaunchRequest.command override. Same
 * one-shot read as root_dirs — a re-fetch is only useful across a daemon
 * config reload + restart. */
export const SessionLauncherConfigResponseSchema = v.object({
  ok: v.literal(true),
  root_dirs: v.array(v.string()),
  templates: v.array(SessionLauncherConfigTemplateSchema),
});
export type SessionLauncherConfigResponse = Output<typeof SessionLauncherConfigResponseSchema>;

/** Payload of a completed session launch, delivered inside
 * the session_launch reply. Signal termination uses null exit_code. */
export const SessionLaunchResponseSchema = v.object({
  ok: v.literal(true),
  stdout: v.string(),
  stderr: v.string(),
  exit_code: v.nullable(v.number()),
  timed_out: v.boolean(),
});
export type SessionLaunchResponse = Output<typeof SessionLaunchResponseSchema>;

/** Payload of a completed session_kill (DR-0028), delivered inside
 * the session_kill reply. `terminated: true` = the process was observed gone
 * within the ~3s grace. `terminated: false` is NOT a failure: both SIGTERM
 * sends succeeded but the process was still alive when the grace expired —
 * the UI presents this as "signal sent, termination unconfirmed" and a human
 * decides whether to kill harder (the daemon never SIGKILLs). */
export const SessionKillResponseSchema = v.object({
  ok: v.literal(true),
  terminated: v.boolean(),
});
export type SessionKillResponse = Output<typeof SessionKillResponseSchema>;

/** Payload of a completed session_rename, delivered inside
 * the session_rename reply. `ok` here means "the `/rename <title>` keystrokes
 * reached the terminal", not "the session is now called that" — see
 * SessionRenameRequest for why the daemon cannot know the latter. `title` is
 * the normalized (trimmed) string actually typed, so a UI can report what it
 * sent rather than what the user's draft happened to contain, and
 * `hyoui_session_id` names the terminal it went to. */
export const SessionRenameResponseSchema = v.object({
  ok: v.literal(true),
  hyoui_session_id: v.string(),
  title: v.string(),
});
export type SessionRenameResponse = Output<typeof SessionRenameResponseSchema>;

/** Why a user_prompt did not reach the session (DR-0035 §5). Nothing is
 * sent by another route in any of these cases.
 *
 * The module's own reasons are UserPromptModuleReason (sidecar.ts). The
 * daemon adds `no_module`: no run of the session has a hooks module that took
 * the request (the plugin not loaded or of a ccmsg that does not know
 * `prompt.send`, a session without a composer, the session gone).
 *
 * With several runs, `no_composer` / `no_terminal` / `session_changed` are
 * the last run's answer after every run gave one of the three. */
export const UserPromptReasonSchema = v.picklist([
  ...UserPromptModuleReasonSchema.options,
  "no_module",
]);
export type UserPromptReason = Output<typeof UserPromptReasonSchema>;

/** Payload of a completed user_prompt (DR-0035 §5).
 *
 * - `accepted`: the session took the text as a person's prompt
 * - `not_delivered`: it did not, for `reason`; the text went nowhere else
 * - `unconfirmed`: a sidecar took the request but no answer came within the
 *   daemon's wait. The text may or may not be in the session — it shows in the
 *   session's timeline if it is — so a caller keeps it rather than sending it
 *   again blindly */
export const UserPromptResponseSchema = v.variant("outcome", [
  v.object({ ok: v.literal(true), outcome: v.literal("accepted") }),
  v.object({
    ok: v.literal(true),
    outcome: v.literal("not_delivered"),
    reason: UserPromptReasonSchema,
  }),
  v.object({ ok: v.literal(true), outcome: v.literal("unconfirmed") }),
]);
export type UserPromptResponse = Output<typeof UserPromptResponseSchema>;

/** Why an user_message did not reach the subagent (DR-0039 §6): the module's
 * AgentAppendReason, or as for user_prompt, `no_module` (no run's module
 * took the request), `session_changed` (/clear, /resume) or `ended`. */
export const UserMessageReasonSchema = v.picklist([
  ...AgentAppendReasonSchema.options,
  "no_module",
  "session_changed",
  "ended",
]);
export type UserMessageReason = Output<typeof UserMessageReasonSchema>;

/** Payload of a completed user_message: `appended` (the subagent's next
 * request carries it), `not_delivered` for `reason`, or `unconfirmed` (a
 * sidecar took the request but no answer came in time). */
export const UserMessageResponseSchema = v.variant("outcome", [
  v.object({ ok: v.literal(true), outcome: v.literal("appended") }),
  v.object({
    ok: v.literal(true),
    outcome: v.literal("not_delivered"),
    reason: UserMessageReasonSchema,
  }),
  v.object({ ok: v.literal(true), outcome: v.literal("unconfirmed") }),
]);
export type UserMessageResponse = Output<typeof UserMessageResponseSchema>;

/** Payload of a sidecar_reply the daemon was waiting for. */
export const SidecarReplyResponseSchema = v.object({
  ok: v.literal(true),
});
export type SidecarReplyResponse = Output<typeof SidecarReplyResponseSchema>;

/** Payload of a sidecar_hello the daemon took: the run is live until the
 * connection closes. */
export const SidecarHelloResponseSchema = v.object({
  ok: v.literal(true),
});
export type SidecarHelloResponse = Output<typeof SidecarHelloResponseSchema>;

/** Payload of a session_facts the daemon took (newer facts than it held, or
 * older ones it dropped: the module has nothing to do about either). */
export const SessionFactsResponseSchema = v.object({
  ok: v.literal(true),
});
export type SessionFactsResponse = Output<typeof SessionFactsResponseSchema>;

/** Payload of a completed session_env.
 * `env` is the session process's environment as name→value pairs.
 *
 * On macOS the source is `ps eww`, whose output is space-separated with no
 * quoting, so a value containing a space cannot be told apart from the next
 * variable by tokenizing alone. The daemon reconstructs values by treating a
 * token as a new variable only when it matches `NAME=`; a value that itself
 * contains a `NAME=`-shaped token is the one case that mis-splits. Linux
 * reads `/proc/<pid>/environ` (NUL-separated), which has no such ambiguity.
 * Values are returned verbatim and are NOT redacted — the caller decides how
 * to present secrets. */
export const SessionEnvResponseSchema = v.object({
  ok: v.literal(true),
  /** The pid the environment was read from, after the same ps verification
   * session_kill applies. Surfaced so the UI can show what it actually read. */
  pid: v.number(),
  env: v.record(v.string(), v.string()),
});
export type SessionEnvResponse = Output<typeof SessionEnvResponseSchema>;

export const SessionSearchMatchSchema = v.object({
  role: v.picklist(["user", "agent"]),
  text: v.string(),
  timestamp: v.optional(v.string()),
});
export type SessionSearchMatch = Output<typeof SessionSearchMatchSchema>;

export const SessionSearchHitSchema = v.object({
  sid: v.string(),
  config_dir: v.string(),
  /** absolute path selected only from detected config dirs' projects trees */
  file: v.string(),
  cwd: v.nullable(v.string()),
  /** `owner/repo` when cwd matches the known repos path convention */
  repo: v.nullable(v.string()),
  /** repo-relative workspace/worktree path when present */
  ws: v.nullable(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
  size: v.number(),
  matches: v.array(SessionSearchMatchSchema),
  /** The session's own title (`/rename`, transcript `custom-title` records),
   * when one appears within the same early portion of the file that already
   * establishes `cwd`/`created_at` — a session never renamed, or renamed only
   * after that point, has `null` here rather than a guessed fallback. */
  title: v.nullable(v.string()),
  /** What the session was last running as, read from the newest main-context
   * assistant record at the end of the file: raw transcript spellings
   * (`message.model`, e.g. "claude-fable-5[1m]", and the row-level `effort`,
   * e.g. "medium"), left for the client to map onto its own vocabulary. A
   * resume relaunches this session, so these are what its next run should
   * default to. Both are optional and independently absent: a transcript whose
   * tail carries no such record answers neither, and one written by a CC
   * version that predates row-level `effort` answers only `model`. */
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
});
export type SessionSearchHit = Output<typeof SessionSearchHitSchema>;

export const SessionSearchResponseSchema = v.object({
  ok: v.literal(true),
  hits: v.array(SessionSearchHitSchema),
  truncated: v.boolean(),
});
export type SessionSearchResponse = Output<typeof SessionSearchResponseSchema>;

/** Where a fork's copied history ends, when the session is a fork whose
 * ancestor transcript still exists. */
export const ForkOriginSchema = v.object({
  /** The ancestor the copied records came from. */
  sid: v.string(),
  /** uuid of the last copied record: the seam sits immediately after it. */
  boundary_uuid: v.string(),
  /** How many records were copied — how far into the file the seam is, for a
   * client that wants to say so without holding the whole window. */
  copied: v.number(),
});
export type ForkOrigin = Output<typeof ForkOriginSchema>;

/** `origin` is null both when the session is not a fork and when it is one
 * whose ancestor file is gone: neither case has a seam a viewer could place,
 * and the difference is not observable from what remains on disk. */
export const ForkOriginResponseSchema = v.object({
  ok: v.literal(true),
  origin: v.nullable(ForkOriginSchema),
});
export type ForkOriginResponse = Output<typeof ForkOriginResponseSchema>;

/** Where a `session_dump_file` dump landed. `entries` and `bytes` let a client
 * say how much was written without reading the file back. */
export const SessionDumpFileResponseSchema = v.object({
  ok: v.literal(true),
  /** Absolute path of the written JSONL file, on the daemon host. */
  path: v.string(),
  entries: v.number(),
  bytes: v.number(),
});
export type SessionDumpFileResponse = Output<typeof SessionDumpFileResponseSchema>;

/** One live session process, as Claude Code records it in
 * `<config dir>/sessions/<pid>.json`, annotated with which CLAUDE_CONFIG_DIR
 * it is in. Field names follow Claude Code's (camelCase), and `kind` /
 * `status` stay plain strings so newer Claude Code values don't break older
 * daemons. */
export const AgentInfoSchema = v.object({
  pid: v.number(),
  cwd: v.string(),
  /** "interactive" | "background" (upstream values, open set) */
  kind: v.string(),
  /** epoch ms */
  startedAt: v.number(),
  sessionId: v.string(),
  name: v.optional(v.string()),
  /** Claude Code's own word for the process: "waiting" while a dialog waits
   *  for the person (`waitingFor` says which), "shell" while a background
   *  shell (a Monitor) runs, otherwise "idle" / "busy" … (an
   *  upstream-controlled open set). Whether the session answers a turn is
   *  `turn`'s, not this. */
  status: v.optional(v.string()),
  /** Human-readable detail for the current status, e.g. "dialog open". */
  waitingFor: v.optional(v.string()),
  /** the CLAUDE_CONFIG_DIR the session is in, as a realpath */
  config_dir: v.string(),
  /** The `HYOUI_SESSION_ID` the live run tied to this row's process named
   *  (sidecar_hello, DR-0035 §3): the terminal its hooks module presses Enter
   *  on. Absent when no run is tied to the process (the session has no hooks
   *  module, or its module has not named the run yet) or the run was started
   *  outside hyoui. Per process: resuming the same sessionId in a new process
   *  is a new run with its own terminal. */
  hyoui_session_id: v.optional(v.string()),
  /** Whether the session's main thread is answering a turn, and since when,
   *  as its hooks module said (session_facts, DR-0035 §3). Absent when no
   *  module has said anything of the session: it has none (an older plugin,
   *  a config home that does not load it), or the daemon has not heard from
   *  it yet. */
  turn: v.optional(SessionTurnSchema),
});
export type AgentInfo = Output<typeof AgentInfoSchema>;

export const AgentsResponseSchema = v.object({
  ok: v.literal(true),
  agents: v.array(AgentInfoSchema),
  /** ISO time of the round that read `agents`; null when none has run yet */
  polled_at: v.nullable(v.string()),
});
export type AgentsResponse = Output<typeof AgentsResponseSchema>;

export const SessionStatusResponseSchema = v.object({
  ...SessionStatusSnapshotSchema.entries,
  ok: v.literal(true),
  sid: v.string(),
});
export type SessionStatusResponse = Output<typeof SessionStatusResponseSchema>;

export const SessionStatusSubscribeResponseSchema = SessionStatusResponseSchema;
export type SessionStatusSubscribeResponse = SessionStatusResponse;

export const SessionStatusUnsubscribeResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
});
export type SessionStatusUnsubscribeResponse = Output<
  typeof SessionStatusUnsubscribeResponseSchema
>;

export const SessionErrorsResponseSchema = v.object({
  ok: v.literal(true),
  /** Only sessions currently stopped on an error appear; a recovered session
   * drops out of the list rather than appearing with an empty error. Sorted
   * by sid for a stable compare on the daemon's change check. */
  errors: v.array(SessionErrorEntrySchema),
});
export type SessionErrorsResponse = Output<typeof SessionErrorsResponseSchema>;
