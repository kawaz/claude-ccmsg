// Test harness: spawn a real daemon in a temp dir and talk to it over UDS.
// No blind sleeps — daemon readiness is confirmed by retrying the actual connect.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "bun";

const DAEMON_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export interface DaemonCtx {
  base: string;
  stateDir: string;
  configDir: string;
  dataDir: string;
  roomsDir: string;
  sock: string;
  proc: Bun.Subprocess;
  env: Record<string, string>;
}

/** Test daemons keep their config dir inside the temp data dir so that every
 * call site gets it from `dataDir` alone (restarts stay one-liners) and no test
 * can ever read or migrate into the developer's real ~/.config/ccmsg. */
export function testConfigDir(dataDir: string): string {
  return path.join(dataDir, "config");
}

export function spawnDaemonProc(
  stateDir: string,
  dataDir: string,
  extraEnv: Record<string, string> = {},
): Bun.Subprocess {
  return Bun.spawn([process.execPath, DAEMON_ENTRY, "daemon", "run"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // HTTP off by default so parallel test daemons never fight over the fixed
    // default port (8642); tests that need HTTP pass CCMSG_HTTP_BIND explicitly
    // (typically 127.0.0.1:0 for an ephemeral port) via extraEnv, which wins below.
    env: {
      ...process.env,
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: testConfigDir(dataDir),
      CCMSG_DATA_DIR: dataDir,
      // Pin integration subprocesses to this working copy rather than PATH's install.
      CCMSG_NO_SELF_EXEC: "1",
      CCMSG_HTTP_BIND: "off",
      // No route-monitor child and no api-error folds per test daemon; tests
      // that exercise the wake drive createNetworkWatch directly.
      CCMSG_NETWORK_WATCH: "off",
      ...extraEnv,
    },
  });
}

export async function waitConnectable(sock: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const s = await Bun.connect({
        unix: sock,
        socket: { data() {}, close() {}, error() {} },
      });
      s.end();
      return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`daemon not connectable: ${sock}`);
    await sleep(25);
  }
}

export async function startTestDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonCtx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-t-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const env: Record<string, string> = {
    CCMSG_STATE_DIR: stateDir,
    CCMSG_CONFIG_DIR: testConfigDir(dataDir),
    CCMSG_DATA_DIR: dataDir,
    CCMSG_NO_SELF_EXEC: "1",
    CCMSG_HTTP_BIND: "off",
    CCMSG_NETWORK_WATCH: "off",
    ...extraEnv,
  };
  const proc = spawnDaemonProc(stateDir, dataDir, extraEnv);
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  return {
    base,
    stateDir,
    configDir: testConfigDir(dataDir),
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock,
    proc,
    env,
  };
}

export async function stopTestDaemon(ctx: DaemonCtx): Promise<void> {
  try {
    const c = await connect(ctx.sock);
    await c.request({ op: "shutdown" });
    c.close();
  } catch {
    // fall back to signal
  }
  try {
    ctx.proc.kill();
  } catch {
    // already gone
  }
  await ctx.proc.exited;
  try {
    fs.rmSync(ctx.base, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export async function connect(sock: string): Promise<TestClient> {
  const client = new TestClient();
  const socket = await Bun.connect({
    unix: sock,
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
  client.attach(socket);
  return client;
}

export class TestClient {
  private socket!: Socket;
  private decoder = new TextDecoder();
  private buf = "";
  private lines: string[] = [];
  private waiters: Array<(l: string | null) => void> = [];
  private ended = false;
  /** Stream events that arrived while `request` was waiting for a reply. */
  private eventBacklog: string[] = [];

  attach(socket: Socket): void {
    this.socket = socket;
  }
  onData(chunk: Uint8Array): void {
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
  onClose(): void {
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()!(null);
  }
  readLine(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }
  writeRaw(s: string): void {
    this.socket.write(s);
  }
  write(obj: unknown): void {
    this.socket.write(`${JSON.stringify(obj)}\n`);
  }
  /** Send an op and return its reply, classifying the way the real client does
   * (ws.ts onMessage): a reply is the line carrying `ok`; everything else is a
   * stream event and is set aside for readEvent. Two kinds of frame can arrive
   * ahead of a reply on the same socket — an ephemeral `ev` push while the op
   * awaits IO, and a delivered storage event when the op itself broadcasts to
   * a room this same connection subscribes to (create_room, say, say_read...).
   * Both must keep their place in the event stream rather than being mistaken
   * for the reply, or every later reply on this socket is off by one. */
  async request<T = any>(obj: unknown): Promise<T> {
    this.write(obj);
    for (;;) {
      const line = await this.readLine();
      if (line === null) throw new Error("connection closed before response");
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Object.hasOwn(parsed, "ok")) {
        this.eventBacklog.push(line);
        continue;
      }
      return parsed as T;
    }
  }
  async readEvent<T = any>(): Promise<T | null> {
    const buffered = this.eventBacklog.shift();
    if (buffered !== undefined) return JSON.parse(buffered) as T;
    const line = await this.readLine();
    return line === null ? null : (JSON.parse(line) as T);
  }
  /** Events already delivered to this socket, without waiting for more — for
   * asserting that a push was *not* addressed to this client. Only meaningful
   * after something else has ordered the stream past the moment in question
   * (e.g. a request round-trip). */
  async pendingEvents<T = any>(): Promise<T[]> {
    const events: T[] = [];
    for (;;) {
      const buffered = this.eventBacklog.shift();
      if (buffered !== undefined) {
        events.push(JSON.parse(buffered) as T);
        continue;
      }
      if (this.lines.length === 0) return events;
      events.push(JSON.parse(this.lines.shift()!) as T);
    }
  }
  /** Read events until pred matches (skipping backlog). Relies on the expected event
   *  actually arriving; if it never does, the bun test timeout fails the test. */
  async readEventUntil<T = any>(pred: (ev: any) => boolean): Promise<{ ev: T; seen: any[] }> {
    const seen: any[] = [];
    for (;;) {
      const ev = await this.readEvent();
      if (ev === null) throw new Error(`connection closed; seen ${JSON.stringify(seen)}`);
      seen.push(ev);
      if (pred(ev)) return { ev: ev as T, seen };
    }
  }
  async hello(
    identity:
      | { role: "user" }
      | { role: "session"; sid: string; repo?: string; ws?: string; cwd?: string },
  ): Promise<any> {
    if (identity.role === "user") return this.request({ op: "hello", role: "user" });
    return this.request({
      op: "hello",
      role: "session",
      sid: identity.sid,
      repo: identity.repo ?? "",
      ws: identity.ws ?? "",
      cwd: identity.cwd ?? "",
    });
  }
  close(): void {
    try {
      this.socket.end();
    } catch {
      // already closing
    }
  }
}
