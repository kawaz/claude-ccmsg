// The wire's requests about the daemon and its host (client -> daemon), as
// schemas (DR-0038): liveness, shutdown, translation on the host, and the LLM
// gateway the daemon proxies. request.ts joins them into one request and
// reads a line with them.
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";

export const PingRequestSchema = v.object({
  op: v.literal("ping"),
});
export type PingRequest = v.InferOutput<typeof PingRequestSchema>;

export const ShutdownRequestSchema = v.object({
  op: v.literal("shutdown"),
  reason: v.optional(v.string()),
});
export type ShutdownRequest = v.InferOutput<typeof ShutdownRequestSchema>;

/** Local en→ja translation through the daemon host (DR-0023, user role only).
 * An empty batch is a capability probe: it verifies the helper can be found or
 * built without starting a TranslationSession.
 *
 * Slow reply (same rationale as SessionLaunchRequest): translation takes
 * hundreds of ms to seconds per batch, and the one reply carrying every
 * result — per-item failures included — comes back then. */
export const TranslateRequestSchema = v.object({
  op: v.literal("translate"),
  texts: v.array(v.string()),
});
export type TranslateRequest = v.InferOutput<typeof TranslateRequestSchema>;

/** Per-credential LLM quota snapshot, proxied from the gateway named by
 * `<configDir>/config.json`'s `llm_usage_url` (user role only — quota is an
 * operator's view of the host's credentials, not something a session's agent
 * has any use for). The daemon fetches rather than the browser because the
 * gateway serves no CORS headers, so a direct fetch from the webui origin is
 * impossible; routing it through the daemon also keeps the gateway URL (an
 * internal address) out of the browser entirely.
 *
 * Slow for session_env's reason: the upstream fetch takes seconds. */
export const LlmUsageRequestSchema = v.object({
  op: v.literal("llm_usage"),
  /** Ask the gateway to probe upstream instead of answering from its cache,
   * passed through as `?refresh=true`. Only a probe response carries
   * `LlmUsageCredential.limits` and `probe_error` — the cached document has
   * neither. It is also the only request that can spend upstream rate limit
   * (an account already limited answers the probe with a 429, which arrives
   * as that credential's `probe_error`), so this is for an explicit user
   * action and never for polling. */
  refresh: v.optional(v.boolean()),
});
export type LlmUsageRequest = v.InferOutput<typeof LlmUsageRequestSchema>;

/** Per-day LLM spend, proxied from the gateway named by `<configDir>/config.json`'s
 * `llm_stats_url` (user role only, same posture as `llm_usage`: what the host's
 * credentials cost is an operator's view). The daemon fetches for the same
 * reason — the gateway serves no CORS headers, and proxying keeps its internal
 * address out of the browser.
 *
 * Slow like `llm_usage`: a wide window is a much larger document than the
 * quota one and the fetch is correspondingly slow. */
export const LlmStatsRequestSchema = v.object({
  op: v.literal("llm_stats"),
  /** How many days back to ask the gateway for, passed through as its `days`
   * query parameter. Must be an integer in LLM_STATS_DAYS_MIN..MAX; omitted
   * leaves the gateway's own default in place. The gateway clamps a request
   * wider than its own history, so asking for more than it holds is the
   * supported way to say "everything you have". */
  days: v.optional(v.number()),
});
export type LlmStatsRequest = v.InferOutput<typeof LlmStatsRequestSchema>;

/** Upstream service health, proxied from the gateway named by
 * `<configDir>/config.json`'s `llm_status_url` (user role only, same posture
 * as `llm_usage`: which providers are up is the operator's view of the host's
 * gateway). The daemon fetches for the same two reasons — no CORS headers on
 * the endpoint, and the gateway's internal address stays out of the browser.
 *
 * Slow like `llm_usage`.
 * The same report also arrives unsolicited as `ev:"llm_status"` after the
 * gateway reports a 529, so a client that has asked once keeps up without
 * asking again. */
export const LlmStatusRequestSchema = v.object({
  op: v.literal("llm_status"),
  /** Ask the gateway to re-read the providers' status pages before answering,
   * passed through as `?refresh=true`. The cached read costs the gateway
   * nothing; a refresh calls out to every configured status page, so it
   * belongs to an explicit user action. */
  refresh: v.optional(v.boolean()),
});
export type LlmStatusRequest = v.InferOutput<typeof LlmStatusRequestSchema>;
