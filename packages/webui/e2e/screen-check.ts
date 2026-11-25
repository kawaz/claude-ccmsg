// The e2e run's one look at the screen. `just e2e` preloads this file, so the
// screen is read once before any test file loads, and the run ends with one
// line naming why and how many describe blocks it left out. Each engine's
// describe block is `describe.skipIf(skipsEngine(engine))` (harness.ts), so
// bun's summary counts what was left out under `skip` as well; bun counts a
// skipped block's beforeAll / afterAll there too, so its number is larger than
// the block's tests.
//
// Off macOS, or when the probe cannot run or its output cannot be read,
// everything runs.
import { afterAll } from "bun:test";
import type { BrowserType } from "playwright";
import {
  readScreen,
  SCREEN_PROBE,
  skippedLine,
  skipsEngine as skipsOn,
  type Screen,
} from "./screen.ts";

function probeScreen(): Screen {
  if (process.platform !== "darwin") return "unknown";
  try {
    const run = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", SCREEN_PROBE], {
      stderr: "ignore",
    });
    return run.success ? readScreen(run.stdout.toString()) : "unknown";
  } catch {
    // osascript is not there.
    return "unknown";
  }
}

const screen = probeScreen();
let skippedGroups = 0;

/** Whether `engine`'s describe block is left out of this run. Call once per
 * block. */
export function skipsEngine(engine: BrowserType): boolean {
  const skips = skipsOn(screen, engine.name());
  if (skips) skippedGroups += 1;
  return skips;
}

// A top-level afterAll of a preloaded file runs once, after every test file.
afterAll(() => {
  if (skippedGroups > 0) console.error(skippedLine(screen, skippedGroups));
});
