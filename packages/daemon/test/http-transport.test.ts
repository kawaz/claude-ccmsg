// HTTP/WS transport (DR-0004): /ws speaks the same line protocol as UDS, browsers are
// identity-pinned to id "u1" (User), and CCMSG_HTTP_BIND controls whether it exists at all.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
    return this.request({
      op: "hello",
      role: "session",
      sid: identity.sid,
      repo: "",
      ws: "",
      cwd: "",
    });
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
        const created = await owner.request<{ ok: true; room: string }>({
          op: "create_room",
          members: [],
        });
        expect(created.ok).toBe(true);

        const ws = await connectWs(ctx);
        const helloRes = await ws.hello({ role: "user" });
        expect(helloRes.ok).toBe(true);

        const rooms = await ws.request<{ ok: true; rooms: { id: string }[] }>({ op: "rooms" });
        expect(rooms.rooms.some((r) => r.id === created.room)).toBe(true);

        // `backlog: true` mirrors the real webui client (packages/webui/src/client/ws.ts),
        // which always opts into the join snapshot — the daemon's bare default
        // (issue 2026-07-17-subscribe-no-backlog-default) sends only a `room_cursors`
        // summary for a room with no since/since_seq cursor.
        const sub = await ws.request<{ ok: true; subscribed: true }>({
          op: "subscribe",
          backlog: true,
        });
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
    'identity pinning: a hello claiming role:session over WS is repinned to user (post.from === "u1")',
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const owner = await connect(ctx.sock);
        await owner.hello({ role: "session", sid: "S", repo: "", ws: "", cwd: "" });
        const created = await owner.request<{ ok: true; room: string }>({
          op: "create_room",
          members: [],
        });

        const ws = await connectWs(ctx);
        // claim to be a session; DR-0004 §2 says the daemon must ignore this and pin to user
        const helloRes = await ws.hello({
          role: "session",
          sid: "browser-pretending-to-be-a-session",
        });
        expect(helloRes.ok).toBe(true);

        const posted = await ws.request<{ ok: true; mid: number }>({
          op: "post",
          room: created.room,
          msg: "am I pinned?",
        });
        expect(posted.ok).toBe(true);

        const read = await ws.request<{ ok: true; msgs: { from: string }[] }>({
          op: "read",
          room: created.room,
          mids: [posted.mid],
        });
        expect(read.msgs[0]!.from).toBe("u1"); // ADMIN_ID, not a session member id

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

        // UDS session posts -> WS user (id "u1", sees every room per DR-0003 §5) receives it live
        await udsSession.request({ op: "post", room, msg: "from uds" });
        const { ev: fromUds } = await wsUser.readEventUntil(
          (e) => e.type === "msg" && e.msg === "from uds",
        );
        expect(fromUds.r).toBe(room);

        // WS user posts -> UDS subscriber (a different connection, so no echo suppression applies) receives it live
        await wsUser.request({ op: "post", room, msg: "from ws" });
        const { ev: fromWs } = await udsSub.readEventUntil(
          (e) => e.type === "msg" && e.msg === "from ws",
        );
        expect(fromWs.from).toBe("u1"); // the WS poster, pinned to user

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
    "CCMSG_HTTP_ALLOW restricted to a non-loopback range: loopback gets 403 for both plain HTTP and the WS upgrade path",
    async () => {
      // DR-0004 §3 addendum: allowlist gates fetch() itself, so it must cover the
      // WS upgrade too (upgrade happens inside fetch(), not a separate handler).
      const ctx = await startHttpDaemon({ CCMSG_HTTP_ALLOW: "100.64.0.0/10" });
      try {
        const addr = await httpAddress(ctx);

        const res = await fetch(`http://${addr}/`);
        expect(res.status).toBe(403);

        const ws = new WebSocket(`ws://${addr}/ws`);
        const outcome = await new Promise<"open" | "rejected">((resolve) => {
          ws.addEventListener("open", () => resolve("open"));
          ws.addEventListener("error", () => resolve("rejected"));
          ws.addEventListener("close", () => resolve("rejected"));
        });
        expect(outcome).toBe("rejected");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "default CCMSG_HTTP_ALLOW (loopback only, 2026-07-10 trust-model addendum): loopback connections are not blocked, and ping reports the active allowlist",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const c = await connect(ctx.sock);
        await c.hello({ role: "user" });
        const pong = await c.request<{ httpAllow: string[] }>({ op: "ping" });
        // tailscale CGNAT/ULA ranges removed from the default: source-IP alone can't
        // distinguish "this daemon's own webui" from "any browser tab kawaz has open"
        // on a device he owns via tailscale (docs/issue/2026-07-10-webui-transport-
        // trust-model-security-critical.md). The Origin check (see below) is the
        // actual trust boundary for browser clients now.
        expect(pong.httpAllow).toEqual(["127.0.0.0/8", "::1"]);
        c.close();

        const addr = await httpAddress(ctx);
        const res = await fetch(`http://${addr}/`);
        expect(res.status).not.toBe(403); // no fallback wired in tests -> 404, but never 403
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "Origin check: matching self-origin passes, a forged evil origin gets 403 (both plain HTTP and the WS upgrade path)",
    async () => {
      // DR-0004 trust-model addendum: source IP alone can't tell this daemon's own
      // webui apart from any other page a browser has open (both connect from
      // 127.0.0.1). Origin is the only signal that can.
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);

        // self-origin (what the daemon's own webui would send) passes.
        const okRes = await fetch(`http://${addr}/`, { headers: { Origin: `http://${addr}` } });
        expect(okRes.status).not.toBe(403); // no fallback wired -> 404, never 403

        // an unrelated page's origin is rejected, plain HTTP...
        const evilRes = await fetch(`http://${addr}/`, { headers: { Origin: "http://evil.com" } });
        expect(evilRes.status).toBe(403);

        // ...and the WS upgrade path (fetch() is where upgrade happens, same gate).
        // Bun's WebSocket accepts a non-standard `headers` option (real browsers don't
        // let page JS set Origin); this simulates the forgeable request a raw client
        // (or a browser's sandboxed-iframe null-origin trick) could send.
        const ws = new WebSocket(`ws://${addr}/ws`, { headers: { Origin: "http://evil.com" } });
        const outcome = await new Promise<"open" | "rejected">((resolve) => {
          ws.addEventListener("open", () => resolve("open"));
          ws.addEventListener("error", () => resolve("rejected"));
          ws.addEventListener("close", () => resolve("rejected"));
        });
        expect(outcome).toBe("rejected");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "Origin check: a missing Origin header passes (non-browser client, e.g. this daemon's own test WebSocket/fetch clients)",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        // plain fetch() from Bun doesn't send an Origin header by itself (verified:
        // req.headers.get("Origin") === null on the server side for this exact call).
        const res = await fetch(`http://${addr}/`);
        expect(res.status).not.toBe(403);

        // same for the WS upgrade path: every round-trip test above already relies on
        // this (WsTestClient never sets Origin), this just asserts it explicitly.
        const ws = await connectWs(ctx);
        const helloRes = await ws.hello({ role: "user" });
        expect(helloRes.ok).toBe(true);
        ws.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "Origin check: localhost is accepted as an alias of a loopback bind (2026-07-10 loopback-aliasing addendum)",
    async () => {
      // startHttpDaemon binds 127.0.0.1:<ephemeral>. Opening the webui via
      // http://localhost:<port> instead of the literal bind address is an
      // equally legitimate way to reach this same daemon and must not 403.
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const port = addr.split(":").pop();

        const okRes = await fetch(`http://${addr}/`, {
          headers: { Origin: `http://localhost:${port}` },
        });
        expect(okRes.status).not.toBe(403); // no fallback wired -> 404, never 403

        const ws = new WebSocket(`ws://${addr}/ws`, {
          headers: { Origin: `http://localhost:${port}` },
        });
        const outcome = await new Promise<"open" | "rejected">((resolve) => {
          ws.addEventListener("open", () => resolve("open"));
          ws.addEventListener("error", () => resolve("rejected"));
          ws.addEventListener("close", () => resolve("rejected"));
        });
        expect(outcome).toBe("open");
        ws.close();

        // The aliasing is same-port only: a different port on localhost is still 403.
        const wrongPortRes = await fetch(`http://${addr}/`, {
          headers: { Origin: `http://localhost:${Number(port) + 1}` },
        });
        expect(wrongPortRes.status).toBe(403);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "Origin check: localhost aliasing also holds on an IPv6 [::1] bind (Bun reports srv.hostname in bracket notation)",
    async () => {
      // The default bind is "127.0.0.1:8642,[::1]:8642" and `localhost` may resolve
      // to ::1, landing the browser on the IPv6 listener. Bun's srv.hostname for that
      // listener is the bracketed literal "[::1]", so loopback detection must accept
      // bracket notation too — otherwise localhost aliasing works on the v4 listener
      // but 403s on the v6 one, an inconsistency invisible until the OS happens to
      // prefer ::1 for localhost.
      const ctx = await startHttpDaemon({ CCMSG_HTTP_BIND: "[::1]:0" });
      try {
        const addr = await httpAddress(ctx);
        const port = addr.split(":").pop();

        const okRes = await fetch(`http://${addr}/`, {
          headers: { Origin: `http://localhost:${port}` },
        });
        expect(okRes.status).not.toBe(403); // no fallback wired -> 404, never 403

        // Cross-origin from an arbitrary site is still rejected on this listener.
        const evilRes = await fetch(`http://${addr}/`, {
          headers: { Origin: "https://evil.example" },
        });
        expect(evilRes.status).toBe(403);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "CCMSG_HTTP_ALLOW_ORIGIN: an explicitly configured extra origin (e.g. a tailscale serve HTTPS front) passes",
    async () => {
      const extraOrigin = "https://my-machine.tailnet-name.ts.net";
      const ctx = await startHttpDaemon({ CCMSG_HTTP_ALLOW_ORIGIN: extraOrigin });
      try {
        const addr = await httpAddress(ctx);

        const okRes = await fetch(`http://${addr}/`, { headers: { Origin: extraOrigin } });
        expect(okRes.status).not.toBe(403);

        // an origin NOT in the extra list is still rejected even with the env var set.
        const evilRes = await fetch(`http://${addr}/`, { headers: { Origin: "http://evil.com" } });
        expect(evilRes.status).toBe(403);
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

// tailscale serve origin auto-allow (docs/issue/2026-07-11-tailscale-serve-origin-auto-
// allow.md): the daemon-startup wiring and its subprocess seam. extractProxiedOrigins'
// own JSON-shape unit tests live in tailscale-origin.test.ts; no test here depends on a
// real tailscale binary (CI has none) — everything goes through CCMSG_TAILSCALE_BIN.

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** A free TCP port, grabbed by binding :0 and immediately releasing it. Best-effort like
 *  the rest of this test harness (waitConnectable's retry-until-connectable is the same
 *  idea): there's a race between release and the daemon binding it for real, acceptable
 *  for a test that already retries past transient failures below. */
async function freeTcpPort(): Promise<number> {
  const srv = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {}, drain() {} },
  });
  const port = srv.port;
  srv.stop(true);
  return port;
}

/** Writes an executable shell script that mimics `tailscale serve status --json`,
 *  reporting a single Web entry fronting `port` on `hostname`. The fake blocks until
 *  `gatePath` exists before answering, so the test can deterministically assert the
 *  "auto-allow has NOT landed yet" state first and then open the gate. (A fixed
 *  `sleep 0.3` window here raced with full-suite load: the test's own first fetch
 *  could arrive after the window and find the origin already allowed.) The wait is
 *  bounded (~5s) so a test bug can't strand the daemon's subprocess: on timeout it
 *  exits non-zero, the origin never gets allowed, and waitForOriginAllowed reports
 *  that visibly. */
function writeFakeTailscale(dir: string, hostname: string, port: number, gatePath: string): string {
  const scriptPath = path.join(dir, "fake-tailscale");
  const json = JSON.stringify({
    Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
  });
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
i=0
while [ ! -f '${gatePath}' ]; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && exit 1
  sleep 0.05
done
if [ "$1 $2 $3" = "serve status --json" ]; then echo '${json}'; exit 0; fi
exit 1
`,
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Retries a same-origin-tagged fetch until the daemon's async serve-origin lookup has
 *  landed (or timeoutMs elapses) — there is no event to await for "subprocess finished
 *  and its result got folded into extraOrigins", so polling the externally-observable
 *  effect (the Origin check itself) is the only option, same rationale as
 *  waitConnectable's retry-until-connectable. */
async function waitForOriginAllowed(addr: string, origin: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`http://${addr}/`, { headers: { Origin: origin } });
    if (res.status !== 403) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`origin ${origin} never became allowed within ${timeoutMs}ms`);
    }
    await sleep(50);
  }
}

describe("tailscale serve origin auto-allow (docs/issue/2026-07-11)", () => {
  test(
    "tailscale binary absent (CCMSG_TAILSCALE_BIN points nowhere): daemon still starts promptly and serves requests",
    async () => {
      const start = Date.now();
      const ctx = await startTestDaemon({
        CCMSG_HTTP_BIND: "127.0.0.1:0",
        CCMSG_TAILSCALE_BIN: "/nonexistent/path/definitely-not-a-tailscale-binary",
      });
      try {
        // startTestDaemon already waited for the UDS socket via waitConnectable; the
        // absent-binary lookup must not have delayed that (it's fired off with `void`,
        // never awaited by daemon startup) — bounding total elapsed time here catches a
        // regression where it accidentally becomes synchronous/blocking.
        expect(Date.now() - start).toBeLessThan(5000);
        const c = await connect(ctx.sock);
        const pong = await c.request<{ ok: true; pong: true }>({ op: "ping" });
        expect(pong.ok).toBe(true);
        c.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "fake tailscale reports a serve config fronting this daemon's bind port: that ts.net origin's WS connects without CCMSG_HTTP_ALLOW_ORIGIN",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-fake-ts-"));
      try {
        const port = await freeTcpPort();
        const hostname = "fake-machine.tail1234.ts.net";
        const gatePath = path.join(dir, "gate");
        const bin = writeFakeTailscale(dir, hostname, port, gatePath);
        const ctx = await startTestDaemon({
          CCMSG_HTTP_BIND: `127.0.0.1:${port}`,
          CCMSG_TAILSCALE_BIN: bin,
        });
        try {
          const origin = `https://${hostname}`;
          const addr = `127.0.0.1:${port}`;

          // before auto-allow lands, the origin is not yet trusted (proves the WS
          // success below is actually caused by the auto-allow, not some pre-existing
          // implicit allow).
          const tooSoon = await fetch(`http://${addr}/`, { headers: { Origin: origin } });
          expect(tooSoon.status).toBe(403);

          // Open the gate: the fake answers, the daemon folds the origin in.
          fs.writeFileSync(gatePath, "");
          await waitForOriginAllowed(addr, origin);

          const ws = new WebSocket(`ws://${addr}/ws`, { headers: { Origin: origin } });
          const outcome = await new Promise<"open" | "rejected">((resolve) => {
            ws.addEventListener("open", () => resolve("open"));
            ws.addEventListener("error", () => resolve("rejected"));
            ws.addEventListener("close", () => resolve("rejected"));
          });
          expect(outcome).toBe("open");
          ws.close();

          // an origin NOT reported by (fake) tailscale is still rejected.
          const evilRes = await fetch(`http://${addr}/`, {
            headers: { Origin: "https://evil.example" },
          });
          expect(evilRes.status).toBe(403);
        } finally {
          await stopTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});
