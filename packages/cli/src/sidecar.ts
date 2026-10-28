// `ccmsg sidecar` (DR-0035 §3): the child a session's hooks module keeps for
// the session's life. It binds `<sid>.<run id>.sock`, copies every request
// line written there to its standard output, which the module reads, and names
// the run to the daemon on a connection it keeps open, so the daemon knows the
// run is there for exactly as long as that connection is.
import { chmodSync, fstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { type Identity, type Paths, sidecarSocketName } from "@ccmsg/protocol";
import { type Client, nameRunNoSpawn, type RunName } from "./client.ts";

/** Where the sidecar's lines go. An error from it is the reader having gone,
 * which ends the sidecar. */
export type Out = (line: string, done: (error?: Error | null) => void) => void;

export interface SidecarOptions {
  readonly dir: string;
  readonly sid: string;
  /** The run (SidecarRunIdSchema), which names the socket. */
  readonly runId: string;
  readonly out: Out;
  /** Settles when the reader closes its end of `out`: the reader gone, as a
   * failing write says, and the only sign of it while nothing is written. */
  readonly outClosed?: Promise<void>;
}

/** Why a sidecar stopped: asked to by whoever started it, or its reader gone. */
export type Stopped = "stopped" | "reader_gone";

export interface Sidecar {
  readonly path: string;
  /** Settles once, when the sidecar has let go of its socket. */
  readonly stopped: Promise<Stopped>;
  stop(): void;
}

/** Bind the run's socket and copy every line written to it onto `out`.
 *
 * Nothing here reads what a line says. The daemon that writes and the module
 * that reads agree on the requests between themselves; a sidecar that parsed
 * them would need changing whenever they add an op, and it is a process
 * started once per session and kept for its life. Nothing is answered on the
 * connection either: a line written is a line taken, and the module's reply
 * goes back by `ccmsg sidecar reply`.
 *
 * The path is unlinked before binding because whatever is there is this run's
 * own: the run id is the run's, so another run's socket has another name, and
 * a file under this one is a sidecar of this run that did not live to remove
 * it. */
export function startSidecar(options: SidecarOptions): Sidecar {
  const socketPath = path.join(options.dir, sidecarSocketName(options.sid, options.runId));
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  // Stated rather than left to the umask or to whoever made the directory:
  // what is written here reaches a session as if a person typed it.
  chmodSync(options.dir, 0o700);
  unlink(socketPath);

  const settled = Promise.withResolvers<Stopped>();
  // One streaming decoder per connection: a write may end inside a multi-byte
  // character, and decoding each chunk on its own would turn both halves into
  // replacement characters.
  const buffers = new Map<object, { decoder: TextDecoder; rest: string }>();
  let finished = false;

  const emit = (line: string): void => {
    if (finished || line.trim() === "") return;
    options.out(`${line}\n`, (error) => {
      if (error !== undefined && error !== null) finish("reader_gone");
    });
  };

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data: (socket, chunk) => {
        const buffer = buffers.get(socket) ?? { decoder: new TextDecoder(), rest: "" };
        buffers.set(socket, buffer);
        const parts = (buffer.rest + buffer.decoder.decode(chunk, { stream: true })).split("\n");
        buffer.rest = parts.pop() ?? "";
        for (const line of parts) emit(line);
      },
      open: () => {},
      // A writer that closed without a last newline still ended its line.
      close: (socket) => {
        const buffer = buffers.get(socket);
        buffers.delete(socket);
        if (buffer !== undefined) emit(buffer.rest + buffer.decoder.decode());
      },
      error: () => {},
    },
  });
  chmodSync(socketPath, 0o600);
  // Which file is ours, so leaving removes this socket and not one a later
  // sidecar of the same run has bound under the same name meanwhile.
  const bound = statSync(socketPath).ino;

  function finish(why: Stopped): void {
    if (finished) return;
    finished = true;
    // Let go of rather than stopped: Bun unlinks the path it listened on when
    // it stops, by name, and that name may be a later sidecar's socket by now.
    // Unreferenced, it no longer holds the process; the name is removed here
    // only while it is still ours.
    server.unref();
    try {
      if (statSync(socketPath).ino === bound) unlink(socketPath);
    } catch {
      // Already gone.
    }
    settled.resolve(why);
  }

  void options.outClosed?.then(() => finish("reader_gone"));

  return { path: socketPath, stopped: settled.promise, stop: () => finish("stopped") };
}

