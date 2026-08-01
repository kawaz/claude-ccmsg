// LLM gateway quota proxy (op `llm_usage`).
//
// Fetch and byte-bounding live in llm-gateway.ts, shared with `llm_stats`;
// what is here is the shape this endpoint's document has to have.
import {
  ErrorCode,
  type ErrorCode as ErrorCodeType,
  type LlmUsageCredential,
  type LlmUsageLimit,
  type LlmUsageOverage,
  type LlmUsageResponse,
  type LlmUsageSnapshot,
  type LlmUsageWindow,
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

/** Upstream is a small JSON document (a handful of credentials); anything at
 * this size is a misconfigured URL pointing at something else entirely, and
 * buffering it would cost the daemon memory for a response it cannot use. */
const RESPONSE_MAX_BYTES = 1024 * 1024;

/** The gateway is normally on the LAN or localhost. Long enough to survive a
 * cold upstream, short enough that the UI's own retry stays plausible. */
export const LLM_USAGE_TIMEOUT_MS = 10_000;

/** A refresh makes the gateway call every upstream provider in turn, so it
 * takes far longer than serving the cache. Wide enough that a slow provider
 * does not abort the whole probe, and the button that triggers it shows its
 * own pending state meanwhile. */
export const LLM_USAGE_PROBE_TIMEOUT_MS = 60_000;

export type LlmUsageResult =
  | { ok: true; data: LlmUsageResponse }
  | { ok: false; code: ErrorCodeType; msg: string };

/** A sibling key of `observed_at` counts as a quota window only if it carries
 * the two fields the UI needs to draw one. Shape rather than an allowlist of
 * "5h"/"7d" so a gateway that adds a window needs no daemon change, and a
 * gateway that adds an unrelated key is dropped instead of drawn as an empty
 * bar (LlmUsageSnapshot.windows). */
function parseWindow(value: unknown): LlmUsageWindow | null {
  if (!isRecord(value)) return null;
  const utilization = optionalNumber(value.utilization);
  const status = optionalString(value.status);
  if (utilization === undefined || status === undefined) return null;
  const reset = optionalNumber(value.reset);
  const resetIso = optionalString(value.reset_iso);
  return {
    utilization,
    status,
    ...(reset !== undefined ? { reset } : {}),
    ...(resetIso !== undefined ? { reset_iso: resetIso } : {}),
  };
}

function parseOverage(value: unknown): LlmUsageOverage | undefined {
  if (!isRecord(value)) return undefined;
  const status = optionalString(value.status);
  if (status === undefined) return undefined;
  const reason = optionalString(value.disabled_reason);
  return { status, ...(reason !== undefined ? { disabled_reason: reason } : {}) };
}

function parseSnapshot(value: unknown): LlmUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const windows: Record<string, LlmUsageWindow> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "observed_at" || key === "observed_at_iso" || key === "overage") continue;
    const window = parseWindow(entry);
    if (window) windows[key] = window;
  }
  const observedAt = optionalNumber(value.observed_at);
  const observedAtIso = optionalString(value.observed_at_iso);
  const overage = parseOverage(value.overage);
  return {
    ...(observedAt !== undefined ? { observed_at: observedAt } : {}),
    ...(observedAtIso !== undefined ? { observed_at_iso: observedAtIso } : {}),
    ...(overage ? { overage } : {}),
    windows,
  };
}

/** Recognised by shape, like parseWindow: an entry counts as a limit only if
 * it carries the two fields the UI needs to draw one (a name for it and a
 * figure). Everything else degrades to absent and the row still renders, so a
 * gateway that adds a field needs no daemon change. */
function parseLimit(value: unknown): LlmUsageLimit | null {
  if (!isRecord(value)) return null;
  const kind = optionalString(value.kind);
  const percent = optionalNumber(value.percent);
  if (kind === undefined || percent === undefined) return null;
  const resetsAt = optionalString(value.resets_at);
  const model = optionalString(value.model);
  return {
    kind,
    percent,
    severity: optionalString(value.severity) ?? "unknown",
    ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(typeof value.is_active === "boolean" ? { is_active: value.is_active } : {}),
  };
}

