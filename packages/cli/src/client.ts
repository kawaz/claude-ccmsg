// UDS client + ensure-daemon (DR-0002 §2/§4/§5).
//
// ensure-daemon path: connect -> (fail) spawn -> backoff-retry connect -> hello.
// If the running daemon's version is OLDER than ours, shut it down and re-spawn
// the current one (client-driven upgrade, DR-0002 §4, newer-wins policy per
// docs/issue/2026-07-10-daemon-version-flapping-on-gradual-rollout.md: a
// same-or-newer daemon is left alone so old and new clients don't fight over
// which version should run during a gradual plugin rollout).
import * as fs from "node:fs";
import type { Socket } from "bun";
import {
  compareVersions,
  PROTOCOL_VERSION,
  readDaemonFrame,
  VERSION,
  type DaemonFrame,
  type Identity,
  type Paths,
  type ReplyOf,
  type RequestInput,
  type SessionFacts,
} from "@ccmsg/protocol";

type ReplyFrame = Extract<DaemonFrame, { kind: "reply" }>;

/** A line the daemon wrote that is not the reply to a request of this client
 * (a subscribed connection's pushes and delivered events): the line as it
 * came, and what it reads as. */
export interface StreamLine {
  readonly line: string;
  readonly frame: DaemonFrame;
}

export class Client {
  private socket: Socket | undefined;
  private decoder = new TextDecoder();
  private buf = "";
  private lines: StreamLine[] = [];
  private waiters: Array<(line: StreamLine | null) => void> = [];
  private ended = false;
  /** request_ids only have to be unique among this connection's in-flight
   * requests, so a counter is enough. */
  private nextRequestId = 0;
  /** In-flight `request` calls, keyed by the request_id each is waiting for. */
  private pendingReplies = new Map<string, (frame: ReplyFrame | null) => void>();
  /** Lines written but not yet taken by the socket, oldest first; the head
   * may be a line's remainder. Bun's `write` takes what the socket has room
   * for and keeps nothing, so a request bigger than that (a long message
   * body) is finished on `drain`, in order. One entry per line, so adding a
   * line never copies the ones before it. */
  private unsent: Uint8Array[] = [];
  /** `close` was asked for while bytes were still unsent: end once they go. */
  private closing = false;

  static async connect(sockPath: string): Promise<Client> {
    const client = new Client();
    const socket = await Bun.connect({
      unix: sockPath,
      socket: {
        data(_s, chunk) {
          client.onData(chunk);
        },
        drain() {
          client.flush();
        },
        close() {
          client.onClose();
        },
        error() {
          client.onClose();
        },
      },
    });
    client.socket = socket;
    return client;
  }

