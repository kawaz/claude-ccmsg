// Guards against the pending-resolver leak found in codex review (2026-07-10,
// Minor 3, see docs/findings/2026-07-10-codex-review-evaluation.md): send()
// pushes a resolver onto `pending` before the response arrives; if the socket
// closes before a reply comes back, that resolver used to sit forever
// (Composer's awaited Promise hangs), and a *later* reconnected socket's
// first reply could be mis-delivered to the stale resolver via
// onMessage's pending.shift(). These tests exercise createWsClient against a
// minimal in-memory WebSocket mock (bun's runtime has no DOM globals, so
// WebSocket/location/localStorage are stubbed for the duration of the file).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWsClient } from "../src/client/ws.ts";
import type { Action } from "../src/client/store.ts";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.triggerClose();
  }

  // --- test-only helpers to drive the mock from outside ---
  triggerMessage(data: string): void {
    for (const cb of this.listeners.message ?? []) cb({ data });
  }

  triggerClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    for (const cb of this.listeners.close ?? []) cb(undefined);
  }

  // U1: fires the "open" listener connect() registers, so a test can drive
  // createWsClient's actual onOpen handshake (hello -> rooms -> subscribe ->
  // peers -> agents -> ping) instead of only exercising the standalone
  // send()-wrapper methods (agents()/ping()/peers()/...) directly.
  triggerOpen(): void {
    for (const cb of this.listeners.open ?? []) cb(undefined);
  }
}

let instances: MockWebSocket[] = [];
let storage: Record<string, string> = {};

// bun test runs every test file in one shared process: these globals must be
// *restored* to whatever Bun had (WebSocket is a real builtin there), not
// deleted — `delete globalThis.WebSocket` permanently removes the builtin and
// breaks any later test file that talks to a real daemon over WS. (This
// exact leak made packages/daemon/test/http-transport.test.ts fail with
// "WebSocket is not defined" on CI runners where this file happens to run
// first; locally the file order differed and hid it.)
const originalGlobals: Record<string, unknown> = {};
const MOCKED_GLOBALS = ["WebSocket", "location", "localStorage"] as const;

// Every handle created in a test is closed in afterEach even if the test
// fails mid-way: close() also cancels the client's scheduled auto-reconnect
// timer, which would otherwise fire *after* the mocks are torn down and blow
// up an unrelated later test file with "location is not defined".
let openHandles: Array<{ close(): void }> = [];

beforeEach(() => {
  instances = [];
  storage = {};
  openHandles = [];
  for (const key of MOCKED_GLOBALS) {
    originalGlobals[key] = (globalThis as any)[key];
  }
  (globalThis as any).WebSocket = MockWebSocket;
  (globalThis as any).location = { protocol: "http:", host: "localhost:8642" };
  (globalThis as any).localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    setItem: (k: string, v: string) => {
      storage[k] = v;
    },
  };
});

afterEach(() => {
  for (const handle of openHandles) handle.close();
  for (const key of MOCKED_GLOBALS) {
    if (originalGlobals[key] === undefined) {
      delete (globalThis as any)[key];
    } else {
      (globalThis as any)[key] = originalGlobals[key];
    }
  }
});

