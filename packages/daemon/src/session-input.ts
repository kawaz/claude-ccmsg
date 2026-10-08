// session_input (DR-0035 §1, §3, §5): hand what a person wrote to a sidecar of
// the session, and wait for the session's hooks module to say whether the
// harness took it as the person's prompt.
//
// The daemon neither resolves the session's terminal nor sends Enter: the
// module fills its own composer and presses Enter on its own terminal, then
// reports back with `ccmsg sidecar report`, which arrives here as
// session_input_result. What this file owns is which run is asked, the
// correlation between a request and its report, and the deadline.
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  sidecarSocketPid,
  type SessionInputModuleReason,
  type SessionInputReason,
  type SidecarFillRequest,
} from "@ccmsg/protocol";
import { writeSocket } from "./peer-inject.ts";

/** The longest a session_input takes to answer, every run it tries included.
 *
 * One try on the module's side is at most a `hyoui input` (3 s), the wait for
 * UserPromptSubmit (3 s) and the report process (3 s) — 9 s — plus the fill and
 * the write, which take milliseconds. The rest of the 12 s leaves room for a
 * second run after a first that answered at once that it cannot take input
 * (no_composer / no_terminal, which needs no Enter and so comes back within a
 * report's time). Past it the answer is unconfirmed: a person waiting on a
 * send is told it may or may not have landed rather than kept waiting. */
export const SESSION_INPUT_DEADLINE_MS = 12_000;

/** Connect and flush one line to one sidecar. */
export const SIDECAR_WRITE_MS = 2_000;

/** SessionInputResponse without the envelope's `ok`. */
export type SessionInputOutcome =
  | { outcome: "accepted" }
  | { outcome: "not_delivered"; reason: SessionInputReason }
  | { outcome: "unconfirmed" };

export interface ModuleReport {
  outcome: "accepted" | "not_delivered";
  reason?: SessionInputModuleReason;
}

interface Pending {
  sid: string;
  report?: ModuleReport;
  notify?: () => void;
}

/** The tries waiting for their module's report, by the id the sidecar line
 * carries. Every try has an id of its own, so a report decides that try and no
 * other, and only the first report under an id counts. */
export class PendingInputs {
  readonly #pending = new Map<string, Pending>();

  /** Register `id` before the line is written, so a report that beats the
   * write's own completion still finds it. */
  open(id: string, sid: string): void {
    this.#pending.set(id, { sid });
  }

  close(id: string): void {
    this.#pending.delete(id);
  }

  /** Record a module's report. False when no try is waiting under `id` for
   * `sid` — decided already, timed out, or never sent there. A second report
   * under an id still waiting is taken as said and changes nothing. */
  report(id: string, sid: string, report: ModuleReport): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined || pending.sid !== sid) return false;
    if (pending.report === undefined) {
      pending.report = report;
      pending.notify?.();
    }
    return true;
  }

  /** The first report under `id`, or undefined when none came within `ms`.
   * The id is forgotten either way. */
  async wait(id: string, ms: number): Promise<ModuleReport | undefined> {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    const reported = Promise.withResolvers<ModuleReport | undefined>();
    pending.notify = () => reported.resolve(pending.report);
    if (pending.report !== undefined) reported.resolve(pending.report);
    const deadline = setTimeout(() => reported.resolve(undefined), Math.max(0, ms));
    try {
      return await reported.promise;
    } finally {
      clearTimeout(deadline);
      this.#pending.delete(id);
    }
  }
}

/** Injectable effects, so a test can stand in for the filesystem, the process
 * table and the clock. */
export interface SessionInputDeps {
  sidecarDir: string;
  pending: PendingInputs;
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
  deadlineMs: number;
}

/** The sockets of the live runs of `sid`, in a stable order. */
export async function liveSidecars(sid: string, deps: SessionInputDeps): Promise<string[]> {
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

/** Reasons that say the run cannot take a person's input at all, so asking
 * another run of the session cannot put the text in twice. Any other answer —
 * or none — may mean the text is in, or that this run is the one with the
 * composer and simply could not now; trying the next run then risks a second
 * copy, which is what one-at-a-time exists to prevent (DR-0035 §3). */
const TRY_NEXT: ReadonlySet<SessionInputModuleReason> = new Set(["no_composer", "no_terminal"]);

/** What became of one try, for the daemon log. */
export interface SessionInputTry {
  id: string;
  socket: string;
  result: "unwritten" | "accepted" | "unconfirmed" | `not_delivered:${SessionInputModuleReason}`;
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
    const id = deps.newId();
    const request: SidecarFillRequest = { kind: "prompt.fill", id, text };
    deps.pending.open(id, sid);
    const written = await deps.write(
      socket,
      `${JSON.stringify(request)}\n`,
      Math.min(SIDECAR_WRITE_MS, remaining),
    );
    if (written !== "delivered") {
      deps.pending.close(id);
      tries.push({ id, socket, result: "unwritten" });
      continue;
    }
    const report = await deps.pending.wait(id, until - deps.now());
    if (report === undefined) {
      tries.push({ id, socket, result: "unconfirmed" });
      return { outcome: "unconfirmed", tries };
    }
    if (report.outcome === "accepted") {
      tries.push({ id, socket, result: "accepted" });
      return { outcome: "accepted", tries };
    }
    const reason = report.reason ?? "refused";
    tries.push({ id, socket, result: `not_delivered:${reason}` });
    if (!TRY_NEXT.has(reason)) return { outcome: "not_delivered", reason, tries };
    unable = reason;
  }
  return { outcome: "not_delivered", reason: unable ?? "no_module", tries };
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

export function productionInputDeps(sidecarDir: string, pending: PendingInputs): SessionInputDeps {
  return {
    sidecarDir,
    pending,
    newId: randomUUID,
    listDir: (dir) => readdir(dir),
    isAlive,
    write: (socketPath, line, ms) => writeSocket(socketPath, line, ms),
    now: Date.now,
    deadlineMs: SESSION_INPUT_DEADLINE_MS,
  };
}
