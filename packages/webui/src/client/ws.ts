// Effect layer for the wire protocol over `/ws` (DR-0003, DR-0004 §2/§4,
// DR-0005 §1: "副作用...は store の外 (effect 層) に隔離"). Owns the
// WebSocket lifecycle (connect/reconnect/hello/subscribe handshake) and
// translates everything it observes into store actions; the reducer never
// touches the network. HTTP/WS connections are pinned to role "user" (u1)
// server-side regardless of what we send, so we always hello as user.
//
// Responses vs. pushed events share one socket with no request id in the wire
// protocol. The daemon processes each line synchronously in receipt order, so
// replies to our requests arrive in the same order we sent them; anything
// without an `ok` field is a push (subscribe backlog/live event, or an
// ephemeral `ev` frame), never a reply. That's the only reliable way to tell
// the two apart from the client side.
import type {
  DeliveredEvent,
  ErrorResponse,
  PeersResponse,
  PostResponse,
  ReadResponse,
  Request,
  Response,
  RoomsResponse,
  StreamEvent,
} from "@ccmsg/protocol";
import type { Action } from "./store.ts";

const SINCE_KEY = "ccmsg.since";
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000, 30000];

function loadSince(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SINCE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSince(since: Record<string, number>): void {
  try {
    localStorage.setItem(SINCE_KEY, JSON.stringify(since));
  } catch {
    // storage unavailable (private mode, quota) — since-tracking degrades to
    // full resync on reconnect, which is still correct, just more backlog.
  }
}

export interface WsHandle {
  connect(): void;
  close(): void;
  post(room: string, msg: string, to?: string[]): Promise<PostResponse | ErrorResponse>;
  peers(): Promise<PeersResponse | ErrorResponse>;
  read(room: string, mids: string | number[]): Promise<ReadResponse | ErrorResponse>;
}

export function createWsClient(dispatch: (action: Action) => void): WsHandle {
  let ws: WebSocket | null = null;
  let pending: Array<(v: Response) => void> = [];
  let reconnectAttempt = 0;
  let closedByUs = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const since = loadSince();

  function send<T extends Response>(req: Request): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      pending.push(resolve as (v: Response) => void);
      ws.send(JSON.stringify(req));
    });
  }

  async function onOpen(): Promise<void> {
    reconnectAttempt = 0;
    dispatch({ type: "conn/status", status: "connected" });
    try {
      await send({ op: "hello", role: "user" });
      const rooms = await send<RoomsResponse>({ op: "rooms" });
      if (rooms.ok) dispatch({ type: "rooms/loaded", rooms: rooms.rooms });
      await send({ op: "subscribe", since });
      const peers = await send<PeersResponse>({ op: "peers" });
      if (peers.ok) dispatch({ type: "peers/loaded", peers: peers.peers });
    } catch {
      // socket dropped mid-handshake; onClose already schedules the reconnect.
    }
  }

  function onMessage(data: string): void {
    let obj: StreamEvent | Response;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (Object.hasOwn(obj, "ok")) {
      const settle = pending.shift();
      settle?.(obj as Response);
      return;
    }
    const streamEv = obj as StreamEvent;
    if ("ev" in streamEv && streamEv.ev === "restarting") {
      dispatch({ type: "conn/status", status: "restarting" });
      return;
    }
    if ("ev" in streamEv && streamEv.ev === "notify") return; // not surfaced in the UI (yet)
    const delivered = streamEv as DeliveredEvent;
    if (delivered.type === "msg") {
      since[delivered.r] = Math.max(since[delivered.r] ?? 0, delivered.mid);
      saveSince(since);
    }
    dispatch({ type: "protocol-event", event: delivered });
  }

  // Settles every in-flight send() with a synthetic error response instead of
  // leaving its Promise pending forever, and empties the queue so a stale
  // resolver can never be mis-matched (via onMessage's pending.shift()) to a
  // reply that arrives on a later, reconnected socket.
  function flushPending(): void {
    const stale = pending;
    pending = [];
    for (const settle of stale) {
      settle({ ok: false, error: { code: "connection_closed", msg: "ws connection closed" } });
    }
  }

  function onClose(): void {
    dispatch({ type: "conn/status", status: "disconnected" });
    flushPending();
    if (closedByUs) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    closedByUs = false;
    // A manual connect() supersedes any scheduled auto-reconnect; without this,
    // the pending timer would fire later and knock down the fresh socket.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Belt-and-suspenders: also flush on connect() itself, in case it's ever
    // invoked (e.g. a manual reconnect) without onClose having run first.
    flushPending();
    const previous = ws;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    ws = socket;
    // Every listener below is guarded with `socket !== ws`: once `connect()`
    // runs again, `ws` points at the newer socket but this `socket` const
    // still names the one this closure was created for. A stale socket's
    // events (a delayed reply, or its own close firing after we've already
    // moved on) must never touch `pending`/dispatch on behalf of the current
    // connection — that's the mis-delivery this whole file exists to avoid.
    socket.addEventListener("open", () => {
      if (socket !== ws) return;
      void onOpen();
    });
    socket.addEventListener("message", (e) => {
      if (socket !== ws) return;
      onMessage(e.data as string);
    });
    socket.addEventListener("close", () => {
      if (socket !== ws) return;
      onClose();
    });
    // Close the outgoing socket now that `ws` no longer references it, so it
    // stops holding a live connection open in the background. Its close
    // event (real or synthetic) is a no-op thanks to the guard above.
    if (previous) {
      try {
        previous.close();
      } catch {
        // best-effort; the socket is being discarded either way.
      }
    }
  }

  return {
    connect,
    close() {
      closedByUs = true;
      // Cancel a scheduled auto-reconnect too: close() means "stop", including
      // the reconnect already queued by a close event that preceded this call.
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    },
    post: (room, msg, to) => send({ op: "post", room, msg, ...(to && to.length ? { to } : {}) }),
    peers: () => send({ op: "peers" }),
    read: (room, mids) => send({ op: "read", room, mids }),
  };
}