describe("createWsClient pending queue on close/reconnect", () => {
  test("onClose settles in-flight requests instead of hanging their Promise forever", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    expect(ws1).toBeDefined();
    // Skip the onOpen hello/rooms/subscribe/peers handshake chain (not the
    // concern of this test); just mark the socket open enough for send() to
    // accept a request.
    ws1.readyState = MockWebSocket.OPEN;

    const pendingReq = handle.peers();
    expect(ws1.sent.length).toBe(1); // the request really went out

    // Socket drops before any reply arrives.
    ws1.triggerClose();

    // Must not hang: onClose flushes `pending` synchronously.
    const result = await pendingReq;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("connection_closed");
    }
  });

  test("connect() clears stale pending entries so a fresh reply after reconnect isn't mis-delivered to them", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    // A request is in flight on the old socket, but connect() is invoked
    // again (simulating a reconnect path) before onClose ever ran.
    const stale = handle.peers();
    expect(ws1.sent.length).toBe(1);

    handle.connect();
    const ws2 = instances[1];
    expect(ws2).toBeDefined();

    // The stale promise must resolve on its own (flushed by connect()), not
    // stay pending waiting for a reply that will never come on ws1.
    const staleResult = await stale;
    expect(staleResult.ok).toBe(false);

    // A fresh request on the new socket gets its own, correctly-matched reply.
    ws2.readyState = MockWebSocket.OPEN;
    const fresh = handle.peers();
    ws2.triggerMessage(JSON.stringify({ ok: true, peers: [] }));
    const freshResult = await fresh;
    expect(freshResult.ok).toBe(true);
  });

  // DR-0008: fs_list/fs_read wire shape. `path` is only sent when the caller
  // actually passed one (fsList's root call omits it — daemon treats absent
  // as root — rather than send an empty string, keeping the request minimal).
  test("fsList sends {op:'fs_list', sid} without path when path is omitted (root)", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.fsList("sess-1");
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({ op: "fs_list", sid: "sess-1" });

    ws1.triggerMessage(JSON.stringify({ ok: true, sid: "sess-1", path: "", entries: [] }));
    const res = await req;
    expect(res.ok).toBe(true);
  });

  test("fsList sends {op:'fs_list', sid, path} when a subdirectory path is given", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    void handle.fsList("sess-1", "src");
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({ op: "fs_list", sid: "sess-1", path: "src" });
  });

  test("fsRead sends {op:'fs_read', sid, path} and resolves the file response", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.fsRead("sess-1", "README.md");
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({
      op: "fs_read",
      sid: "sess-1",
      path: "README.md",
    });

    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        sid: "sess-1",
        path: "README.md",
        size: 5,
        truncated: false,
        binary: false,
        content: "hello",
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toBe("hello");
  });

  // DR-0009: transcript_read wire shape. `before`/`max_bytes` are only sent
  // when the caller actually passed them, mirroring fsList's "omit path when
  // absent" minimal-request convention above.
  test("transcriptRead sends {op:'transcript_read', sid} without before/max_bytes when opts is omitted", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.transcriptRead("sess-1");
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({ op: "transcript_read", sid: "sess-1" });

    ws1.triggerMessage(
      JSON.stringify({ ok: true, sid: "sess-1", lines: ["a"], start: 0, end: 2, size: 2 }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.lines).toEqual(["a"]);
  });

  test("transcriptRead sends {op:'transcript_read', sid, before} when paging older", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    void handle.transcriptRead("sess-1", { before: 100 });
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({
      op: "transcript_read",
      sid: "sess-1",
      before: 100,
    });
  });

  test("transcriptRead sends max_bytes only when explicitly passed", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    void handle.transcriptRead("sess-1", { before: 100, max_bytes: 4096 });
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({
      op: "transcript_read",
      sid: "sess-1",
      before: 100,
      max_bytes: 4096,
    });
  });

  // U2 live-tail addendum (DR-0009): transcript_subscribe/unsubscribe wire
  // shape, mirroring the transcriptRead coverage above.
  test("transcriptSubscribe sends {op:'transcript_subscribe', sid} and resolves size", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.transcriptSubscribe("sess-1");
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({ op: "transcript_subscribe", sid: "sess-1" });

    ws1.triggerMessage(JSON.stringify({ ok: true, sid: "sess-1", size: 200 }));
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.size).toBe(200);
  });

  test("transcriptUnsubscribe sends {op:'transcript_unsubscribe', sid}", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.transcriptUnsubscribe("sess-1");
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({ op: "transcript_unsubscribe", sid: "sess-1" });

    ws1.triggerMessage(JSON.stringify({ ok: true, sid: "sess-1" }));
    const res = await req;
    expect(res.ok).toBe(true);
  });

  // Guards against the stale-socket mis-delivery found in the adversarial
  // review of the fix above: connect() used to swap `ws` without detaching
  // the old socket's listeners or closing it, so a late reply/close on the
  // discarded socket could still fire onMessage/onClose against the *new*
  // connection's `pending` queue and dispatch. Each listener in connect() is
  // now guarded with `socket !== ws`, and connect() closes the outgoing
  // socket up front — these tests drive the old socket directly (bypassing
  // that close) to prove the guard, not just the close, is what stops it.
  test("stale socket's delayed message does not settle the new socket's pending request", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    handle.connect(); // reconnect path; ws1 is now stale (and already closed)
    const ws2 = instances[1];
    expect(ws2).toBeDefined();
    ws2.readyState = MockWebSocket.OPEN;

    const fresh = handle.peers();
    expect(ws2.sent.length).toBe(1);

    // A reply arrives late on the discarded socket. Without the `socket !==
    // ws` guard this would incorrectly settle `fresh` via pending.shift().
    ws1.triggerMessage(JSON.stringify({ ok: true, peers: [] }));

    let settled = false;
    void fresh.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // The real reply, on the current socket, resolves it correctly.
    ws2.triggerMessage(JSON.stringify({ ok: true, peers: [] }));
    const freshResult = await fresh;
    expect(freshResult.ok).toBe(true);
  });

  // close() must mean "stop", including a reconnect that onClose already
  // queued: an unexpected close schedules setTimeout(connect, 250ms), and a
  // close() arriving in that window used to leave the timer armed — the
  // client would silently resurrect itself (and, in tests, the leaked timer
  // fired after this file's mocks were torn down, crashing an unrelated
  // later test file). The 300ms real-time wait deliberately outlives the
  // first RECONNECT_DELAYS_MS slot (250ms) so an armed timer would fire
  // inside this test if close() failed to cancel it.
  test("close() cancels an already-scheduled auto-reconnect", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    ws1.triggerClose(); // unexpected drop -> reconnect scheduled (250ms)
    handle.close(); // user says stop before the timer fires

    await new Promise((r) => setTimeout(r, 300));
    expect(instances.length).toBe(1); // no resurrected socket
  });

  // Guards the exact race the webui bugfix (direct `#s<sid>[:<path>]` /
  // `#t<sid>` links opened before the WS handshake completes) is built on:
  // FileTree/FileViewer/Timeline's first-fetch effects call fsList/fsRead/
  // transcriptRead, and send() rejects synchronously (not "resolves with an
  // error response") when the socket isn't open yet. Callers must `.catch()`
  // this, not just `.then()` — these tests document the rejection shape so a
  // regression that turned it back into a hang would show up here first.
  test("fsList rejects with 'ws not open' before the socket has ever opened", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    expect(ws1).toBeDefined();
    expect(ws1.readyState).toBe(MockWebSocket.CONNECTING); // not OPEN yet

    let caught: unknown;
    try {
      await handle.fsList("sess-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("ws not open");
    expect(ws1.sent.length).toBe(0); // send() bailed before touching the socket
  });

  test("fsRead rejects with 'ws not open' before the socket has ever opened", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();

    let caught: unknown;
    try {
      await handle.fsRead("sess-1", "README.md");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("ws not open");
  });

  test("transcriptRead rejects with 'ws not open' before the socket has ever opened", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();

    let caught: unknown;
    try {
      await handle.transcriptRead("sess-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("ws not open");
  });

  test("stale socket's delayed close does not re-trigger disconnect/reconnect for the new connection", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    handle.connect();
    const ws2 = instances[1];
    expect(ws2).toBeDefined();
    ws2.readyState = MockWebSocket.OPEN;
    actions.length = 0; // only care about actions dispatched after this point

    // Simulate a duplicate/delayed close event arriving from the discarded
    // socket (e.g. underlying transport fires close asynchronously after
    // connect() already called previous.close()). Without the guard this
    // would dispatch conn/status "disconnected" and schedule a reconnect for
    // the still-live ws2 connection.
    ws1.triggerClose();

    expect(actions).toEqual([]);
    expect(instances.length).toBe(2); // no extra reconnect socket was created
  });
});

