// The live sessions on this machine, read from Claude Code's state files
// (`<config dir>/sessions/<pid>.json`, one per harness process): what the
// agents poll registers and shows (agents.ts, DR-0034 §5), and what
// send_message and peer_list (DR-0039 §3) match, read fresh at each request
// rather than from the poll, which may be a round behind: a session that just
// started, or a run that just moved to another id (/clear), is then sent to as
// it is now.
import { readdir, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import {
  ClaudeSessionFileTextSchema,
  errorText,
  parseWith,
  type ClaudeSessionFile,
} from "@ccmsg/protocol";
import { type LateScan, type ScanProgress, withinBudget } from "./time-budget.ts";

/** One live run of a session: the harness process `pid` holding session
 * `sid` under the CLAUDE_CONFIG_DIR `configDir`, working in `cwd`, under the
 * name the session was given. */
export interface SessionRun {
  configDir: string;
  sid: string;
  pid: number;
  cwd?: string;
  name?: string;
}

/** Read Claude Code's state files within. */
export const RUNS_SCAN_MS = 1_000;

/** What liveRuns left out that was there to read: what it leaves out reads
 * to a send like a session that is not running, so the caller is told.
 * - `late`: a config dir whose files were not all read in time, with how far
 *   the read got (it adds no run)
 * - `unread`: the records of a config dir that could not be read or did not
 *   read as a record, or its `sessions/` that could not be listed, each with
 *   why (each adds no run) */
export interface LeftOut {
  late(scan: LateScan): void;
  unread(sessionsDir: string, reasons: readonly string[]): void;
}

const NOTHING_TOLD: LeftOut = { late: () => {}, unread: () => {} };

/** The live runs recorded in `<config dir>/sessions/<pid>.json` of each of
 * `configDirs`. A file whose process no longer runs is a run that ended
 * without removing it, and is left out. A record that cannot be read adds no
 * run, and a config dir that cannot be listed, or whose files are not all
 * read within `scanMs` of this process's running time (withinBudget), adds
 * none; `leftOut` is told of each. A process is one run however many of
 * `configDirs` name its config dir (one through a symlink, another by its
 * realpath): it is listed once, so it is sent to once. */
export async function liveRuns(
  configDirs: readonly string[],
  isAlive: (pid: number) => boolean,
  scanMs: number = RUNS_SCAN_MS,
  leftOut: LeftOut = NOTHING_TOLD,
): Promise<SessionRun[]> {
  const perDir = await Promise.all(
    configDirs.map((configDir) => {
      const progress: ScanProgress = { listed: undefined, read: 0 };
      return withinBudget(
        runsIn(configDir, isAlive, progress, leftOut),
        scanMs,
        (spent): SessionRun[] => {
          leftOut.late({ dir: path.join(configDir, "sessions"), ...progress, ...spent });
          return [];
        },
      );
    }),
  );
  const byPid = new Map<number, SessionRun>();
  for (const run of perDir.flat()) if (!byPid.has(run.pid)) byPid.set(run.pid, run);
  return [...byPid.values()];
}

async function runsIn(
  configDir: string,
  isAlive: (pid: number) => boolean,
  progress: ScanProgress,
  leftOut: LeftOut,
): Promise<SessionRun[]> {
  const read = await readSessionsDir(configDir, isAlive, progress);
  if (read.unread !== undefined) leftOut.unread(path.join(configDir, "sessions"), read.unread);
  return read.live.map(({ sessionId: sid, pid, cwd, name }) => ({
    configDir,
    sid,
    pid,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(name !== undefined ? { name } : {}),
  }));
}

/** What one config dir's `sessions/` says. */
export interface SessionsDirRead {
  /** The records of processes that still run. A record whose process no
   * longer runs is a run that ended without removing it, and is left out, as
   * is one removed while the dir was read. */
  live: ClaudeSessionFile[];
  /** Why the dir was not read whole: `sessions/` could not be listed, or the
   * named records could not be read or did not read as a record. Absent when
   * it was (no `sessions/` at all is a dir with no sessions). */
  unread?: string[];
}

/** Read `<configDir>/sessions/<pid>.json` of every process, counting in
 * `progress` how far the read has got. */
export async function readSessionsDir(
  configDir: string,
  isAlive: (pid: number) => boolean,
  progress: ScanProgress = { listed: undefined, read: 0 },
): Promise<SessionsDirRead> {
  const sessionsDir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch (e) {
    progress.listed = 0;
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return { live: [] };
    return { live: [], unread: [`${sessionsDir}: ${errorText(e)}`] };
  }
  const records = names.filter((file) => /^\d+\.json$/.test(file));
  progress.listed = records.length;
  const reads = await Promise.all(
    records.map(async (file): Promise<ClaudeSessionFile | string | null> => {
      try {
        return await readRecord(path.join(sessionsDir, file), isAlive);
      } finally {
        progress.read += 1;
      }
    }),
  );
  const live: ClaudeSessionFile[] = [];
  const unread: string[] = [];
  for (const read of reads) {
    if (typeof read === "string") unread.push(read);
    else if (read !== null) live.push(read);
  }
  return unread.length > 0 ? { live, unread } : { live };
}

/** One `<pid>.json`: the record of a process that still runs, null for one
 * whose process does not (or a file removed while the dir was read), or why
 * it does not read. */
async function readRecord(
  filePath: string,
  isAlive: (pid: number) => boolean,
): Promise<ClaudeSessionFile | string | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    return `${filePath}: ${errorText(e)}`;
  }
  const read = parseWith(ClaudeSessionFileTextSchema, text);
  if (!read.ok) return `${filePath}: ${read.failure.summary}`;
  return isAlive(read.value.pid) ? read.value : null;
}

/** `dir` as a realpath, or undefined when it does not resolve. */
export async function realpathOrUndefined(dir: string): Promise<string | undefined> {
  try {
    return await realpath(dir);
  } catch {
    return undefined;
  }
}
