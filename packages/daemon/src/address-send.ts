// address_send (DR-0037): a message a session's hooks module took over from
// SendMessage, delivered to every live session run its `ccmsg:` address
// names. Each run gets the envelope in its peer messaging socket
// (peer-inject.ts); the sender is told delivered when any run took it, and
// nothing is held for a later attempt (DR-0036 §3).
//
// The runs are read fresh from Claude Code's state files
// (`<config dir>/sessions/<pid>.json`) at each send rather than from the
// agents poll, which may be a poll behind: a session that just started, or a
// run that just moved to another id (/clear), is then sent to as it is now.
import { readdir, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import {
  type AddressSendReason,
  type CcmsgAddress,
  ClaudeSessionFileTextSchema,
  parseCcmsgAddress,
  parseWith,
  renderAddressedDelivery,
} from "@ccmsg/protocol";
import type { InjectFrame, InjectResult } from "./peer-inject.ts";

/** One live run of a session: the harness process `pid` holding session
 * `sid` under the CLAUDE_CONFIG_DIR `configDir`, working in `cwd`. */
export interface SessionRun {
  configDir: string;
  sid: string;
  pid: number;
  cwd?: string;
}

export type AddressSendOutcome =
  | { outcome: "delivered" }
  | { outcome: "not_delivered"; reason: AddressSendReason }
  | { outcome: "unconfirmed" };

export interface AddressSendDeps {
  /** The live runs of every session the daemon can deliver to. */
  runs(): Promise<SessionRun[]>;
  /** `dir` as a realpath, or undefined when it does not resolve. */
  realpath(dir: string): Promise<string | undefined>;
  issueMid(): string;
  deliver(run: SessionRun, frame: InjectFrame): Promise<InjectResult>;
  log(line: string): void;
}

/** The runs `address` names among `runs`. A directory is compared as a
 * realpath, whole: a session in a subdirectory works elsewhere. The sender's
 * own runs are left out of a directory's sessions, which the sender is
 * usually one of. */
export async function resolveAddress(
  address: CcmsgAddress,
  from: string,
  runs: readonly SessionRun[],
  realpathOf: (dir: string) => Promise<string | undefined>,
): Promise<SessionRun[]> {
  switch (address.kind) {
    case "session":
      return runs.filter((run) => run.sid === address.sid);
    case "run":
      return runs.filter((run) => run.sid === address.sid && run.pid === address.pid);
    case "path": {
      const dir = await realpathOf(address.dir);
      if (dir === undefined) return [];
      const named: SessionRun[] = [];
      for (const run of runs) {
        if (run.sid === from || run.cwd === undefined) continue;
        if (((await realpathOf(run.cwd)) ?? run.cwd) === dir) named.push(run);
      }
      return named;
    }
  }
}

/** Which failure a send to runs that all failed reports when they failed for
 * different reasons: the first here that any run gave. */
const FAILURE_ORDER = ["refused", "unreachable", "no_status_socket", "no_peer_socket"] as const;

/** What the deliveries to the runs of one address come to. One that arrived
 * makes the send delivered; otherwise one that may have arrived makes it
 * unconfirmed, and only then is it not delivered. */
export function addressSendOutcome(results: readonly InjectResult[]): AddressSendOutcome {
  if (results.some((r) => r.outcome === "delivered")) return { outcome: "delivered" };
  if (results.some((r) => r.outcome === "unconfirmed")) return { outcome: "unconfirmed" };
  const causes = new Set<AddressSendReason>(
    results.flatMap((r) =>
      r.outcome === "refused" ? ["refused"] : r.outcome === "unavailable" ? [r.cause] : [],
    ),
  );
  const reason = FAILURE_ORDER.find((cause) => causes.has(cause));
  return { outcome: "not_delivered", reason: reason ?? "no_recipient" };
}

/** Deliver one message from session `from` to the address `to`. */
export async function sendToAddress(
  message: { from: string; to: string; text: string },
  deps: AddressSendDeps,
): Promise<AddressSendOutcome> {
  const address = parseCcmsgAddress(message.to);
  if (address === undefined) return { outcome: "not_delivered", reason: "invalid_address" };
  if (address.kind !== "path" && address.sid === message.from) {
    return { outcome: "not_delivered", reason: "self" };
  }
  const targets = await resolveAddress(address, message.from, await deps.runs(), (dir) =>
    deps.realpath(dir),
  );
  if (targets.length === 0) return { outcome: "not_delivered", reason: "no_recipient" };
  // A mid per run: the refusal a run may answer names the mid it refuses,
  // and runs sharing one would take each other's.
  const results = await Promise.all(
    targets.map(async (run) => {
      const mid = deps.issueMid();
      const content = renderAddressedDelivery({ mid, from: message.from, text: message.text });
      const result = await deps.deliver(run, { mid, content });
      deps.log(
        `peer-inject ${mid} -> ${run.sid}.${String(run.pid)} (${message.to}): ${result.outcome}` +
          (result.outcome === "unavailable" ? ` (${result.cause})` : ""),
      );
      return result;
    }),
  );
  return addressSendOutcome(results);
}

/** Read Claude Code's state files within. */
export const RUNS_SCAN_MS = 1_000;

/** The live runs recorded in `<config dir>/sessions/<pid>.json` of each of
 * `configDirs`. A file whose process no longer runs is a run that ended
 * without removing it, and is left out. A config dir that cannot be read, or
 * whose files are not all read within `scanMs`, adds none. */
export async function liveRuns(
  configDirs: readonly string[],
  isAlive: (pid: number) => boolean,
  scanMs: number = RUNS_SCAN_MS,
): Promise<SessionRun[]> {
  const perDir = await Promise.all(
    configDirs.map(async (configDir) => {
      const late = Promise.withResolvers<SessionRun[]>();
      const deadline = setTimeout(() => late.resolve([]), scanMs);
      try {
        return await Promise.race([runsIn(configDir, isAlive), late.promise]);
      } finally {
        clearTimeout(deadline);
      }
    }),
  );
  return perDir.flat();
}

async function runsIn(configDir: string, isAlive: (pid: number) => boolean): Promise<SessionRun[]> {
  const sessionsDir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const runs = await Promise.all(
    names
      .filter((name) => /^\d+\.json$/.test(name))
      .map(async (name): Promise<SessionRun[]> => {
        let text: string;
        try {
          text = await readFile(path.join(sessionsDir, name), "utf8");
        } catch {
          return [];
        }
        const read = parseWith(ClaudeSessionFileTextSchema, text);
        if (!read.ok || !isAlive(read.value.pid)) return [];
        const { sessionId: sid, pid, cwd } = read.value;
        return [{ configDir, sid, pid, ...(cwd !== undefined ? { cwd } : {}) }];
      }),
  );
  return runs.flat();
}

/** `dir` as a realpath, or undefined when it does not resolve. */
export async function realpathOrUndefined(dir: string): Promise<string | undefined> {
  try {
    return await realpath(dir);
  } catch {
    return undefined;
  }
}
