// Creating a mock executable for a test costs ~0ms on Linux and, on macOS under
// load, up to *minutes*: the first exec of a freshly created inode is held while
// syspolicyd/XProtect evaluates it, and the evaluation is cached per inode — not
// per path and not per content. Measured on this repo at load average 46-74:
//
//   fresh inode, first exec       102,889 / 140,981 / 173,270 ms
//   fresh inode, warm evaluator       409 -   1,036 ms
//   hard link to an already-run inode    12 -      23 ms
//
// Tests that write a mock script per case therefore pay that toll per case and
// blow their timeouts. writeMockBin sidesteps it: the file placed at `binPath` is
// a hard link to one shim committed in the repo, so after the very first exec on
// a machine the kernel never sees an unevaluated inode again. The script the test
// actually wants to run is written beside it as a sidecar and reaches its
// interpreter as a data file argument, which Gatekeeper does not gate.
//
// The indirection is invisible to the code under test: argv, stdin/stdout/stderr,
// exit status and signals all behave as if the script were exec'd directly (the
// shim `exec`s, so no extra process remains in between). The one exception is
// "$0", which reads as the sidecar's path — see exec-shim.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** The shim every mock links to. Committed with its exec bit set — the hard link
 *  inherits it, so no chmod (which would race across links) is needed. */
const SHIM = fileURLToPath(new URL("./exec-shim", import.meta.url));

/** Where writeMockBin stores `binPath`'s script. Exposed for the rare test that
 *  needs to rewrite a mock's behaviour in place after creating it. */
export function mockScriptPath(binPath: string): string {
  return `${binPath}.script`;
}

/**
 * Runs the shim once so its inode is evaluated, and returns how long that took.
 *
 * The evaluation happens on the first exec after a checkout (or after the shim's
 * contents change) whether or not anything calls this, but it happens *inside*
 * whichever test execs first, against that test's timeout. `just test` pays it up
 * front instead, where it is slow rather than fatal. A failure to run the shim is
 * not reported: the tests that need it will fail with far better context.
 */
export function warmShim(): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-warm-shim-"));
  try {
    // Has to be a real exec of a real hard link: the evaluation is keyed on the
    // inode being exec'd, so running the shim as an interpreter argument would
    // warm nothing.
    return warmExecutable(writeMockBin(path.join(dir, "warm"), "#!/bin/sh\nexit 0\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `bin` once and returns the elapsed milliseconds, for executables the
 *  suite hard-links from the repo rather than building through writeMockBin.
 *  `env`, when given, replaces the environment rather than extending it — callers
 *  use it to make the target exit as early as possible. */
export function warmExecutable(
  bin: string,
  args: string[] = [],
  env?: Record<string, string>,
): number {
  const start = Date.now();
  Bun.spawnSync({ cmd: [bin, ...args], env, stdout: "ignore", stderr: "ignore" });
  return Date.now() - start;
}

/**
 * Installs `script` as an executable at `binPath` and returns `binPath`.
 *
 * `script` is an ordinary shell/bun script including its `#!` line, exactly as it
 * would be written for a directly-executed file; the shebang selects the
 * interpreter as usual.
 */
export function writeMockBin(binPath: string, script: string): string {
  fs.writeFileSync(mockScriptPath(binPath), script);
  // A hard link cannot cross a filesystem boundary (repo and TMPDIR are both on
  // the system volume here, but a test may point elsewhere), and cannot replace
  // an existing file. Copying instead is always correct — it only forfeits the
  // speedup — so fall back rather than fail.
  fs.rmSync(binPath, { force: true });
  try {
    fs.linkSync(SHIM, binPath);
    // The link shares the shim's mode, so a checkout that dropped the exec bit
    // would fail every mock with a bare EACCES. Copy instead and set the bit on
    // the copy: chmod here would edit the committed shim through the link.
    if ((fs.statSync(binPath).mode & 0o111) === 0) throw new Error("shim is not executable");
  } catch {
    fs.rmSync(binPath, { force: true });
    fs.copyFileSync(SHIM, binPath);
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}
