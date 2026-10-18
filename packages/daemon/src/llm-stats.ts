// LLM gateway spend proxy (op `llm_stats`).
//
// Fetch and byte-bounding live in llm-gateway.ts, shared with `llm_usage`;
// what is here is the shape this endpoint's document has to have, plus the
// one thing the quota proxy has no equivalent of — a caller-chosen window.
import {
  ErrorCode,
  LLM_STATS_DAYS_MAX,
  LLM_STATS_DAYS_MIN,
  LlmStatsDaySchema,
  errorText,
  parseWith,
  type ErrorCode as ErrorCodeType,
  type JsonValue,
  type LlmStatsResponse,
} from "@ccmsg/protocol";
import * as v from "valibot";
import {
  fetchGatewayJson,
  productionGatewayDeps,
  unreadable,
  withQueryParam,
  type LlmGatewayDeps,
} from "./llm-gateway.ts";

/** The gateway's spend document (its `stats.rs` Report), read for what the
 * screen draws. Its days and counters are the wire's own shape; what else the
 * gateway reports (per-origin entries, the basis `input` is counted on, the
 * window's total) is not read, and leaves the document readable. */
const StatsDocumentSchema = v.object({
  generated_at: v.optional(v.number()),
  days: v.record(v.string(), LlmStatsDaySchema),
});

/** A year of daily spend across every credential and model runs to a few
 * hundred KB at the observed density (~1.6 KB/day). Four megabytes leaves
 * room for a busier host without letting a misconfigured URL stream the
 * daemon out of memory. */
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/** Wider than the quota fetch's: this document is assembled over a range the
 * caller chose, so a 366-day request is legitimately slower than a snapshot. */
export const LLM_STATS_TIMEOUT_MS = 30_000;

export type LlmStatsResult =
  | { ok: true; data: LlmStatsResponse }
  | { ok: false; code: ErrorCodeType; msg: string };

export function isValidDays(days: number): boolean {
  return Number.isInteger(days) && days >= LLM_STATS_DAYS_MIN && days <= LLM_STATS_DAYS_MAX;
}

/** Put `days` on the configured URL, leaving it alone when the caller named
 * no window (the gateway then picks its own). */
export function statsUrlWithDays(base: string, days?: number): string {
  return days === undefined ? base : withQueryParam(base, "days", String(days));
}

/** Split out from the fetch so the shape rules are testable without a
 * Response object. A document that does not read is answered with where it is
 * wrong. */
export function parseStatsPayload(document: JsonValue): LlmStatsResult {
  const read = parseWith(StatsDocumentSchema, document);
  if (!read.ok) return unreadable("stats", ErrorCode.llm_stats_unavailable, read.failure);
  return { ok: true, data: { ok: true, ...read.value } };
}

/** Fetch and normalize the gateway's spend document for a window of days. */
export async function fetchLlmStats(
  url: string,
  days?: number,
  deps: LlmGatewayDeps = productionGatewayDeps,
  timeoutMs: number = LLM_STATS_TIMEOUT_MS,
): Promise<LlmStatsResult> {
  let target: string;
  try {
    target = statsUrlWithDays(url, days);
  } catch (e) {
    return {
      ok: false,
      code: ErrorCode.llm_stats_unavailable,
      msg: `stats endpoint URL is unusable: ${errorText(e)}`,
    };
  }
  const res = await fetchGatewayJson(
    {
      url: target,
      label: "stats",
      code: ErrorCode.llm_stats_unavailable,
      maxBytes: RESPONSE_MAX_BYTES,
      timeoutMs,
    },
    deps,
  );
  if (!res.ok) return res;
  return parseStatsPayload(res.document);
}
