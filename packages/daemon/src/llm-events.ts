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

/** One observed event, before the daemon decides whether its series is the
 * session's main one — that verdict belongs to the cache (it needs the other
 * series to make it), not to the parser. */
export type LlmRequestObservation = Omit<LlmRequestInfo, "main">;

/** Validate one `event: request` payload into the shape the wire type
 * promises. Returns null for anything unusable — including the events the
 * gateway emits for clients that sent no session id, which carry
 * `session_id: null` and cannot be attached to a session row. A malformed
 * event must never take the subscription down, so this never throws. */
export function parseLlmRequestEvent(data: string): LlmRequestObservation | null {
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
  // A gateway older than v0.13.0 sends no prefix; "" then stands for "this
  // session has one unnamed series", which is exactly the pre-prefix
  // behaviour. A non-string prefix is treated the same way rather than
  // rejecting the event — the timestamp is still usable.
  const rawPrefix = raw.prefix;
  const prefix = typeof rawPrefix === "string" ? rawPrefix : "";
  const info: LlmRequestObservation = { ts, session_id: sid, prefix };
  if (typeof raw.ns === "string" && raw.ns !== "") info.ns = raw.ns;
  if (typeof raw.model === "string" && raw.model !== "") info.model = raw.model;
  if (typeof raw.credential === "string" && raw.credential !== "") info.credential = raw.credential;
  if (typeof raw.status === "number" && Number.isFinite(raw.status)) info.status = raw.status;
  return info;
}

/** Upper bound on remembered series. The TTL prune below already keeps this
 * near the number of series active in the last five minutes; the cap is the
 * guard against a clock-skewed gateway stamping events far in the future,
 * which prune alone would never expire. */
const MAX_CACHED_SERIES = 500;

/** Map key for one conversation series. JSON-encoding the pair sidesteps the
 * question of which separator can never appear in either half — no join
 * character means no way for two different pairs to produce one key. */
function seriesKey(sid: string, prefix: string): string {
  return JSON.stringify([sid, prefix]);
}

/** Upper bound on prefixes whose session set is remembered. Sharing is a
 * property of a prefix, so it stays useful after that series' window closes —
 * but it can't be kept forever, and the oldest are the least likely to matter.
 */
const MAX_TRACKED_PREFIXES = 2000;

interface CachedSeries {
  info: LlmRequestObservation;
  /** Order in which this session first used the series; the tiebreak when a
   * session has several non-subagent series live at once. */
  firstSeen: number;
}

/** Latest request per conversation series, pruned to the prompt cache TTL.
 *
 * Keyed by (session_id, prefix) rather than session_id: a session's subagents
 * issue requests under the same sid but their own system prompt, so their
 * cache entries are separate from the session's own. Folding them together
 * would restart the session's countdown every time a subagent ran, which is
 * precisely the thing the ring must not do — the session's own cache keeps
 * expiring on schedule while a subagent chatters.
 *
 * The daemon also decides WHICH series is a session's main one, since that
 * verdict needs a view across sessions that no single client has. Two signals
 * decide it, and both are observations rather than declarations — the gateway
 * reports no such flag:
 *
 *  - A prefix seen under more than one session is a subagent's. A main
 *    series' system prompt carries that session's cwd and git status, so it
 *    cannot recur elsewhere; subagent prompts have no such session-local
 *    content and do recur verbatim across sessions.
 *  - Among what is left, the series seen first for that session wins.
 *
 * Both are re-evaluated per snapshot rather than frozen at election time, so
 * a daemon that started mid-subagent — briefly seeing only subagent traffic
 * and taking it for the main series — corrects itself as soon as that prefix
 * shows up under a second session. Model names are deliberately not consulted:
 * main and subagent both range over the whole model lineup.
 *
 * A session whose live series ALL look shared falls back to its most recent
 * one — see the fallback in `snapshot` for why the sharing signal has to be
 * given up in that case. */
export class LlmRequestCache {
  private entries = new Map<string, CachedSeries>();
  /** prefix -> the sessions it has been observed under, capped at the 2 it
   * takes to prove sharing (nothing downstream needs the exact count). The
   * empty prefix is excluded: it is the placeholder for a pre-v0.13.0
   * gateway that reports no prefix at all, so it recurs across every session
   * without meaning anything about subagents. */
  private sidsByPrefix = new Map<string, Set<string>>();
  /** Monotonic first-seen counter, the tiebreak among a session's series. */
  private sequence = 0;

