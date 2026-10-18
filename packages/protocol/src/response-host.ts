// The wire's replies to host requests (daemon -> client), as schemas
// (DR-0038): the daemon itself (ping, shutdown), translation on the host, and
// what the host's LLM gateway reports (quota, spend, upstream status).
// response.ts joins them with the other topics' replies, by the op each
// answers.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): see response-rooms.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";

export const PingResponseSchema = v.object({
  ok: v.literal(true),
  pong: v.literal(true),
  version: v.string(),
  uptime: v.number(),
  pid: v.number(),
  clients: v.number(),
  /** provenance of the running daemon: the bun executable and the entry
   * script path (Bun.main). The entry script tells which face's plugin cache
   * (e.g. ~/.claude-personal vs a work overlay) this daemon actually runs
   * from; version skew across faces is resolved by the newer-wins upgrade. */
  exe: v.optional(v.string()),
  script: v.optional(v.string()),
  /** actual HTTP/WS bind addresses ("host:port"); empty when CCMSG_HTTP_BIND=off (DR-0004 §3). */
  http: v.array(v.string()),
  /** active source-IP allowlist entries (CIDR/IP strings, DR-0004 §3 addendum). */
  httpAllow: v.array(v.string()),
  /** The daemon's current view of the host link, which decides whether a
   * recovery can wake sessions stopped on an API error: `"off"` when no
   * network watch is running, `"unknown"` before its first probe settles,
   * otherwise the last probed state. Diagnostic only — nothing on the wire
   * depends on it. */
  network: v.picklist(["off", "unknown", "online", "offline"]),
});
export type PingResponse = Output<typeof PingResponseSchema>;

export const ShutdownResponseSchema = v.object({
  ok: v.literal(true),
  stopping: v.literal(true),
});
export type ShutdownResponse = Output<typeof ShutdownResponseSchema>;

export const TranslateResultSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), text: v.string() }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);
export type TranslateResult = Output<typeof TranslateResultSchema>;

export const TranslateResponseSchema = v.object({
  ok: v.literal(true),
  /** One result per request text, preserving input order. Per-item failures keep
   * the helper's Translation.framework error text (including notInstalled). */
  results: v.array(TranslateResultSchema),
});
export type TranslateResponse = Output<typeof TranslateResponseSchema>;

// --- llm_usage ---------------------------------------------------------------

/** One quota window of one credential (upstream key "5h" / "7d" / whatever a
 * future gateway adds — see LlmUsageSnapshot.windows). */
export const LlmUsageWindowSchema = v.object({
  /** Fraction of the window's quota already consumed, 0..1 (upstream sends
   * 0.13 for 13%). Values above 1 are possible and are NOT clamped here.
   * Absent when upstream's reading did not carry it; the UI draws no bar for
   * such a window. */
  utilization: v.optional(v.number()),
  /** Upstream verdict for the window. Known values are "allowed",
   * "allowed_warning" and "rejected"; kept as a string because the set is the
   * gateway's to grow and an unknown value must reach the UI as-is rather
   * than being flattened into a wrong one. Absent when upstream's reading
   * carried no verdict (observed 2026-10-11 on a window with utilization 0). */
  status: v.optional(v.string()),
  /** Epoch ms at which the window's counter resets. */
  reset: v.optional(v.number()),
  /** Length of the window's period in seconds (18000 for a 5h window, 604800
   * for a 7d one). Upstream states the period itself here rather than leaving
   * it to be read out of the key, because a key like "primary" names a slot
   * whose length differs between providers. Absent when the provider does not
   * report one, which means unknown — not a licence to guess. */
  window_seconds: v.optional(v.number()),
  /** The reading is from before `reset` and is NOT the current consumption —
   * the counter has since rolled over. Upstream sends the field only when it
   * is true. Without it a week-old "101%" reads as a credential that is out of
   * quota right now, which is the misreading this flag exists to prevent. */
  expired: v.optional(v.boolean()),
});
export type LlmUsageWindow = Output<typeof LlmUsageWindowSchema>;

