// The shapes of the JSON that crosses process boundaries, shared by the
// daemon, the CLI, the webui and the hooks (DR-0038 §3), and the constants
// both ends of them must agree on. This file re-exports every module beside
// it; which module holds which shape, who reads it and the house rules for
// reading are laid out in docs/design/protocol-package.md.

export { VERSION, PROTOCOL_VERSION, UNANNOUNCED_PROTOCOL_VERSION } from "./version.ts";
export { compareVersions } from "./version-compare.ts";
export * from "./paths.ts";
export * from "./config-migration.ts";
export * from "./search-query.ts";
export * from "./file-search-query.ts";
export * from "./ccmsg-address.ts";
export * from "./ccmsg-direct-transcript.ts";
export * from "./parse.ts";
export * from "./json-value.ts";
export * from "./transcript-content.ts";
export * from "./transcript-attachment.ts";
export * from "./transcript-row.ts";
export * from "./transcript-tool-result.ts";
export * from "./agent-meta.ts";
export * from "./claude-agents.ts";
export * from "./session-files.ts";
export * from "./allowed-origins.ts";
export * from "./workflow-run.ts";
export * from "./sidecar.ts";
export * from "./request.ts";
export * from "./storage-event.ts";
export * from "./session-status.ts";
export * from "./response.ts";
export * from "./stream-event.ts";
export * from "./frame.ts";
export * from "./attachment-upload.ts";
import type { LlmRequestInfo } from "./stream-event.ts";

/** Reserved id for the User (kawaz), admin role. Implicit member of every room. */
export const ADMIN_ID = "u1";

/** Default initial-delivery cap on join (DR-0003 §5, N=50). */
export const DEFAULT_JOIN_BACKLOG = 50;

/** Default dedup window for create_room (DR-0003 §4, minute-order). */
export const DEFAULT_DEDUP_WINDOW_MS = 60_000;

/** Default HTTP/WS bind for `/ws` (DR-0004 §3).
 *  `CCMSG_HTTP_BIND=off` disables it. Loopback only — a browser's Same-Origin
 *  Policy does not gate WebSocket connections, so binding beyond loopback (or
 *  trusting source-IP alone, e.g. a shared tailnet CGNAT range) would let any
 *  page a browser has open reach this daemon. tailscale serve (or any other
 *  reverse proxy) forwards to loopback from the outside; see `CCMSG_HTTP_ALLOW_ORIGIN`
 *  for allowing that proxy's Origin through the check below. */
export const DEFAULT_HTTP_BIND = "127.0.0.1:8642,[::1]:8642";

/** Default source-IP allowlist for `/ws` and HTTP fallback (DR-0004 §3).
 *  loopback only — override with `CCMSG_HTTP_ALLOW`
 *  (comma-separated CIDR/IP). This is a defense-in-depth belt against a misconfigured
 *  `CCMSG_HTTP_BIND`; the actual trust boundary for browser clients is the `Origin`
 *  header check (see `CCMSG_HTTP_ALLOW_ORIGIN`), since source IP alone can't
 *  distinguish this daemon's own webui from any other page open in the same browser. */
export const DEFAULT_HTTP_ALLOW = "127.0.0.0/8,::1";

/** fs_read (DR-0008) sends at most this many bytes of a file's head; larger
 * files come back `truncated: true` so the viewer can say so instead of
 * silently showing a partial file. */
export const FS_READ_MAX_BYTES = 512 * 1024;

/** DR-0018 §3.1 defaults used when session launcher config omits or corrupts
 * the corresponding positive numeric fields. */
export const DEFAULT_DIR_TREE_DEPTH = 2;
export const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 10;

/** Every template implicitly declares this parameter, because the launcher has
 * to have a directory to spawn in: it is the child process's working directory
 * and the one value checked against `root_dirs`. A config that omits it from a
 * template's `params` gets it prepended at parse time. */
export const LAUNCHER_CWD_PARAM = "CWD";

/** transcript_read (DR-0009) returns at most this many bytes of jsonl lines
 * per request; the viewer pages with byte offsets instead of asking for more.
 * 1 MB balances two costs measured on real transcripts: a larger page makes
 * the initial render heavier (every record is materialized into the DOM), a
 * smaller one makes the reader press "older" more often (500 KB was too
 * small, 2 MB too heavy). */
export const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024;

/** Historical session search response caps (DR-0021 Phase 1). These are wire
 * contract limits so every client can render truncation consistently. */
export const SESSION_SEARCH_RESULT_MAX = 50;
export const SESSION_SEARCH_MATCH_SUMMARY_MAX = 3;