  /** Record one event, keeping the newer of the two when the series already
   * had one — events are near-ordered in practice, but a reconnect can
   * deliver an older one after a newer, and the countdown must not go
   * backwards. */
  record(info: LlmRequestObservation): void {
    const key = seriesKey(info.session_id, info.prefix);
    const prev = this.entries.get(key);
    if (prev && prev.info.ts >= info.ts) return;
    this.notePrefixSession(info);
    // Delete first so the re-insert moves the series to the end of the Map's
    // insertion order, which is what makes the eviction below drop the
    // least-recently-seen one. `firstSeen` survives the re-insert: it orders
    // series by when the session started using them, not by last activity.
    this.entries.delete(key);
    this.entries.set(key, { info, firstSeen: prev?.firstSeen ?? ++this.sequence });
    while (this.entries.size > MAX_CACHED_SERIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  private notePrefixSession(info: LlmRequestObservation): void {
    if (info.prefix === "") return;
    let sids = this.sidsByPrefix.get(info.prefix);
    if (!sids) {
      sids = new Set();
      this.sidsByPrefix.set(info.prefix, sids);
      while (this.sidsByPrefix.size > MAX_TRACKED_PREFIXES) {
        const oldest = this.sidsByPrefix.keys().next();
        if (oldest.done) break;
        this.sidsByPrefix.delete(oldest.value);
      }
    }
    if (sids.size < 2) sids.add(info.session_id);
  }

  /** True once this prefix has been seen under two different sessions, which
   * is what makes it a subagent's rather than a session's own. */
  private isShared(prefix: string): boolean {
    return (this.sidsByPrefix.get(prefix)?.size ?? 0) > 1;
  }

  /** Every series whose cache window is still open, each tagged with whether
   * it is its session's main one. Prunes as it goes, so an expired entry is
   * dropped rather than re-sent forever. */
  snapshot(now = Date.now()): LlmRequestInfo[] {
    const live: CachedSeries[] = [];
    for (const [key, series] of this.entries) {
      if (series.info.ts * 1000 + LLM_PROMPT_CACHE_TTL_MS <= now) {
        this.entries.delete(key);
        continue;
      }
      live.push(series);
    }
    // One main per session: the earliest-seen of its series that isn't a
    // known subagent's. Computed from what is live right now, which is what
    // makes both the sharing correction and the "main went cold, re-learn"
    // case fall out without any stored election to invalidate.
    const mainKey = new Map<string, CachedSeries>();
    const fallback = new Map<string, CachedSeries>();
    for (const series of live) {
      if (this.isShared(series.info.prefix)) continue;
      const sid = series.info.session_id;
      const best = mainKey.get(sid);
      if (!best || series.firstSeen < best.firstSeen) mainKey.set(sid, series);
    }
    // Fallback for a session whose every live series looks shared: show its
    // most recent one anyway. The sharing rule has a blind spot — two sessions
    // opened on the same cwd of the same repo produce the same leading system
    // block, so their real main series share a prefix and disqualify each
    // other, which would leave both rings dark forever (kawaz r99m32). A
    // countdown from the session's latest request is more use than none, and
    // the strict series separation is only given up in this degenerate case,
    // where there is nothing left to separate.
    for (const series of live) {
      const sid = series.info.session_id;
      if (mainKey.has(sid)) continue;
      const best = fallback.get(sid);
      if (!best || series.info.ts > best.info.ts) fallback.set(sid, series);
    }
    for (const [sid, series] of fallback) mainKey.set(sid, series);
    return live.map((series) => ({
      ...series.info,
      main: mainKey.get(series.info.session_id) === series,
    }));
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
  onRequest(info: LlmRequestObservation): void;
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

  /** `onHealthy` fires the first time this connection delivers bytes — see the
   * reconnect loop for why that, and not the HTTP response, is what counts as
   * a working subscription. */
  async function readStream(onHealthy: () => void): Promise<void> {
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
    let healthy = false;
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
        if (!healthy) {
          healthy = true;
          onHealthy();
        }
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
        // The reset belongs to a connection that actually carried bytes, not
        // to one that merely got a 200: a gateway that accepts and instantly
        // drops would otherwise reset the delay on every attempt and be
        // hammered once a second forever, which is the exact hot loop the
        // backoff exists to prevent. Any byte counts — the 20s keepalive
        // comment is what proves a quiet-but-healthy stream — and a
        // connection that delivers nothing at all is cut by the idle timeout
        // and does back off. Without this a daemon that had been up for hours
        // kept escalating 1s → 2s → 4s across unrelated disconnects (observed
        // in the production daemon log, kawaz r99m32).
        await readStream(() => {
          attempt = 0;
        });
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
