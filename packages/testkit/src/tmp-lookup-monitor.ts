// How long looking a name up directly under /private/tmp takes on macOS
// through the test run, for what a slow one held up.
//
// On macOS in CI, a daemon's async stat of `/private/tmp/.jj` (its hello
// deriving the location of the cwd `/tmp`) once took 1727 ms while the same
// stat under `/private` and `/` took under 10 ms and the daemon's event loop
// turned; the run's temp dirs and the sockets of the fake harnesses sit
// directly under /private/tmp as well. Whether /private/tmp's lookups wait at
// other times too, and when, is not known. The monitor's child
// (tmp-lookup-probe.ts) times them through the run; the run's end prints
// each slow round with its time (bun's output gives the test that ran then),
// beside how many entries /private/tmp held at the run's start and end.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./tmp-lookup-probe.ts", import.meta.url));
/** Each round's spacing, and the time a lookup has to take to be reported. */
const INTERVAL_MS = 50;
const SLOW_MS = 100;

export interface TmpLookupMonitor {
  /** The name of the file the child writes in the run dir, for the run's
   * leftover check to keep. */
  file: string;
  /** Stop the child and give what it saw, the lines to print. */
  stop(): Promise<string[]>;
}

function entriesOf(dir: string): string {
  try {
    return String(fs.readdirSync(dir).length);
  } catch {
    return "?";
  }
}

/** Start timing the lookups directly under `watched.dir` (/private/tmp) and
 * `watched.parent` (/private), writing in `runDir`. */
export function startTmpLookupMonitor(
  runDir: string,
  watched: { dir: string; parent: string; slowMs: number } = {
    dir: "/private/tmp",
    parent: "/private",
    slowMs: SLOW_MS,
  },
): TmpLookupMonitor {
  const file = "tmp-lookups.txt";
  const out = path.join(runDir, file);
  const { dir, parent, slowMs } = watched;
  const atStart = entriesOf(dir);
  const child = Bun.spawn(
    [process.execPath, PROBE, out, dir, parent, runDir, String(INTERVAL_MS), String(slowMs)],
    { stdin: "pipe", stdout: "ignore", stderr: "inherit" },
  );
  return {
    file,
    stop: async () => {
      await child.stdin.end();
      await child.exited;
      let seen: string[];
      try {
        seen = fs.readFileSync(out, "utf8").trimEnd().split("\n");
      } catch {
        seen = ["the probe wrote nothing"];
      }
      return [
        `${dir} lookups (every ${String(INTERVAL_MS)} ms; ${dir} held ${atStart} entries at the start, ${entriesOf(dir)} at the end):`,
        ...seen.map((line) => `  ${line}`),
      ];
    },
  };
}
