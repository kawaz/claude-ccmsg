// Thin client for the ccmsg wire protocol over `/ws` (DR-0003, DR-0004 §2/§4).
// Same line protocol as UDS: 1 frame = 1 JSON. HTTP/WS connections are pinned to
// role "user" (uid 0) server-side regardless of what we send, so we always hello
// as user.
//
// Responses vs. pushed events share one socket with no request id in the wire
// protocol (packages/protocol/src/index.ts). The daemon processes each line
// synchronously in receipt order, so replies to our requests arrive in the same
// order we sent them; anything without an `ok` field is a push (subscribe
// backlog/live event, or an ephemeral `ev` frame), never a reply. That's the
// only reliable way to tell the two apart from the client side.

const SINCE_KEY = "ccmsg.since";
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000, 30000];

function loadSince() {
  try {
    const raw = localStorage.getItem(SINCE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSince(since) {
  try {
    localStorage.setItem(SINCE_KEY, JSON.stringify(since));
  } catch {
    // storage unavailable (private mode, quota) — since-tracking degrades to
    // full resync on reconnect, which is still correct, just more backlog.
  }
}

export class WsClient extends EventTarget {
  #ws = null;
  #pending = [];
  #reconnectAttempt = 0;
  #closedByUs = false;
  since = loadSince();

  connect() {
    this.#closedByUs = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.#ws = ws;
    ws.addEventListener("open", () => this.#onOpen());
    ws.addEventListener("message", (e) => this.#onMessage(e.data));
    ws.addEventListener("close", () => this.#onClose());
  }

  close() {
    this.#closedByUs = true;
    this.#ws?.close();
  }

  async #onOpen() {
    this.#reconnectAttempt = 0;
    this.dispatchEvent(new Event("connecting-done"));
    try {
      await this.#request({ op: "hello", role: "user" });
      const rooms = await this.#request({ op: "rooms" });
      this.dispatchEvent(new CustomEvent("rooms", { detail: rooms }));
      await this.#request({ op: "subscribe", since: this.since });
      this.dispatchEvent(new Event("subscribed"));
    } catch {
      // request() rejects if the socket drops mid-handshake; #onClose already
      // schedules the reconnect, nothing more to do here.
    }
  }

  #onMessage(data) {
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (Object.hasOwn(obj, "ok")) {
      const settle = this.#pending.shift();
      settle?.(obj);
      return;
    }
    if (obj.ev === "restarting") {
      this.dispatchEvent(new Event("restarting"));
      return;
    }
    if (obj.ev === "notify") {
      this.dispatchEvent(new CustomEvent("notify", { detail: obj }));
      return;
    }
    if (obj.type === "msg" && typeof obj.mid === "number" && typeof obj.r === "string") {
      this.since[obj.r] = Math.max(this.since[obj.r] ?? 0, obj.mid);
      saveSince(this.since);
    }
    this.dispatchEvent(new CustomEvent("event", { detail: obj }));
  }

  #onClose() {
    this.dispatchEvent(new Event("disconnected"));
    if (this.#closedByUs) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.#reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }

  #request(obj) {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      this.#pending.push(resolve);
      this.#ws.send(JSON.stringify(obj));
    });
  }

  rooms() {
    return this.#request({ op: "rooms" });
  }

  peers() {
    return this.#request({ op: "peers" });
  }

  post(room, msg, to) {
    return this.#request({ op: "post", room, msg, ...(to && to.length ? { to } : {}) });
  }

  read(room, mids) {
    return this.#request({ op: "read", room, mids });
  }
}
