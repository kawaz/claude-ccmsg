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
  SIDECAR_REQUEST_VERSION,
  type SidecarReply,
  type SidecarRequest,
  sidecarSocketPid,
} from "@ccmsg/protocol";
import { writeSocket } from "./peer-inject.ts";

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
  write(
    socketPath: string,
    line: string,
    ms: number,
  ): Promise<"delivered" | "unavailable" | "refused">;
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

/** What became of one request: not written (nobody took the line), or written
 * and answered with `reply` — undefined when no reply came in time. */
export type SidecarCall =
  | { id: string; written: false }
  | { id: string; written: true; reply: SidecarReply | undefined };

/** Ask the module behind `socket` (a run of `sid`) to run `op`, and wait for
 * its reply. `ms` bounds the write and the wait together. */
export async function callSidecar(
  socket: string,
  sid: string,
  op: string,
  args: Record<string, unknown>,
  ms: number,
  deps: SidecarDeps,
): Promise<SidecarCall> {
  const until = deps.now() + ms;
  const id = deps.newId();
  const request: SidecarRequest = { v: SIDECAR_REQUEST_VERSION, op, id, args };
  deps.replies.open(id, sid);
  const written = await deps.write(
    socket,
    `${JSON.stringify(request)}\n`,
    Math.min(SIDECAR_WRITE_MS, ms),
  );
  if (written !== "delivered") {
    deps.replies.close(id);
    return { id, written: false };
  }
  return { id, written: true, reply: await deps.replies.wait(id, until - deps.now()) };
}

function isAlive(pid: number): boolean {
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
    isAlive,
    write: (socketPath, line, ms) => writeSocket(socketPath, line, ms),
    now: Date.now,
  };
}
