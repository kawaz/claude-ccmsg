#!/usr/bin/env bun
// Pre-exec the executables the test suite hard-links, so macOS evaluates their
// inodes here (see mock-bin.ts) rather than inside the first test that happens to
// run one — where the wait counts against that test's timeout. `just test` runs
// this before `bun test`; it is a no-op on Linux and on an already-warm machine.
import { fileURLToPath } from "node:url";
import { warmShim, warmExecutable } from "./mock-bin.ts";

const LAUNCHER = fileURLToPath(new URL("../../../bin/ccmsg", import.meta.url));

const shimMs = warmShim();
// bin/ccmsg.test.ts hard-links the real launcher into its fixtures, so the
// launcher's own inode needs the same treatment. Running it with an empty PATH
// makes it exit early ("bun not found") instead of booting the CLI: the point
// here is to exec the inode, not to do anything with it.
const launcherMs = warmExecutable(LAUNCHER, ["--help"], { PATH: "/usr/bin:/bin" });

const total = shimMs + launcherMs;
// Only worth a line when it actually cost something: a warm machine is ~10ms and
// does not need to say so, while a cold one is about to look like it hung.
if (total >= 1000) {
  console.log(
    `warmed test executables in ${(total / 1000).toFixed(1)}s (shim ${shimMs}ms, launcher ${launcherMs}ms)`,
  );
}
