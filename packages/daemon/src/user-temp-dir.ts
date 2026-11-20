// The TMPDIR a process ccmsg starts for no particular session gets: the daemon
// the CLI spawns (DR-0002 §2) and the launch command the daemon runs (DR-0018
// §3.5). The TMPDIR they would otherwise inherit is the temp place of whoever
// happened to start them — a session's own (`<project>/tmp.local/<sid>/`,
// gone with that session, and out of reach of a session confined to another
// account's repos) — and means
// nothing to a long-lived daemon or to a session not yet started.
//
// The replacement is the OS's per-user temp dir: on macOS the one
// `confstr(_CS_DARWIN_USER_TEMP_DIR)` names, which launchd also hands every
// login process as TMPDIR (owner-only, cleaned by the OS). Other platforms have
// no per-user one, and the variable is left out: the process falls back to
// /tmp as it would in a fresh login.

/** `getconf` is in the base system at this path on macOS. */
const GETCONF = "/usr/bin/getconf";

let cached: { dir: string | undefined } | undefined;

/** The OS's per-user temp dir (macOS, with its trailing `/` as launchd gives
 * it), or undefined where the platform has none or it cannot be read. Read
 * once per process: it is fixed for a user. */
export function userTempDir(): string | undefined {
  if (cached === undefined) cached = { dir: readUserTempDir() };
  return cached.dir;
}

function readUserTempDir(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    // An empty environment: getconf needs none, and the answer must not come
    // from the caller's TMPDIR.
    const run = Bun.spawnSync([GETCONF, "DARWIN_USER_TEMP_DIR"], {
      env: {},
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (run.exitCode !== 0) return undefined;
    const dir = run.stdout.toString().trim();
    return dir.startsWith("/") ? dir : undefined;
  } catch {
    // ENOENT / EACCES on getconf: no per-user dir to give.
    return undefined;
  }
}

/** `env` with its TMPDIR replaced by `tmpdir`, or left out when `tmpdir` is
 * undefined. Unset entries are dropped (a spawn's env takes strings only). */
export function withTmpdir(
  env: Readonly<Record<string, string | undefined>>,
  tmpdir: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === "TMPDIR") continue;
    out[key] = value;
  }
  if (tmpdir !== undefined) out.TMPDIR = tmpdir;
  return out;
}
