// Requests to a session's hooks module through the sidecar of one of its runs
// (DR-0035 §3), whatever the op.
//
// The daemon writes one SidecarRequest line to a run's sidecar socket; the
// sidecar copies it to the module, which answers with `ccmsg sidecar reply`,
// arriving here as sidecar_reply. What this file owns is finding the live
// runs of a session, writing a request, and matching a reply to the request it
// names. What an op's result means belongs to whoever asked for the op
// (session-input.ts for prompt.send).
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  type Parsed,
  parseSidecarSocketName,
  parseWith,
  SIDECAR_OPS,
  SIDECAR_REQUEST_VERSION,
  type SidecarArgs,
  type SidecarOp,
  type SidecarReply,
  type SidecarReplyOf,
  sidecarSocketPid,
} from "@ccmsg/protocol";
import { type WriteOutcome, writeSocket } from "./peer-inject.ts";

/** Connect and flush one line to one sidecar. */
export const SIDECAR_WRITE_MS = 2_000;

interface Waiting {
  sid: string;
  reply?: SidecarReply;
  notify?: () => void;
}

/** The requests waiting for their module's reply, by request id. Every
 * request has an id of its own, so a reply decides that request and no other;
 * only the session the request was written to may answer it, and only the
 * first reply under an id counts. */
export class SidecarReplies {
  readonly #waiting = new Map<string, Waiting>();

  /** Register `id` before the line is written, so a reply that beats the
   * write's own completion still finds it. */
  open(id: string, sid: string): void {
    this.#waiting.set(id, { sid });
  }

  close(id: string): void {
    this.#waiting.delete(id);
  }

  /** Take `reply` from session `sid`. False when no request is waiting under
   * its id for `sid` — answered and forgotten already, timed out, or never
   * sent there. A second reply under an id still waiting is taken as said and
   * changes nothing. */
  take(sid: string, reply: SidecarReply): boolean {
    const waiting = this.#waiting.get(reply.id);
    if (waiting === undefined || waiting.sid !== sid) return false;
    if (waiting.reply === undefined) {
      waiting.reply = reply;
      waiting.notify?.();
    }
    return true;
  }

  /** The first reply under `id`, or undefined when none came within `ms`.
   * The id is forgotten either way. */
  async wait(id: string, ms: number): Promise<SidecarReply | undefined> {
    const waiting = this.#waiting.get(id);
    if (waiting === undefined) return undefined;
    const replied = Promise.withResolvers<SidecarReply | undefined>();
    waiting.notify = () => replied.resolve(waiting.reply);
    if (waiting.reply !== undefined) replied.resolve(waiting.reply);
    const deadline = setTimeout(() => replied.resolve(undefined), Math.max(0, ms));
    try {
      return await replied.promise;
    } finally {
      clearTimeout(deadline);
      this.#waiting.delete(id);
    }
  }
}

/** Injectable effects, so a test can stand in for the filesystem, the process
 * table and the clock. */
export interface SidecarDeps {
  sidecarDir: string;
  replies: SidecarReplies;
  newId(): string;
  listDir(dir: string): Promise<string[]>;
  /** Whether the harness process a socket is named after still runs. A
   * sidecar can outlive its harness by one write (it notices only when its
   * output fails), so a socket of a gone run is skipped instead of taking a
   * request nobody will answer. */
  isAlive(pid: number): boolean;
  write(socketPath: string, line: string, ms: number): Promise<WriteOutcome>;
  now(): number;
}

/** The sockets of the live runs of `sid`, in a stable order. */
export async function liveSidecars(sid: string, deps: SidecarDeps): Promise<string[]> {
  let names: string[];
  try {
    names = await deps.listDir(deps.sidecarDir);
  } catch {
    return [];
  }
  const sockets: string[] = [];
  for (const name of names.toSorted()) {
    const pid = sidecarSocketPid(name, sid);
    if (pid !== undefined && deps.isAlive(pid)) sockets.push(path.join(deps.sidecarDir, name));
  }
  return sockets;
}

/** Whether a run of `sid` now serves another session id: a socket of one of
 * `pids` (the harness pids `sid` has run under) is bound under an id other
 * than `sid`, by a harness still running. That is a run that changed its id
 * (/clear, /resume) — its module replaced its sidecar under the new id. */