  /** Each line is read once, by the wire's frame schema: a reply goes to the
   * request waiting for it, anything else joins the readable stream. */
  private onData(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const frame = readDaemonFrame(line);
      if (frame.kind === "reply" && this.settle(frame)) continue;
      this.lines.push({ line, frame });
    }
    this.drain();
  }

  /** Hand a reply to the request it answers; false when no request waits.
   *
   * A reply with no `request_id` is handed to the oldest in-flight request:
   * that is the refusal of a line whose frame the daemon could not read (it
   * names none), or a daemon older than the correlation envelope, and
   * completing a hello against one is how `ensureDaemon` discovers the
   * version it has to replace. */
  private settle(frame: ReplyFrame): boolean {
    const key = frame.requestId ?? this.pendingReplies.keys().next().value;
    if (key === undefined) return false;
    const resolve = this.pendingReplies.get(key);
    if (resolve === undefined) return false;
    this.pendingReplies.delete(key);
    resolve(frame);
    return true;
  }

  /** Hand buffered lines to whoever is waiting, oldest first. */
  private drain(): void {
    for (;;) {
      if (this.waiters.length === 0 || this.lines.length === 0) return;
      const waiter = this.waiters.shift();
      const line = this.lines.shift();
      if (waiter !== undefined && line !== undefined) waiter(line);
    }
  }

  private onClose(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    for (const resolve of this.pendingReplies.values()) resolve(null);
    this.pendingReplies.clear();
  }

  /** The next line that is not a reply to this client's requests, or null
   * once the connection has closed. */
  readLine(): Promise<StreamLine | null> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.ended) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }

  private writeLine(line: string): void {
    // Behind lines still waiting, so lines never interleave.
    this.unsent.push(new TextEncoder().encode(`${line}\n`));
    this.flush();
  }

  /** Hand the socket as much of the unsent lines as it takes now; the rest
   * waits for the next `drain`. A socket that takes nothing more because it
   * is closed (`write` answers -1) settles everyone waiting at once: no close
   * event may follow to do it. */
  private flush(): void {
    const socket = this.socket;
    if (socket === undefined) return;
    for (let head = this.unsent[0]; head !== undefined; head = this.unsent[0]) {
      let taken: number;
      try {
        taken = socket.write(head);
      } catch {
        taken = -1;
      }
      if (taken < 0) {
        this.unsent = [];
        this.onClose();
        return;
      }
      if (taken < head.length) {
        this.unsent[0] = head.subarray(taken);
        break;
      }
      this.unsent.shift();
    }
    if (this.closing && this.unsent.length === 0) this.end();
  }

  /** Send one request and wait for the reply carrying its `request_id`, read
   * as the answer to the request's op: its success reply or an error. The
   * daemon answers a connection's requests concurrently, so replies may come
   * back in any order and several requests may be outstanding at once;
   * anything that is not a reply (a subscribed connection's stream events)
   * stays in the readable stream for `readLine`. A reply that is not its op's
   * answer is an error thrown, like a connection that closes first. */
  async request<B extends RequestInput>(body: B): Promise<ReplyOf<B["op"]>> {
    const rid = `r${++this.nextRequestId}`;
    // A closed connection gets no close event again to settle the wait.
    if (this.ended) throw new Error("connection closed before response");
    const frame = await new Promise<ReplyFrame | null>((resolve) => {
      this.pendingReplies.set(rid, resolve);
      this.writeLine(JSON.stringify({ ...body, request_id: rid }));
    });
    if (frame === null) throw new Error("connection closed before response");
    const read = frame.reply<B["op"]>(body.op);
    if (!read.ok) {
      throw new Error(
        `the daemon's reply to ${body.op} is not its answer: ${read.failure.summary}`,
      );
    }
    return read.value;
  }

  /** End the connection once everything written has gone out. */
  close(): void {
    this.closing = true;
    if (this.unsent.length === 0) this.end();
  }

  private end(): void {
    try {
      this.socket?.end();
    } catch {
      // already closing
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function tryConnect(sockPath: string): Promise<Client | null> {
  try {
    return await Client.connect(sockPath);
  } catch {
    return null;
  }
}

/** Command to (re-)invoke ourselves as the daemon. Handles both source and compiled forms. */
function daemonSpawnCmd(): string[] {
  const exec = process.execPath;
  // Design rationale: `CCMSG_DAEMON_ENTRY` is a test-only seam. When running
  // `ensureDaemon` from `bun test`, `process.argv[1]` points at the test runner
  // rather than the cli entry, so the auto-detected relaunch command wouldn't
  // land on `daemon run`. Setting this env var lets the automated tests (see
  // packages/cli/test/version-mismatch.test.ts) point spawn at the daemon
  // entry file directly. Production callers always relaunch via the cli
  // entry (path detected below) and never set this. Env-var form matches the
  // existing CCMSG_* overrides; adding a parameter would leak a test-only
  // knob into `ensureDaemon`'s public signature.
  const override = process.env.CCMSG_DAEMON_ENTRY;
  if (override && override !== "") return [exec, override, "daemon", "run"];
  const script = process.argv[1];
  const execBase = exec.split("/").pop() ?? exec;
  if ((execBase === "bun" || execBase === "bun-debug") && script) {
    return [exec, script, "daemon", "run"];
  }
  // compiled self-contained binary: no script arg
  return [exec, "daemon", "run"];
}

function spawnDaemon(): Bun.Subprocess<"ignore", "ignore", "ignore"> {
  const cmd = daemonSpawnCmd();
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
    // Without this, the child inherits the spawning process's process group
    // (verified empirically: Bun.spawn does not setpgid by default). The
    // daemon is meant to outlive whichever session happened to spawn it —
    // but a session torn down by its terminal/PTY manager (hyoui, tmux, a
    // closed terminal window) can have its whole process group signalled,
    // and the daemon would die along with it despite `unref()` (unref only
    // keeps Bun's own event loop from waiting on the child, it does nothing
    // about signal delivery or group membership). `detached: true` makes
    // the daemon its own process group leader (pgid == pid), so a group
    // signal aimed at the originating session's terminal never reaches it.
    // The daemon still exits cleanly on a real SIGTERM/SIGINT sent to it
    // directly (system shutdown, `daemon stop`) via its own handlers.
    detached: true,
  });
  proc.unref();
  return proc;
}

