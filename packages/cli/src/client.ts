// UDS client + ensure-daemon (DR-0002 §2/§4/§5).
//
// ensure-daemon path: connect -> (fail) spawn -> backoff-retry connect -> hello.
// If the running daemon's version differs from ours, shut it down and re-spawn the
// current one (client-driven upgrade, DR-0002 §4).
import type { Socket } from "bun";
import { VERSION, type Identity, type Paths } from "@ccmsg/protocol";

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

function helloRequest(identity: Identity): Record<string, unknown> {
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
  if (hello.ok && hello.version && hello.version !== VERSION) {
    // running daemon is a different version: shut it down and spawn ours
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

export { waitDaemonGone };