// U1: agents()/ping() wire shape, and the onOpen handshake's initial
// op:"agents"/op:"ping" fetch (mirrors the peers() coverage above).
describe("createWsClient agents/ping (U1)", () => {
  test("agents sends {op:'agents'} and resolves the agents list", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.agents();
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({ op: "agents" });

    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        agents: [
          {
            pid: 1,
            cwd: "/repo",
            kind: "interactive",
            startedAt: 1,
            sessionId: "s1",
            config_dir: "/home/.claude",
          },
        ],
        polled_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.agents).toHaveLength(1);
  });

  test("ping sends {op:'ping'} and resolves exe/script/version", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.ping();
    expect(JSON.parse(ws1.sent[0] ?? "")).toEqual({ op: "ping" });

    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        pong: true,
        version: "0.19.0",
        uptime: 10,
        pid: 999,
        rooms: 0,
        clients: 1,
        exe: "/usr/local/bin/bun",
        script: "/repos/claude-ccmsg/main/packages/daemon/src/index.ts",
        http: [],
        httpAllow: [],
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.script).toBe("/repos/claude-ccmsg/main/packages/daemon/src/index.ts");
    }
  });

  // The onOpen handshake (hello -> rooms -> subscribe -> peers -> agents ->
  // ping) dispatches agents/loaded and daemon-info/loaded once the sockets
  // "answer" each request in order — this drives the whole handshake through
  // a live-ish mock instead of calling the two ops directly, to guard the
  // wiring in onOpen itself (a regression there wouldn't show up in the two
  // unit tests above, which call agents()/ping() standalone).
  test("onOpen handshake dispatches agents/loaded and daemon-info/loaded after peers", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;

    // Drive onOpen by firing its own "open" listener (readyState is already
    // OPEN above so send() inside onOpen will succeed).
    ws1.triggerOpen();

    // Each `await send(...)` in onOpen only resumes (and issues the *next*
    // send()) on a microtask tick after its reply settles — triggerMessage()
    // resolves synchronously but the continuation runs later, so a
    // triggerMessage() fired before that continuation has run lands on an
    // empty `pending` queue and is silently dropped (settle?.() no-ops).
    // `tick()` flushes enough microtasks between each reply for onOpen to
    // reach its next `await send(...)` before the next message arrives.
    const tick = () => Promise.resolve().then(() => Promise.resolve());

    // hello
    ws1.triggerMessage(JSON.stringify({ ok: true, version: "0.19.0" }));
    await tick();
    // rooms
    ws1.triggerMessage(JSON.stringify({ ok: true, rooms: [] }));
    await tick();
    // subscribe
    ws1.triggerMessage(JSON.stringify({ ok: true, subscribed: true }));
    await tick();
    // peers
    ws1.triggerMessage(JSON.stringify({ ok: true, peers: [] }));
    await tick();
    // agents
    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        agents: [
          {
            pid: 1,
            cwd: "/repo",
            kind: "interactive",
            startedAt: 1,
            sessionId: "s1",
            config_dir: "/home/.claude",
          },
        ],
        polled_at: null,
      }),
    );
    await tick();
    // ping
    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        pong: true,
        version: "0.19.0",
        uptime: 1,
        pid: 1,
        rooms: 0,
        clients: 1,
        exe: "/usr/local/bin/bun",
        script: "entry.ts",
        http: [],
        httpAllow: [],
      }),
    );
    await tick();

    const agentsAction = actions.find((a) => a.type === "agents/loaded");
    const daemonAction = actions.find((a) => a.type === "daemon-info/loaded");
    expect(agentsAction).toBeDefined();
    expect(daemonAction).toBeDefined();
    if (agentsAction?.type === "agents/loaded") expect(agentsAction.agents).toHaveLength(1);
    if (daemonAction?.type === "daemon-info/loaded") expect(daemonAction.script).toBe("entry.ts");
  });

  test("ev:'agents' push dispatches agents/loaded (live update, no request needed)", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    ws1.triggerMessage(
      JSON.stringify({
        ev: "agents",
        agents: [
          {
            pid: 2,
            cwd: "/repo2",
            kind: "background",
            startedAt: 2,
            sessionId: "s2",
            config_dir: "/home/.claude",
          },
        ],
        polled_at: "2026-07-11T00:00:00.000Z",
      }),
    );

    expect(actions).toEqual([
      {
        type: "agents/loaded",
        agents: [
          {
            pid: 2,
            cwd: "/repo2",
            kind: "background",
            startedAt: 2,
            sessionId: "s2",
            config_dir: "/home/.claude",
          },
        ],
      },
    ]);
  });
});

