// Does this host's `claude` accept `--resume-session-at`?
//
// A fork launch resumes a session and truncates the loaded conversation at a
// chosen record, which only `--resume-session-at=<uuid>` can do. That option is
// real but undocumented — `claude --help` does not list it (verified on
// 2.1.227) — so the webui cannot decide whether to offer a fork affordance by
// reading help text. It has to ask the binary.
//
// The probe runs a launch that is guaranteed to fail before doing any work and
// reads *how* it failed:
//
//   claude --resume-session-at=<zero uuid> --resume <zero uuid> --print x
//
// Option parsing happens first, so an unsupported build dies with commander's
// `error: unknown option '--resume-session-at'` (~150 ms). A supported build
// gets past parsing and dies at session lookup instead ("No conversation found
// with session ID: …", ~1.7 s) — it never reaches the API, and the all-zero
// session id cannot resolve to a real transcript, so nothing is resumed,
// forked or written. Measured matrix (2026-08-11, claude 2.1.227): the
// unknown-option wording appeared only for options the binary does not know
// (`--nope-not-real`), and not for `--resume-session-at`, `--resume-drops-turn`
// or `--fork-session`.
import * as os from "node:os";

/** All-zero UUID: syntactically a session id, never an existing session. */
const NONEXISTENT_SESSION_ID = "00000000-0000-0000-0000-000000000000";

/** The probe must outlive a cold `claude` start (~2 s measured) without
 * holding daemon startup hostage if the binary hangs. */
const PROBE_TIMEOUT_MS = 15_000;

/** Commander's rejection wording for an option the binary does not define.
 * Matching the option name too keeps an unrelated unknown option (a future
 * rename of `--print`, say) from being read as "fork unsupported". */
const UNKNOWN_OPTION_MARKER = /unknown option '?-{0,2}resume-session-at/;

export interface ForkProbeResult {
  available: boolean;
  /** Why the answer is what it is, for the daemon log. Never surfaced on the
   * wire — hello carries the boolean only. */
  detail: string;
}

/** Decide the probe's verdict from how the run ended. Split out from the spawn
 * so the wording match is exercised without a `claude` on the test host. */
export function interpretForkProbe(stderr: string, signalCode: string | null): ForkProbeResult {
  if (UNKNOWN_OPTION_MARKER.test(stderr)) {
    return { available: false, detail: "claude rejects --resume-session-at as an unknown option" };
  }
  if (signalCode !== null) {
    return { available: false, detail: `probe killed by ${signalCode} (timeout?)` };
  }
  return { available: true, detail: "claude accepts --resume-session-at" };
}

/** Run the probe once. Never throws: any failure to even start `claude` is a
 * "no" (a host without a runnable claude cannot launch a fork either). `env`
 * is the environment the probe runs under — the daemon passes its own, tests
 * point PATH at a stub. */
export async function probeForkSupport(
  env: Record<string, string | undefined> = process.env,
): Promise<ForkProbeResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [
        "claude",
        `--resume-session-at=${NONEXISTENT_SESSION_ID}`,
        "--resume",
        NONEXISTENT_SESSION_ID,
        "--print",
        "x",
      ],
      // A throwaway cwd and a closed stdin: the probe must not read the
      // daemon's terminal, and must not look like a session started in any
      // project directory.
      { cwd: os.tmpdir(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch (e) {
    return { available: false, detail: `could not run claude: ${String(e)}` };
  }

  const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);
  try {
    const [stderr] = await Promise.all([
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return interpretForkProbe(stderr, proc.signalCode);
  } catch (e) {
    return { available: false, detail: `probe failed: ${String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
