// The prompt-cache state the webui's ring is drawn from: validation of the
// request events the LLM gateway posts to ccmsg, and the per-series cache
// those events feed.
//
// The gateway sends one event per call it forwards, carrying the instant its
// upstream answered — the moment the 5-minute prompt cache starts running.
// Delivery is inbound (the gateway POSTs to this daemon's /webhook/llm-gateway,
// see webhook.ts) rather than the daemon subscribing outward: the gateway runs
// as two processes at once (stable and unstable), and a single subscription
// only ever saw whichever one it happened to connect to. A receiver sees both.
import { LLM_PROMPT_CACHE_TTL_MS, type LlmRequestInfo } from "@ccmsg/protocol";

/** One observed event, before the daemon decides whether its series is the
 * session's main one — that verdict belongs to the cache (it needs the other
 * series to make it), not to the parser. */
export type LlmRequestObservation = Omit<LlmRequestInfo, "main">;

/** Validate one posted request event into the shape the wire type promises.
 * Returns null for anything unusable — including the events the gateway emits
 * for clients that sent no session id, which carry `session_id: null` and
 * cannot be attached to a session row. One bad event in a batch must never
 * cost the good ones, so this never throws; the caller drops and logs. */
export function parseLlmRequestEvent(value: unknown): LlmRequestObservation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
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
