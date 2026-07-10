// UDS client + ensure-daemon (DR-0002 §2/§4/§5).
//
// ensure-daemon path: connect -> (fail) spawn -> backoff-retry connect -> hello.
// If the running daemon's version is OLDER than ours, shut it down and re-spawn
// the current one (client-driven upgrade, DR-0002 §4, newer-wins policy per
// docs/issue/2026-07-10-daemon-version-flapping-on-gradual-rollout.md: a
// same-or-newer daemon is left alone so old and new clients don't fight over
// which version should run during a gradual plugin rollout).
import type { Socket } from "bun";
import { compareVersions, VERSION, type Identity, type Paths } from "@ccmsg/protocol";

export class Client {
  private socket!: Socket;
  private decoder = new TextDecoder();
  private buf = "";
  private lines: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private ended = false;

  static async connect(sockPath: string): Promise<Client> {
    const client = new Client();
    const socket = await Bun.connect({
      unix: sockPath,
      socket: {
        data(_s, chunk) {
          client.onData(chunk);
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

  private onData(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const w = this.waiters.shift();
      if (w) w(line);
      else this.lines.push(line);
    }
  }

  private onClose(): void {
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()!(null);
  }

  readLine(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }

  write(obj: unknown): void {
    this.socket.write(`${JSON.stringify(obj)}\n`);
  }

  async request<T = Record<string, unknown>>(obj: unknown): Promise<T> {
    this.write(obj);
    const line = await this.readLine();
    if (line === null) throw new Error("connection closed before response");
    return JSON.parse(line) as T;
  }

  close(): void {
    try {
      this.socket.end();
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

function spawnDaemon(): void {
  const cmd = daemonSpawnCmd();
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  proc.unref();
}

// Exponential backoff schedule for reconnecting to a freshly spawned daemon.
// This is connection retry (each attempt is a real connect, not a blind sleep):
// the daemon usually answers within the first few hundred ms.
const SPAWN_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 400, 600, 800, 1000, 1500, 2000, 3000];

async function connectWithSpawn(sockPath: string): Promise<Client> {
  const c = await tryConnect(sockPath);
  if (c) return c;
  spawnDaemon();
  for (const delay of SPAWN_RETRY_DELAYS_MS) {
    await sleep(delay);
    const c2 = await tryConnect(sockPath);
    if (c2) return c2;
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

export function helloRequest(identity: Identity): Record<string, unknown> {
  if (identity.role === "user") return { op: "hello", role: "user" };
  return {
    op: "hello",
    role: "session",
    sid: identity.sid,
    repo: identity.repo,
    ws: identity.ws,
    cwd: identity.cwd,
  };
}

/** Connect (spawning + upgrading the daemon as needed) and complete the hello handshake. */
export async function ensureDaemon(paths: Paths, identity: Identity): Promise<Client> {
  let client = await connectWithSpawn(paths.sock);
  let hello = await client.request<{ ok: boolean; version?: string }>(helloRequest(identity));
  if (hello.ok && hello.version && compareVersions(VERSION, hello.version) > 0) {
    // we are strictly newer than the running daemon: shut it down and spawn ours.
    // A same-or-newer daemon is left running (newer-wins, see file header).
    try {
      await client.request({ op: "shutdown", reason: "upgrade" });
    } catch {
      // it may close the connection without replying; that's fine
    }
    client.close();
    await waitDaemonGone(paths.sock);
    client = await connectWithSpawn(paths.sock);
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
 * - Returns null when the socket is not connectable, hello fails, or subscribe ack
 *   is not ok. Callers handle backoff/retry.
 */
export async function reconnectSubscribeNoSpawn(
  paths: Paths,
  identity: Identity,
  since: Record<string, number>,
): Promise<Client | null> {
  const client = await tryConnect(paths.sock);
  if (!client) return null;
  try {
    const hello = await client.request<{ ok?: boolean }>(helloRequest(identity));
    if (!hello.ok) {
      client.close();
      return null;
    }
    const ack = await client.request<{ ok?: boolean }>({
      op: "subscribe",
      ...(Object.keys(since).length > 0 ? { since } : {}),
    });
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

export { waitDaemonGone };
