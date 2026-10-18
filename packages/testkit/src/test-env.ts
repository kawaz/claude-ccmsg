// Preloaded into every `bun test` run (bunfig.toml). Daemons spawned by tests
// inherit this process's environment, and an agents poll in one of them would
// register every live Claude Code session on the developer's machine into the
// test's registry — tests that exercise the poll opt back in with their own
// fake $HOME and `claude`.
import { afterAll, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openLifeline } from "./lifeline.ts";

process.env.CCMSG_AGENTS_POLL ??= "off";

// One timeout for every test, long enough for the ones that start a daemon or
// a CLI process. bun reads no `timeout` from bunfig.toml's [test] section, so
// it is set here, where every run passes. A test that needs longer passes its
// own with a comment saying why.
setDefaultTimeout(15_000);

// Every daemon a test spawns, directly or through the CLI, lives no longer than
// this run (lifeline.ts). A daemon still holding the line after the last test
// fails the run: a test started it and did not stop it. That includes one that
// bun killed as a timed-out test's dangling process just before the end, whose
// line this process has not yet seen close — that test did not stop it either.
const lifelineDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-lifeline-"));
const lifeline = openLifeline(path.join(lifelineDir, "sock"));
process.env.CCMSG_TEST_LIFELINE = lifeline.path;

afterAll(() => {
  const left = lifeline.holders();
  lifeline.close();
  fs.rmSync(lifelineDir, { recursive: true, force: true });
  if (left.length > 0) {
    throw new Error(
      `${String(left.length)} daemon(s) were not stopped by the test that started them; ` +
        `the state dir of each (its prefix names the test file):\n${left.join("\n")}`,
    );
  }
});