/** Extra-credit spending state, which is per credential rather than per
 * window (a credential can be out of credits while both windows are still
 * "allowed"). */
export const LlmUsageOverageSchema = v.object({
  /** Absent when upstream reported only the reason. */
  status: v.optional(v.string()),
  disabled_reason: v.optional(v.string()),
});
export type LlmUsageOverage = Output<typeof LlmUsageOverageSchema>;

/** One observation of a credential's quota, as of `observed_at` — which can
 * lag the response's own `generated_at` by minutes when the gateway has not
 * seen traffic on that credential recently, so the UI shows its age. */
export const LlmUsageSnapshotSchema = v.object({
  /** Epoch ms. */
  observed_at: v.optional(v.number()),
  overage: v.optional(LlmUsageOverageSchema),
  /** Window key → window, keys verbatim from upstream. A map rather than
   * named `five_hour`/`seven_day` fields so a gateway that starts reporting a
   * third window needs no protocol change. */
  windows: v.record(v.string(), LlmUsageWindowSchema),
});
export type LlmUsageSnapshot = Output<typeof LlmUsageSnapshotSchema>;

/** One named limit the upstream provider enforces on a credential, beside the
 * rolling quota windows. Upstream's vocabulary is passed through untranslated
 * (the gateway owns these words): `kind` is "session" / "weekly_all" /
 * "weekly_scoped" today and may grow, and a `weekly_scoped` entry names the
 * model family it applies to. */
export const LlmUsageLimitSchema = v.object({
  /** Which limit this is. A string rather than a union for LlmUsageWindow.status's
   * reason — the set is the gateway's to grow, and an unknown kind must reach
   * the UI as itself rather than be flattened into a wrong one. */
  kind: v.string(),
  /** Consumed share of the limit as a PERCENTAGE, 0..100 — deliberately not
   * the same unit as LlmUsageWindow.utilization (0..1). Kept as upstream sends
   * it so the wire stays a faithful copy of the gateway's document; the webui
   * normalizes at the presentation boundary. */
  percent: v.number(),
  /** Upstream's own verdict: "normal" / "warning" / "critical" today. String
   * for `kind`'s reason. Absent when upstream gave none. */
  severity: v.optional(v.string()),
  /** Epoch ms the limit's counter resets at. Absent for a limit with no
   * scheduled reset. */
  resets_at: v.optional(v.number()),
  /** Model family the limit is scoped to, as a display name ("Fable").
   * Present on `weekly_scoped` entries. */
  model: v.optional(v.string()),
  /** True when upstream is currently counting against this limit. NOT a
   * statement that the limit is blocking anything — an inactive limit can sit
   * at 0% and an active one at 47% "normal". */
  is_active: v.optional(v.boolean()),
  /** Length of the limit's period in seconds, stated by the provider instead
   * of being inferred from `kind`. Absent when the provider does not report
   * one, which means unknown — not a licence to guess. */
  window_seconds: v.optional(v.number()),
});
export type LlmUsageLimit = Output<typeof LlmUsageLimitSchema>;

/** State of the credential's own authentication, as the gateway last observed
 * it while refreshing a token. Separate from `support` and from the quota
 * readings: a credential whose refresh token died still has its last snapshot,
 * and nothing about that snapshot says why the numbers stopped moving. */
