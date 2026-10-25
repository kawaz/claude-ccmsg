// The wire's session requests (client -> daemon), as schemas (DR-0038): the
// hello that identifies a connection, the peers and messages between
// sessions, and what the person does to a session from the webui (launch,
// kill, rename, type into it, look into it). request.ts joins them into one
// request and reads a line with them.
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";
import { LaunchInputSchema } from "./launch.ts";
import type { Output } from "./parse.ts";
import { PeerListInputSchema, SendMessageInputSchema } from "./peer-tools.ts";
import { PermitInputSchema } from "./permit-request.ts";
import {
  AgentAppendArgsSchema,
  SessionFactsSchema,
  SidecarReplySchema,
  SidecarRunIdSchema,
} from "./sidecar.ts";
import { PROTOCOL_VERSION } from "./version.ts";

/** A Claude Code session id as a request names one. Its shape (a lowercase
 * UUID) is the daemon's to check where it matters; the request only has to
 * name something. */
const SessionIdSchema = v.pipe(
  v.string(),
  v.nonEmpty("Expected a session id, not an empty string"),
);

export const HelloRequestSchema = v.object({
  op: v.literal("hello"),
  role: v.picklist(["session", "user"]),
  sid: v.optional(v.string()),
  repo: v.optional(v.string()),
  ws: v.optional(v.string()),
  cwd: v.optional(v.string()),
  transcript_path: v.optional(v.string()),
  repo_root: v.optional(v.string()),
  branch: v.optional(v.string()),
  /** CLAUDE_CONFIG_DIR of the session's own process — the CLI reads it from
   * its environment (falling back to Claude Code's default `$HOME/.claude`
   * when unset) and the daemon normalizes it. Only used to find the sessions
   * a send may reach: the daemon reads the live runs of every config dir it
   * knows (`send_message`, DR-0039 §3); never echoed back on the wire. */
  config_dir: v.optional(v.string()),
  /** The ccmsg build this client runs (`VERSION`). Diagnostic only — the
   * daemon never gates on it — but it is what turns "this session's client is
   * stale" into an actionable line: it names the version to upgrade from. */
  client_version: v.optional(v.string()),
  /** The wire generation this client speaks: this one. A hello of another
   * generation is OtherGenerationHelloRequest. Omitting the field means
   * generation `UNANNOUNCED_PROTOCOL_VERSION`, which is this generation, so
   * such a hello is read here; when `PROTOCOL_VERSION` moves past it, the
   * field becomes required here and its absence moves to the other
   * generation. */
  protocol: v.optional(v.literal(PROTOCOL_VERSION)),
  /** How the browser arrived at the page this hello comes from
   * (`PerformanceNavigationTiming.type`: navigate / reload / back_forward /
   * prerender). Diagnostic only, and sent by the webui on the first hello of a
   * page load alone — a hello without it is a socket the same page re-opened,
   * which is exactly the distinction the daemon log needs to tell "kawaz
   * reloaded the tab" from "the tab reconnected on its own". */
  nav_type: v.optional(v.string()),
  /** Two-word summary of the browser this hello comes from
   * (`<platform>/<browser>`, e.g. `iPad/Safari`), not the raw user agent —
   * enough to name which device a connection belongs to in the daemon log,
   * with no fingerprinting surface beyond that. Diagnostic only. */
  ua: v.optional(v.string()),
});
export type HelloRequest = Output<typeof HelloRequestSchema>;

/** A hello of a generation this daemon does not speak (DR-0002 §4). Only what
 * the refusal needs is read: the generation, and which session's client it is
 * (filed as `PeerInfo.stale_client`). The rest of it is that generation's
 * shape, and is not read. */
export const OtherGenerationHelloRequestSchema = v.object({
  op: v.literal("hello"),
  protocol: v.pipe(v.number(), v.notValue(PROTOCOL_VERSION)),
  role: v.optional(v.picklist(["session", "user"])),
  sid: v.optional(v.string()),
  client_version: v.optional(v.string()),
});
export type OtherGenerationHelloRequest = Output<typeof OtherGenerationHelloRequestSchema>;

/** A hello of any generation, told apart by the generation it announces. */
export const AnyGenerationHelloRequestSchema = v.variant("protocol", [
  HelloRequestSchema,
  OtherGenerationHelloRequestSchema,
]);

export const PeersRequestSchema = v.object({
  op: v.literal("peers"),
});
export type PeersRequest = Output<typeof PeersRequestSchema>;