/** A credential without a name cannot be labelled or told apart from its
 * neighbours, so it is dropped; every other field degrades to absent and the
 * row still renders. */
function parseCredential(value: unknown): LlmUsageCredential | null {
  if (!isRecord(value)) return null;
  const name = optionalString(value.name);
  if (name === undefined) return null;
  const type = optionalString(value.type);
  const support = optionalString(value.support) ?? "unknown";
  const snapshot = parseSnapshot(value.snapshot);
  const probeError = optionalString(value.probe_error);
  // An absent `limits` and an unusable one both collapse to "no limits": the
  // screen shows nothing extra either way, and a gateway too old to send the
  // field is the common case rather than an error.
  const limits = Array.isArray(value.limits)
    ? value.limits.map(parseLimit).filter((limit): limit is LlmUsageLimit => limit !== null)
    : [];
  return {
    name,
    ...(type !== undefined ? { type } : {}),
    support,
    ...(snapshot ? { snapshot } : {}),
    ...(limits.length > 0 ? { limits } : {}),
    ...(probeError !== undefined ? { probe_error: probeError } : {}),
  };
}

/** Split out from the fetch so the shape rules are testable without a
 * Response object. Rejects only the one thing the UI cannot work around: a
 * body that is not an object with a `credentials` array. */
export function parseUsagePayload(parsed: unknown): LlmUsageResult {
  if (!isRecord(parsed) || !Array.isArray(parsed.credentials)) {
    return {
      ok: false,
      code: ErrorCode.llm_usage_unavailable,
      msg: "usage endpoint returned no credentials array",
    };
  }
  const credentials: LlmUsageCredential[] = [];
  for (const entry of parsed.credentials) {
    const credential = parseCredential(entry);
    if (credential) credentials.push(credential);
  }
  const generatedAt = optionalNumber(parsed.generated_at);
  const generatedAtIso = optionalString(parsed.generated_at_iso);
  return {
    ok: true,
    data: {
      ok: true,
      ...(generatedAt !== undefined ? { generated_at: generatedAt } : {}),
      ...(generatedAtIso !== undefined ? { generated_at_iso: generatedAtIso } : {}),
      credentials,
    },
  };
}

/** Ask the gateway to probe upstream rather than answer from its cache. Only
 * the probe response carries `limits` and `probe_error`. */
export function usageUrlWithRefresh(base: string, refresh?: boolean): string {
  return refresh === true ? withQueryParam(base, "refresh", "true") : base;
}

/** Fetch and normalize the gateway's usage document, optionally forcing an
 * upstream probe. */
export async function fetchLlmUsage(
  url: string,
  refresh?: boolean,
  deps: LlmGatewayDeps = productionGatewayDeps,
  timeoutMs: number = LLM_USAGE_TIMEOUT_MS,
): Promise<LlmUsageResult> {
  let target: string;
  try {
    target = usageUrlWithRefresh(url, refresh);
  } catch (e) {
    return {
      ok: false,
      code: ErrorCode.llm_usage_unavailable,
      msg: `usage endpoint URL is unusable: ${String(e)}`,
    };
  }
  const res = await fetchGatewayJson(
    {
      url: target,
      label: "usage",
      code: ErrorCode.llm_usage_unavailable,
      maxBytes: RESPONSE_MAX_BYTES,
      // A probe waits on upstream rather than on the gateway's cache, so it
      // is legitimately slower than a cached read.
      timeoutMs: refresh === true ? LLM_USAGE_PROBE_TIMEOUT_MS : timeoutMs,
    },
    deps,
  );
  if (!res.ok) return res;
  return parseUsagePayload(res.parsed);
}
