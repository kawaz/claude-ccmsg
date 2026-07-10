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
}

let instances: MockWebSocket[] = [];
let storage: Record<string, string> = {};

beforeEach(() => {
  instances = [];
  storage = {};
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
  delete (globalThis as any).WebSocket;
  delete (globalThis as any).location;
  delete (globalThis as any).localStorage;
});

describe("createWsClient pending queue on close/reconnect", () => {
  test("onClose settles in-flight requests instead of hanging their Promise forever", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
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

  test("stale socket's delayed close does not re-trigger disconnect/reconnect for the new connection", async () => {
    const actions: Action[] = [];
    const handle = createWsClient((a) => actions.push(a));
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