/** Turn this connection into a stream of the daemon's pushes: notify and
 * net_online for a session, and the webui's pushes (peers, agents, says, …)
 * for the user role (stream-event.ts). */
export const SubscribeRequestSchema = v.object({
  op: v.literal("subscribe"),
});
export type SubscribeRequest = Output<typeof SubscribeRequestSchema>;

export const NotifyRequestSchema = v.object({
  op: v.literal("notify"),
  /** target session sid; absent = self. */
  sid: v.optional(v.string()),
  text: v.string(),
});
export type NotifyRequest = Output<typeof NotifyRequestSchema>;

/** Record that this session spoke through `ccmsg say` (session role only).
 * The daemon keeps the record in memory and pushes it to user-role
 * subscribers as part of `ev:"says"` (stream-event.ts SayRecord); the speaker
 * is the caller's own sid, so the request names no session. The CLI ignores
 * the reply and execs `/usr/bin/say` regardless, so a failure here costs the
 * observation, never the speech. */
export const SayRequestSchema = v.object({
  op: v.literal("say"),
  /** The argv forwarded to `/usr/bin/say`, joined by spaces (see SayRecord.text). */
  text: v.string(),
});
export type SayRequest = Output<typeof SayRequestSchema>;

/** Ask the person for permission (DR-0040, session role only): the caller's
 * `permit` tool. The daemon records the request (its attachments by path), and
 * shows it in the caller's Timeline; the caller is the one asking, so the
 * request names no session. */
export const PermitRequestRequestSchema = v.object({
  op: v.literal("permit_request"),
  permit: PermitInputSchema,
});
export type PermitRequestRequest = Output<typeof PermitRequestRequestSchema>;

/** Mark requests for permission as read (the webui's 許可する, DR-0040 §7).
 * User role only, as say_read is: what is unread is what the person has not
 * acted on. */
export const PermitRequestReadRequestSchema = v.object({
  op: v.literal("permit_request_read"),
  ids: v.pipe(v.array(v.string()), v.nonEmpty("Expected at least one request id")),
});
export type PermitRequestReadRequest = Output<typeof PermitRequestReadRequestSchema>;

/** Read one attachment of a request for permission, as it is now (DR-0040
 * §3): the webui's opening it. User role only. `path` must be one the
 * request named, so the person reads only what the asking session put in
 * front of them. */
export const PermitAttachmentReadRequestSchema = v.object({
  op: v.literal("permit_attachment_read"),
  id: v.string(),
  path: v.string(),
});
export type PermitAttachmentReadRequest = Output<typeof PermitAttachmentReadRequestSchema>;

/** Mark say records as read (the webui's 既読 button). User role only: the
 * unread count exists for the person watching the session list, and a session
 * acking its own speech would clear a badge nobody looked at. */
export const SayReadRequestSchema = v.object({
  op: v.literal("say_read"),
  /** `id`s of the SayRecords being acked: one for a single bubble, every
   * unread one the Timeline shows for its 「すべて既読」. The ids are the ones
   * the reader saw, so a say arriving after the click stays unread. */
  ids: v.pipe(v.array(v.string()), v.nonEmpty("Expected at least one say id")),
});
export type SayReadRequest = Output<typeof SayReadRequestSchema>;

/** Send a message to the sessions `to` picks out: what the `send` tool of a
 * session's hooks module asks (session role only, DR-0039 §3).
 *
 * The daemon reads the live session runs afresh, keeps the sessions that
 * match every field of `to`, and writes the envelope (`from: ccmsg:<sid>` of
 * the asking session, no reply line) into the peer socket of each that has a
 * hooks module. The asking session is left out; a send that matched it alone
 * says so. With `agent_id`, the text goes instead to that running subagent of
 * each matched session, through the session's module (`agent.append`, as
 * user_message), marked as from the asking session; the asking session is
 * then not left out, its own subagents being others. It answers one result
 * per session matched. */
export const SendMessageRequestSchema = v.object({
  op: v.literal("send_message"),
  ...SendMessageInputSchema.entries,
});
export type SendMessageRequest = Output<typeof SendMessageRequestSchema>;

/** The sessions a send could go to, as send_message would match them: what the
 * `peers` tool of a session's hooks module asks (session role only,
 * DR-0039 §3). */
