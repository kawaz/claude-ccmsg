// The session as the module serves it: whether it has a composer, which id
// it runs under and how many times that id has changed, and its state file.
//
// When the session starts, and when it changes its id (/clear, /resume), the
// module runs `ccmsg sidecar begin`, which writes the session's state file and
// brings the daemon up if none is running (DR-0039 §2). /clear and /resume
// start no session.start: once the command went through, the session's id is
// the new one. A request that arrived under the old id is not put into the
// new session: the id's generation moves on.
import * as v from "valibot";
import { errorText, type Output } from "@ccmsg/protocol/parse";
import type { Engine } from "./engine.ts";
import type { PromptSendState } from "./prompt-send.ts";

/** The session as the module serves it. */
export interface LifecycleState {
  /** The session id the module serves, and how many times it has changed
   * (/clear, /resume). A prompt.send belongs to the generation it arrived in. */
  sid?: string;
  generation: number;
  /** Whether the session has a composer to fill; undefined until known. */
  interactive?: boolean;
}

export function newLifecycleState(): LifecycleState {
  return { generation: 0 };
}

/** The session moved to another id: what was waiting for the old one is
 * dropped, so nothing of it reaches the new session. The awaited prompt.send
 * is the one thing that waits on the id. */
export function nextGeneration(
  state: Pick<LifecycleState, "generation"> & Pick<PromptSendState, "awaiting">,
): void {
  state.generation += 1;
  state.awaiting = undefined;
}

// The engine's input for each event, as far as this module reads it. The
// engine is another program, and its inputs change between its versions, so
// they are read like any data from outside (DR-0038 §1): the fields used, each
// one allowed to be absent, the rest let through. The shapes follow the
// engine's `claude-code.d.ts`.
export const SessionStartInputSchema = v.looseObject({
  isInteractive: v.optional(v.boolean()),
  surface: v.optional(v.nullable(v.string())),
});

export const SessionEndInputSchema = v.looseObject({ reason: v.optional(v.string()) });

/** Whether a command (or the reason a session ends) moves the session to
 * another id: /clear starts a conversation under a new one, /resume goes to
 * the resumed one's. */
export function changesSessionId(command: string | undefined): boolean {
  return command === "clear" || command === "resume";
}

/** `ccmsg sidecar begin` for session `sid` working in `cwd`. */
export function beginArgv(root: string, sid: string, cwd: string): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", "begin", "--sid", sid, "--cwd", cwd];
}

/** `ccmsg sidecar begin` budget: the VCS lookup (1 s at most) and the daemon's
 * start, whose wait for the new daemon to listen is about 10 s at most and
 * twice that when a running daemon of another version is replaced. The
 * daemon itself is detached, so a begin cut short leaves it starting. */
export const BEGIN_TIMEOUT_MS = 25_000;

/** The session began under the id it has now (its start, /clear, /resume):
 * write its state file and bring the daemon up (DR-0039 §2). Run without
 * being awaited, so neither holds the session up; never rejects. */
export async function sessionBegin($: Engine): Promise<void> {
  try {
    const sid = await $.session.id();
    const cwd = await $.session.root();
    const done = await $.process.run(beginArgv($.plugin.root, sid, cwd), {
      timeoutMs: BEGIN_TIMEOUT_MS,
    });
    if (done.exitCode !== 0) {
      $.ui.log(`ccmsg: begin exited ${done.exitCode}: ${done.stderr.trim()}`, { to: "debug" });
    }
  } catch (e) {
    $.ui.log(`ccmsg: begin failed: ${errorText(e)}`, { to: "debug" });
  }
}

/** The session started (or was reloaded): whether it has a composer, from
 * what the engine says of it, and its state file. No composer to fill (`-p`,
 * the SDK): no sidecar to keep (DR-0035 §3) and no tools (DR-0039 §3). */
export function sessionStarted(
  $: Engine,
  state: Pick<LifecycleState, "interactive">,
  input: Output<typeof SessionStartInputSchema>,
): void {
  state.interactive = input.isInteractive !== false && input.surface !== null;
  void sessionBegin($);
}

/** The session ends for /clear or /resume: the requests that arrived under
 * its id go no further. */
export function sessionCleared(
  state: Pick<LifecycleState, "sid" | "generation"> & Pick<PromptSendState, "awaiting">,
): void {
  if (state.sid === undefined) return;
  nextGeneration(state);
  state.sid = undefined;
}
