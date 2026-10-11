import * as fs from "node:fs";
import * as path from "node:path";
import { ClaudeSessionFileTextSchema, parseWith, type ClaudeSessionFile } from "@ccmsg/protocol";

export interface SubscribeOwnerWatch {
  stale: Promise<void>;
  close(): void;
}

/** The registry record in `file`, or null when it cannot be read or does not
 * name a process and a session. */
function readRegistryEntry(file: string): ClaudeSessionFile | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const entry = parseWith(ClaudeSessionFileTextSchema, text);
  if (!entry.ok) return null;
  const { pid, sessionId } = entry.value;
  return Number.isInteger(pid) && pid > 0 && sessionId !== "" ? entry.value : null;
}

/** Find the Claude process registry entry that currently owns `sid`.
 *
 * Claude Code stores one `sessions/<pid>.json` record per live process and
 * rewrites its `sessionId` when `/clear` starts a new conversation in that same
 * process. If the registry is unavailable or malformed, return null so a live
 * subscribe is never terminated from ambiguous evidence. */
export function findSubscribeOwnerFile(configDir: string, sid: string): string | null {
  const sessionsDir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(sessionsDir, name);
    const entry = readRegistryEntry(file);
    if (entry?.sessionId === sid && name === `${entry.pid}.json`) matches.push(file);
  }
  const [only, ...others] = matches;
  return only !== undefined && others.length === 0 ? only : null;
}

/** Watch the owning Claude process's registry record until it no longer names
 * `sid`. `fs.watch` is the primary signal; a backup check covers coalesced or
 * dropped filesystem events. The watch is enabled only after an unambiguous
 * initial sid→pid match, so missing registry support degrades to no supervision
 * rather than risking a false termination. */
export function watchSubscribeOwner(
  configDir: string | undefined,
  sid: string,
  backupIntervalMs = 2000,
  missingGraceMs = 250,
): SubscribeOwnerWatch | null {
  if (!configDir) return null;
  const ownerFile = findSubscribeOwnerFile(configDir, sid);
  if (!ownerFile) return null;
  const sessionsDir = path.dirname(ownerFile);

  let settled = false;
  let missingTimer: ReturnType<typeof setTimeout> | null = null;
  const { promise: stale, resolve: resolveStale } = Promise.withResolvers<void>();

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (missingTimer) clearTimeout(missingTimer);
    missingTimer = null;
    resolveStale();
  };

  const check = (): void => {
    if (settled) return;
    const entry = readRegistryEntry(ownerFile);
    if (entry?.sessionId === sid && ownerFile === path.join(sessionsDir, `${entry.pid}.json`)) {
      if (missingTimer) clearTimeout(missingTimer);
      missingTimer = null;
      return;
    }
    if (entry !== null) {
      settle();
      return;
    }
    // Claude may replace the registry file atomically or truncate-and-rewrite it.
    // A brief missing/malformed window is not evidence that the owner died; only
    // terminate if a second read after the grace period still cannot prove the
    // original sid owns this PID file.
    if (!missingTimer) {
      missingTimer = setTimeout(() => {
        missingTimer = null;
        const confirmed = readRegistryEntry(ownerFile);
        if (
          confirmed?.sessionId === sid &&
          ownerFile === path.join(sessionsDir, `${confirmed.pid}.json`)
        ) {
          return;
        }
        settle();
      }, missingGraceMs);
    }
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(sessionsDir, check);
  } catch {
    return null;
  }
  const timer = setInterval(check, backupIntervalMs);
  check();

  return {
    stale,
    close(): void {
      settled = true;
      if (missingTimer) clearTimeout(missingTimer);
      missingTimer = null;
      watcher?.close();
      clearInterval(timer);
    },
  };
}
