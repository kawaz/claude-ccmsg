// Guards against the pending-resolver leak found in codex review (2026-07-10,
// Minor 3, see docs/findings/2026-07-10-codex-review-evaluation.md): send()
// registers a resolver in `pending` before the response arrives; if the socket
// closes before a reply comes back, that resolver used to sit forever
// (Composer's awaited Promise hangs), and a *later* reconnected socket's reply
// could be mis-delivered to the stale resolver through a reused request_id.
// These tests exercise createWsClient against a
// minimal in-memory WebSocket mock (bun's runtime has no DOM globals, so
// WebSocket/location/localStorage are stubbed for the duration of the file).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createWsClient,
  KEEPALIVE_CHECK_MS,
  KEEPALIVE_IDLE_MS,
  KEEPALIVE_TIMEOUT_MS,
  RECONNECT_DELAYS_MS,
  USER_PROMPT_REPLY_TIMEOUT_MS,
} from "../src/client/ws.ts";
import type { Action } from "../src/client/store.ts";
import {
  parseWith,
  PROTOCOL_VERSION,
  VERSION,
  type JsonObject,
  type JsonValue,
  type Request,
  type RequestOp,
} from "@ccmsg/protocol";
import {
  defined,
  FakeClock,
  instanceOf,
  JsonObjectTextSchema,
  jsonObjectOf,
  requestOf,
  stubGlobal,
} from "./helpers.ts";
import { fullSessionStatusSnapshot } from "./session-status-fixture.ts";

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
  /** Deliver one frame to the client. A reply frame (`ok`, no `ev`) that does
   * not name a request is addressed to the oldest request this mock has not
   * answered yet — the ordinary case, where a test just wants "the answer to
   * what I asked". Tests about correlation itself (out-of-order replies) put
   * an explicit `request_id` in the frame and this leaves it alone. */
  triggerMessage(data: string): void {
    let frame = data;
    const read = parseWith(JsonObjectTextSchema, data);
    const obj = read.ok ? read.value : undefined;
    const isReply = obj !== undefined && Object.hasOwn(obj, "ok") && !Object.hasOwn(obj, "ev");
    if (isReply && Object.hasOwn(obj, "request_id")) {
      const rid = obj.request_id;
      if (typeof rid === "string") this.answered.add(rid);
    } else if (isReply) {
      const rid = this.sentRequestIds().find((id) => !this.answered.has(id));
      if (rid !== undefined) {
        this.answered.add(rid);
        frame = JSON.stringify({ ...obj, request_id: rid });
      }
    }
    for (const cb of this.listeners.message ?? []) cb({ data: frame });
  }
  private sentRequestIds(): string[] {
    return this.sent.flatMap((line) => {
      const id = jsonObjectOf(line).request_id;
      return typeof id === "string" ? [id] : [];
    });
  }
  /** request_ids already answered, so the next unaddressed reply moves on to
   * the next outstanding request instead of re-answering this one. */
  private answered = new Set<string>();

  /** Answer the request of `op` this mock has not answered yet, naming it by
   * its request_id — so a test drives the client by what it asked, whatever
   * else it asked before or alongside. */
  replyTo(op: RequestOp, reply: JsonObject): void {
    const request = this.sent
      .map(requestOf)
      .find((sent) => sent.op === op && !this.answered.has(sent.request_id));
    if (request === undefined) throw new Error(`no unanswered ${op} request`);
    this.triggerMessage(JSON.stringify({ ...reply, request_id: request.request_id }));
  }

  triggerClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    for (const cb of this.listeners.close ?? []) cb(undefined);
  }

  // U1: fires the "open" listener connect() registers, so a test can drive
  // createWsClient's actual onOpen handshake (hello -> subscribe ->
  // peers -> agents -> ping) instead of only exercising the standalone
  // send()-wrapper methods (agents()/ping()/peers()/...) directly.
  triggerOpen(): void {
    for (const cb of this.listeners.open ?? []) cb(undefined);
  }
}

/** The ops of the frames this socket sent, oldest first. */
function opsSent(ws: MockWebSocket): JsonValue[] {
  return ws.sent.map((line) => defined(jsonObjectOf(line).op, "the op of a sent frame"));
}

/** The one frame this socket sent for `op`, every field as written; none, or
 * more than one, fails the test. Frames are found by what they ask for, not
 * by where they fall among the others. */
function sentFrame(ws: MockWebSocket, op: RequestOp): JsonObject {
  const frames = ws.sent.map(jsonObjectOf).filter((frame) => frame.op === op);
  if (frames.length !== 1) throw new Error(`expected one ${op} frame, got ${frames.length}`);
  return defined(frames[0], `the ${op} frame`);
}

/** `sentFrame` without its correlation envelope — so a test can assert the
 * exact wire body (excess fields included) without restating the request_id
 * the client stamps on every request. */