export const PeerListRequestSchema = v.object({
  op: v.literal("peer_list"),
  ...PeerListInputSchema.entries,
});
export type PeerListRequest = Output<typeof PeerListRequestSchema>;

/** Session-launcher cwd tree (DR-0018 §3.4, user role only). Requested roots
 * may be configured roots or any descendants: descendant roots are required
 * for LN-Q3 lazy expansion after the initial bounded fetch. */
export const DirTreeRequestSchema = v.object({
  op: v.literal("dir_tree"),
  roots: v.array(v.string()),
  /** Absent uses config dir_tree_depth; lazy expansion sends 1. */
  depth: v.optional(v.number()),
  /** Root-relative path substring; matching nodes and their ancestors survive. */
  filter: v.optional(v.string()),
});
export type DirTreeRequest = Output<typeof DirTreeRequestSchema>;

/** Session launch request (DR-0018 §3.4), from the user and from a session
 * alike (§3.8): the one launch command the config names is what runs, and the
 * caller chooses only the launch.
 *
 * Slow reply: the reply comes once the launch command has finished (up to
 * launch_timeout_seconds, the kill grace and the wait for its output). Requests of
 * one connection are answered concurrently (RequestEnvelope), so the wait
 * holds nothing else back. */
export const SessionLaunchRequestSchema = v.object({
  op: v.literal("session_launch"),
  launch: LaunchInputSchema,
});
export type SessionLaunchRequest = Output<typeof SessionLaunchRequestSchema>;

/** What the webui's launch form needs before anything is picked: `root_dirs`,
 * the roots of its cwd tree, and `default_effort`, the effort to preselect for
 * each model (DR-0018 §3.4, user role). The models and efforts offered come
 * from the protocol's picklists, not from here.
 * `launcher_not_configured` when there is no `session_launcher`, as for the
 * launch itself. */
export const SessionLauncherConfigRequestSchema = v.object({
  op: v.literal("session_launcher_config"),
});
export type SessionLauncherConfigRequest = Output<typeof SessionLauncherConfigRequestSchema>;

/** Terminate the OS process behind a Claude Code session (DR-0028, user role
 * only — session-role agents must never be able to kill each other). The
 * daemon resolves sid→pid FRESH at request time from Claude Code's state files
 * (`sessions/<pid>.json`) in the config dirs where it reaches the session
 * (never the agents rows, which can be a round stale — a stale pid is a
 * mis-kill), then verifies the
 * pid's command line still looks like a claude process (`ps -p <pid> -o
 * command=`, pid-reuse guard) before signalling. Kill sequence: SIGTERM →
 * ~1s wait → SIGTERM again if still alive (the claude TUI's first SIGTERM
 * only arms its quit-confirmation guard; the second confirms) → observe up
 * to ~3s total. Never escalates to SIGKILL (graceful shutdown / transcript
 * flush must not be broken by the daemon's own judgement).
 *
 * Slow reply like session_launch: the resolve + kill sequence takes up to
 * ~4s, and the one reply carrying the outcome comes back then. */
export const SessionKillRequestSchema = v.object({
  op: v.literal("session_kill"),
  /** The Claude Code session UUID whose process to terminate. The request
   * intentionally carries NO pid — a client-asserted pid would be a weaker
   * basis for killing than the daemon's own fresh resolution (DR-0028). */
  session_id: SessionIdSchema,
  /** DR-0028: escalate to SIGKILL when true. Absent /
   * false runs the normal two-shot SIGTERM sequence.
   * SIGKILL is irreversible and can break transcript flush, so the daemon
   * never chooses it on its own — the caller must explicitly opt in after
   * observing that a graceful attempt failed (webui: 「終了確認」で `terminated:
   * false` を観測してから「強制終了 (-KILL)」に切り替わったボタンをもう一度
   * 押す 2 段動線)。sid→pid 解決と ps 検証は force 時も同じで、pid-reuse ガード
   * だけは絶対に外さない。 */
  force: v.optional(v.boolean()),
});
export type SessionKillRequest = Output<typeof SessionKillRequestSchema>;

/** Restart a session (DR-0028 「restart」, user role only): stop its process as
 * session_kill does, and once it is observed gone, resume the same id through
 * the launch command (DR-0018), with the model / effort / name it runs as and
 * a prompt saying it was restarted. Every reason to refuse is checked before
 * the process is stopped.
 *
 * Slow reply like session_launch: up to the kill grace and the launch
 * command's wait. */
