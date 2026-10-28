// The run's sidecar and the requests that come through it (DR-0035 §3).
//
// At session.start, and when the session changes its id (/clear, /resume),
// the module starts `ccmsg sidecar`, which binds this run's socket, names the
// run to the daemon, and copies each line the daemon writes there to its
// standard output. The run is named by what the module knows of itself — a
// run id drawn when it was loaded, the session's CLAUDE_CONFIG_DIR and
// HYOUI_SESSION_ID — and the daemon ties it to a harness process on its own.
// A session without a composer (`-p`, the SDK) gets no sidecar.
//
// A line is a request naming an op (`{ v, op, id, args }`); every request
// with an id gets one reply (`{ id, ok, result }` or `{ id, ok: false, error }`),
// which goes back to the daemon through `ccmsg sidecar reply`. A line that is
// not a request this module runs is logged and not answered: the daemon,
// getting no reply, takes the request as unconfirmed at its deadline. The ops
// are each concern's: `prompt.send` (prompt-send.ts), `session.facts`
// (facts.ts), `agent.append` (subagents.ts), `request.override`
// (request-override.ts), `turn.abort` (turn-abort.ts); `describe` says which
// ops the module has.
import { errorText } from "@ccmsg/protocol/parse";
import {
  type DescribeResult,
  type FailedSidecarReply,
  readSidecarRequest,
  SIDECAR_OP_NAMES,
  SIDECAR_REQUEST_VERSION,
  type SidecarErrorCode,
  type SidecarReplyOf,
  type SidecarRequest,
  sidecarRunId,
} from "@ccmsg/protocol/sidecar";
import type { Engine, SpawnChunk, SpawnEnd } from "./engine.ts";
import { currentFacts, type FactsState } from "./facts.ts";
import { type PromptSendState, type QueuedSend, queuePromptSend } from "./prompt-send.ts";
import { requestOverrideSet } from "./request-override.ts";
import { type LifecycleState, nextGeneration } from "./session-lifecycle.ts";
import { appendToAgent } from "./subagents.ts";
import { abortMainTurn, type TurnAbortState } from "./turn-abort.ts";

/** A `ccmsg` command that is one process and one round trip to the daemon (a
 * reply, the version), measured at about 0.3 s. */
export const REPLY_TIMEOUT_MS = 3_000;

/** Respawn delays for a sidecar that keeps dying young: doubled per death
 * from the first value up to the last, and back to the first once a sidecar
 * has lived STABLE_MS. */
export const RESPAWN_MIN_MS = 500;
export const RESPAWN_MAX_MS = 30_000;
export const STABLE_MS = 10_000;

/** The sidecar of this load. */
export interface SidecarState {
  sidecar?: { sid: string; child: AsyncGenerator<SpawnChunk, SpawnEnd> };
  delay: number;
  /** Sidecar starts run one at a time, so a session.start and a command.run
   * arriving together cannot each start one. */
  starting: Promise<void>;
  /** This run, as every sidecar of this load names it: drawn when the first
   * sidecar starts, which is about when the harness started, and kept across
   * sidecars and session ids so the daemon sees one run. */
  run?: { id: string; startedAt: number };
}

export function newSidecarState(): SidecarState {
  return { delay: RESPAWN_MIN_MS, starting: Promise.resolve() };
}

/** What the sidecar reads and writes: its own state, the session it serves,
 * and what the ops it answers run on. */
type SidecarHost = SidecarState & LifecycleState & PromptSendState & FactsState & TurnAbortState;

/** The reply to one request this module runs. */
export type Reply =
  | SidecarReplyOf<"describe">
  | SidecarReplyOf<"prompt.send">
  | SidecarReplyOf<"session.facts">
  | SidecarReplyOf<"agent.append">
  | SidecarReplyOf<"request.override">
  | SidecarReplyOf<"turn.abort">;

function failed(id: string, code: SidecarErrorCode, message: string): FailedSidecarReply {
  return { id, ok: false, error: { code, message } };
}