/** Fallback length of an upstream prompt cache window, for events that carry
 * neither `cache_expires_at` nor `origin`. Both sides count down to the same
 * deadline, so the assumed length has to be shared; when the gateway states
 * the real one, that wins over this guess. */
export const LLM_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/** When the cache window opened by one request closes, in epoch ms. The
 * daemon prunes with it and the webui draws the ring to it, so the arithmetic
 * lives here once rather than once per side.
 *
 * The gateway states `origin` on every request event, so on such an event a
 * missing deadline is not silence about the cache — it is the gateway saying
 * this request cached nothing, and the window closed the moment it opened.
 * Only an event carrying no `origin` at all falls back to the assumed five
 * minutes. */
export function llmCacheWindowEndMs(info: {
  ts: number;
  cache_expires_at?: number;
  origin?: LlmRequestInfo["origin"];
}): number {
  if (info.cache_expires_at !== undefined) return info.cache_expires_at;
  if (info.origin !== undefined) return info.ts;
  return info.ts + LLM_PROMPT_CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Wire: identity
// ---------------------------------------------------------------------------

export interface SessionIdentity {
  role: "session";
  sid: string;
  repo: string;
  ws: string;
  /** absolute path the session is working in, from the fixed sources alone
   * (DR-0003 §3 「所在の正本」): `CCMSG_CWD`, the session state file
   * `sidecar begin` writes, `CLAUDE_PROJECT_DIR`. Empty means the caller could not name it, and
   * the daemon then keeps the location it registered earlier instead of
   * blanking it — `repo`/`ws`/`repo_root`/`branch` move with it as one group. */
  cwd: string;
  /** absolute path of this session's Claude Code transcript jsonl (DR-0009).
   * Announced only through the CCMSG_TRANSCRIPT_PATH override; the daemon
   * otherwise finds the session's own `projects/<project>/<sid>.jsonl` at
   * hello time. Validated there, and it is the ONLY file transcript_read
   * serves for this sid. */
  transcript_path?: string;
  /** absolute path of the repository container holding ALL of this repo's
   * workspaces/worktrees (DR-0008 addendum). When announced and accepted by
   * the daemon's hello-time validation (absolute, realpath-resolvable, a
   * strict ancestor of cwd, not "/" or $HOME itself), it becomes the
   * containment root and fs_list/fs_read base so sibling workspaces are
   * browsable. fs_write remains cwd-relative inside that boundary. Rejected or
   * absent = cwd is both the browse base and containment root. */
  repo_root?: string;
  /** current branch / bookmark name of the session's checkout (informational,
   * for the webui session list). Empty/absent when detached or unknown. */
  branch?: string;
  /** absolute path of the CLAUDE_CONFIG_DIR this session runs under, as the
   * daemon normalized it at hello time. It adds the directory to those whose
   * sessions a `ccmsg:` address may reach (`address_send`, DR-0037 §1).
   * Absent when the client did not announce one. */
  config_dir?: string;
}
export interface UserIdentity {
  role: "user";
}
export type Identity = SessionIdentity | UserIdentity;

// ---------------------------------------------------------------------------
// Wire: requests, replies and pushes, one JSON per line
// ---------------------------------------------------------------------------
//
// The requests and their replies are schemas: request.ts and the request-*.ts
// files it joins, response.ts and the response-*.ts files it joins, and the
// pushes in stream-event.ts (DR-0038). What follows are limits the replies
// keep to.

/** Maximum paths per fs_stat_batch request. A single agent message rarely
 * exceeds a handful of file references; the cap defends the daemon against
 * a runaway client from opening an unbounded loop of stat syscalls. Chosen
 * generously (256) so a heavily-cited migration report still fits in one
 * batch without needing multi-round coordination. */
export const FS_STAT_BATCH_MAX_PATHS = 256;

/** Maximum hits one fs_find reply carries. A name search is a navigation aid:
 * past a screenful or two the user narrows the query rather than scrolling, so
 * a modest cap keeps the response small and the walk short. */
export const FS_FIND_RESULT_MAX = 200;

/** Maximum directory entries one fs_find walk will visit before giving up,
 * independent of how many matched. Bounds the syscall cost of a search in a
 * repo whose tree is enormous (a monorepo with vendored dependencies), so one
 * request cannot stall the daemon's synchronous handler indefinitely — the
 * same concern MAX_DIR_TREE_DEPTH addresses for dir_tree. */
export const FS_FIND_VISIT_MAX = 50_000;

/** Bounds on LlmStatsRequest.days. One day is the smallest window the gateway
 * buckets by. The ceiling is a sanity bound rather than a real span — a
 * century of days: the gateway clamps any request to what it actually holds,
 * and the UI's widest view ("yearly") deliberately asks for more than that to
 * mean "everything". It exists only so a typo cannot ask for an absurd number. */
export const LLM_STATS_DAYS_MIN = 1;
export const LLM_STATS_DAYS_MAX = 36_524;

// ---------------------------------------------------------------------------
// Attachment upload over multipart HTTP (DR-0015 §2.3). The body it answers
// with is AttachmentUploadResponseSchema (attachment-upload.ts).
// ---------------------------------------------------------------------------

/** DR-0015 §2.2 default upload size cap (bytes). Overridable via
 * `CCMSG_ATTACHMENT_MAX_BYTES`; upload exceeding this returns HTTP 413. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Error codes (string, per DR-0003 §1)
// ---------------------------------------------------------------------------

export const ErrorCode = {
  bad_request: "bad_request",
  hello_required: "hello_required",
  room_not_found: "room_not_found",
  not_a_member: "not_a_member",
  invalid_args: "invalid_args",
  // Workspace file access (DR-0008)
  session_not_found: "session_not_found",
  path_forbidden: "path_forbidden",
  not_found: "not_found",
  // Inbox file creation (DR-0019): fs_write is restricted to new paths under
  // docs/inbox/ and never overwrites an existing filesystem entry.
  path_not_writable: "path_not_writable",
  file_exists: "file_exists",
  // fs_edit (in-place text edit): file was modified between read and write.
  file_conflict: "file_conflict",
  // fs_edit: on-disk content sniffed as binary (NUL byte in head) — refusing
  // ensures this op can only mutate what the viewer could faithfully display.
  not_a_text_file: "not_a_text_file",
  // Session launcher (DR-0018): no valid session_launcher configuration means
  // both directory browsing and launch remain closed.
  launcher_not_configured: "launcher_not_configured",
  // Broadcast room (DR-0013 §2.4): agent post to a broadcast room must include
  // "u1" in `to`. "u1 に届かない agent 発話" を broadcast の意味論で禁じるため。
  broadcast_agent_target_required: "broadcast_agent_target_required",
  // reply (DR-0017 §2.2): the mid the reply points at doesn't exist in the room.
  msg_not_found: "msg_not_found",
  // reply (DR-0017 §2.2): replying to your own msg is meaningless — the
  // constructed target list would collapse to just u1 + yourself.
  self_reply: "self_reply",
  // DR-0023 host translation: the daemon is not running on macOS, the helper
  // cannot be built/found, or its persistent process failed.
  translate_unavailable: "translate_unavailable",
  translate_helper_failed: "translate_helper_failed",
  // llm_usage: `<configDir>/config.json` has no valid `llm_usage_url`, so there
  // is nothing to proxy. Distinct from llm_usage_unavailable so the webui can
  // tell "operator never set this up" (hide the feature) from "the gateway is
  // down right now" (show the error and let the user retry).
  llm_usage_not_configured: "llm_usage_not_configured",
  // llm_usage: the gateway was configured but did not answer usably — refused
  // the connection, timed out, returned a non-2xx status, or sent a body that
  // is not the expected JSON shape.
  llm_usage_unavailable: "llm_usage_unavailable",
  // llm_stats: the same two distinctions as llm_usage, for the independently
  // configured spend endpoint (`llm_stats_url`).
  llm_stats_not_configured: "llm_stats_not_configured",
  llm_stats_unavailable: "llm_stats_unavailable",
  // llm_status: the same two distinctions again, for the independently
  // configured upstream-service endpoint (`llm_status_url`). Separate from the
  // usage pair because a gateway old enough to serve usage may not serve
  // status at all, and the webui hides only the part it cannot fill.
  llm_status_not_configured: "llm_status_not_configured",
  llm_status_unavailable: "llm_status_unavailable",
  // sandbox_grant: `<configDir>/config.json` has no usable
  // `sandbox_origin_template`, so there is no origin to mint a URL on
  // (DR-0030 §7.1). Same "operator never set this up" role
  // llm_usage_not_configured plays — hello's `sandbox_available` normally
  // keeps the webui from asking at all, and this covers the window where the
  // config changed under a live connection.
  sandbox_not_configured: "sandbox_not_configured",
  // session_rename: the session exists but the daemon knows no terminal to
  // type into (no run of it named a HYOUI_SESSION_ID: no hooks module, started
  // outside hyoui, or the agents poll has not seen it yet). Kept apart from not_found — "this session cannot be renamed
  // this way" is a standing property of how the session was started, whereas
  // not_found would suggest retrying against a session that is simply gone.
  terminal_unavailable: "terminal_unavailable",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