export const LlmUsageAuthSchema = v.object({
  /** "ok" / "relogin_required" / "degraded" today. String for
   * LlmUsageWindow.status's reason — the vocabulary is the gateway's to grow,
   * and the UI treats anything it does not know as "nothing to announce"
   * rather than inventing an alarm. */
  status: v.string(),
  /** What to do about it, in the gateway's own words (English, and it names
   * the CLI command for the cases the browser cannot fix). Present on the
   * states that are not "ok". */
  reason: v.optional(v.string()),
  /** Epoch ms. */
  observed_at: v.optional(v.number()),
  /** Absolute URL of the gateway's browser re-login page for this credential.
   * The gateway sends a relative `login_path` — it does not know the origin it
   * is published under — and the daemon resolves it against the usage endpoint
   * it fetched, since that is the one address it knows reaches the gateway.
   * The wire carries only the resolved form: a relative path would otherwise
   * be resolved a second time against the WEBUI's origin, which is the
   * daemon's, not the gateway's. Present only for a credential whose re-login
   * the browser can actually perform (`claude_oauth`), and only from a gateway
   * new enough to offer it. */
  login_url: v.optional(v.string()),
});
export type LlmUsageAuth = Output<typeof LlmUsageAuthSchema>;

export const LlmUsageCredentialSchema = v.object({
  name: v.string(),
  /** Credential kind, e.g. "claude_oauth" / "claude_bedrock" / "relay". */
  type: v.optional(v.string()),
  /** Whether quota is knowable for this credential at all. Known values:
   * "observed" (a snapshot is present), "not_applicable" (the credential has
   * no quota to report), "upstream_dependent" (quota lives behind a relay).
   * String for LlmUsageWindow.status's reason. */
  support: v.string(),
  /** How the credential's authentication is holding up. Absent on a gateway
   * too old to report it and on one that has not observed this credential yet,
   * so absence means "nothing known", never "healthy". */
  auth: v.optional(LlmUsageAuthSchema),
  /** Present when `support` is "observed"; absent otherwise. */
  snapshot: v.optional(LlmUsageSnapshotSchema),
  /** Provider-enforced limits beside the quota windows, in upstream's order.
   * Absent when the gateway reports none — which is every credential on a
   * gateway too old to send them, so the UI must read absence as "nothing to
   * show" rather than as an error. */
  limits: v.optional(v.array(LlmUsageLimitSchema)),
  /** Why the gateway could not refresh this credential's reading. Present
   * only on failure; whatever `snapshot` holds alongside it is the last good
   * observation, and its `observed_at` says how old that is. */
  probe_error: v.optional(v.string()),
});
export type LlmUsageCredential = Output<typeof LlmUsageCredentialSchema>;

/** Payload of a completed llm_usage.
 * The gateway's own top-level fields are passed through; only `credentials`
 * is normalized (see LlmUsageSnapshot.windows). */
export const LlmUsageResponseSchema = v.object({
  ok: v.literal(true),
  /** When the gateway assembled the response (epoch ms). */
  generated_at: v.optional(v.number()),
  credentials: v.array(LlmUsageCredentialSchema),
});
export type LlmUsageResponse = Output<typeof LlmUsageResponseSchema>;

// --- llm_stats ---------------------------------------------------------------

/** What one model cost on one day under one credential. Every field is
 * optional and passed through as sent: the gateway owns which counters it
 * reports, and a missing one must read as "not reported" rather than as a
 * zero the UI would then sum. */
export const LlmStatsModelUsageSchema = v.object({
  requests: v.optional(v.number()),
  /** Token counts by the gateway's kind name ("input", "output",
   * "input.cache_read", …), kept as the gateway's own map: the kinds are an
   * open set a provider can add to, and a dotted kind can be a part of the
   * kind it extends ("input.cache_creation.ephemeral_1h" is counted inside
   * "input.cache_creation"), so which kinds to add up is the reader's call. */
  tokens: v.optional(v.record(v.string(), v.number())),
  /** Spend in USD. The one field the screen is built around. */
  usd: v.optional(v.number()),
});
export type LlmStatsModelUsage = Output<typeof LlmStatsModelUsageSchema>;

/** One day's spend, credential → model → counters. Credential names are
 * verbatim from upstream, including the literal "-" the gateway uses for
 * traffic it cannot attribute to a named credential. */