function sentBody(ws: MockWebSocket, op: RequestOp): JsonObject {
  const { request_id: _rid, ...body } = sentFrame(ws, op);
  return body;
}

/** The requests this socket sent for `op`, oldest first, read as the daemon
 * would read them. */
function sentRequests<Op extends RequestOp>(
  ws: MockWebSocket,
  op: Op,
): Extract<Request, { op: Op }>[] {
  return ws.sent
    .map(requestOf)
    .filter((request): request is Extract<Request, { op: Op }> => request.op === op);
}

/** The one request this socket sent for `op`; none, or more than one, fails
 * the test. */
function sentRequest<Op extends RequestOp>(
  ws: MockWebSocket,
  op: Op,
): Extract<Request, { op: Op }> {
  const requests = sentRequests(ws, op);
  if (requests.length !== 1) throw new Error(`expected one ${op} request, got ${requests.length}`);
  return defined(requests[0], `the ${op} request`);
}

/** Whether `promise` has settled once every promise job already queued has
 * run — for asserting that a wait has not run out yet. */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  void promise.then(mark, mark);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return settled;
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
let restoreGlobals: (() => void)[] = [];

// location.reload() は実行せずここを数えるだけにして、テストプロセスが実
// ページ遷移を試みないようにする (version-guard がページを捨てないことの確認)。
let reloads = 0;
let sessionStore: Record<string, string> = {};

// Every handle created in a test is closed in afterEach even if the test
// fails mid-way: close() also cancels the client's scheduled auto-reconnect
// timer, which would otherwise fire *after* the mocks are torn down and blow
// up an unrelated later test file with "location is not defined".
let openHandles: Array<{ close(): void }> = [];

beforeEach(() => {
  instances = [];
  storage = {};
  openHandles = [];
  restoreGlobals = [stubGlobal("WebSocket", MockWebSocket)];
  reloads = 0;
  sessionStore = {};
  restoreGlobals.push(
    stubGlobal("location", {
      protocol: "http:",
      host: "localhost:8642",
      reload: () => {
        reloads++;
      },
    }),
  );
  restoreGlobals.push(
    stubGlobal("sessionStorage", {
      getItem: (k: string) => sessionStore[k] ?? null,
      setItem: (k: string, v: string) => {
        sessionStore[k] = v;
      },
    }),
  );
  restoreGlobals.push(
    stubGlobal("localStorage", {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => {
        storage[k] = v;
      },
    }),
  );
});

afterEach(() => {
  for (const handle of openHandles) handle.close();
  for (const restore of restoreGlobals.reverse()) restore();
});

describe("createWsClient keepalive", () => {
  test("an open socket that receives nothing is pinged and replaced when the ping also gets no reply", () => {
    const clock = new FakeClock();
    const handle = createWsClient(() => {}, { clock });
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;
    ws1.triggerOpen();
    const ops = () => ws1.sent.map((raw) => jsonObjectOf(raw).op);

    // The hello handshake itself is deliberately left unanswered: a silently
    // dead TCP/WebSocket can remain OPEN locally while delivering no daemon
    // frames. Keepalive must not depend on the handshake Promise settling.
    clock.advance(KEEPALIVE_IDLE_MS - 1);
    expect(ops()).not.toContain("ping");

    // Idle for the full span: pinged by the next check, and the socket stays
    // while the ping still has time to be answered.
    clock.advance(KEEPALIVE_CHECK_MS);
    expect(ops()).toContain("ping");
    expect(ws1.readyState).toBe(MockWebSocket.OPEN);
    expect(instances).toHaveLength(1);

    // The ping's own wait runs out: the socket is closed and a new one opened.
    clock.advance(KEEPALIVE_TIMEOUT_MS);
    expect(ws1.readyState).toBe(MockWebSocket.CLOSED);
    expect(instances).toHaveLength(2);
  });
});

