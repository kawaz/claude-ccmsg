// "前回稼働中" sessions: the on-disk record of which sessions were connected,
// so a daemon that comes back after a crash or a machine reboot can still say
// what was running and offer to resume it (issue 2026-08-25-restart-recovery-
// last-live-sessions).
//
// Design rationale — why a file at all: the peers registry is memory only, on
// purpose (a peer is a live connection). That is exactly what a reboot
// destroys, and it is the one moment a user most needs the list: "which
// directories did I have sessions open in?" is unanswerable afterwards. The
// snapshot is therefore a record of a *past* fact ("these were alive as of
// this instant"), never a claim about the present — nothing here is treated as
// a connection, and a graceful shutdown does not clear it either, since a
// planned reboot loses the same knowledge an unplanned one does.
//
// Writes are tmp+rename rather than the plain writeFileSync the rest of the
// daemon's small state files use. Those are written once at startup (pid) or
// by an explicit user action (dumps); this one is rewritten as sessions come
// and go, and the failure it exists to survive — power loss — is precisely the
// one that would otherwise leave a half-written JSON behind and lose the whole
// list. Cost is one extra rename per join/leave.
import * as fs from "node:fs";
import * as path from "node:path";
import type { LastLiveSession } from "@ccmsg/protocol";
import { readSessionLaunchContext } from "./session-search.ts";

/** Minimal logging surface, kept structural so this module has no dependency
 *  edge on log.ts's class (same rationale as agents.ts's AgentsLog). */
export interface LastLiveLog {
  info(msg: string): void;
  error(msg: string): void;
}

/** Persisted file shape. `version` exists so a future change of the record
 *  shape can be recognized rather than half-parsed; an unknown version is
 *  dropped whole (the list is a convenience, never worth a migration risk). */
const FORMAT_VERSION = 1;

interface SnapshotFile {
  version: number;
  updated_at: string;
  sessions: LastLiveSession[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** One persisted record, or null when it carries nothing usable. `sid`, `cwd`
 *  and `last_seen_at` are the load-bearing three: without a sid there is
 *  nothing to resume, without a cwd the launcher has no directory to run in,
 *  and without a time the row cannot say how old it is. repo/ws are labels and
 *  default to "" exactly as an empty hello would leave them. */
function parseEntry(raw: unknown): LastLiveSession | null {
  if (!isRecord(raw)) return null;
  const sid = str(raw.sid);
  const cwd = str(raw.cwd);
  const lastSeenAt = str(raw.last_seen_at);
  if (!sid || !cwd || !lastSeenAt) return null;
  const transcriptPath = str(raw.transcript_path);
  const repoRoot = str(raw.repo_root);
  const branch = str(raw.branch);
  const title = str(raw.title);
  const connectedAt = str(raw.connected_at);
  return {
    sid,
    repo: typeof raw.repo === "string" ? raw.repo : "",
    ws: typeof raw.ws === "string" ? raw.ws : "",
    cwd,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    ...(branch ? { branch } : {}),
    ...(title ? { title } : {}),
    ...(connectedAt ? { connected_at: connectedAt } : {}),
    last_seen_at: lastSeenAt,
  };
}

/** Read the snapshot the previous daemon left. A missing file is the normal
 *  first-run case and says nothing; anything else unreadable or unparseable is
 *  logged and treated as empty — a broken convenience list must never stop the
 *  daemon from starting. */
export function readLastLiveSessions(file: string, log: LastLiveLog): LastLiveSession[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error(`last-live snapshot unreadable (${String(e)}); starting with none`);
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error(`last-live snapshot is not valid JSON (${String(e)}); starting with none`);
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.sessions)) {
    log.error("last-live snapshot has an unrecognized shape; starting with none");
    return [];
  }
  const entries: LastLiveSession[] = [];
  const seen = new Set<string>();
  for (const item of parsed.sessions) {
    const entry = parseEntry(item);
    if (!entry || seen.has(entry.sid)) continue;
    seen.add(entry.sid);
    entries.push(entry);
  }
  return entries;
}

/** The subset of an entry that belongs on disk: connection facts only.
 *  `model`/`effort` are deliberately dropped — they are derived from the
 *  transcript by withLaunchContext at load time, and a file holding derived
 *  data would go stale against the very transcript it was derived from. */
function persistedRecord(entry: LastLiveSession): LastLiveSession {
  return {
    sid: entry.sid,
    repo: entry.repo,
    ws: entry.ws,
    cwd: entry.cwd,
    ...(entry.transcript_path ? { transcript_path: entry.transcript_path } : {}),
    ...(entry.repo_root ? { repo_root: entry.repo_root } : {}),
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.connected_at ? { connected_at: entry.connected_at } : {}),
    last_seen_at: entry.last_seen_at,
  };
}

/** Replace the snapshot with `entries`, atomically (write a sibling tmp file,
 *  then rename over the target — rename(2) within one directory is atomic, so
 *  a reader after a crash sees either the whole old file or the whole new
 *  one). Best-effort: a failure to persist is logged and otherwise ignored,
 *  since the live daemon's own list is unaffected. */
export function writeLastLiveSessions(
  file: string,
  entries: readonly LastLiveSession[],
  log: LastLiveLog,
): void {
  const payload: SnapshotFile = {
    version: FORMAT_VERSION,
    updated_at: new Date().toISOString(),
    sessions: entries.map(persistedRecord),
  };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    log.error(`last-live snapshot write failed (${String(e)})`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean up, or the same failure again; ignore either way
    }
  }
}

/** Fill in `model`/`effort` from each entry's transcript.
 *
 * Deliberately not persisted at snapshot time: what a session must resume as
 * is whatever its final turn ran under, and that turn may be written long
 * after the daemon's last write (a model switched mid-run, or the very last
 * exchange before the power went out). Reading it here, once, off transcripts
 * that are no longer being appended to, is both cheaper (only stale entries,
 * only at startup) and more accurate than freezing it earlier.
 *
 * Entries with no transcript, or whose transcript establishes nothing, are
 * returned unchanged — the launcher form then simply opens on its own
 * defaults, the same as a Session Search hit with no model. */
export async function withLaunchContext(
  entries: readonly LastLiveSession[],
): Promise<LastLiveSession[]> {
  return await Promise.all(
    entries.map(async (entry) => {
      if (!entry.transcript_path) return entry;
      const context = await readSessionLaunchContext(entry.transcript_path);
      if (!context.model && !context.effort) return entry;
      return {
        ...entry,
        ...(context.model ? { model: context.model } : {}),
        ...(context.effort ? { effort: context.effort } : {}),
      };
    }),
  );
}