export const LlmStatsDaySchema = v.object({
  credentials: v.record(v.string(), v.record(v.string(), LlmStatsModelUsageSchema)),
  /** The gateway's own total for the day. Kept rather than recomputed from
   * the models so the screen can show the authoritative figure; it can differ
   * from the sum when the gateway counts something it does not break out. */
  total_usd: v.optional(v.number()),
});
export type LlmStatsDay = Output<typeof LlmStatsDaySchema>;

/** Payload of a completed llm_stats.
 * Keyed by "YYYY-MM-DD" in the gateway's own timezone — the daemon does not
 * reinterpret the dates, so a day here means whatever the gateway means. */
export const LlmStatsResponseSchema = v.object({
  ok: v.literal(true),
  /** When the gateway assembled the response (epoch ms). */
  generated_at: v.optional(v.number()),
  days: v.record(v.string(), LlmStatsDaySchema),
});
export type LlmStatsResponse = Output<typeof LlmStatsResponseSchema>;

// --- llm_status --------------------------------------------------------------

/** The gateway's display verdict for one service, and for the report as a
 * whole: "ok" / "warning" / "critical" / "unknown" today. ccmsg never
 * recomputes it: the gateway is the one that knows which of `official` and
 * `observed` outweighs the other, and a second opinion here would disagree
 * with the CLI showing the same report. A string rather than a union, as the
 * transcript's other kinds (DR-0038 §3): the vocabulary is the gateway's to
 * grow, and the UI shows a word it does not know as unknown rather than the
 * report failing to read. */
export const LlmStatusSeveritySchema = v.string();
export type LlmStatusSeverity = Output<typeof LlmStatusSeveritySchema>;

/** What the provider's own status page says: "operational" / "degraded" /
 * "partial_outage" / "major_outage" / "maintenance" / "unknown" today. A
 * string for LlmStatusSeverity's reason. */
export const LlmStatusOfficialStateSchema = v.string();
export type LlmStatusOfficialState = Output<typeof LlmStatusOfficialStateSchema>;

/** What this gateway saw on the wire: "reachable" / "failing" / "unknown"
 * today, deliberately disjoint from the official vocabulary so a reader can
 * never mistake one signal for the other. A string for LlmStatusSeverity's
 * reason. */
export const LlmStatusObservedStateSchema = v.string();
export type LlmStatusObservedState = Output<typeof LlmStatusObservedStateSchema>;

/** One status-page component the gateway watches for this service. */
export const LlmStatusComponentSchema = v.object({
  id: v.optional(v.string()),
  name: v.string(),
  state: LlmStatusOfficialStateSchema,
});
export type LlmStatusComponent = Output<typeof LlmStatusComponentSchema>;

/** One unresolved incident from the provider's status page. Every field but
 * the title is optional: the gateway passes through what the page gave it,
 * and a summary line with a title alone is still worth showing. All of it is
 * provider-authored prose, rendered as text and never as markup. */
export const LlmStatusIncidentSchema = v.object({
  id: v.optional(v.string()),
  name: v.string(),
  /** Provider's own workflow word ("investigating", "monitoring", …). A
   * string rather than a union: the vocabulary is the status page's to grow,
   * and the UI shows it verbatim. */
  state: v.optional(v.string()),
  impact: v.optional(v.string()),
  /** Epoch ms. Absent when the status page's own stamp could not be read. */
  created_at: v.optional(v.number()),
  updated_at: v.optional(v.number()),
  url: v.optional(v.string()),
  latest_update: v.optional(v.string()),
  /** "page" when the incident carries no component mapping, meaning it is
   * shown for reference and did not raise this service's severity. */
  scope: v.optional(v.string()),
});
export type LlmStatusIncident = Output<typeof LlmStatusIncidentSchema>;