/** daemon.log's size now: where the lines of a daemon about to be spawned
 * begin. */
function logSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The daemon.log lines written from byte `from` on — the whole log when it
 * has rotated since. */
function logSince(file: string, from: number): string {
  let log: Buffer;
  try {
    log = fs.readFileSync(file);
  } catch {
    return "";
  }
  return log
    .subarray(from <= log.length ? from : 0)
    .toString("utf8")
    .trimEnd();
}

// Exponential backoff schedule for reconnecting to a freshly spawned daemon.
// This is connection retry (each attempt is a real connect, not a blind sleep):
// the daemon usually answers within the first few hundred ms.
export const SPAWN_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 400, 600, 800, 1000, 1500, 2000, 3000];

/** Connect, spawning the daemon when none answers. A spawned daemon that
 * exits with a failure before it answers (a configuration that does not read,
 * an invalid CCMSG_HTTP_ALLOW) is reported with the lines it logged, since its
 * own stderr goes nowhere. One that exits cleanly lost the startup lock to
 * another daemon coming up, which the retries then reach. */
async function connectWithSpawn(paths: Paths): Promise<Client> {
  const c = await tryConnect(paths.sock);
  if (c) return c;
  const logFrom = logSize(paths.log);
  const spawned: { exitCode: number | null } = { exitCode: null };
  void spawnDaemon().exited.then((code) => {
    spawned.exitCode = code;
  });
  for (const delay of SPAWN_RETRY_DELAYS_MS) {
    await sleep(delay);
    const c2 = await tryConnect(paths.sock);
    if (c2) return c2;
    if (spawned.exitCode !== null && spawned.exitCode !== 0) {
      throw new Error(
        `daemon exited with code ${spawned.exitCode} while starting; ${paths.log} says:\n` +
          logSince(paths.log, logFrom),
      );
    }
  }
  throw new Error("ccmsg: daemon did not become reachable after spawn");
}

async function waitDaemonGone(sockPath: string): Promise<void> {
  for (const delay of [10, 25, 50, 100, 200, 400, 800, 1500, 3000]) {
    const c = await tryConnect(sockPath);
    if (!c) return; // connect refused => daemon gone
    c.close();
    await sleep(delay);
  }
  // give up waiting; the re-spawn below will unlink a stale socket anyway
}

/** What every hello says about the process sending it, regardless of role: the
 * build, so a stale client can be named, and the wire generation, so a daemon
 * that no longer speaks it refuses instead of half-serving it. */
const clientBuild = { client_version: VERSION, protocol: PROTOCOL_VERSION } as const;

export function helloRequest(identity: Identity): Extract<RequestInput, { op: "hello" }> {
  if (identity.role === "user") return { op: "hello", role: "user", ...clientBuild };
  return {
    op: "hello",
    role: "session",
    ...clientBuild,
    sid: identity.sid,
    repo: identity.repo,
    ws: identity.ws,
    cwd: identity.cwd,
    ...(identity.transcript_path ? { transcript_path: identity.transcript_path } : {}),
    ...(identity.repo_root ? { repo_root: identity.repo_root } : {}),
    ...(identity.branch ? { branch: identity.branch } : {}),
    ...(identity.config_dir ? { config_dir: identity.config_dir } : {}),
  };
}

/** Connect (spawning + upgrading the daemon as needed) and complete the hello handshake. */
export async function ensureDaemon(paths: Paths, identity: Identity): Promise<Client> {
  let client = await connectWithSpawn(paths);
  let hello = await client.request(helloRequest(identity));
  if (hello.ok && compareVersions(VERSION, hello.version) > 0) {
    // we are strictly newer than the running daemon: shut it down and spawn ours.
    // A same-or-newer daemon is left running (newer-wins, see file header).
    try {
      await client.request({ op: "shutdown", reason: "upgrade" });
    } catch {
      // it may close the connection without replying; that's fine
    }
    client.close();
    await waitDaemonGone(paths.sock);
    client = await connectWithSpawn(paths);
    hello = await client.request(helloRequest(identity));
  }
  if (!hello.ok) throw new Error("ccmsg: hello handshake failed");
  return client;
}

/** Connect only if a daemon is already running (does not spawn). Used by `daemon stop`/`status`. */
export async function connectIfRunning(paths: Paths): Promise<Client | null> {
  return tryConnect(paths.sock);
}

