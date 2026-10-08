// session_input (DR-0035 §1, §5): hand what a person wrote to the sidecar of
// every live run of a session, and wait for the session's hooks module to say
// whether the harness took it as the person's prompt.
//
// The daemon neither resolves the session's terminal nor sends Enter: the
// module fills its own composer and presses Enter on its own terminal, then
// reports back with `ccmsg sidecar report`, which arrives here as
// session_input_result. What this file owns is the correlation between the
// two: the request is answered by the first report that decides it, or as
// unconfirmed when none does in time.
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

/** How long the daemon waits for the module's report once a sidecar took the
 * request. The module's own path is a fill, a `hyoui input` of at most 5 s,
 * up to 3 s for the harness to raise UserPromptSubmit, then one `ccmsg`
 * process to carry the report; an answer later than this is reported as
 * unconfirmed rather than holding the person's send open. */
export const SESSION_INPUT_CONFIRM_MS = 10_000;

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
  reports: ModuleReport[];
  /** Set once the request knows how many runs took it. */
  notify?: () => void;
}

/** The session_input requests waiting for their module's report, by the id
 * the sidecar line carries. */
export class PendingInputs {
  readonly #pending = new Map<string, Pending>();

  /** Register `id` before the line is written, so a report that beats the
   * write's own completion still finds it. */
  open(id: string, sid: string): void {
    this.#pending.set(id, { sid, reports: [] });
  }

  close(id: string): void {
    this.#pending.delete(id);
  }

  /** Record a module's report. False when no request is waiting under `id`
   * for `sid` — answered already, timed out, or never sent there — which
   * the reporter cannot act on either way. */
  report(id: string, sid: string, report: ModuleReport): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined || pending.sid !== sid) return false;
    pending.reports.push(report);
    pending.notify?.();
    return true;
  }

  /** Settle `id` from the reports of the `runs` sidecars that took it.
   *
   * One `accepted` decides it: the prompt is in the session. `not_delivered`
   * decides it only once every run has said so, because a run that has not
   * answered yet may be the one holding the composer. Anything short of that
   * when `withinMs` runs out is unconfirmed. */
  async settle(id: string, runs: number, withinMs: number): Promise<SessionInputOutcome> {
    const pending = this.#pending.get(id);
    if (pending === undefined) return { outcome: "unconfirmed" };
    const decided = Promise.withResolvers<SessionInputOutcome>();
    const decide = (): void => {
      if (pending.reports.some((r) => r.outcome === "accepted")) {
        decided.resolve({ outcome: "accepted" });
        return;
      }
      if (pending.reports.length >= runs) {
        decided.resolve({
          outcome: "not_delivered",
          reason: pending.reports.find((r) => r.reason !== undefined)?.reason ?? "refused",
        });
      }
    };
    pending.notify = decide;
    decide();
    const deadline = setTimeout(() => decided.resolve({ outcome: "unconfirmed" }), withinMs);
    try {
      return await decided.promise;
    } finally {
      clearTimeout(deadline);
      this.#pending.delete(id);
    }
  }
}

/** Injectable effects, so a test can stand in for the filesystem and the
 * process table. */
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
  write(socketPath: string, line: string): Promise<"delivered" | "unavailable" | "refused">;
  confirmMs: number;
}

/** The sockets of the live runs of `sid`. */
export async function liveSidecars(sid: string, deps: SessionInputDeps): Promise<string[]> {
  let names: string[];
  try {
    names = await deps.listDir(deps.sidecarDir);
  } catch {
    return [];
  }
  const sockets: string[] = [];
  for (const name of names) {
    const pid = sidecarSocketPid(name, sid);
    if (pid !== undefined && deps.isAlive(pid)) sockets.push(path.join(deps.sidecarDir, name));
  }
  return sockets;
}

export async function sessionInput(
  sid: string,
  text: string,
  deps: SessionInputDeps,
): Promise<SessionInputOutcome & { id: string; runs: number }> {
  const id = deps.newId();
  const request: SidecarFillRequest = { kind: "prompt.fill", id, text };
  const line = `${JSON.stringify(request)}\n`;
  deps.pending.open(id, sid);
  const sockets = await liveSidecars(sid, deps);
  const written = await Promise.all(sockets.map((socket) => deps.write(socket, line)));
  const runs = written.filter((w) => w === "delivered").length;
  if (runs === 0) {
    deps.pending.close(id);
    return { id, runs, outcome: "not_delivered", reason: "no_module" };
  }
  return { id, runs, ...(await deps.pending.settle(id, runs, deps.confirmMs)) };
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
    write: (socketPath, line) => writeSocket(socketPath, line, SIDECAR_WRITE_MS),
    confirmMs: SESSION_INPUT_CONFIRM_MS,
  };
}