export const SessionRestartRequestSchema = v.object({
  op: v.literal("session_restart"),
  /** The session to restart. No pid, for the reason session_kill takes none. */
  session_id: SessionIdSchema,
});
export type SessionRestartRequest = Output<typeof SessionRestartRequestSchema>;

/** Retitle a running Claude Code session by typing its own `/rename` command
 * into the terminal that session lives in (user role only).
 *
 * There is no API to set a session's title: Claude Code records `name` in
 * its state file but nothing writes it from outside, and the title kawaz wants to fix
 * is exactly that `name` (the Sessions list's first line). The one route that
 * does work is the one kawaz performs by hand today — switch to the session's
 * terminal and type `/rename <title>`. This op automates that keystroke
 * delivery through hyoui, the terminal multiplexer the sessions run under:
 * the daemon already learns each session's `HYOUI_SESSION_ID` from the run its
 * hooks module names (AgentInfo.hyoui_session_id), which is the terminal
 * handle `hyoui input` needs. A session with no known hyoui terminal is refused with
 * `terminal_unavailable` rather than guessed at.
 *
 * **Best-effort by construction**: success means the keystrokes were handed
 * to the terminal, NOT that Claude Code accepted the rename — the daemon
 * cannot see the TUI's reaction. A session sitting in a modal, or a build of
 * Claude Code without `/rename`, will report `ok` here and simply not be
 * renamed. The webui says so in its own wording rather than claiming the
 * title changed; the authoritative title arrives later via the normal agents
 * poll.
 *
 * `title` is embedded into a single hyoui spec argument (`text:/rename
 * <title>`), and hyoui applies no escape processing — a raw newline in the
 * value would reach the TUI as a real newline and submit a half-typed
 * command. Control characters are therefore rejected up front (see
 * validateRenameTitle in the daemon) instead of being silently stripped.
 *
 * Slow reply for the same reason as session_kill: this spawns a `hyoui
 * input` child, and hyoui itself serializes against other input holders. */
export const SessionRenameRequestSchema = v.object({
  op: v.literal("session_rename"),
  /** The Claude Code session UUID to retitle. The request carries no
   * hyoui session id for the same reason session_kill carries no pid: the
   * daemon's own agents-poll resolution is a stronger basis than a
   * client-asserted terminal handle, and a wrong handle would type a
   * `/rename` into somebody else's terminal. */
  session_id: SessionIdSchema,
  /** The new title, as the user typed it. Leading/trailing whitespace is
   * trimmed; control characters are rejected (invalid_args). */
  title: v.string(),
});
export type SessionRenameRequest = Output<typeof SessionRenameRequestSchema>;

/** Put what the person wrote into a session as their own prompt (user role
 * only, DR-0035 §1).
 *
 * The daemon writes one `prompt.send` SidecarRequest to a sidecar of a live
 * run of the session. The session's hooks module fills the composer with the
 * text and sends Enter to its own terminal, so the harness records the prompt
 * as typed by a person (`origin: { kind: "human" }`, `promptSource: "typed"`),
 * not as a message from a peer. The module answers with a SidecarReply
 * (through SidecarReplyRequest), and the reply to this op is what that answer
 * says — or `unconfirmed` when none came in time.
 *
 * Runs are asked one at a time, each try under an id of its own: the next run
 * is asked only after one answers `no_composer` or `no_terminal`, which say it
 * cannot take a person's input at all. Asking two runs that both have a
 * composer would put the text in twice (DR-0035 §3). */
export const UserPromptRequestSchema = v.object({
  op: v.literal("user_prompt"),
  session_id: SessionIdSchema,
  /** The prompt, verbatim. Several lines become one prompt. Must hold
   * something other than whitespace. */
  text: v.pipe(
    v.string(),
    v.check((text) => text.trim() !== "", "Expected text with something other than whitespace"),
  ),
});
export type UserPromptRequest = Output<typeof UserPromptRequestSchema>;

/** Add what a person wrote to the conversation of a running subagent of a
 * session (user role only, DR-0039 §6). The daemon hands it to a run's hooks
 * module as an `agent.append` request; the subagent's next request carries
 * it, the session's main thread does not. Context, not a prompt: it grants
 * nothing. */
export const UserMessageRequestSchema = v.object({
  op: v.literal("user_message"),
  session_id: SessionIdSchema,
  agent_id: AgentAppendArgsSchema.entries.agentId,
  text: AgentAppendArgsSchema.entries.text,
});
export type UserMessageRequest = Output<typeof UserMessageRequestSchema>;

