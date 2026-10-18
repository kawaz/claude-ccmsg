// The live runs of the sessions on this machine, as peer_send and peer_list
// (DR-0039 §3) match them: one per harness process, read fresh from Claude
// Code's state files (`<config dir>/sessions/<pid>.json`) at each request
// rather than from the agents poll, which may be a poll behind: a session
// that just started, or a run that just moved to another id (/clear), is
// then sent to as it is now.
import { readdir, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { ClaudeSessionFileTextSchema, parseWith } from "@ccmsg/protocol";

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

/** The live runs recorded in `<config dir>/sessions/<pid>.json` of each of
 * `configDirs`. A file whose process no longer runs is a run that ended
 * without removing it, and is left out. A config dir that cannot be read, or
 * whose files are not all read within `scanMs`, adds none. A process is one
 * run however many of `configDirs` name its config dir (one through a
 * symlink, another by its realpath): it is listed once, so it is sent to
 * once. */
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
  const byPid = new Map<number, SessionRun>();
  for (const run of perDir.flat()) if (!byPid.has(run.pid)) byPid.set(run.pid, run);
  return [...byPid.values()];
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
      .filter((file) => /^\d+\.json$/.test(file))
      .map(async (file): Promise<SessionRun[]> => {
        let text: string;
        try {
          text = await readFile(path.join(sessionsDir, file), "utf8");
        } catch {
          return [];
        }
        const read = parseWith(ClaudeSessionFileTextSchema, text);
        if (!read.ok || !isAlive(read.value.pid)) return [];
        const { sessionId: sid, pid, cwd, name } = read.value;
        return [
          {
            configDir,
            sid,
            pid,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(name !== undefined ? { name } : {}),
          },
        ];
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