export async function runMovedOn(
  sid: string,
  pids: readonly number[],
  deps: SidecarDeps,
): Promise<boolean> {
  if (pids.length === 0) return false;
  let names: string[];
  try {
    names = await deps.listDir(deps.sidecarDir);
  } catch {
    return false;
  }
  return names.some((name) => {
    const socket = parseSidecarSocketName(name);
    return (
      socket !== undefined &&
      socket.sid !== sid &&
      pids.includes(socket.pid) &&
      deps.isAlive(socket.pid)
    );
  });
}

/** The harness pids each session id has been seen running under, kept past
 * the poll that last listed them. A run that changes its id (/clear,
 * /resume) is listed under the new id from then on, so which process the old
 * id ran in is known only from before; runMovedOn needs it to tell a person
 * writing to the old id that the session changed rather than that no module
 * is there. An entry goes once none of its processes runs any more. */
export class RunPids {
  readonly #pids = new Map<string, Set<number>>();

  /** Take one poll's rows, and drop entries whose processes all ended. */
  record(
    rows: readonly { sessionId?: string; pid?: number }[],
    isAlive: (pid: number) => boolean = isProcessAlive,
  ): void {
    for (const row of rows) {
      if (typeof row.sessionId !== "string" || row.sessionId === "") continue;
      if (typeof row.pid !== "number" || !Number.isSafeInteger(row.pid) || row.pid <= 1) continue;
      const known = this.#pids.get(row.sessionId) ?? new Set<number>();
      known.add(row.pid);
      this.#pids.set(row.sessionId, known);
    }
    for (const [sid, pids] of this.#pids) {
      for (const pid of pids) if (!isAlive(pid)) pids.delete(pid);
      if (pids.size === 0) this.#pids.delete(sid);
    }
  }

  pidsOf(sid: string): number[] {
    return [...(this.#pids.get(sid) ?? [])];
  }
}

/** What became of one request of `Op`. `not_written`: the sidecar has none of
 * the line, so the module never saw it. Otherwise the line went in (`written`)
 * or may have (`uncertain`), and `reply` is the module's answer with its
 * result read by the op's schema — undefined when none came in time, a
 * failure when the result is not of the op's shape (a module of another
 * ccmsg). A reply settles an `uncertain` write: the module read the line. */
export type SidecarCall<Op extends SidecarOp> =
  | { id: string; write: "not_written" }
  | {
      id: string;
      write: "written" | "uncertain";
      reply: Parsed<SidecarReplyOf<Op>> | undefined;
    };

/** `reply`, to a request of `op`, with its result read: which op a reply
 * answers is known here, where the request was made, and nowhere on the way. */
function readReply<Op extends SidecarOp>(op: Op, reply: SidecarReply): Parsed<SidecarReplyOf<Op>> {
  if (!reply.ok) return { ok: true, value: reply };
  const result = parseWith(SIDECAR_OPS[op].result, reply.result);
  if (!result.ok) return result;
  return { ok: true, value: { id: reply.id, ok: true, result: result.value } };
}

/** Ask the module behind `socket` (a run of `sid`) to run `op`, and wait for
 * its reply. `ms` bounds the write and the wait together. */
export async function callSidecar<Op extends SidecarOp>(
  socket: string,
  sid: string,
  op: Op,
  args: SidecarArgs<Op>,
  ms: number,
  deps: SidecarDeps,
): Promise<SidecarCall<Op>> {
  const until = deps.now() + ms;
  const id = deps.newId();
  const request = { v: SIDECAR_REQUEST_VERSION, op, id, args };
  deps.replies.open(id, sid);
  const written = await deps.write(
    socket,
    `${JSON.stringify(request)}\n`,
    Math.min(SIDECAR_WRITE_MS, ms),
  );
  if (written === "not_written") {
    deps.replies.close(id);
    return { id, write: written };
  }
  const reply = await deps.replies.wait(id, until - deps.now());
  return { id, write: written, reply: reply === undefined ? undefined : readReply(op, reply) };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH is gone; EPERM is a process that exists but is not ours, so not a
    // harness of this user's session either.
    return false;
  }
}

export function productionSidecarDeps(sidecarDir: string, replies: SidecarReplies): SidecarDeps {
  return {
    sidecarDir,
    replies,
    newId: randomUUID,
    listDir: (dir) => readdir(dir),
    isAlive: isProcessAlive,
    write: (socketPath, line, ms) => writeSocket(socketPath, line, ms),
    now: Date.now,
  };
}
