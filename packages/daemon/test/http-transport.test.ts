// HTTP/WS transport (DR-0004): /ws speaks the same line protocol as UDS, browsers are
// identity-pinned to uid 0 (User), and CCMSG_HTTP_BIND controls whether it exists at all.
import { describe, expect, test } from "bun:test";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";

const T = 15000;

/** Minimal WS counterpart of helpers.ts's TestClient: same request/readEvent shape,
 *  backed by a browser-standard WebSocket instead of a UDS Bun.connect socket. */
class WsTestClient {
  private ws: WebSocket;
  private lines: string[] = [];
  private waiters: Array<(l: string | null) => void> = [];
  private ended = false;
  private opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error(`ws connect failed: ${url}`)));
    });
    this.ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : "";
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const w = this.waiters.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
    this.ws.addEventListener("close", () => {
      this.ended = true;
      while (this.waiters.length) this.waiters.shift()!(null);
    });
  }
  async ready(): Promise<this> {
    await this.opened;
    return this;
  }
  readLine(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }
  write(obj: unknown): void {
    this.ws.send(`${JSON.stringify(obj)}\n`);
  }
  async request<T = any>(obj: unknown): Promise<T> {
    this.write(obj);
    const line = await this.readLine();
    if (line === null) throw new Error("connection closed before response");
    return JSON.parse(line) as T;
  }
  async readEvent<T = any>(): Promise<T | null> {
    const line = await this.readLine();
    return line === null ? null : (JSON.parse(line) as T);
  }
  async readEventUntil<T = any>(pred: (ev: any) => boolean): Promise<{ ev: T; seen: any[] }> {
    const seen: any[] = [];
    for (;;) {
      const ev = await this.readEvent();
      if (ev === null) throw new Error(`connection closed; seen ${JSON.stringify(seen)}`);
      seen.push(ev);
      if (pred(ev)) return { ev: ev as T, seen };
    }
  }
  async hello(identity: { role: "user" } | { role: "session"; sid: string }): Promise<any> {
    if (identity.role === "user") return this.request({ op: "hello", role: "user" });
    return this.request({ op: "hello", role: "session", sid: identity.sid, repo: "", ws: "", cwd: "" });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closing
    }
  }
}

async function startHttpDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonCtx> {
  return startTestDaemon({ CCMSG_HTTP_BIND: "127.0.0.1:0", ...extraEnv });
}

/** ping over UDS to read back the ephemeral HTTP bind address chosen by the daemon. */
async function httpAddress(ctx: DaemonCtx): Promise<string> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  const pong = await c.request<{ http: string[] }>({ op: "ping" });
  c.close();
  expect(pong.http.length).toBe(1);
  return pong.http[0]!;
}

async function connectWs(ctx: DaemonCtx): Promise<WsTestClient> {
  const addr = await httpAddress(ctx);
  const client = new WsTestClient(`ws://${addr}/ws`);
  await client.ready();
  return client;
}

