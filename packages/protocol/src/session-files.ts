// The per-session files read across processes, as schemas (DR-0038 §3).
//
// - `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` is Claude Code's record of one
//   running process: which session it holds (rewritten when `/clear` starts a
//   new one) and the peer socket it listens on. The CLI reads it to tell
//   whether its session still owns the process, the daemon to deliver into
//   the session. The file is Claude Code's, so the schema lists the fields
//   ccmsg reads and lets the rest through.
// - `<ccmsg state dir>/sessions/<sid>.json` is ccmsg's own: `ccmsg sidecar
//   begin` writes what it found out about the session, and the CLI reads it
//   to introduce the session to the daemon.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** Claude Code's `sessions/<pid>.json`. `messagingSocketPath` and
 * `peerProtocol` are written by a Claude Code that takes peer messages (both
 * present on every file observed 2026-10-11, two config dirs). */
export const ClaudeSessionFileSchema = v.looseObject({
  pid: v.number(),
  sessionId: v.string(),
  /** The working directory, as a realpath (observed 2026-10-09 with the
   * session started through a symlink and with a trailing `/`). */
  cwd: v.optional(v.string()),
  /** The socket the session takes peer messages on. */
  messagingSocketPath: v.optional(v.string()),
  /** The peer protocol generation the socket speaks. */
  peerProtocol: v.optional(v.number()),
});
export type ClaudeSessionFile = Output<typeof ClaudeSessionFileSchema>;

/** A `sessions/<pid>.json` file's text. */
export const ClaudeSessionFileTextSchema = jsonText(ClaudeSessionFileSchema);

/** What `ccmsg sidecar begin` writes to `<state dir>/sessions/<sid>.json`
 * (DR-0039 §2). Everything but `updated_at` may be undiscoverable (no VCS
 * facts) without that being an error. */
export const SessionStateFileSchema = v.object({
  cwd: v.optional(v.string()),
  repo: v.optional(v.string()),
  ws: v.optional(v.string()),
  /** Absolute path of the repo container holding all workspaces / worktrees
   * (DR-0008 addendum). */
  repo_root: v.optional(v.string()),
  /** Current branch / bookmark of the session's checkout; absent when
   * detached or unresolvable. */
  branch: v.optional(v.string()),
  updated_at: v.string(),
});
export type SessionStateFile = Output<typeof SessionStateFileSchema>;

/** A `<state dir>/sessions/<sid>.json` file's text. */
export const SessionStateFileTextSchema = jsonText(SessionStateFileSchema);