/** Settles when the process at the other end of the socket `fd` has closed
 * it, or `undefined` when `fd` is not a socket.
 *
 * A hooks module's spawn gives its child a socket for its output (Claude Code
 * 2.1.302), and the module only reads from it. Reading this end therefore
 * gets nothing until the module's process is gone, and then the end of the
 * stream: the harness's death, told the moment it happens, whether or not
 * anything is ever written again. Any other `fd` is left alone: a terminal's
 * input is the person's, and the write end of a pipe cannot be read. */
export function socketPeerClosed(fd: number): Promise<void> | undefined {
  return fstatSync(fd).isSocket() ? streamEnded(Bun.file(fd).stream()) : undefined;
}

/** Settles when `stream` ends, whatever it carried before. A stream that
 * fails has ended too: a socket that cannot be read any more has no one at
 * the other end. */
export async function streamEnded(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // The reader writes nothing back; whatever does come is not news.
    }
  } catch {
    // Ended by failing.
  }
}

function unlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Nothing there, which is the state this is asking for.
  }
}

/** Waits between attempts to reach a daemon that is not listening: these in
 * turn, then NAME_RETRY_MAX_MS for as long as the sidecar lives. */
const NAME_RETRY_MS = [250, 500, 1000, 2000, 4000] as const;
const NAME_RETRY_MAX_MS = 5000;

export interface KeepNamedOptions {
  readonly paths: Paths;
  readonly identity: Identity;
  readonly name: RunName;
  /** Settles when the sidecar has let go of its socket: the run is named no
   * more, and the connection naming it is closed. */
  readonly stopped: Promise<unknown>;
  readonly log: (line: string) => void;
  /** Settles `ms` after it is called; the timer by default. A test holds it
   * to start the next daemon before the next attempt, rather than wait. */
  readonly wait?: (ms: number) => Promise<void>;
}

function timer(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep the run named to the daemon for as long as the sidecar lives: name it
 * to the daemon listening now, and once that connection closes (the daemon
 * stopped, restarted, or was replaced by a newer one), to whichever daemon
 * listens next. The daemon counts the run as live while the connection is
 * open, so closing it is how the run's end reaches the daemon.
 *
 * No daemon is started: one the person stopped stays stopped, and the
 * session's own start brings one up (`sidecar begin`). Until one listens, each
 * attempt is a real connect, spaced as NAME_RETRY_MS says — nothing would say
 * when a daemon starts listening other than trying.
 *
 * Design rationale: retrying on a timer rather than waiting on an event. The
 * one signal of a daemon starting to listen is its socket appearing, and a
 * watch on the state dir is what this sidecar exists to stop depending on
 * (FSEvents can deliver late or not at all). */
export async function keepNamed(options: KeepNamedOptions): Promise<void> {
  const STOPPED = Symbol("stopped");
  const stopped = options.stopped.then((): typeof STOPPED => STOPPED);
  let attempt = 0;
  let client: Client | null = null;
  try {
    for (;;) {
      const naming = nameRunNoSpawn(options.paths, options.identity, options.name);
      const named = await Promise.race([naming, stopped]);
      if (named === STOPPED) {
        void naming.then((late) => late?.close());
        return;
      }
      if (named !== null) {
        client = named;
        attempt = 0;
        options.log(`named ${options.name.runId} to ${options.paths.sock}`);
        if ((await Promise.race([untilClosed(named), stopped])) === STOPPED) return;
        client = null;
        options.log(`lost ${options.paths.sock}; naming the run again once a daemon listens`);
        continue;
      }
      const ms = NAME_RETRY_MS[attempt] ?? NAME_RETRY_MAX_MS;
      attempt++;
      if ((await Promise.race([(options.wait ?? timer)(ms), stopped])) === STOPPED) return;
    }
  } finally {
    client?.close();
  }
}

/** Settles when the daemon closes the connection. Nothing is pushed to a
 * connection that only named a run but the daemon's going (`restarting`),
 * which is read past like anything else. */
async function untilClosed(client: Client): Promise<void> {
  while ((await client.readLine()) !== null) {
    // read past
  }
}
