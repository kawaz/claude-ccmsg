// `ccmsg sidecar` (DR-0035 §3): the child a session's hooks module keeps for
// the session's life. It binds `<sid>.<pid>.sock` and copies every request
// line written there to its standard output, which the module reads.
import { chmodSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { sidecarSocketName } from "@ccmsg/protocol";

/** Where the sidecar's lines go. An error from it is the reader having gone,
 * which ends the sidecar. */
export type Out = (line: string, done: (error?: Error | null) => void) => void;

export interface SidecarOptions {
  readonly dir: string;
  readonly sid: string;
  /** The harness process running the session, which names the socket. */
  readonly pid: number;
  readonly out: Out;
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
 * own: the pid is the run's, so another run's socket has another name, and a
 * file under this one is a sidecar of this run that did not live to remove it. */
export function startSidecar(options: SidecarOptions): Sidecar {
  const socketPath = path.join(options.dir, sidecarSocketName(options.sid, options.pid));
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

  return { path: socketPath, stopped: settled.promise, stop: () => finish("stopped") };
}

function unlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Nothing there, which is the state this is asking for.
  }
}

/** One process as `ps` states it. Named so a test can describe a tree it never
 * has to create. */
export type AskProcess = (pid: number) => { ppid: number; command: string } | undefined;

/** How far up the tree the harness is looked for. The sidecar is started by
 * the harness through the launcher script, which execs; a few levels covers a
 * shell or two in between, and an unbounded walk would reach init on a
 * process that is not below a harness at all. */
const DEPTH = 8;

/** The Claude Code process this command runs under, or undefined.
 *
 * Judged by the basename of argv[0], as session_kill verifies a pid: `claude`
 * with or without a directory. */
export function harnessPid(
  ask: AskProcess = askPs,
  from: number = process.ppid,
): number | undefined {
  let pid = from;
  for (let step = 0; step < DEPTH; step++) {
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    const ancestor = ask(pid);
    if (ancestor === undefined) return undefined;
    const argv0 = ancestor.command.trimStart().split(/\s/, 1)[0] ?? "";
    if (argv0.slice(argv0.lastIndexOf("/") + 1) === "claude") return pid;
    pid = ancestor.ppid;
  }
  return undefined;
}

const askPs: AskProcess = (pid) => {
  try {
    const done = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (done.exitCode !== 0) return undefined;
    const line = done.stdout.toString().trim();
    const at = line.search(/\s/);
    if (at <= 0) return undefined;
    const ppid = Number(line.slice(0, at));
    return Number.isInteger(ppid) ? { ppid, command: line.slice(at + 1).trimStart() } : undefined;
  } catch {
    return undefined;
  }
};