/** Hand the daemon a session's hooks module's SidecarReply (session role,
 * DR-0035 §1). Taken only from the session the request was written to, and
 * only the first reply under an id counts. The reply's `result` is read by
 * the daemon with the schema of the op it asked (see SidecarReplySchema). */
export const SidecarReplyRequestSchema = v.object({
  op: v.literal("sidecar_reply"),
  reply: SidecarReplySchema,
});
export type SidecarReplyRequest = Output<typeof SidecarReplyRequestSchema>;

/** Name a run of the session to the daemon (session role, DR-0035 §3). The
 * session's sidecar sends it once it has bound its socket, on a connection of
 * its own that it keeps open for its life: the run counts among the session's
 * live runs — the ones a user_prompt is written to — until that connection
 * closes, and a sidecar whose daemon went away connects to the next one and
 * names the run again. The session is the connection's (its hello), and the
 * socket is `<sid>.<run_id>.sock` in the sidecar directory both sides derive
 * from the state dir, so no path is taken from the sender. */
export const SidecarHelloRequestSchema = v.object({
  op: v.literal("sidecar_hello"),
  run_id: SidecarRunIdSchema,
  /** When the run started (the hooks module was loaded), epoch ms. The daemon
   * ties the run to its harness process by the session's row in `claude
   * agents --json` whose start is nearest this. */
  started_at: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  /** The run's CLAUDE_CONFIG_DIR as its hooks module reads it, which is where
   * the daemon looks for that row; absent when the variable is unset. */
  config_dir: v.optional(v.pipe(v.string(), v.nonEmpty())),
  /** The run's HYOUI_SESSION_ID as its hooks module reads it — the terminal
   * the module presses Enter on; absent outside hyoui, where a person's input
   * cannot be submitted (`no_terminal`). */
  hyoui_session_id: v.optional(v.pipe(v.string(), v.nonEmpty())),
});
export type SidecarHelloRequest = Output<typeof SidecarHelloRequestSchema>;

/** Hand the daemon what a session's hooks module knows of its session
 * through Claude Code itself (session role, DR-0035 §3): `ccmsg sidecar
 * facts` sends it each time a part moves. The facts are the session's (its
 * hello), replace the ones the daemon holds unless they are older, and go
 * when the session does. */
export const SessionFactsRequestSchema = v.object({
  op: v.literal("session_facts"),
  facts: SessionFactsSchema,
});
export type SessionFactsRequest = Output<typeof SessionFactsRequestSchema>;

/** Read the environment variables of a session's own process (user role
 * only). The env is read from the resolved pid rather than
 * from the daemon's session connection: the subscribe helper the session
 * spawns carries whatever Claude Code added on the way down, which is not
 * the session process's environment. sid→pid resolution and the ps
 * pid-reuse verification are shared verbatim with session_kill — reading a
 * recycled pid's environment would disclose an unrelated process's secrets. */
export const SessionEnvRequestSchema = v.object({
  op: v.literal("session_env"),
  /** The Claude Code session UUID whose process environment to read. Carries
   * no pid for the same reason session_kill doesn't — a client-asserted pid
   * is a weaker basis than the daemon's own fresh resolution. */
  session_id: SessionIdSchema,
});
export type SessionEnvRequest = Output<typeof SessionEnvRequestSchema>;

/** Search historical Claude Code session transcripts under daemon-detected
 * config dirs (DR-0021 Phase 1, user role only). */
export const SessionSearchRequestSchema = v.object({
  op: v.literal("session_search"),
  /** newline-separated clauses, OR-ed; blank lines are ignored, and a clause's
   * whitespace-separated terms are ANDed across the session's messages */
  query: v.optional(v.string()),
  /** default false; preserves pattern/text case when matching */
  case_sensitive: v.optional(v.boolean()),
  /** default false; treats each non-blank query line as a RegExp pattern */
  regex: v.optional(v.boolean()),
  /** default true; includes ccmsg queue deliveries authored by u1 */
  target_user: v.optional(v.boolean()),
  /** default true; includes ccmsg queue deliveries authored by non-u1 members */
  target_agent: v.optional(v.boolean()),
  /** space-separated, case-insensitive substring words matched against restored cwd */
  cwd: v.optional(v.string()),
  /** UUID substring filter */
  sid: v.optional(v.string()),
  /** intersected with daemon-detected dirs; paths outside that set are ignored */
  config_dirs: v.optional(v.array(v.string())),
  /** `<number>m`, `<number>h`, or `<number>d`; default `5d` */
  mtime_within: v.optional(v.string()),
});
export type SessionSearchRequest = Output<typeof SessionSearchRequestSchema>;

