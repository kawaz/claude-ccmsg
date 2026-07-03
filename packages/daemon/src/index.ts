// Daemon entry. Invoked as `ccmsg daemon run [--foreground]` (the cli spawns this
// detached; see packages/cli/src/client.ts). Running directly blocks in the
// current process — the listen socket keeps the event loop alive.
import { startDaemon } from "./server.ts";

const foreground = process.argv.includes("--foreground");
startDaemon({ foreground });
