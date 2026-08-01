// Resident subscription to the LLM gateway's request event stream, and the
// per-session cache the webui's prompt-cache countdown is drawn from.
//
// The gateway publishes one SSE `event: request` per forwarded call, carrying
// the instant its upstream answered — the moment the 5-minute prompt cache
// starts running. The browser could read that stream itself (it is unauthed
// and CORS-open today), but then every tab would hold its own connection to a
// service ccmsg otherwise fronts, and the authentication story would fork the
// day the gateway grows one. So the daemon subscribes once and relays over the
// WS connection the webui already has.
//
// The subscription is resident rather than started on the first user
// subscriber (the posture agents.ts takes): its whole value is having watched
// the window that began *before* the tab connected, and a subscription that
// starts when the tab does can only ever report requests the tab was already
// present for. Everything here is async IO per DR-0029.
import { LLM_PROMPT_CACHE_TTL_MS, type LlmRequestInfo } from "@ccmsg/protocol";
import type { GatewayFetch } from "./llm-gateway.ts";

/** One dispatched SSE event. `event` is "message" when the stream omitted the
 * field, per the EventSource default. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental SSE frame parser (WHATWG event-stream). Kept separate from the
 * transport so the chunk-boundary cases — a field split mid-line, a dispatch
 * blank line arriving in the next read — are testable without a socket. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  /** Feed one decoded chunk; returns every event completed by it (possibly
   * none, when the chunk ends mid-frame). */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      // A line is only complete once its terminator is in hand: without this
      // the tail of a split chunk would be parsed as a whole field.
      const idx = this.buffer.search(/\r\n|\n|\r/);
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      const skip = this.buffer.startsWith("\r\n", idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + skip);
      const done = this.line(line);
      if (done) out.push(done);
    }
    return out;
  }

  /** Process one complete line; returns an event when the line dispatched one. */
  private line(line: string): SseEvent | null {
    if (line === "") {
      // Blank line dispatches. A frame with no data lines is a no-op in the
      // spec (this is how a bare `event:` heartbeat is ignored).
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const ev: SseEvent = {
        event: this.event === "" ? "message" : this.event,
        data: this.data.join("\n"),
      };
      this.event = "";
      this.data = [];
      return ev;
    }
    if (line.startsWith(":")) return null; // comment — the gateway's keepalive
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    // Exactly one leading space after the colon is part of the delimiter.
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    // `id` and `retry` are ignored: this stream has no replay to resume into
    // (the gateway sends only what happens after connect), and the reconnect
    // delay is ours to decide.
    return null;
  }
}

/** Validate one `event: request` payload into the shape the wire type
 * promises. Returns null for anything unusable — including the events the
 * gateway emits for clients that sent no session id, which carry
 * `session_id: null` and cannot be attached to a session row. A malformed
 * event must never take the subscription down, so this never throws. */
export function parseLlmRequestEvent(data: string): LlmRequestInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const ts = raw.ts;
  const sid = raw.session_id;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  if (typeof sid !== "string" || sid === "") return null;
  const info: LlmRequestInfo = { ts, session_id: sid };
  if (typeof raw.ns === "string" && raw.ns !== "") info.ns = raw.ns;
  if (typeof raw.model === "string" && raw.model !== "") info.model = raw.model;
  if (typeof raw.credential === "string" && raw.credential !== "") info.credential = raw.credential;
  if (typeof raw.status === "number" && Number.isFinite(raw.status)) info.status = raw.status;
  return info;
}

/** Upper bound on remembered sessions. The TTL prune below already keeps this
 * near the number of sessions active in the last five minutes; the cap is the
 * guard against a clock-skewed gateway stamping events far in the future,
 * which prune alone would never expire. */
const MAX_CACHED_SESSIONS = 500;

/** Latest request per session, pruned to the prompt cache TTL. The daemon
 * keeps this so a browser that connects (or reloads) mid-window still learns
 * about a countdown that started before it was listening. */
export class LlmRequestCache {
  private entries = new Map<string, LlmRequestInfo>();

