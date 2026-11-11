// Daemon composition root: wires the webui app into the daemon's HTTP fallback.
// Both spawn paths (`ccmsg daemon run` in the cli and the direct daemon entry)
// call this instead of startDaemon so the wiring exists in exactly one place,
// while server.ts / http.ts stay UI-agnostic (DR-0004 §4): the daemon calls
// the app's prepare once it listens for HTTP, and the app knows what that
// starts (the webui's bundle).
import { createWebuiApp } from "@ccmsg/webui";
import { startDaemon, type StartOptions } from "./server.ts";

export async function runDaemon(opts: Omit<StartOptions, "fallback"> = {}): Promise<void> {
  await startDaemon({ ...opts, fallback: createWebuiApp() });
}