/** Split a stream of text pieces into lines; a piece may end mid-line. */
export function lineSplitter(onLine: (line: string) => void): (piece: string) => void {
  let rest = "";
  return (piece) => {
    const parts = (rest + piece).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) if (part.trim() !== "") onLine(part);
  };
}

/** `ccmsg sidecar reply` for a reply to a request that arrived under `sid`.
 * The reply itself goes on standard input (see `sendReply`). */
export function replyArgv(root: string, sid: string): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", "reply", "--sid", sid];
}

/** Hand `reply` to the daemon. On standard input rather than as an argument:
 * a reply carries whatever its op returns, an argument is bounded in size and
 * shown to every user by `ps`, and `$.process.run` writes `stdin` once and
 * closes it, which is all one reply needs. */
async function sendReply($: Engine, sid: string, reply: Reply): Promise<void> {
  try {
    const done = await $.process.run(replyArgv($.plugin.root, sid), {
      stdin: JSON.stringify(reply),
      timeoutMs: REPLY_TIMEOUT_MS,
    });
    if (done.exitCode !== 0) {
      $.ui.log(`ccmsg: reply ${reply.id} exited ${done.exitCode}: ${done.stderr.trim()}`, {
        to: "debug",
      });
    }
  } catch (e) {
    $.ui.log(`ccmsg: reply ${reply.id} failed: ${errorText(e)}`, { to: "debug" });
  }
}

/** describe's result. The version is the one `ccmsg` beside this module
 * prints (the launcher runs its own plugin's CLI, DR-0032 §2.2-4); left out
 * when it cannot be had. */
async function describe($: Engine): Promise<DescribeResult> {
  const described: DescribeResult = { v: [SIDECAR_REQUEST_VERSION], ops: [...SIDECAR_OP_NAMES] };
  try {
    const run = await $.process.run([`${$.plugin.root}/bin/ccmsg`, "version"], {
      timeoutMs: REPLY_TIMEOUT_MS,
    });
    const version = run.stdout.trim();
    if (run.exitCode === 0 && version !== "") return { ...described, version };
  } catch (e) {
    $.ui.log(`ccmsg: describe could not read the version: ${errorText(e)}`, { to: "debug" });
  }
  return described;
}

/** The reply to one request: the op's, or `internal` when anything is thrown
 * on the way, so every request is answered. */
async function replyTo(
  $: Engine,
  state: SidecarHost,
  sid: string,
  generation: number,
  request: SidecarRequest,
): Promise<Reply> {
  const { id } = request;
  try {
    switch (request.op) {
      case "describe":
        return { id, ok: true, result: await describe($) };
      case "prompt.send": {
        const { text, override } = request.args;
        const queued: QueuedSend = {
          id,
          text,
          sid,
          generation,
          ...(override !== undefined ? { override } : {}),
        };
        return await queuePromptSend($, state, queued);
      }
      case "session.facts":
        return { id, ok: true, result: await currentFacts($, state) };
      case "agent.append":
        return { id, ok: true, result: await appendToAgent($, request.args) };
      case "request.override":
        return { id, ok: true, result: requestOverrideSet($, state, request.args) };
      case "turn.abort":
        return { id, ok: true, result: await abortMainTurn($, state) };
    }
  } catch (e) {
    $.ui.log(`ccmsg: request ${id} failed: ${errorText(e)}`, { to: "debug" });
    return failed(id, "internal", errorText(e));
  }
}

/** Run one request line that arrived under `sid` in `generation`, and reply.
 * A line that is not a request this module runs is logged and not answered.
 * Never rejects: a reply that cannot be sent is logged. */
export function answer(
  $: Engine,
  state: SidecarHost,
  sid: string,
  generation: number,
  line: string,
): Promise<void> {
  const read = readSidecarRequest(line);
  if (!read.ok) {
    $.ui.log(
      `ccmsg sidecar: dropped a line that is not a request this module runs (${read.failure.summary}): ${line.slice(0, 200)}`,
      { to: "debug" },
    );
    return Promise.resolve();
  }
  const { id } = read.value;
  // sendReply catches its own failures; this catches anything else, so the
  // promise never rejects for the caller that drops it.
  return replyTo($, state, sid, generation, read.value)
    .then((r) => sendReply($, sid, r))
    .catch((e: unknown) => {
      $.ui.log(`ccmsg: request ${id} not answered: ${errorText(e)}`, { to: "debug" });
    });
}