/** The provider's published state for one service. */
export const LlmStatusOfficialSchema = v.object({
  state: LlmStatusOfficialStateSchema,
  /** How the gateway obtained it ("statuspage_v2", "link", …). */
  source: v.optional(v.string()),
  /** The human status page, for the "詳しくは公式ページ" link. */
  source_url: v.optional(v.string()),
  /** When the gateway last read the source (epoch ms); null when it never
   * has. */
  observed_at: v.nullish(v.number()),
  /** True when that reading is older than the gateway's `stale_after`: the
   * value shown is the last success, not a current one. */
  stale: v.optional(v.boolean()),
  components: v.array(LlmStatusComponentSchema),
  incidents: v.array(LlmStatusIncidentSchema),
  /** Why the last read failed, when it did. The previous successful state is
   * kept beside it rather than being replaced by the failure. */
  error: v.optional(v.string()),
});
export type LlmStatusOfficial = Output<typeof LlmStatusOfficialSchema>;

/** What this gateway itself observed for the service's routes. */
export const LlmStatusObservedSchema = v.object({
  state: LlmStatusObservedStateSchema,
  /** Epoch ms, like every other instant in this report; null while the
   * gateway has observed nothing. */
  observed_at: v.nullish(v.number()),
  /** When the observation stops counting and the state falls back to
   * "unknown" (the gateway's `observation_ttl`); null with `observed_at`. */
  expires_at: v.nullish(v.number()),
  /** Null until a request has succeeded. */
  last_success_at: v.nullish(v.number()),
  last_failure: v.optional(
    v.object({
      at: v.optional(v.number()),
      /** What kind of failure it was ("upstream_http", "transport", …). */
      kind: v.optional(v.string()),
      /** HTTP status when the failure was one (529 in the case this feature
       * exists for). */
      status: v.optional(v.number()),
    }),
  ),
});
export type LlmStatusObserved = Output<typeof LlmStatusObservedSchema>;

/** One upstream service, with the two signals kept apart. Both are optional
 * because a gateway may report a service it has neither read nor exercised;
 * `severity` is always present since it is what the row's icon is chosen
 * from. */
export const LlmStatusServiceSchema = v.object({
  id: v.string(),
  /** Display name from the gateway. */
  name: v.string(),
  severity: LlmStatusSeveritySchema,
  /** Which configured routes draw on this service. */
  routes: v.array(v.string()),
  official: v.optional(LlmStatusOfficialSchema),
  observed: v.optional(LlmStatusObservedSchema),
});
export type LlmStatusService = Output<typeof LlmStatusServiceSchema>;

/** Top-level roll-up: the worst service severity, plus the breakdown that
 * keeps "one critical among many ok" from reading as "everything is down". */
export const LlmStatusOverallSchema = v.object({
  severity: LlmStatusSeveritySchema,
  /** severity → how many services hold it. Kept as a Record rather than four
   * named fields so a future severity does not need a protocol change. */
  service_counts: v.record(v.string(), v.number()),
});
export type LlmStatusOverall = Output<typeof LlmStatusOverallSchema>;

/** The gateway's upstream-service report (DR-0021 in the gateway repo), as it
 * reaches the webui — the same document whether it arrives as the answer to
 * an `llm_status` request or as a `ev:"llm_status"` push, which is why the
 * `ok: true` envelope is not part of it. */
export const LlmStatusReportSchema = v.object({
  /** The gateway's own version of this document's shape. Passed through
   * rather than gated on. */
  schema_version: v.optional(v.number()),
  /** When the gateway assembled the report (epoch ms). */
  generated_at: v.optional(v.number()),
  overall: LlmStatusOverallSchema,
  services: v.array(LlmStatusServiceSchema),
});
export type LlmStatusReport = Output<typeof LlmStatusReportSchema>;

/** Payload of a completed llm_status. */
export const LlmStatusResponseSchema = v.object({
  ok: v.literal(true),
  ...LlmStatusReportSchema.entries,
});
export type LlmStatusResponse = Output<typeof LlmStatusResponseSchema>;