describe("createWsClient pending queue on close/reconnect", () => {
  test("onClose settles in-flight requests instead of hanging their Promise forever", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    // Skip the onOpen hello/subscribe/peers handshake chain (not the
    // concern of this test); just mark the socket open enough for send() to
    // accept a request.
    ws1.readyState = MockWebSocket.OPEN;

    const pendingReq = handle.peers();
    expect(opsSent(ws1)).toEqual(["peers"]); // the request really went out

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
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    // A request is in flight on the old socket, but connect() is invoked
    // again (simulating a reconnect path) before onClose ever ran.
    const stale = handle.peers();
    expect(opsSent(ws1)).toEqual(["peers"]);

    handle.connect();
    const ws2 = defined(instances[1], "the second socket");

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
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.fsList("sess-1");
    expect(sentBody(ws1, "fs_list")).toEqual({ op: "fs_list", sid: "sess-1" });

    ws1.triggerMessage(JSON.stringify({ ok: true, sid: "sess-1", path: "", entries: [] }));
    const res = await req;
    expect(res.ok).toBe(true);
  });

  test("fsList sends {op:'fs_list', sid, path} when a subdirectory path is given", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    void handle.fsList("sess-1", "src");
    expect(sentBody(ws1, "fs_list")).toEqual({
      op: "fs_list",
      sid: "sess-1",
      path: "src",
    });
  });

  test("fsRead sends {op:'fs_read', sid, path} and resolves the file response", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.fsRead("sess-1", "README.md");
    expect(sentBody(ws1, "fs_read")).toEqual({
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
        mtime: "2026-01-01T00:00:00.000Z",
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toBe("hello");
  });

  test("fsReadExternal sends the exact DR-0024 absolute allowlist path", async () => {
    // No path rewriting or root joining occurs client-side; the daemon owns all
    // exact-match/realpath authorization for the absolute path.
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const externalPath = "/external/shared.md";
    const req = handle.fsReadExternal("sess-1", externalPath);
    expect(sentBody(ws1, "fs_read_external")).toEqual({
      op: "fs_read_external",
      sid: "sess-1",
      path: externalPath,
    });
    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        sid: "sess-1",
        path: externalPath,
        size: 5,
        truncated: false,
        binary: false,
        content: "hello",
        mtime: "2026-01-01T00:00:00.000Z",
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
  });

  // DR-0009: transcript_read wire shape. `before`/`max_bytes` are only sent
  // when the caller actually passed them, mirroring fsList's "omit path when
  // absent" minimal-request convention above.
  test("transcriptRead sends {op:'transcript_read', sid} without before/max_bytes when opts is omitted", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.transcriptRead("sess-1");
    expect(sentBody(ws1, "transcript_read")).toEqual({ op: "transcript_read", sid: "sess-1" });

    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        sid: "sess-1",
        lines: ["a"],
        start: 0,
        end: 2,
        size: 2,
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.lines).toEqual(["a"]);
  });

  test("transcriptRead sends {op:'transcript_read', sid, before} when paging older", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    void handle.transcriptRead("sess-1", { before: 100 });
    expect(sentBody(ws1, "transcript_read")).toEqual({
      op: "transcript_read",
      sid: "sess-1",
      before: 100,
    });
  });

  test("transcriptRead sends max_bytes only when explicitly passed", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    void handle.transcriptRead("sess-1", { before: 100, max_bytes: 4096 });
    expect(sentBody(ws1, "transcript_read")).toEqual({
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
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.transcriptSubscribe("sess-1");
    expect(sentBody(ws1, "transcript_subscribe")).toEqual({
      op: "transcript_subscribe",
      sid: "sess-1",
    });

    ws1.triggerMessage(JSON.stringify({ ok: true, sid: "sess-1", size: 200 }));
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.size).toBe(200);
  });

  test("transcriptUnsubscribe sends {op:'transcript_unsubscribe', sid}", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.transcriptUnsubscribe("sess-1");
    expect(sentBody(ws1, "transcript_unsubscribe")).toEqual({
      op: "transcript_unsubscribe",
      sid: "sess-1",
    });

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
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    handle.connect(); // reconnect path; ws1 is now stale (and already closed)
    const ws2 = defined(instances[1], "the second socket");
    ws2.readyState = MockWebSocket.OPEN;

    const fresh = handle.peers();
    expect(opsSent(ws2)).toEqual(["peers"]);

    // A reply arrives late on the discarded socket. Without the `socket !==
    // ws` guard this would incorrectly settle `fresh` from the stale socket.
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
  // queued: an unexpected close schedules a reconnect after the first
  // RECONNECT_DELAYS_MS slot, and a close() arriving in that window cancels
  // it — otherwise the client would silently resurrect itself.
  test("close() cancels an already-scheduled auto-reconnect", () => {
    const clock = new FakeClock();
    const handle = createWsClient(() => {}, { clock });
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    ws1.triggerClose(); // unexpected drop -> reconnect scheduled
    handle.close(); // user says stop before the reconnect runs

    clock.advance(Math.max(...RECONNECT_DELAYS_MS));
    expect(instances).toHaveLength(1); // no resurrected socket
  });

  // The counterpart that keeps the test above from passing on a client that
  // never reconnects at all.
  test("an unexpected close reconnects after the first reconnect delay", () => {
    const clock = new FakeClock();
    const handle = createWsClient(() => {}, { clock });
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    ws1.triggerClose();
    const firstDelay = defined(RECONNECT_DELAYS_MS[0], "the first reconnect delay");
    clock.advance(firstDelay - 1);
    expect(instances).toHaveLength(1);
    clock.advance(1);
    expect(instances).toHaveLength(2);
  });

  test("a request made while connecting is sent after hello when the socket opens", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    expect(ws1.readyState).toBe(MockWebSocket.CONNECTING);

    const queued = handle.fsList("sess-1");
    expect(opsSent(ws1)).toEqual([]);

    ws1.readyState = MockWebSocket.OPEN;
    ws1.triggerOpen();
    expect(sentBody(ws1, "hello")).toEqual({
      op: "hello",
      role: "user",
      client_version: VERSION,
      protocol: 1,
      // no nav_type: the test runner has no navigation entry, and the UA it
      // does have is not a browser this summary knows.
      ua: "other/other",
    });
    expect(sentBody(ws1, "fs_list")).toEqual({ op: "fs_list", sid: "sess-1" });
    const ops = opsSent(ws1);
    expect(ops.indexOf("fs_list")).toBeGreaterThan(ops.indexOf("hello"));

    const queuedRid = sentRequest(ws1, "fs_list").request_id;
    ws1.triggerMessage(
      JSON.stringify({ ok: true, sid: "sess-1", path: "", entries: [], request_id: queuedRid }),
    );
    const result = await queued;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toEqual([]);
  });

  test("a request made while connecting rejects if that socket closes", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");

    const queued = handle.fsRead("sess-1", "README.md");
    ws1.triggerClose();

    let caught: unknown;
    try {
      await queued;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(instanceOf(caught, Error, "the rejection").message).toBe("ws connection closed");
  });

  // The room logs are read-only (DR-0036 §2): the list and one log are the
  // two reads the room views make.
  test("rooms sends {op:'rooms'} and resolves the summaries", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.rooms();
    expect(sentBody(ws1, "rooms")).toEqual({ op: "rooms" });
    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        rooms: [{ id: "r1", members: [], last_mid: 2, last_ts: "2026-10-01T00:00:00.000Z" }],
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rooms.map((r) => r.id)).toEqual(["r1"]);
  });

  test("roomHistory sends {op:'room_history', room} and resolves the log's events", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.roomHistory("r1");
    expect(sentBody(ws1, "room_history")).toEqual({ op: "room_history", room: "r1" });
    const msg = {
      type: "msg" as const,
      mid: 1,
      from: "a1",
      ts: "2026-10-01T00:00:00.000Z",
      msg: "hi",
    };
    ws1.triggerMessage(JSON.stringify({ ok: true, room: "r1", events: [msg] }));
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events).toEqual([msg]);
  });

  test("stale socket's delayed close does not re-trigger disconnect/reconnect for the new connection", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    handle.connect();
    const ws2 = defined(instances[1], "the second socket");
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
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.agents();
    expect(sentBody(ws1, "agents")).toEqual({ op: "agents" });

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
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.ping();
    expect(sentBody(ws1, "ping")).toEqual({ op: "ping" });

    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        pong: true,
        version: "0.19.0",
        uptime: 10,
        pid: 999,
        clients: 1,
        exe: "/usr/local/bin/bun",
        script: "/repos/claude-ccmsg/main/packages/daemon/src/index.ts",
        http: [],
        httpAllow: [],
        network: "online",
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.script).toBe("/repos/claude-ccmsg/main/packages/daemon/src/index.ts");
    }
  });

  // The wire request carries a client-generated request_id and the Promise
  // settles from the correlated reply — order/per-item failures preserved.
  test("translate sends the texts batch with a request_id and resolves from the reply", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.translate(["English.日本語。", "Second."]);
    const sent = sentFrame(ws1, "translate");
    expect(sent).toEqual({
      op: "translate",
      request_id: defined(sent.request_id, "the request id of the translate frame"),
      texts: ["English.日本語。", "Second."],
    });
    expect(sent.request_id).not.toBe("");
    ws1.triggerMessage(
      JSON.stringify({
        request_id: sent.request_id,
        ok: true,
        results: [
          { ok: true, text: "英語。日本語。" },
          { ok: false, error: "TranslationError.notInstalled" },
        ],
      }),
    );

    const response = await req;
    expect(response).toEqual({
      ok: true,
      results: [
        { ok: true, text: "英語。日本語。" },
        { ok: false, error: "TranslationError.notInstalled" },
      ],
    });
  });

  // session_rename is a slow op like translate; its reply pairs by
  // request_id the same way.
  test("sessionRename sends the title with a request_id and resolves from the reply", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.sessionRename("sid-1", "新しいタイトル");
    const sent = sentFrame(ws1, "session_rename");
    expect(sent).toEqual({
      op: "session_rename",
      request_id: defined(sent.request_id, "the request id of the session_rename frame"),
      session_id: "sid-1",
      title: "新しいタイトル",
    });

    ws1.triggerMessage(
      JSON.stringify({
        request_id: sent.request_id,
        ok: true,
        hyoui_session_id: "run-abc",
        title: "新しいタイトル",
      }),
    );

    expect(await req).toEqual({
      ok: true,
      hyoui_session_id: "run-abc",
      title: "新しいタイトル",
    });
  });

  // DR-0035 §1: the input panel sends the text verbatim as user_prompt (no
  // room is created or posted to) and the daemon's answer pairs by request_id.
  test("userPrompt sends user_prompt with the text and resolves from the reply", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.userPrompt("sid-1", "1 行目\n2 行目");
    expect(opsSent(ws1)).toEqual(["user_prompt"]);
    const sent = sentFrame(ws1, "user_prompt");
    expect(sent).toEqual({
      op: "user_prompt",
      request_id: defined(sent.request_id, "the request id of the user_prompt frame"),
      session_id: "sid-1",
      text: "1 行目\n2 行目",
    });

    ws1.triggerMessage(
      JSON.stringify({
        request_id: sent.request_id,
        ok: true,
        outcome: "not_delivered",
        reason: "dialog",
      }),
    );
    expect(await req).toEqual({ ok: true, outcome: "not_delivered", reason: "dialog" });
  });

  // A user_prompt written before the socket closed settles with
  // connection_closed — the panel reads that as "maybe delivered", not as a
  // failure, so this must not hang or reject.
  test("userPrompt written before a close settles with connection_closed", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.userPrompt("sid-1", "hello");
    expect(opsSent(ws1)).toEqual(["user_prompt"]);
    ws1.triggerClose();

    expect(await req).toEqual({
      ok: false,
      error: { code: "connection_closed", msg: "ws connection closed" },
    });
  });

  // A written user_prompt whose answer never comes on a socket that stays
  // open settles with request_timeout once its own deadline passes, so the
  // input panel's lock is released; the late answer is then dropped.
  test("userPrompt settles with request_timeout when no reply comes", async () => {
    const clock = new FakeClock();
    const handle = createWsClient(() => {}, { clock });
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.userPrompt("sid-1", "hello");
    const sent = sentRequest(ws1, "user_prompt");
    clock.advance(USER_PROMPT_REPLY_TIMEOUT_MS - 1);
    expect(await settledNow(req)).toBe(false);
    clock.advance(1);
    expect(await req).toEqual({
      ok: false,
      error: {
        code: "request_timeout",
        msg: `no reply within ${USER_PROMPT_REPLY_TIMEOUT_MS} ms`,
      },
    });
    // The late answer has nothing left to settle and must not throw.
    ws1.triggerMessage(
      JSON.stringify({ request_id: sent.request_id, ok: true, outcome: "accepted" }),
    );
  });

  // A reply inside the deadline wins; the deadline firing afterwards changes
  // nothing.
  test("userPrompt resolves from a reply that beats its deadline", async () => {
    const clock = new FakeClock();
    const handle = createWsClient(() => {}, { clock });
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.userPrompt("sid-1", "hello");
    const sent = sentRequest(ws1, "user_prompt");
    clock.advance(USER_PROMPT_REPLY_TIMEOUT_MS - 1);
    ws1.triggerMessage(
      JSON.stringify({ request_id: sent.request_id, ok: true, outcome: "accepted" }),
    );
    expect(await req).toEqual({ ok: true, outcome: "accepted" });
    // The deadline passing afterwards has nothing left to settle.
    clock.advance(USER_PROMPT_REPLY_TIMEOUT_MS);
  });

  // Still queued behind a connecting socket at the deadline means it was never
  // sent: it rejects (the panel reads that as "could not send") and is not
  // written when the socket opens later.
  test("userPrompt still queued at its deadline rejects and is never written", async () => {
    const clock = new FakeClock();
    const handle = createWsClient(() => {}, { clock });
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    expect(ws1.readyState).toBe(MockWebSocket.CONNECTING);

    const req = handle.userPrompt("sid-1", "hello");
    clock.advance(USER_PROMPT_REPLY_TIMEOUT_MS - 1);
    expect(await settledNow(req)).toBe(false);
    clock.advance(1);
    let rejected: unknown = null;
    try {
      await req;
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(instanceOf(rejected, Error, "the rejection").message).toBe("ws not open");
    ws1.readyState = MockWebSocket.OPEN;
    ws1.triggerOpen();
    expect(opsSent(ws1)).not.toContain("user_prompt");
  });

  // The failure path the row's editor renders inline.
  test("sessionRename surfaces a terminal_unavailable reply as an error", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.sessionRename("sid-1", "t");
    const sent = sentRequest(ws1, "session_rename");
    ws1.triggerMessage(
      JSON.stringify({
        request_id: sent.request_id,
        ok: false,
        error: { code: "terminal_unavailable", msg: "no known terminal" },
      }),
    );

    const res = await req;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("terminal_unavailable");
  });

  // THE regression correlated replies fix: while a slow
  // translate is in flight, a later op's reply must pair with that later op,
  // so nothing is held back and nothing is mis-paired.
  test("a later op's reply resolves while a translate is still outstanding", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const slow = handle.translate(["slow text"]);
    const quick = handle.ping();
    const sentTranslate = sentRequest(ws1, "translate");
    const sentPing = sentRequest(ws1, "ping");
    // ping's reply comes back first — the daemon is no longer gating the
    // connection on the running translation. Named explicitly so it cannot be
    // mis-paired with the translate that is still running.
    ws1.triggerMessage(
      JSON.stringify({
        request_id: sentPing.request_id,
        ok: true,
        pong: true,
        version: "0",
        uptime: 0,
        pid: 1,
        clients: 1,
        exe: "",
        script: "",
        http: [],
        httpAllow: [],
        network: "online",
      }),
    );

    const pingRes = await quick;
    expect(pingRes).toMatchObject({ ok: true, pong: true });

    // translate's Promise is still unsettled; its late reply resolves it.
    ws1.triggerMessage(
      JSON.stringify({
        request_id: sentTranslate.request_id,
        ok: true,
        results: [{ ok: true, text: "遅い" }],
      }),
    );
    const slowRes = await slow;
    expect(slowRes).toEqual({
      ok: true,
      results: [{ ok: true, text: "遅い" }],
    });
  });

  // Two concurrent translates: replies may arrive in ANY order (the daemon
  // answers each as its helper batch finishes) and must pair strictly by
  // request_id, not arrival order.
  test("concurrent translates pair replies by request_id, not arrival order", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const first = handle.translate(["first"]);
    const second = handle.translate(["second"]);
    const ridOf = (text: string) =>
      defined(
        sentRequests(ws1, "translate").find((request) => request.texts[0] === text),
        `the translate of ${text}`,
      ).request_id;
    const rid1 = ridOf("first");
    const rid2 = ridOf("second");
    expect(rid1).not.toBe(rid2);
    // second finishes first — cross order on purpose.
    ws1.triggerMessage(
      JSON.stringify({
        request_id: rid2,
        ok: true,
        results: [{ ok: true, text: "二番" }],
      }),
    );
    ws1.triggerMessage(
      JSON.stringify({
        request_id: rid1,
        ok: true,
        results: [{ ok: true, text: "一番" }],
      }),
    );

    expect(await first).toEqual({
      ok: true,
      results: [{ ok: true, text: "一番" }],
    });
    expect(await second).toEqual({
      ok: true,
      results: [{ ok: true, text: "二番" }],
    });
  });

  // Disconnect while a slow op is still running: flushPending must settle it
  // with connection_closed instead of leaving the Promise (and a Map entry)
  // behind forever.
  test("close settles an unanswered translate with connection_closed", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.translate(["never finishes"]);
    ws1.triggerClose();

    const res = await req;
    expect(res).toEqual({
      ok: false,
      error: { code: "connection_closed", msg: "ws connection closed" },
    });
  });

  // Synchronous validation failure (e.g. invalid_args): the reply IS the
  // error, and the Promise settles from it like any other reply.
  test("a validation-error reply settles a slow op directly", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.translate(["bad"]);
    ws1.triggerMessage(
      JSON.stringify({
        ok: false,
        error: { code: "invalid_args", msg: "nope" },
      }),
    );
    expect(await req).toEqual({
      ok: false,
      error: { code: "invalid_args", msg: "nope" },
    });

    // The lane is clean afterwards: a following ordinary op pairs correctly.
    const ping = handle.ping();
    ws1.triggerMessage(
      JSON.stringify({
        ok: true,
        pong: true,
        version: "0",
        uptime: 0,
        pid: 1,
        clients: 1,
        exe: "",
        script: "",
        http: [],
        httpAllow: [],
        network: "online",
      }),
    );
    expect(await ping).toMatchObject({ ok: true, pong: true });
  });

  // DR-0021 Phase 2: sessionSearch's wire shape — params (excluding op and
  // the 2-phase request_id, both added by the wrapper) pass through
  // untouched (same convention as fsList/transcriptRead's option-object
  // callers), and the Promise resolves from the correlated result event.
  test("sessionSearch sends {op:'session_search', ...params} and resolves hits from the reply", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;

    const req = handle.sessionSearch({
      query: "foo\nbar",
      case_sensitive: true,
      regex: true,
      mtime_within: "2h",
    });
    const sent = sentFrame(ws1, "session_search");
    expect(sent).toEqual({
      op: "session_search",
      request_id: defined(sent.request_id, "the request id of the session_search frame"),
      query: "foo\nbar",
      case_sensitive: true,
      regex: true,
      mtime_within: "2h",
    });

    ws1.triggerMessage(
      JSON.stringify({
        request_id: sent.request_id,
        ok: true,
        hits: [
          {
            sid: "11111111-2222-3333-4444-555555555555",
            config_dir: "/home/.claude",
            file: "/home/.claude/projects/x/11111111-2222-3333-4444-555555555555.jsonl",
            cwd: "/repos/claude-ccmsg/main",
            repo: "kawaz/claude-ccmsg",
            ws: "main",
            title: "",
            created_at: "2026-07-10T00:00:00.000Z",
            updated_at: "2026-07-15T00:00:00.000Z",
            size: 2048,
            matches: [{ role: "user", text: "foo bar baz" }],
          },
        ],
        truncated: false,
      }),
    );
    const res = await req;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hits).toHaveLength(1);
      expect(res.truncated).toBe(false);
    }
  });

  // The onOpen handshake (hello, subscribe, peers, agents,
  // session_errors, ping, translate capability) dispatches the initial
  // daemon-backed state once the socket answers each request — this drives the
  // whole handshake through a live-ish mock instead of calling the ops
  // directly, to guard the wiring in onOpen itself (a regression there wouldn't
  // show up in the unit tests above, which call agents()/ping() standalone).
  test("onOpen handshake dispatches daemon state and host translation availability", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
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

    ws1.replyTo("hello", { ok: true, version: "0.19.0", protocol: PROTOCOL_VERSION });
    await tick();
    ws1.replyTo("subscribe", { ok: true, subscribed: true });
    await tick();
    ws1.replyTo("peers", { ok: true, peers: [] });
    await tick();
    ws1.replyTo("agents", {
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
    });
    await tick();
    // One connected session stopped on a harness API error.
    ws1.replyTo("session_errors", {
      ok: true,
      errors: [
        {
          sid: "s1",
          text: "API Error: 500",
          timestamp: "2026-07-27T09:00:00Z",
        },
      ],
    });
    await tick();
    ws1.replyTo("ping", {
      ok: true,
      pong: true,
      version: "0.19.0",
      uptime: 1,
      pid: 1,
      clients: 1,
      exe: "/usr/local/bin/bun",
      script: "entry.ts",
      http: [],
      httpAllow: [],
      network: "online",
    });
    await tick();
    // empty-batch host translation capability probe: one reply carries the
    // outcome.
    const probe = sentFrame(ws1, "translate");
    expect(probe).toEqual({
      op: "translate",
      request_id: defined(probe.request_id, "the request id of the translate frame"),
      texts: [],
    });
    ws1.replyTo("translate", { ok: true, results: [] });
    await tick();

    const agentsAction = actions.find((a) => a.type === "agents/loaded");
    const errorsAction = actions.find((a) => a.type === "session-errors/loaded");
    const daemonAction = actions.find((a) => a.type === "daemon-info/loaded");
    const translatorAction = actions.find(
      (a) => a.type === "translator/availability" && a.host === true,
    );
    expect(agentsAction).toBeDefined();
    expect(errorsAction).toBeDefined();
    expect(daemonAction).toBeDefined();
    expect(translatorAction).toBeDefined();
    if (agentsAction?.type === "agents/loaded") expect(agentsAction.agents).toHaveLength(1);
    if (errorsAction?.type === "session-errors/loaded")
      expect(errorsAction.errors.map((e) => e.sid)).toEqual(["s1"]);
    if (daemonAction?.type === "daemon-info/loaded")
      expect(daemonAction.exe).toBe("/usr/local/bin/bun");
  });

  // Subscribe carries no room traffic and the room list is read only when the
  // sidebar's room fold is opened (DR-0036 §2), so the handshake goes straight
  // from hello to a bare subscribe, and never asks for the rooms.
  test("onOpen subscribes with no cursor and does not read the room list", async () => {
    const handle = createWsClient(() => {});
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;
    ws1.triggerOpen();

    const tick = () => Promise.resolve().then(() => Promise.resolve());
    ws1.replyTo("hello", { ok: true, version: "0.19.0", protocol: PROTOCOL_VERSION });
    await tick();

    expect(sentBody(ws1, "subscribe")).toEqual({ op: "subscribe" });
    expect(ws1.sent.map((raw) => jsonObjectOf(raw).op)).not.toContain("rooms");
  });

  test("ev:'agents' push dispatches agents/loaded (live update, no request needed)", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
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

  // U1: ev:"peers" push (issue 2026-07-12-peers-live-update-protocol) —
  // mirrors the ev:"agents" coverage above, dispatches into the same
  // peers/loaded action the one-shot op:"peers" reply in onOpen uses.
  test("ev:'peers' push dispatches peers/loaded (live update, no request needed)", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    ws1.triggerMessage(
      JSON.stringify({
        ev: "peers",
        peers: [
          {
            sid: "s2",
            repo: "repo2",
            ws: "main",
            cwd: "/repo2",
          },
        ],
      }),
    );

    expect(actions).toEqual([
      {
        type: "peers/loaded",
        peers: [
          {
            sid: "s2",
            repo: "repo2",
            ws: "main",
            cwd: "/repo2",
          },
        ],
      },
    ]);
  });

  // Mirrors the ev:"agents" coverage above: the push carries the full list
  // (never a delta) and folds into the same action the one-shot
  // op:"session_errors" reply in onOpen uses.
  test("ev:'session_errors' push dispatches session-errors/loaded", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    ws1.triggerMessage(
      JSON.stringify({
        ev: "session_errors",
        errors: [
          {
            sid: "s2",
            text: "Prompt is too long",
            timestamp: "2026-07-27T09:00:00Z",
          },
        ],
      }),
    );

    expect(actions).toEqual([
      {
        type: "session-errors/loaded",
        errors: [
          {
            sid: "s2",
            text: "Prompt is too long",
            timestamp: "2026-07-27T09:00:00Z",
          },
        ],
      },
    ]);
  });

  // An empty list is the "every session recovered" push — it must still reach
  // the reducer, otherwise a cleared error would leave the sidebar red forever.
  test("ev:'session_errors' with an empty list still dispatches (clears the set)", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    ws1.triggerMessage(JSON.stringify({ ev: "session_errors", errors: [] }));

    expect(actions).toEqual([{ type: "session-errors/loaded", errors: [] }]);
  });

  // The say records (DR-0036 §3) come as the full set, and an empty set is
  // what a restarted daemon sends: it must still reach the reducer, or the old
  // daemon's unread 📣 would stay on the sidebar.
  test("ev:'says' push dispatches says/loaded, an empty set included", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    const say = { id: "i/1", sid: "s2", text: "hello", ts: "2026-10-13T00:00:00Z", read: false };
    ws1.triggerMessage(JSON.stringify({ ev: "says", says: [say] }));
    ws1.triggerMessage(JSON.stringify({ ev: "says", says: [] }));

    expect(actions).toEqual([
      { type: "says/loaded", says: [say] },
      { type: "says/loaded", says: [] },
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
    const ws1 = defined(instances[0], "the first socket");
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
    const ws1 = defined(instances[0], "the first socket");
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

// DR-0020 Phase 2: ev:"session_status" pushes relayed as session-status/loaded
// actions, mirroring the ev:"transcript" coverage above. The push carries the
// snapshot fields inline (ev/sid + status snapshot); the relay hands every
// snapshot field to the reducer, the same path the subscribe response's own
// initial dispatch takes (SessionView).
describe("createWsClient session_status push (DR-0020)", () => {
  test("ev:'session_status' push dispatches session-status/loaded with every snapshot field", () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[0], "the first socket");
    ws1.readyState = MockWebSocket.OPEN;
    actions.length = 0;

    const snapshot = fullSessionStatusSnapshot();
    ws1.triggerMessage(JSON.stringify({ ev: "session_status", sid: "sess-1", ...snapshot }));

    expect(actions).toEqual([{ type: "session-status/loaded", sid: "sess-1", snapshot }]);
  });
});

// 古い bundle のまま新 daemon と喋り続けるタブを畳む (issue 2026-09-03)。
// 判定そのものの分岐は version-guard.test.ts が持つので、ここで見るのは
// 「onOpen の hello 応答が判定に繋がっていて、接続のたびに通る」こと。
describe("createWsClient daemon version guard", () => {
  /** hello だけ返して onOpen の version 判定を通す (以降の handshake の
   *  応答は判定に関与しないので返さない)。 */
  async function helloWith(version: string, dispatch: (a: Action) => void): Promise<void> {
    const handle = createWsClient(dispatch);
    openHandles.push(handle);
    handle.connect();
    const ws1 = defined(instances[instances.length - 1], "the latest socket");
    ws1.readyState = MockWebSocket.OPEN;
    ws1.triggerOpen();
    ws1.replyTo("hello", { ok: true, version, protocol: PROTOCOL_VERSION });
    await Promise.resolve().then(() => Promise.resolve());
  }

  function newerThanBundle(): string {
    const major = Number.parseInt(VERSION.split(".")[0] ?? "0", 10);
    return `${major + 1}.0.0`;
  }

  test("bundle と同じ version の daemon にはリロードも通知もしない", async () => {
    const actions: Action[] = [];
    await helloWith(VERSION, (a) => actions.push(a));
    expect(reloads).toBe(0);
    expect(actions).toContainEqual({
      type: "version-mismatch/detected",
      mismatch: null,
    });
  });

  // 読み直す瞬間はユーザが決める。検出しても reload は 0 回で、導線だけが立つ。
  test("daemon の方が新しければ読み直さず導線だけ出す", async () => {
    const newer = newerThanBundle();
    const actions: Action[] = [];
    await helloWith(newer, (a) => actions.push(a));
    expect(reloads).toBe(0);
    expect(actions).toContainEqual({
      type: "version-mismatch/detected",
      mismatch: { daemonVersion: newer },
    });
  });
});
