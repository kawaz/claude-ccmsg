// Prompt-cache keepalive markers posted by the LLM gateway, relayed to the
// session they belong to as an ordinary `ev:"notify"`.
//
// The gateway watches a session's 5-minute prompt cache and, shortly before it
// would lapse, asks ccmsg to make that session say something — one cheap turn
// re-warms the cache and saves re-sending the whole prefix. It cannot reach the
// session itself: it only ever sees HTTP requests, and has no channel back into
// a running CLI. ccmsg does, because the session is already holding a
// `subscribe` stream open for exactly this kind of out-of-band delivery.
//
// The marker goes out verbatim, with nothing wrapped around it: the gateway
// decides what text proves the keepalive turn happened (it matches the same
// string back on the request it is waiting for), and a notification that grows
// decorations risks being truncated before the marker itself is read.
//
// Whether the session is mid-turn is deliberately not consulted. A marker that
// lands during a turn rides along on that turn's next request, which re-warms
// the cache just as well; one that lands too late is caught by the gateway's
// own nonce guard. So the only question here is whether the deadline has
// already passed — which makes this a relay, with no state to keep and nothing
// to wait for.
import type { NotifyFrom } from "@ccmsg/protocol";

/** One `type: "cache_keepalive"` item from the gateway, validated.
 *
 * The wire payload carries more than this (`prefix`, `ts`, `ts_iso`,
 * `deadline_iso`) — those are the gateway's own bookkeeping and describe the
 * cache series it is protecting, which is not something this relay decides
 * anything from. Only the four fields below change what happens. */
export interface CacheKeepaliveEvent {
  /** Claude session id the marker must reach. */
  session_id: string;
  /** Exact notification text. Relayed unchanged — see module doc. */
  marker: string;
  /** Unix seconds after which delivering is pointless (the cache has lapsed). */
  deadline: number;
  /** Single-use id of this keepalive, for logs. */
  nonce: string;
}

/** True for an item claiming to be a keepalive, whether or not it is valid.
 * Split from parsing so the webhook fold can route an item to this handler and
 * still hear about it when it turns out to be malformed — an unparseable
 * keepalive must not silently fall through and be recorded as a request event
 * (its `session_id`/`ts` would pass that parser and restart a cache countdown
 * that nothing actually refreshed). */
export function isCacheKeepaliveItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value as { type?: unknown }).type === "cache_keepalive";
}

/** Validate one keepalive item. Returns null for anything unusable; the caller
 * logs and drops, never throws — one bad item in a posted batch must not cost
 * the good ones. */
export function parseCacheKeepaliveEvent(value: unknown): CacheKeepaliveEvent | null {
  if (!isCacheKeepaliveItem(value)) return null;
  const raw = value as Record<string, unknown>;
  const sid = raw.session_id;
  const marker = raw.marker;
  const deadline = raw.deadline;
  if (typeof sid !== "string" || sid === "") return null;
  if (typeof marker !== "string" || marker === "") return null;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return null;
  const nonce = typeof raw.nonce === "string" ? raw.nonce : "";
  return { session_id: sid, marker, deadline, nonce };
}

/** Stamped on the relayed notify: from the session's side this is
 * indistinguishable from `ccmsg notify --sid <sid>` sent by a user-role client,
 * so nothing downstream (CLI relay, webui fold) needs a case for it. */
export const CACHE_KEEPALIVE_FROM: NotifyFrom = { role: "user" };

export interface CacheKeepaliveDeps {
  /** Push the marker down that session's subscribe stream, answering how many
   * streams took it — 0 means the session has none open, which is the only
   * "undeliverable" case there is. */
  deliver(sid: string, text: string): number;
  log: { info(msg: string): void };
  /** Injectable clock (ms), for tests. */
  now?: () => number;
}

/** Relay one keepalive, or log why it went nowhere. */
export function relayCacheKeepalive(event: CacheKeepaliveEvent, deps: CacheKeepaliveDeps): void {
  const label = `cache keepalive ${event.nonce === "" ? "" : `${event.nonce} `}for ${event.session_id}`;
  const now = deps.now ? deps.now() : Date.now();
  if (event.deadline * 1000 - now <= 0) {
    deps.log.info(`${label}: deadline already passed, dropped`);
    return;
  }
  const delivered = deps.deliver(event.session_id, event.marker);
  if (delivered === 0) {
    deps.log.info(`${label}: session is not subscribed, dropped`);
    return;
  }
  deps.log.info(`${label}: delivered`);
}
