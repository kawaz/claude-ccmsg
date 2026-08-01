// LLM gateway spend proxy (op `llm_stats`).
//
// Fetch and byte-bounding live in llm-gateway.ts, shared with `llm_usage`;
// what is here is the shape this endpoint's document has to have, plus the
// one thing the quota proxy has no equivalent of — a caller-chosen window.
import {
  ErrorCode,
  LLM_STATS_DAYS_MAX,
  LLM_STATS_DAYS_MIN,
  type ErrorCode as ErrorCodeType,
  type LlmStatsDay,
  type LlmStatsModelUsage,
  type LlmStatsResponse,
} from "@ccmsg/protocol";
import {
  fetchGatewayJson,
  isRecord,
  optionalNumber,
  optionalString,
  productionGatewayDeps,
  withQueryParam,
  type LlmGatewayDeps,
} from "./llm-gateway.ts";

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

export function isValidDays(days: unknown): days is number {
  return (
    typeof days === "number" &&
    Number.isInteger(days) &&
    days >= LLM_STATS_DAYS_MIN &&
    days <= LLM_STATS_DAYS_MAX
  );
}

/** Put `days` on the configured URL, leaving it alone when the caller named
 * no window (the gateway then picks its own). */
export function statsUrlWithDays(base: string, days?: number): string {
  return days === undefined ? base : withQueryParam(base, "days", String(days));
}

/** Counters for one model. Non-numeric fields are dropped rather than
 * coerced: a counter the UI sums has to be a number or absent, never NaN. */
function parseModelUsage(value: unknown): LlmStatsModelUsage | null {
  if (!isRecord(value)) return null;
  const usage: LlmStatsModelUsage = {};
  for (const key of [
    "requests",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "usd",
  ] as const) {
    const num = optionalNumber(value[key]);
    if (num !== undefined) usage[key] = num;
  }
  return usage;
}

/** One day. A day whose `credentials` is not an object still renders as an
 * empty day with its total, which is more useful than dropping the date out
 * of the series and leaving a hole in the chart. */
function parseDay(value: unknown): LlmStatsDay | null {
  if (!isRecord(value)) return null;
  const credentials: Record<string, Record<string, LlmStatsModelUsage>> = {};
  if (isRecord(value.credentials)) {
    for (const [name, models] of Object.entries(value.credentials)) {
      if (!isRecord(models)) continue;
      const byModel: Record<string, LlmStatsModelUsage> = {};
      for (const [model, entry] of Object.entries(models)) {
        const usage = parseModelUsage(entry);
        if (usage) byModel[model] = usage;
      }
      credentials[name] = byModel;
    }
  }
  const totalUsd = optionalNumber(value.total_usd);
  return { credentials, ...(totalUsd !== undefined ? { total_usd: totalUsd } : {}) };
}

/** Split out from the fetch so the shape rules are testable without a
 * Response object. Rejects only what the UI cannot work around: a body that
 * is not an object with a `days` object. */
export function parseStatsPayload(parsed: unknown): LlmStatsResult {
  if (!isRecord(parsed) || !isRecord(parsed.days)) {
    return {
      ok: false,
      code: ErrorCode.llm_stats_unavailable,
      msg: "stats endpoint returned no days object",
    };
  }
  const days: Record<string, LlmStatsDay> = {};
  for (const [date, entry] of Object.entries(parsed.days)) {
    const day = parseDay(entry);
    if (day) days[date] = day;
  }
  const generatedAt = optionalNumber(parsed.generated_at);
  const generatedAtIso = optionalString(parsed.generated_at_iso);
  return {
    ok: true,
    data: {
      ok: true,
      ...(generatedAt !== undefined ? { generated_at: generatedAt } : {}),
      ...(generatedAtIso !== undefined ? { generated_at_iso: generatedAtIso } : {}),
      days,
    },
  };
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
      msg: `stats endpoint URL is unusable: ${String(e)}`,
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
  return parseStatsPayload(res.parsed);
}