/** `ccmsg sidecar` for `sid` in run `run`. The config dir and the terminal
 * are read through `$.env.get` here, as prompt.send reads the terminal, so
 * what the daemon is told the run has is what the module will use. */
async function sidecarArgv(
  $: Engine,
  sid: string,
  run: { id: string; startedAt: number },
): Promise<string[]> {
  const configDir = await $.env.get("CLAUDE_CONFIG_DIR");
  const hyouiSessionId = await $.env.get("HYOUI_SESSION_ID");
  return [
    `${$.plugin.root}/bin/ccmsg`,
    "sidecar",
    "--sid",
    sid,
    "--run",
    run.id,
    "--started-at",
    String(run.startedAt),
    ...(configDir ? ["--config-dir", configDir] : []),
    ...(hyouiSessionId ? ["--hyoui-session-id", hyouiSessionId] : []),
  ];
}

/** Run one sidecar for `sid` until it ends, then start the next one unless it
 * was replaced. The next start goes through `$.clock.after`, which a module
 * unload cancels: the unload kills the child, and this is what keeps that
 * death from being answered with a new one. */
async function runSidecar(
  $: Engine,
  state: SidecarHost,
  sid: string,
  run: { id: string; startedAt: number },
): Promise<void> {
  const child = $.process.spawn({ argv: await sidecarArgv($, sid, run) });
  const mine = { sid, child };
  state.sidecar = mine;
  const startedAt = await $.clock.now();
  const onLine = lineSplitter((line) => {
    void answer($, state, sid, state.generation, line);
  });
  try {
    for await (const piece of child) {
      if (piece.stream === "stdout") onLine(piece.text);
      else $.ui.log(`ccmsg sidecar: ${piece.text.trimEnd()}`, { to: "debug" });
    }
  } catch (e) {
    $.ui.log(`ccmsg sidecar: ${errorText(e)}`, { to: "debug" });
  }
  if (state.sidecar !== mine) return;
  state.sidecar = undefined;
  const lived = (await $.clock.now()) - startedAt;
  if (lived >= STABLE_MS) state.delay = RESPAWN_MIN_MS;
  const wait = state.delay;
  state.delay = Math.min(state.delay * 2, RESPAWN_MAX_MS);
  $.clock.after(wait, () => {
    if (state.sidecar === undefined) startSidecar($, state);
  });
}

export function startSidecar($: Engine, state: SidecarHost): void {
  state.starting = state.starting
    .then(() => replaceSidecar($, state))
    .catch((e: unknown) => {
      $.ui.log(`ccmsg sidecar: start failed: ${errorText(e)}`, { to: "debug" });
    });
}

/** Keep one sidecar, bound under the session's current id. A session that
 * changed its id (/clear, /resume) is written to under the new one, and the
 * old sidecar would never be asked again. */
async function replaceSidecar($: Engine, state: SidecarHost): Promise<void> {
  // A command.run can be the first to arrive after a reload; whether the
  // session draws a composer is then asked of the session itself.
  state.interactive ??= (await $.session.surfaces()).length > 0;
  if (!state.interactive) return;
  const sid = await $.session.id();
  if (state.sid !== undefined && state.sid !== sid) nextGeneration(state);
  state.sid = sid;
  if (state.sidecar?.sid === sid) return;
  if (state.run === undefined) {
    const startedAt = await $.clock.now();
    state.run = { id: sidecarRunId(startedAt, Math.random()), startedAt };
  }
  const old = state.sidecar;
  state.sidecar = undefined;
  if (old !== undefined) await old.child.return(undefined);
  void runSidecar($, state, sid, state.run);
}
