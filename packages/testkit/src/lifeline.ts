// The test run's end of the lifeline its daemons and sidecars hold
// (packages/daemon/src/test-lifeline.ts).
//
// A daemon or sidecar a test spawns is not tied to the test process by
// anything bun offers: `bun test` fires no `exit` / `beforeExit` event, so a
// registry killed from there never runs, and a daemon the CLI spawns (or a
// sidecar started behind a shell pipe) is a grandchild that bun does not know
// about. Each one that a test fails to stop — a setup that throws after the
// spawn, a test that times out before its `finally` — would outlive the run.
//
// The lifeline is a UNIX socket this process listens on; its path goes to every
// one of them through CCMSG_TEST_LIFELINE in the environment. Each holds a
// connection and leaves when it closes, which the kernel does when this process
// exits however it exits. One asked to stop lets go first, so a connection
// still open after the last test names a process no test stopped.
import type { Socket } from "bun";

export interface Lifeline {
  /** The socket the holders connect to: the value for CCMSG_TEST_LIFELINE. */
  path: string;
  /** What each holder still on the line said it is: a daemon's state dir, a
   * sidecar's socket. */
  holders(): string[];
  /** Drop every holder (each one leaves) and stop listening. */
  close(): void;
}

/** Listen for holders on the UNIX socket at `sockPath`. */
export function openLifeline(sockPath: string): Lifeline {
  // What each holder has said so far: what it is, once the line is whole.
  const said = new Map<Socket, string>();
  const listener = Bun.listen({
    unix: sockPath,
    socket: {
      open(socket) {
        said.set(socket, "");
      },
      data(socket, chunk) {
        said.set(socket, (said.get(socket) ?? "") + chunk.toString());
      },
      close(socket) {
        said.delete(socket);
      },
      error(socket) {
        said.delete(socket);
      },
    },
  });
  return {
    path: sockPath,
    holders: () => [...said.values()].map((text) => text.split("\n")[0] ?? ""),
    close: () => listener.stop(true),
  };
}
