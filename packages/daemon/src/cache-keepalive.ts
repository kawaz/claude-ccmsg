// Prompt-cache keepalive markers posted by the LLM gateway, relayed to the
// session they belong to as a notice in its conversation (DR-0039 §9).
//
// The gateway watches a session's prompt cache and, shortly before it
// would lapse, asks ccmsg to make that session say something — one cheap turn
// re-warms the cache and saves re-sending the whole prefix. It cannot reach the
// session itself: it only ever sees HTTP requests, and has no channel back into
// a running CLI. ccmsg does: it puts notices into a session's conversation.
//
// The marker is the notice's text, untouched: the gateway decides what text
// proves the keepalive turn happened (it matches the same string back on the
// request it is waiting for).
//
// Whether the session is mid-turn is deliberately not consulted. A marker that
// lands during a turn rides along on that turn's next request, which re-warms
// the cache just as well; one that lands too late is caught by the gateway's
// own nonce guard. So the only question here is whether the deadline has
// already passed — which makes this a relay, with no state to keep.
import { parseWith, type JsonValue, type Output, type SendMessageResult } from "@ccmsg/protocol";
import * as v from "valibot";

/** One `type: "cache_keepalive"` item from the gateway, read.
 *
 * The wire payload carries more than this (`prefix`, `ts`) — those are the
 * gateway's own bookkeeping and describe the cache series it is protecting,
 * which is not something this relay decides anything from. Only the four
 * fields below change what happens. */
const CacheKeepaliveEventSchema = v.object({
  type: v.literal("cache_keepalive"),
  /** Claude session id the marker must reach. */
  session_id: v.pipe(v.string(), v.nonEmpty()),
  /** Exact notification text. Relayed unchanged — see module doc. */
  marker: v.pipe(v.string(), v.nonEmpty()),
  /** Epoch ms after which delivering is pointless (the cache has lapsed). */
  deadline: v.number(),
  /** Single-use id of this keepalive, for logs. */
  nonce: v.optional(v.string(), ""),
});
/** A keepalive, by the fields that decide what happens to it. */
export type CacheKeepaliveEvent = Omit<Output<typeof CacheKeepaliveEventSchema>, "type">;

/** What an item says it is, read alone. */
const CacheKeepaliveKindSchema = v.object({ type: v.literal("cache_keepalive") });

/** True for an item claiming to be a keepalive, whether or not it is valid.
 * Split from parsing so the webhook fold can route an item to this handler and
 * still hear about it when it turns out to be malformed — an unparseable
 * keepalive must not silently fall through and be recorded as a request event
 * (its `session_id`/`ts` would pass that parser and restart a cache countdown
 * that nothing actually refreshed). */
export function isCacheKeepaliveItem(item: JsonValue): boolean {
  return parseWith(CacheKeepaliveKindSchema, item).ok;
}

/** Read one keepalive item. Returns null for one that does not read; the
 * caller logs and drops, never throws — one bad item in a posted batch must
 * not cost the good ones. */
export function parseCacheKeepaliveEvent(item: JsonValue): CacheKeepaliveEvent | null {
  const read = parseWith(CacheKeepaliveEventSchema, item);
  if (!read.ok) return null;
  const { type: _kind, ...event } = read.value;
  return event;
}

export interface CacheKeepaliveDeps {
  /** Put the marker into that session's conversation as a notice from the
   * daemon — machinery, neither a person nor a session, so a session that
   * reads its `from` does not take it for impersonated input (r261m38) — and
   * say what came of it. */
  deliver(sid: string, text: string): Promise<SendMessageResult>;
  log: { info(msg: string): void };
  /** Injectable clock (ms), for tests. */
  now?: () => number;
}

/** Relay one keepalive, and log what came of it or why it went nowhere.
 * Settles once the delivery has come to its outcome. */
export async function relayCacheKeepalive(
  event: CacheKeepaliveEvent,
  deps: CacheKeepaliveDeps,
): Promise<void> {
  const label = `cache keepalive ${event.nonce === "" ? "" : `${event.nonce} `}for ${event.session_id}`;
  const now = deps.now ? deps.now() : Date.now();
  if (event.deadline - now <= 0) {
    deps.log.info(`${label}: deadline already passed, dropped`);
    return;
  }
  const result = await deps.deliver(event.session_id, event.marker);
  deps.log.info(
    `${label}: ${result.outcome}` +
      (result.outcome === "not_delivered" ? ` (${result.reason}), dropped` : ""),
  );
}