  /** Record one event, keeping the newer of the two when a session already
   * had one — events are near-ordered in practice, but a reconnect can
   * deliver an older one after a newer, and the countdown must not go
   * backwards. */
  record(info: LlmRequestInfo): void {
    const prev = this.entries.get(info.session_id);
    if (prev && prev.ts >= info.ts) return;
    // Delete first so the re-insert moves the sid to the end of the Map's
    // insertion order, which is what makes the eviction below drop the
    // least-recently-seen session.
    this.entries.delete(info.session_id);
    this.entries.set(info.session_id, info);
    while (this.entries.size > MAX_CACHED_SESSIONS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Every session whose cache window is still open, oldest first. Prunes as
   * it goes, so an expired entry is dropped rather than re-sent forever. */
  snapshot(now = Date.now()): LlmRequestInfo[] {
    const out: LlmRequestInfo[] = [];
    for (const [sid, info] of this.entries) {
      if (info.ts * 1000 + LLM_PROMPT_CACHE_TTL_MS <= now) {
        this.entries.delete(sid);
        continue;
      }
      out.push(info);
    }
    return out;
  }
}

/** Reconnect delay for the nth consecutive failure (0-based): 1s doubling to a
 * 30s ceiling. No jitter — there is exactly one subscriber per daemon, so
 * there is no herd to spread out, and a deterministic schedule is one an
 * operator reading the log can predict. */
export function backoffDelayMs(attempt: number): number {
  const base = 1000 * 2 ** Math.max(0, attempt);
  return Math.min(30_000, base);
}

/** Treat the connection as dead after this long with nothing on it. The
 * gateway sends a keepalive comment every 20s (axum's `Sse::keep_alive`), so
 * two missed keepalives is the gateway's own recommended threshold — long
 * enough that one late keepalive doesn't churn the connection, short enough
 * that a half-open socket (laptop slept, NAT dropped the mapping) is noticed
 * within one cache window rather than never. Without it a silently dead TCP
 * connection would hold the subscription open forever: no error ever arrives,
 * so the reconnect loop below would never run. */
const IDLE_TIMEOUT_MS = 40_000;

export interface LlmEventsLog {
  info(msg: string): void;
  error(msg: string): void;
}

export interface LlmEventClientOptions {
  url: string;
  log: LlmEventsLog;
  /** Called for each attributable request event, in arrival order. */
  onRequest(info: LlmRequestInfo): void;
  /** Injected in tests; defaults to the runtime's global fetch. */
  fetch?: GatewayFetch;
  /** Injected in tests to collapse the reconnect wait. */
  delayMs?: (attempt: number) => number;
  /** Injected in tests to collapse the 40s silence threshold. */
  idleTimeoutMs?: number;
}

export interface LlmEventClient {
  stop(): void;
}

/** Subscribe to the gateway's event stream until stopped, reconnecting with
 * backoff across every failure (gateway down at daemon start, restarted
 * later, connection dropped mid-stream). Returns immediately; the read loop
 * runs on its own. */
export function startLlmEventClient(opts: LlmEventClientOptions): LlmEventClient {
  const fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const delayMs = opts.delayMs ?? backoffDelayMs;
  const controller = new AbortController();
  let stopped = false;
  /** Resolver of the in-flight reconnect sleep, so stop() doesn't have to wait
   * out a 30s backoff before the loop notices. */
  let wake: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const id = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(id);
        wake = null;
        resolve();
      };
    });

  async function readStream(): Promise<void> {
    const res = await fetchImpl(opts.url, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = res.body;
    if (!body) throw new Error("no response body");
    opts.log.info(`llm events: subscribed to ${opts.url}`);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const idleMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    try {
      for (;;) {
        // Race the read against the silence budget. Any byte resets it — the
        // gateway's keepalive comments are what normally do, which is exactly
        // what makes silence meaningful evidence that the connection is gone.
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => reject(new Error(`no data for ${idleMs}ms`)), idleMs);
        });
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await Promise.race([reader.read(), idle]);
        } catch (e) {
          // Tear the socket down before reconnecting: a half-open connection
          // left dangling would leak a file descriptor per retry.
          void reader.cancel().catch(() => {});
          throw e;
        } finally {
          clearTimeout(idleTimer);
        }
        if (chunk.done) return; // upstream closed; the loop below reconnects
        for (const ev of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
          if (ev.event !== "request") continue;
          const info = parseLlmRequestEvent(ev.data);
          if (info) opts.onRequest(info);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      try {
        await readStream();
        // A clean end-of-stream is still a disconnect: reconnect promptly
        // rather than treating it as a failure worth backing off from.
        attempt = 0;
      } catch (e) {
        if (stopped) return;
        // One line per failure would flood a log while the gateway is down for
        // hours; the escalating delay keeps the volume self-limiting, and the
        // delay is printed so the silence between lines is explicable.
        opts.log.error(
          `llm events: ${opts.url} disconnected (${String(e)}); retrying in ${delayMs(attempt)}ms`,
        );
        await sleep(delayMs(attempt));
        attempt += 1;
        continue;
      }
      if (!stopped) await sleep(delayMs(0));
    }
  })();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      wake?.();
      controller.abort();
    },
  };
}
