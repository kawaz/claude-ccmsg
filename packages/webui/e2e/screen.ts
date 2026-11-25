// What the e2e run reads of the Mac's screen, and which engines it does not
// run while the screen is off or locked.
//
// While the screen is off or locked, webkit's clicks do not reach the page:
// playwright waits on "`<html>` intercepts pointer events" until the test
// times out (docs/findings/2026-11-22-webkit-e2e-click-after-display-sleep.md,
// docs/TESTING.md). chromium's were seen to pass in that state. The product is
// not at fault, so the run leaves those tests out and says so instead of
// failing. This file only reads; screen-check.ts asks once per run.
import * as v from "valibot";
import { jsonText, parseWith } from "@ccmsg/protocol";

/** A JavaScript for Automation script (`osascript -l JavaScript -e`) printing
 * one line of JSON: `asleep` is `CGDisplayIsAsleep` of the main display (a
 * `boolean_t`, 0 while it is drawable), and `session` is the window server
 * session's dictionary (`CGSessionCopyCurrentDictionary`). */
export const SCREEN_PROBE = [
  'ObjC.import("CoreGraphics");',
  "JSON.stringify({",
  "  asleep: $.CGDisplayIsAsleep($.CGMainDisplayID()),",
  "  session: ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary())),",
  "});",
].join("\n");

/** The probe's line. `CGSSessionScreenIsLocked` is not in Apple's list of the
 * session's keys; it is there, true, while the screen is locked, and absent
 * otherwise. The rest of the session (user, ids) is let through unread. */
const ScreenProbeSchema = jsonText(
  v.object({
    asleep: v.number(),
    session: v.looseObject({ CGSSessionScreenIsLocked: v.optional(v.boolean()) }),
  }),
);

/** The screen as the probe saw it: `unknown` when its output could not be
 * read. */
export type Screen = "on" | "off" | "locked" | "unknown";

/** Reads the probe's output. */
export function readScreen(output: string): Screen {
  const read = parseWith(ScreenProbeSchema, output);
  if (!read.ok) return "unknown";
  if (read.value.asleep !== 0) return "off";
  if (read.value.session.CGSSessionScreenIsLocked === true) return "locked";
  return "on";
}

/** The engines not run while the screen is off or locked: only webkit was
 * seen failing. */
const ENGINES_NEEDING_SCREEN: readonly string[] = ["webkit"];

/** Whether the run leaves out `engine`'s tests on this `screen`. A screen that
 * could not be read runs everything. */
export function skipsEngine(screen: Screen, engine: string): boolean {
  return (screen === "off" || screen === "locked") && ENGINES_NEEDING_SCREEN.includes(engine);
}

/** The line the run ends with when it left `groups` describe blocks out. */
export function skippedLine(screen: Screen, groups: number): string {
  const why = screen === "off" ? "画面が消えている" : "画面がロックされている";
  return `${why}ので ${ENGINES_NEEDING_SCREEN.join(" / ")} の e2e の ${String(groups)} 組 (describe) を流していない`;
}
