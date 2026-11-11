// The child tmp-lookup-monitor.ts starts: every `interval` ms, it times the
// lookup of a name that is not there directly under `dir` (/private/tmp: the
// async stat a daemon's reads make, then a sync one), beside the same lookup
// under `parent` (/private) and under the run's own dir. Each round where one
// took `slow` ms or more goes to `out` as one line, then a summary once its
// stdin closes (the monitor closing it, or the kernel when the test run dies).
//
// Usage: bun tmp-lookup-probe.ts <out> <dir> <parent> <run dir> <interval ms> <slow ms>
//
// A child rather than a timer in the test process: a sync lookup that waits
// would hold the tests up with it.
import * as fs from "node:fs";
import * as path from "node:path";

const [out = "", dir = "", parent = "", runDir = "", intervalArg = "", slowArg = ""] =
  process.argv.slice(2);
const interval = Number(intervalArg);
const slow = Number(slowArg);
const NAME = ".ccmsg-lookup-probe";
const tmpName = path.join(dir, NAME);
const privateName = path.join(parent, NAME);
const runName = path.join(runDir, NAME);

let rounds = 0;
let slowRounds = 0;
const max = { tmpAsync: 0, tmpSync: 0, private: 0, run: 0 };

function timedSync(p: string): number {
  const started = performance.now();
  fs.statSync(p, { throwIfNoEntry: false });
  return performance.now() - started;
}

async function round(): Promise<void> {
  const at = new Date().toISOString();
  const started = performance.now();
  await fs.promises.stat(tmpName).catch(() => undefined);
  const tmpAsync = performance.now() - started;
  const tmpSync = timedSync(tmpName);
  const privateMs = timedSync(privateName);
  const runMs = timedSync(runName);
  rounds += 1;
  max.tmpAsync = Math.max(max.tmpAsync, tmpAsync);
  max.tmpSync = Math.max(max.tmpSync, tmpSync);
  max.private = Math.max(max.private, privateMs);
  max.run = Math.max(max.run, runMs);
  if (Math.max(tmpAsync, tmpSync, privateMs, runMs) < slow) return;
  slowRounds += 1;
  const ms = (n: number): string => `${String(Math.round(n))} ms`;
  fs.appendFileSync(
    out,
    `slow at ${at}: ${dir} ${ms(tmpAsync)} async, ${ms(tmpSync)} sync; ` +
      `${parent} ${ms(privateMs)}; the run dir ${ms(runMs)}\n`,
  );
}

let stopped = false;
const loop = (async () => {
  while (!stopped) {
    await round();
    await Bun.sleep(interval);
  }
})();

for await (const _ of Bun.stdin.stream()) {
  // Nothing is sent; the stream ends when the monitor (or the kernel) closes it.
}
stopped = true;
await loop;
const ms = (n: number): string => `${String(Math.round(n))} ms`;
fs.appendFileSync(
  out,
  `${String(slowRounds)} of ${String(rounds)} rounds took ${String(slow)} ms or more; the longest: ` +
    `${dir} ${ms(max.tmpAsync)} async, ${ms(max.tmpSync)} sync; ${parent} ${ms(max.private)}; ` +
    `the run dir ${ms(max.run)}\n`,
);