/**
 * Reconnect + re-subscribe **without spawning** the daemon (subscribe transparent
 * reconnect path; see docs/issue/2026-07-10-subscribe-daemon-restart-transparent-reconnect.md).
 *
 * Design rationale:
 * - No-spawn: an intentional `ccmsg daemon stop` must not be resurrected by a
 *   long-lived subscribe. The initial subscribe path (via `ensureDaemon`) already
 *   handles spawn; reconnect is strictly "attach if a daemon is available".
 * - No upgrade dance: the initial `ensureDaemon` above handles version mismatch
 *   (newer-wins). Reconnect just re-attaches to whatever daemon is now listening —
 *   an old-client reconnect to a newer daemon must NOT retrigger the upgrade path
 *   (would flap during gradual rollout, cf. DR-0002 §4 追補).
 * - Never fatal: reconnect keeps retrying and never exits the subscribe, however
 *   old this CLI gets — see DR-0002 §4 設計意図. A subscribe is meant to outlive
 *   daemon upgrades without restarting or announcing one, so a skew that keeps
 *   hello from succeeding is not something to tear this process down over.
 *   Cutting that compatibility is the daemon's deliberate call (reasoned in a
 *   DR), and the session restarts its subscribe when it happens.
 * - Returns null when the socket is not connectable, hello fails, or subscribe ack
 *   is not ok. Callers handle backoff/retry.
 */
export async function reconnectSubscribeNoSpawn(
  paths: Paths,
  identity: Identity,
): Promise<Client | null> {
  const client = await tryConnect(paths.sock);
  if (!client) return null;
  try {
    const hello = await client.request(helloRequest(identity));
    if (!hello.ok) {
      client.close();
      return null;
    }
    const ack = await client.request({ op: "subscribe" });
    if (ack.ok === false) {
      client.close();
      return null;
    }
    return client;
  } catch {
    // connection dropped mid-handshake (daemon may be shutting down again)
    client.close();
    return null;
  }
}

/** What a sidecar names its run with (sidecar_hello, DR-0035 §3). */
export interface RunName {
  readonly runId: string;
  readonly startedAt: number;
  readonly configDir?: string;
  readonly hyouiSessionId?: string;
}

/**
 * Connect to the daemon listening now and name a run of `identity`'s session
 * on the connection (a session hello, then sidecar_hello), **without spawning**
 * a daemon. The run counts as live for as long as the connection returned
 * stays open.
 *
 * Design rationale: the same no-spawn, no-upgrade stance as
 * reconnectSubscribeNoSpawn, for the same reasons — a sidecar lives as long
 * as its session and must not bring back a daemon the person stopped, nor
 * replace one during a gradual rollout. The session's start brings the daemon
 * up and upgrades it.
 *
 * Returns null when no daemon is connectable or it refuses the hello or the
 * name; the caller tries again.
 */
export async function nameRunNoSpawn(
  paths: Paths,
  identity: Identity,
  name: RunName,
): Promise<Client | null> {
  const client = await tryConnect(paths.sock);
  if (!client) return null;
  try {
    const hello = await client.request(helloRequest(identity));
    const named = hello.ok
      ? await client.request({
          op: "sidecar_hello",
          run_id: name.runId,
          started_at: name.startedAt,
          ...(name.configDir !== undefined ? { config_dir: name.configDir } : {}),
          ...(name.hyouiSessionId !== undefined ? { hyoui_session_id: name.hyouiSessionId } : {}),
        })
      : hello;
    if (named.ok) return client;
  } catch {
    // dropped mid-handshake (a daemon shutting down)
  }
  client.close();
  return null;
}

/**
 * Send the facts of `identity`'s session (session_facts, DR-0035 §3) to the
 * daemon listening now, **without spawning** one: the same stance as
 * nameRunNoSpawn, since the hooks module sends facts on every turn and must
 * not bring back a daemon the person stopped. A daemon that starts later asks
 * the module for its facts when the run's sidecar names the run.
 *
 * Returns false when no daemon is connectable or it refuses the hello or the
 * facts.
 */
export async function sendFactsNoSpawn(
  paths: Paths,
  identity: Identity,
  facts: SessionFacts,
): Promise<boolean> {
  const client = await tryConnect(paths.sock);
  if (!client) return false;
  try {
    const hello = await client.request(helloRequest(identity));
    const sent = hello.ok ? await client.request({ op: "session_facts", facts }) : hello;
    return sent.ok;
  } catch {
    // dropped mid-request (a daemon shutting down)
    return false;
  } finally {
    client.close();
  }
}

export { waitDaemonGone };
