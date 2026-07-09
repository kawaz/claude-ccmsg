// Daemon composition root: wires the webui app into the daemon's HTTP fallback.
// Both spawn paths (`ccmsg daemon run` in the cli and the direct daemon entry)
// call this instead of startDaemon so the wiring exists in exactly one place,
// while server.ts / http.ts stay UI-agnostic (DR-0004 §4).
import { createWebuiApp } from "@ccmsg/webui";
import { startDaemon, type StartOptions } from "./server.ts";

export function runDaemon(opts: Omit<StartOptions, "fallback"> = {}): void {
  const webui = createWebuiApp();
  startDaemon({ ...opts, fallback: (req) => webui.fetch(req) });
}
