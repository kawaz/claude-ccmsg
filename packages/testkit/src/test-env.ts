// Preloaded into every `bun test` run (bunfig.toml). Daemons spawned by tests
// inherit this process's environment, and the agents rows read in one of them
// would forget a session that said hello with a config dir holding no state
// file for it — tests that exercise the agents rows opt back in with their
// own fake $HOME and state files (DR-0034 §5).
import { afterAll, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { openLifeline } from "./lifeline.ts";
import { contentsOf, openRunTmp } from "./tmp.ts";
import { startTmpLookupMonitor } from "./tmp-lookup-monitor.ts";

process.env.CCMSG_AGENTS_POLL ??= "off";

// One timeout for every test, long enough for the ones that start a daemon or
// a CLI process. bun reads no `timeout` from bunfig.toml's [test] section, so
// it is set here, where every run passes. A test that needs longer passes its
// own with a comment saying why.
setDefaultTimeout(15_000);

// Every temp dir a test makes lives no longer than this run (tmp.ts), and
// every daemon or sidecar a test spawns, directly or through the CLI, neither
// (lifeline.ts; its socket sits in the run's temp dir). What is still there
// after the last test fails the run: a test made it and did not remove or stop
// it. That includes a daemon that bun killed as a timed-out test's dangling
// process just before the end, whose line this process has not yet seen close
// — that test did not stop it either.
const LIFELINE = "lifeline.sock";
const runTmp = openRunTmp();
const lifeline = openLifeline(path.join(runTmp.dir, LIFELINE));
// The lifeline also keeps a test's daemon silent: one whose config names no
// say_command speaks nothing, rather than through /usr/bin/say (DR-0045 §6).
process.env.CCMSG_TEST_LIFELINE = lifeline.path;

// On macOS, how long /private/tmp's lookups take through the run, printed at
// its end (tmp-lookup-monitor.ts).
const tmpLookups = process.platform === "darwin" ? startTmpLookupMonitor(runTmp.dir) : undefined;

afterAll(async () => {
  if (tmpLookups !== undefined) console.error((await tmpLookups.stop()).join("\n"));
  const holders = lifeline.holders();
  lifeline.close();
  const dirs = runTmp
    .leftovers([LIFELINE, ...(tmpLookups !== undefined ? [tmpLookups.file] : [])])
    .map((dir) => [dir, ...contentsOf(dir).map((entry) => `  ${entry}`)].join("\n"));
  runTmp.remove();
  const failures: string[] = [];
  if (holders.length > 0) {
    failures.push(
      `${String(holders.length)} process(es) were not stopped by the test that started them; ` +
        `the state dir of each daemon and the socket of each sidecar (its prefix names the test file):\n${holders.join("\n")}`,
    );
  }
  if (dirs.length > 0) {
    failures.push(
      `${String(dirs.length)} temp file(s) were not removed by the test that made them ` +
        `(the run removed them; each name's prefix names the test file, and what it held follows it):\n${dirs.join("\n")}`,
    );
  }
  if (failures.length > 0) throw new Error(failures.join("\n\n"));
});
