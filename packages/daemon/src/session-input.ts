// session_input (DR-0035 §1, §3, §5): hand what a person wrote to the hooks
// module of a run of the session as a `prompt.send` request, and wait for the
// module to say whether the harness took it as the person's prompt.
//
// The daemon neither resolves the session's terminal nor sends Enter: the
// module fills its own composer and presses Enter on its own terminal. The
// request and its reply go through sidecar-call.ts; what this file owns is
// which run is asked, what a reply means for the person, and the deadline.
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  type Parsed,
  type PromptSendResult,
  type SessionInputModuleReason,
  type SessionInputReadiness,
  type SessionInputReason,
  type SidecarReplyOf,
  sidecarSocketPid,
} from "@ccmsg/protocol";
import {
  callSidecar,
  isProcessAlive,
  liveSidecars,
  productionSidecarDeps,
  runMovedOn,
  type SidecarDeps,
  type SidecarDirDeps,
  type SidecarReplies,
} from "./sidecar-call.ts";

/** The longest a session_input takes to answer, every run it tries included.
 *
 * One try on the module's side is at most a `hyoui input` (3 s), the wait for
 * UserPromptSubmit (3 s) and the reply process (3 s) — 9 s — plus the fill and
 * the write, which take milliseconds. The rest of the 12 s leaves room for a
 * second run after a first that answered at once that it cannot take input
 * (no_composer / no_terminal, which needs no Enter and so comes back within a
 * reply's time). Past it the answer is unconfirmed: a person waiting on a
 * send is told it may or may not have landed rather than kept waiting. */
export const SESSION_INPUT_DEADLINE_MS = 12_000;

/** SessionInputResponse without the envelope's `ok`. */
export type SessionInputOutcome =
  | { outcome: "accepted" }
  | { outcome: "not_delivered"; reason: SessionInputReason }
  | { outcome: "unconfirmed" };

export interface SessionInputDeps extends SidecarDeps {
  deadlineMs: number;
  /** The harness pids `sid` has been seen running under (RunPids). */
  pidsOf(sid: string): readonly number[];
}

/** A `prompt.send` reply as the person's outcome. An op that failed
 * part-way (`internal`) or a result not of prompt.send's shape says nothing
 * about the composer, and is unconfirmed. */
export function readPromptSendReply(
  reply: Parsed<SidecarReplyOf<"prompt.send">>,
): PromptSendResult {
  if (!reply.ok) return { outcome: "unconfirmed" };
  const answer = reply.value;
  return answer.ok ? answer.result : { outcome: "unconfirmed" };
}

/** Reasons that say the run cannot take a person's input at all (or, for
 * `session_changed`, is no longer that session and left the text out), so
 * asking another run of the session cannot put the text in twice. Any other answer —
 * or none — may mean the text is in, or that this run is the one with the
 * composer and simply could not now; trying the next run then risks a second
 * copy, which is what one-at-a-time exists to prevent (DR-0035 §3). */
const TRY_NEXT: ReadonlySet<SessionInputModuleReason> = new Set([
  "no_composer",
  "no_terminal",
  "session_changed",
]);

/** What became of one try, for the daemon log. */
export interface SessionInputTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
    | "write_uncertain"
    | "accepted"
    | "unconfirmed"
    | `not_delivered:${SessionInputModuleReason}`;
}

