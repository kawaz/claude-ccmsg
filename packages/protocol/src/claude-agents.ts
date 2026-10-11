// What `claude agents --json` prints, as a schema (DR-0038 §3): Claude Code's
// register of its sessions, one JSON array per CLAUDE_CONFIG_DIR.
//
// The output is Claude Code's, so the schemas list the fields ccmsg reads and
// let the rest through. Two listings are read, and their rows differ in one
// field:
//
// - `claude agents --json` lists the sessions that are running. Every row is
//   a process, so it has a pid (observed 2026-10-11 on three config dirs).
// - `claude agents --json --all` adds the background sessions that have
//   finished (`state: "done"` / `"stopped"`). Those have no process and no
//   `pid` (observed 2026-10-11).
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** One row of `claude agents --json`: a running session. */
export const ClaudeAgentRowSchema = v.looseObject({
  pid: v.number(),
  cwd: v.string(),
  /** "interactive" | "background" (Claude Code's, an open set). */
  kind: v.string(),
  /** Epoch ms. */
  startedAt: v.number(),
  sessionId: v.string(),
  name: v.optional(v.string()),
  /** "idle" / "busy" / "waiting" …, an open set. */
  status: v.optional(v.string()),
  /** What the session is waiting for, e.g. "dialog open". */
  waitingFor: v.optional(v.string()),
  /** A background session's state, e.g. "done". */
  state: v.optional(v.string()),
  /** A background session's short id. */
  id: v.optional(v.string()),
});
export type ClaudeAgentRow = Output<typeof ClaudeAgentRowSchema>;

/** The text `claude agents --json` prints. */
export const ClaudeAgentsTextSchema = jsonText(v.array(ClaudeAgentRowSchema));

/** One row of `claude agents --json --all`, read for the one thing it is
 * asked: which process, if any, a session id is. */
export const ClaudeAgentsAllRowSchema = v.looseObject({
  sessionId: v.string(),
  /** Absent for a finished background session, which has no process. */
  pid: v.optional(v.number()),
});
export type ClaudeAgentsAllRow = Output<typeof ClaudeAgentsAllRowSchema>;

/** The text `claude agents --json --all` prints. */
export const ClaudeAgentsAllTextSchema = jsonText(v.array(ClaudeAgentsAllRowSchema));
