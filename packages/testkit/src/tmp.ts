// The test run's temp space: every temp dir a test makes lives no longer than
// the run, however the run ends short of a SIGKILL — a test that times out
// before its `finally` included.
//
// The preload points TMPDIR at one dir per run, so `os.tmpdir()` in the tests
// and in every process they start (the CLI, daemons, scripts) lands there, and
// the run removes it at the end. The few tests that need a path shorter than
// that for a UNIX socket take theirs from shortTmpDir, which the run removes
// too.
//
// Design rationale: the run dir sits in /tmp rather than under the inherited
// $TMPDIR. macOS's $TMPDIR is ~50 characters deep, and a daemon's socket under
// a test's dir under the run dir would come close to sun_path's 104 bytes;
// from /tmp the paths are shorter than they were without a run dir.
import { afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** For a test file whose tests each make temp dirs: returns a `mkdtemp`
 * under os.tmpdir() (`<prefix>XXXXXX`), and removes the dirs a test made
 * once that test ends. Call it at the top level of the file — it registers
 * the `afterEach` there. */
export function perTestTmpDir(): (prefix: string) => string {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  return (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
}

/** Dirs shortTmpDir made in this process. */
const shortDirs = new Set<string>();

/** A new empty directory directly under /tmp (`/tmp/<prefix>XXXXXX`), for a
 * test whose UNIX socket path must stay short. The test removes it; the run
 * removes it if the test did not. */
export function shortTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join("/tmp", prefix));
  shortDirs.add(dir);
  return dir;
}

/** How many entries `contentsOf` lists of one leftover before it stops. */
const CONTENTS_SHOWN = 20;

/** What a leftover holds, one line per entry: its path relative to `file`, a
 * directory's ending in `/`, sorted; `(empty)` for an empty directory, nothing
 * for a file or for what is gone by now. What it holds can say who wrote it
 * when its name cannot: a process the test started may have written into it
 * after the test removed it. */
export function contentsOf(file: string): string[] {
  if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() !== true) return [];
  const entries = fs
    .readdirSync(file, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const relative = path.relative(file, path.join(entry.parentPath, entry.name));
      return entry.isDirectory() ? `${relative}/` : relative;
    })
    .toSorted();
  if (entries.length === 0) return ["(empty)"];
  const shown = entries.slice(0, CONTENTS_SHOWN);
  return entries.length > shown.length
    ? [...shown, `... and ${String(entries.length - shown.length)} more`]
    : shown;
}

export interface RunTmp {
  /** The dir TMPDIR points at for this run. */
  dir: string;
  /** What the tests left: entries of the run dir other than `keep`, and the
   * shortTmpDir dirs still there. */
  leftovers(keep: readonly string[]): string[];
  /** Remove the run dir and every shortTmpDir dir. */
  remove(): void;
}

/** Make this run's temp dir and point TMPDIR at it. */
export function openRunTmp(): RunTmp {
  const dir = fs.mkdtempSync("/tmp/ccmsg-run-");
  process.env.TMPDIR = dir;
  return {
    dir,
    leftovers: (keep) => [
      ...fs
        .readdirSync(dir)
        .filter((name) => !keep.includes(name))
        .map((name) => path.join(dir, name)),
      ...[...shortDirs].filter((d) => fs.existsSync(d)),
    ],
    remove: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      for (const d of shortDirs) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}