export async function sessionInput(
  sid: string,
  text: string,
  deps: SessionInputDeps,
): Promise<SessionInputOutcome & { tries: SessionInputTry[] }> {
  const until = deps.now() + deps.deadlineMs;
  const tries: SessionInputTry[] = [];
  let unable: SessionInputModuleReason | undefined;
  for (const socket of await liveSidecars(sid, deps)) {
    const remaining = until - deps.now();
    if (remaining <= 0) return { outcome: "unconfirmed", tries };
    const call = await callSidecar(socket, sid, "prompt.send", { text }, remaining, deps);
    const { id } = call;
    // Only a line the sidecar has none of may go to the next run. One that
    // went in part-way (`uncertain`) and got no reply may still have reached
    // the module, and the next run would put the text in a second time.
    if (call.write === "not_written") {
      tries.push({ id, socket, result: "unwritten" });
      continue;
    }
    if (call.reply === undefined) {
      tries.push({
        id,
        socket,
        result: call.write === "uncertain" ? "write_uncertain" : "unconfirmed",
      });
      return { outcome: "unconfirmed", tries };
    }
    const read = readPromptSendReply(call.reply);
    if (read.outcome !== "not_delivered") {
      tries.push({ id, socket, result: read.outcome });
      return { outcome: read.outcome, tries };
    }
    tries.push({ id, socket, result: `not_delivered:${read.reason}` });
    if (!TRY_NEXT.has(read.reason)) return { outcome: "not_delivered", reason: read.reason, tries };
    unable = read.reason;
  }
  if (unable !== undefined) return { outcome: "not_delivered", reason: unable, tries };
  return { outcome: "not_delivered", reason: await withoutModule(sid, deps), tries };
}

/** Why no module of `sid` can take the input when none of its runs has one.
 * When the process `sid` ran in now serves another id, the session changed
 * (/clear, /resume) rather than lacks a module, and the person is told so
 * instead of to update the plugin. */
async function withoutModule(
  sid: string,
  deps: SidecarDirDeps & Pick<SessionInputDeps, "pidsOf">,
): Promise<"session_changed" | "no_module"> {
  return (await runMovedOn(sid, deps.pidsOf(sid), deps)) ? "session_changed" : "no_module";
}

export interface InputReadinessDeps extends SidecarDirDeps {
  /** The harness pids `sid` has been seen running under (RunPids). */
  pidsOf(sid: string): readonly number[];
  /** `HYOUI_SESSION_ID` in a harness process's environment, or null without
   * one. The module reads the same variable of the same process
   * (`$.env.get`) to find the terminal it sends Enter to, and answers
   * `no_terminal` without it. */
  terminalOf(pid: number): Promise<string | null>;
  /** Whether the daemon still counts `sid` among the running sessions. */
  isRunning(sid: string): boolean;
}

/** Whether a person's input can reach `sid` now (SessionInputReadiness), from
 * what sessionInput depends on: the live runs' sidecars, and for each run the
 * terminal its module would press Enter on. Ready when one run has both, as
 * sessionInput moves past runs that answer `no_terminal` to the next. */
export async function inputReadiness(
  sid: string,
  deps: InputReadinessDeps,
): Promise<SessionInputReadiness> {
  const sockets = await liveSidecars(sid, deps);
  if (sockets.length > 0) {
    for (const socket of sockets) {
      const pid = sidecarSocketPid(path.basename(socket), sid);
      if (pid !== undefined && (await deps.terminalOf(pid)) !== null) return { kind: "ready" };
    }
    return { kind: "no_terminal" };
  }
  const reason = await withoutModule(sid, deps);
  if (reason === "session_changed") return { kind: "session_changed" };
  return deps.isRunning(sid) ? { kind: "no_module" } : { kind: "ended" };
}

export function productionReadinessDeps(
  sidecarDir: string,
  pidsOf: (sid: string) => readonly number[],
  terminalOf: (pid: number) => Promise<string | null>,
  isRunning: (sid: string) => boolean,
): InputReadinessDeps {
  return {
    sidecarDir,
    listDir: (dir) => readdir(dir),
    isAlive: isProcessAlive,
    pidsOf,
    terminalOf,
    isRunning,
  };
}

export function productionInputDeps(
  sidecarDir: string,
  replies: SidecarReplies,
  pidsOf: (sid: string) => readonly number[] = () => [],
): SessionInputDeps {
  return {
    ...productionSidecarDeps(sidecarDir, replies),
    deadlineMs: SESSION_INPUT_DEADLINE_MS,
    pidsOf,
  };
}
