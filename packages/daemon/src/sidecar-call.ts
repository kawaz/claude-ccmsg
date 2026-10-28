// Requests to a session's hooks module through the sidecar of one of its runs
// (DR-0035 §3), whatever the op.
//
// The daemon writes one SidecarRequest line to a run's sidecar socket; the
// sidecar copies it to the module, which answers over `POST /op` (DR-0046),
// arriving here as sidecar_reply. What this file owns is writing a request and
// matching a reply to the request it names; which runs a session has is
// sidecar-runs.ts's. What an op's result means belongs to whoever asked for
// the op (user-prompt.ts for prompt.send).
import { randomUUID } from "node:crypto";
import {
  type Parsed,
  parseWith,
  SIDECAR_OPS,
  SIDECAR_REQUEST_VERSION,
  type SidecarArgs,
  type SidecarOp,
  type SidecarReply,
  type SidecarReplyOf,
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

/** Injectable effects, so a test can stand in for the sockets and the
 * clock. */
export interface SidecarDeps {
  replies: SidecarReplies;
  newId(): string;
  write(socketPath: string, line: string, ms: number): Promise<WriteOutcome>;
  now(): number;
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
  const result = parseWith<(typeof SIDECAR_OPS)[Op]["result"]>(
    SIDECAR_OPS[op].result,
    reply.result,
  );
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

export function productionSidecarDeps(replies: SidecarReplies): SidecarDeps {
  return {
    replies,
    newId: randomUUID,
    write: (socketPath, line, ms) => writeSocket(socketPath, line, ms),
    now: Date.now,
  };
}
