// A pid that is alive for as long as the test that asked for it, for a test
// that needs a running process other than its own (a second session, a second
// run of one session).
//
// Its parent is not one: when whatever started `bun test` exits first (a shell
// that put it in the background), the test process is re-parented and
// `process.ppid` reads 1, which `kill(1, 0)` answers with EPERM — not a
// process of this user (docs/findings/2026-11-11-tests-fail-when-bun-parent-exits.md).
// A fixed number names whatever happens to run under it, or nothing.
//
// Each pid is a child that reads its stdin until it closes: the test's
// `afterEach` stops it, and if the run dies before that, the kernel closes the
// pipe and the child leaves, so it never outlives the run.
import { afterEach } from "bun:test";

/** For a test file whose tests need live pids: returns a function that starts
 * a child and gives its pid, and stops the children a test started once that
 * test ends. Call it at the top level of the file — it registers the
 * `afterEach` there. */
export function perTestLivePid(): () => number {
  const started: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
  afterEach(async () => {
    for (const child of started.splice(0)) {
      child.kill();
      await child.exited;
    }
  });
  return () => {
    const child = Bun.spawn(["cat"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    started.push(child);
    return child.pid;
  };
}