// U2 live-tail addendum (DR-0009): ev:"transcript" pushes relayed as
// timeline/tail actions, mirroring the ev:"agents" coverage above.
describe("createWsClient transcript live-tail push (U2)", () => {
  test("ev:'transcript' push dispatches timeline/tail with the wire fields verbatim", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    ws1.triggerMessage(
      JSON.stringify({
        ev: "transcript",
        sid: "sess-1",
        lines: ['{"type":"user"}'],
        start: 100,
        end: 130,
        size: 130,
      }),
    );

    expect(actions).toEqual([
      {
        type: "timeline/tail",
        sid: "sess-1",
        lines: ['{"type":"user"}'],
        start: 100,
        end: 130,
        size: 130,
      },
    ]);
  });

  // Multiple lines in one push (the daemon batches contiguous appends) must
  // all reach the dispatched action, not just the first.
  test("ev:'transcript' push with multiple lines carries all of them", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = instances[0];
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    ws1.triggerMessage(
      JSON.stringify({
        ev: "transcript",
        sid: "sess-1",
        lines: ["line-a", "line-b", "line-c"],
        start: 0,
        end: 50,
        size: 50,
      }),
    );

    const action = actions[0];
    expect(action?.type).toBe("timeline/tail");
    if (action?.type === "timeline/tail")
      expect(action.lines).toEqual(["line-a", "line-b", "line-c"]);
  });
});
