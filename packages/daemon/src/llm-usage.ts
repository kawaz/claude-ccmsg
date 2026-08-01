// LLM gateway quota proxy (op `llm_usage`).
//
// Fetch and byte-bounding live in llm-gateway.ts, shared with `llm_stats`;
// what is here is the shape this endpoint's document has to have.
import {
  ErrorCode,
  type ErrorCode as ErrorCodeType,
  type LlmUsageCredential,
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
  type LlmGatewayDeps,
} from "./llm-gateway.ts";

/** Upstream is a small JSON document (a handful of credentials); anything at
 * this size is a misconfigured URL pointing at something else entirely, and
 * buffering it would cost the daemon memory for a response it cannot use. */
const RESPONSE_MAX_BYTES = 1024 * 1024;

/** The gateway is normally on the LAN or localhost. Long enough to survive a
 * cold upstream, short enough that the UI's own retry stays plausible. */
export const LLM_USAGE_TIMEOUT_MS = 10_000;

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
  return {
    name,
    ...(type !== undefined ? { type } : {}),
    support,
    ...(snapshot ? { snapshot } : {}),
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

/** Fetch and normalize the gateway's usage document. */
export async function fetchLlmUsage(
  url: string,
  deps: LlmGatewayDeps = productionGatewayDeps,
  timeoutMs: number = LLM_USAGE_TIMEOUT_MS,
): Promise<LlmUsageResult> {
  const res = await fetchGatewayJson(
    {
      url,
      label: "usage",
      code: ErrorCode.llm_usage_unavailable,
      maxBytes: RESPONSE_MAX_BYTES,
      timeoutMs,
    },
    deps,
  );
  if (!res.ok) return res;
  return parseUsagePayload(res.parsed);
}
