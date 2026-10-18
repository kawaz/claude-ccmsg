// A test run's hold on the daemons and sidecars it spawns:
// `CCMSG_TEST_LIFELINE` names a UNIX socket the test process listens on
// (packages/testkit/src/lifeline.ts), and a daemon or sidecar started with it
// connects there and leaves when that connection ends. The test process holding the socket is the only writer, so
// its exit — a finished run, a failed one, Ctrl-C, SIGKILL — closes the
// connection in the kernel and every daemon it spawned follows, including the
// ones a test never stopped and the ones a CLI it ran spawned detached.
//
// Each says what it is on connect — a daemon its state dir, a sidecar its
// socket — so the test run can name one a test left running. It lets go of the
// line itself when it leaves for any other reason: the line still open when
// the run ends is then a process nothing asked to stop.
//
// One started without the variable (every real one) holds nothing.
import type { Socket } from "bun";

export interface TestLifeline {
  /** Let go of the line without the loss being reported: the holder is
   * leaving on its own. */
  release(): void;
}

/** Hold the lifeline at `sockPath`, introducing the holder as `label`.
 * `onLost` runs once when the holder goes away, or at once when it is already
 * gone. */
export async function holdTestLifeline(
  sockPath: string,
  label: string,
  onLost: () => void,
): Promise<TestLifeline> {
  let released = false;
  const lost = (): void => {
    if (released) return;
    released = true;
    onLost();
  };
  let socket: Socket;
  try {
    socket = await Bun.connect({
      unix: sockPath,
      socket: { data() {}, close: lost, error: lost },
    });
  } catch {
    lost();
    return { release() {} };
  }
  socket.write(`${label}\n`);
  return {
    release() {
      if (released) return;
      released = true;
      socket.end();
    },
  };
}