/**
 * Ask where a forked session stopped being a copy of its ancestor (user role
 * only). `claude --fork-session` duplicates the ancestor's records into the new
 * file preserving each `uuid`, rewriting only `sessionId`
 * (docs/findings/2026-08-11-checkpoint-rewind.md §5) — so nothing inside the
 * file marks the seam, and answering needs the sibling transcripts the daemon
 * can already enumerate. There is no client-supplied path: the sid resolves
 * through the same historical resolver transcript_read uses, and only its own
 * project directory is scanned.
 */
export const ForkOriginRequestSchema = v.object({
  op: v.literal("fork_origin"),
  sid: v.string(),
});
export type ForkOriginRequest = Output<typeof ForkOriginRequestSchema>;

/**
 * Write a session's dump to a file under the daemon's `dumps/` directory and
 * answer with its absolute path (user role only). The dump itself is what
 * `ccmsg dump` produces; what this op adds is a durable artifact whose path a
 * successor session can be handed, instead of a payload that would have to
 * travel through the browser and back out again. The sid resolves through the
 * same historical resolver transcript_read uses, and the client never supplies
 * a path — the destination is the daemon's own data directory. The file is
 * always written as text (`formatTextDump`'s form), not jsonl: a successor
 * session is meant to read it directly rather than parse it as structured
 * data.
 */
export const SessionDumpFileRequestSchema = v.object({
  op: v.literal("session_dump_file"),
  sid: v.string(),
  /** Inclusive lower bound, as either a timezone-qualified ISO 8601 timestamp
   * or a transcript record `uuid`; same parsing as `ccmsg dump --since`. A
   * uuid cuts at that record's position rather than its clock, so records
   * sharing its timestamp stay on their own side of the boundary — which is
   * why the webui, which shows each record's uuid, can offer an exact "from
   * this message on". A uuid no record in the session carries is refused. */
  since: v.optional(v.string()),
  /** Inclusive upper bound, in the same two forms as `since`. */
  until: v.optional(v.string()),
  /** Drop assistant thinking blocks (`ccmsg dump --no-thinking`). */
  no_thinking: v.optional(v.boolean()),
  /** Drop in-process agent machinery (`ccmsg dump --no-agent`). */
  no_agent: v.optional(v.boolean()),
});
export type SessionDumpFileRequest = Output<typeof SessionDumpFileRequestSchema>;

/** One-shot fetch of the latest agents rows (user role
 * only). The webui uses this for the initial paint; subsequent changes arrive
 * as `ev:"agents"` stream events. */
export const AgentsRequestSchema = v.object({
  op: v.literal("agents"),
});
export type AgentsRequest = Output<typeof AgentsRequestSchema>;

export const SessionStatusRequestSchema = v.object({
  op: v.literal("session_status"),
  sid: v.string(),
});
export type SessionStatusRequest = Output<typeof SessionStatusRequestSchema>;

export const SessionStatusSubscribeRequestSchema = v.object({
  op: v.literal("session_status_subscribe"),
  sid: v.string(),
});
export type SessionStatusSubscribeRequest = Output<typeof SessionStatusSubscribeRequestSchema>;

export const SessionStatusUnsubscribeRequestSchema = v.object({
  op: v.literal("session_status_unsubscribe"),
  sid: v.string(),
});
export type SessionStatusUnsubscribeRequest = Output<typeof SessionStatusUnsubscribeRequestSchema>;

/** One-shot fetch of every connected session currently stopped on a harness
 * API error (user role only). The webui uses this for the initial paint;
 * later changes arrive as `ev:"session_errors"` stream events. Unlike
 * `session_status`, this is not per-sid: the sidebar has to colour *other*
 * sessions' rows, and subscribing a full status fold per visible peer is the
 * cost DR-0020 §2.1 (a) explicitly avoided. The daemon instead folds the one
 * api_error pattern over every connected peer's transcript tail. */
export const SessionErrorsRequestSchema = v.object({
  op: v.literal("session_errors"),
});
export type SessionErrorsRequest = Output<typeof SessionErrorsRequestSchema>;