describe("HTTP/WS transport (DR-0004)", () => {
  test(
    "CCMSG_HTTP_BIND=off: no HTTP listener, status reports empty http[]",
    async () => {
      // this is the test-suite default (helpers.ts spawnDaemonProc/startTestDaemon inject
      // CCMSG_HTTP_BIND=off) — asserting it explicitly here documents the contract.
      const ctx = await startTestDaemon();
      try {
        const c = await connect(ctx.sock);
        await c.hello({ role: "user" });
        const pong = await c.request<{ http: string[] }>({ op: "ping" });
        expect(pong.http).toEqual([]);
        c.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "CCMSG_HTTP_BIND=127.0.0.1:0 binds an ephemeral port and status reports the real address",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        // resolved to a concrete port, not the literal "0" we configured
        expect(addr).toMatch(/^127\.0\.0\.1:\d+$/);
        expect(addr.endsWith(":0")).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "WS round trip: hello -> rooms -> subscribe -> post delivers the msg, same shape as UDS",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        // room creation is a session-side op (webui MVP has no room-creation UI, DR-0004 §6);
        // set one up over UDS first, the way an AI session normally would.
        const owner = await connect(ctx.sock);
        await owner.hello({ role: "session", sid: "S", repo: "", ws: "", cwd: "" });
        const created = await owner.request<{ ok: true; room: string }>({ op: "create_room", members: [] });
        expect(created.ok).toBe(true);

        const ws = await connectWs(ctx);
        const helloRes = await ws.hello({ role: "user" });
        expect(helloRes.ok).toBe(true);

        const rooms = await ws.request<{ ok: true; rooms: { id: string }[] }>({ op: "rooms" });
        expect(rooms.rooms.some((r) => r.id === created.room)).toBe(true);

        const sub = await ws.request<{ ok: true; subscribed: true }>({ op: "subscribe" });
        expect(sub.subscribed).toBe(true);
        // the ack is followed by the room's join-snapshot backlog (here: the one member
        // event from create_room) before any request/response can resume on this
        // connection — drain it first, same as UDS subscribers must.
        const backlog = await ws.readEvent<{ type: string }>();
        expect(backlog?.type).toBe("member");

        const posted = await ws.request<{ ok: true; mid: number }>({
          op: "post",
          room: created.room,
          msg: "hello from ws",
        });
        expect(posted.mid).toBe(1);

        ws.close();
        owner.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "identity pinning: a hello claiming role:session over WS is repinned to user (post.from === 0)",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const owner = await connect(ctx.sock);
        await owner.hello({ role: "session", sid: "S", repo: "", ws: "", cwd: "" });
        const created = await owner.request<{ ok: true; room: string }>({ op: "create_room", members: [] });

        const ws = await connectWs(ctx);
        // claim to be a session; DR-0004 §2 says the daemon must ignore this and pin to user
        const helloRes = await ws.hello({ role: "session", sid: "browser-pretending-to-be-a-session" });
        expect(helloRes.ok).toBe(true);

        const posted = await ws.request<{ ok: true; mid: number }>({
          op: "post",
          room: created.room,
          msg: "am I pinned?",
        });
        expect(posted.ok).toBe(true);

        const read = await ws.request<{ ok: true; msgs: { from: number }[] }>({
          op: "read",
          room: created.room,
          mids: [posted.mid],
        });
        expect(read.msgs[0]!.from).toBe(0); // USER_UID, not a session member uid

        ws.close();
        owner.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "cross-transport delivery: a UDS session and a WS user share live delivery in the same room",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const udsSession = await connect(ctx.sock);
        await udsSession.hello({ role: "session", sid: "S", repo: "", ws: "", cwd: "" });
        const created = await udsSession.request<{ ok: true; room: string }>({
          op: "create_room",
          members: [],
        });
        const room = created.room;

        const udsSub = await connect(ctx.sock);
        await udsSub.hello({ role: "session", sid: "S", repo: "", ws: "", cwd: "" });
        await udsSub.request({ op: "subscribe" });

        const wsUser = await connectWs(ctx);
        await wsUser.hello({ role: "user" });
        await wsUser.request({ op: "subscribe" });

        // UDS session posts -> WS user (uid 0, sees every room per DR-0003 §5) receives it live
        await udsSession.request({ op: "post", room, msg: "from uds" });
        const { ev: fromUds } = await wsUser.readEventUntil((e) => e.type === "msg" && e.msg === "from uds");
        expect(fromUds.r).toBe(room);

        // WS user posts -> UDS subscriber (a different connection, so no echo suppression applies) receives it live
        await wsUser.request({ op: "post", room, msg: "from ws" });
        const { ev: fromWs } = await udsSub.readEventUntil((e) => e.type === "msg" && e.msg === "from ws");
        expect(fromWs.from).toBe(0); // the WS poster, pinned to user

        udsSession.close();
        udsSub.close();
        wsUser.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "graceful shutdown delivers a restarting event to WS subscribers too",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const ws = await connectWs(ctx);
        await ws.hello({ role: "user" });
        await ws.request({ op: "subscribe" });

        const uds = await connect(ctx.sock);
        await uds.hello({ role: "user" });
        await uds.request({ op: "shutdown" }); // triggers gracefulShutdown() in the daemon process
        uds.close();

        const { ev } = await ws.readEventUntil((e) => e.ev === "restarting");
        expect(ev.ev).toBe("restarting");
        ws.close();
      } finally {
        // the daemon already exited via shutdown; stopTestDaemon tolerates that (falls
        // back to proc.kill(), which is a no-op on an already-dead process)
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
