// A test's look at whether this daemon's async file system operations wait
// while the process runs (CCMSG_TEST_FS_PROBE). Never on unless a test sets it.
//
// On macOS in CI, a daemon a test had just started once took 1–2 s over one
// async stat or readFile (its hello deriving a location, a send reading a
// state file) while its event loop turned and the same lookup in another
// process did not wait. Bun runs node:fs's async operations on one pool of
// threads per process, as many as the cores (UV_THREADPOOL_SIZE overrides),
// so what waits may be the pool rather than the file system. The probe
// stats a name that is not there in the daemon's state dir every round, async
// then sync, from the daemon's start for as long as the env says, and logs
// each round where the async one took the slow time or more: when the sync
// one right after it did not, it was the async path that waited.
import * as fs from "node:fs";
import * as path from "node:path";

/** `<duration ms>:<slow ms>`, the value CCMSG_TEST_FS_PROBE takes. */
export interface FsProbeSpec {
  durationMs: number;
  slowMs: number;
}

/** CCMSG_TEST_FS_PROBE read, or undefined when it is not set or does not read
 * as `<duration ms>:<slow ms>`. */
export function fsProbeSpec(raw: string | undefined): FsProbeSpec | undefined {
  const m = raw?.match(/^(\d+):(\d+)$/);
  if (m === null || m === undefined) return undefined;
  return { durationMs: Number(m[1]), slowMs: Number(m[2]) };
}

/** Each round's spacing. */
const ROUND_MS = 20;

/** Probe `dir` for `spec.durationMs`, or until `stopped()` says so, telling
 * `warn` each slow round and `info` a summary at the end. Resolves once the
 * probe is over. The first line names the size of bun's pool. */
export async function probeFs(
  dir: string,
  spec: FsProbeSpec,
  log: { info(msg: string): void; warn(msg: string): void },
  stopped: () => boolean,
): Promise<void> {
  const name = path.join(dir, ".fs-probe");
  const ms = (n: number): string => `${String(Math.round(n))} ms`;
  const started = performance.now();
  // The pool's size, as bun takes it: UV_THREADPOOL_SIZE, else the cores
  // (navigator.hardwareConcurrency is the same count).
  const pool =
    process.env.UV_THREADPOOL_SIZE ?? `${String(navigator.hardwareConcurrency)} (the cores)`;
  log.info(
    `fs probe: for ${ms(spec.durationMs)} from the start, a round each ${ms(ROUND_MS)}, ` +
      `slow at ${ms(spec.slowMs)}; pool threads ${pool}`,
  );
  let rounds = 0;
  let longestAsync = 0;
  let longestSync = 0;
  while (performance.now() - started < spec.durationMs && !stopped()) {
    const at = performance.now();
    await fs.promises.stat(name).catch(() => undefined);
    const asyncMs = performance.now() - at;
    const syncAt = performance.now();
    fs.statSync(name, { throwIfNoEntry: false });
    const syncMs = performance.now() - syncAt;
    rounds += 1;
    longestAsync = Math.max(longestAsync, asyncMs);
    longestSync = Math.max(longestSync, syncMs);
    if (asyncMs >= spec.slowMs) {
      log.warn(
        `fs probe: an async stat of ${name} took ${ms(asyncMs)} (a sync one right after, ${ms(syncMs)}), ` +
          `${ms(at - started)} into the probe`,
      );
    }
    await Bun.sleep(ROUND_MS);
  }
  log.info(
    `fs probe: ${String(rounds)} rounds over ${ms(performance.now() - started)}; ` +
      `the longest async stat ${ms(longestAsync)}, sync ${ms(longestSync)}`,
  );
}
