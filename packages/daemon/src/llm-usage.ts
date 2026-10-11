// LLM gateway quota proxy (op `llm_usage`).
//
// Fetch and byte-bounding live in llm-gateway.ts, shared with `llm_stats`;
// what is here is the shape this endpoint's document has to have.
import {
  ErrorCode,
  errorText,
  LlmUsageLimitSchema,
  LlmUsageOverageSchema,
  LlmUsageWindowSchema,
  parseWith,
  type ErrorCode as ErrorCodeType,
  type JsonValue,
  type LlmUsageAuth,
  type LlmUsageCredential,
  type LlmUsageResponse,
  type LlmUsageSnapshot,
  type Output,
} from "@ccmsg/protocol";
import * as v from "valibot";
import {
  fetchGatewayJson,
  productionGatewayDeps,
  unreadable,
  withQueryParam,
  type LlmGatewayDeps,
} from "./llm-gateway.ts";

// The gateway's usage document (its `quota.rs` CredentialUsage and Snapshot),
// read for what the screen draws. A window, an overage and a limit are the
// wire's own shapes; the credential, its auth and its snapshot differ from
// the wire and are read here, then built into it below. Fields the gateway
// adds are not read and leave the document readable.

/** What the gateway last observed of a credential's authentication. */
const GatewayAuthSchema = v.object({
  status: v.string(),
  reason: v.optional(v.string()),
  observed_at: v.optional(v.number()),
  /** Relative path of the gateway's browser re-login page. */
  login_path: v.optional(v.string()),
});

/** One observation of a credential's quota: its two windows sit beside
 * `observed_at` under their own keys. */
const GatewaySnapshotSchema = v.object({
  observed_at: v.optional(v.number()),
  "5h": v.optional(LlmUsageWindowSchema),
  "7d": v.optional(LlmUsageWindowSchema),
  overage: v.optional(LlmUsageOverageSchema),
});

const GatewayCredentialSchema = v.object({
  name: v.string(),
  type: v.optional(v.string()),
  support: v.string(),
  auth: v.optional(GatewayAuthSchema),
  snapshot: v.optional(GatewaySnapshotSchema),
  limits: v.optional(v.array(LlmUsageLimitSchema)),
  probe_error: v.optional(v.string()),
});
type GatewayCredential = Output<typeof GatewayCredentialSchema>;

const UsageDocumentSchema = v.object({
  generated_at: v.optional(v.number()),
  credentials: v.array(GatewayCredentialSchema),
});

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

/** Resolve the gateway's relative `login_path` against the address the daemon
 * fetched usage from, which is the only address it knows reaches the gateway.
 *
 * Design rationale: the result is confined to that endpoint's own origin. The
 * link is rendered in the operator's browser, so a gateway (or something
 * answering in its place) that sent an absolute URL elsewhere would be
 * planting a "log in here" button pointing off-host; nothing legitimate needs
 * that, and dropping it costs a button rather than a credential. */
export function resolveLoginUrl(loginPath: string, base: string): string | undefined {
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return undefined;
  }
  let resolved: URL;
  try {
    resolved = new URL(loginPath, baseUrl);
  } catch {
    return undefined;
  }
  if (resolved.origin !== baseUrl.origin) return undefined;
  return resolved.toString();
}

/** `auth` for the wire: the gateway's `login_path` resolved to a link the
 * browser can follow (resolveLoginUrl), when there is an endpoint to resolve
 * it against. */
function wireAuth(
  { login_path: loginPath, ...auth }: NonNullable<GatewayCredential["auth"]>,
  base: string | undefined,
): LlmUsageAuth {
  const loginUrl =
    loginPath === undefined || base === undefined ? undefined : resolveLoginUrl(loginPath, base);
  return { ...auth, ...(loginUrl !== undefined ? { login_url: loginUrl } : {}) };
}

/** `snapshot` for the wire: its windows gathered under `windows`, by key. */
function wireSnapshot({
  "5h": fiveHour,
  "7d": sevenDay,
  ...rest
}: NonNullable<GatewayCredential["snapshot"]>): LlmUsageSnapshot {
  return {
    ...rest,
    windows: {
      ...(fiveHour !== undefined ? { "5h": fiveHour } : {}),
      ...(sevenDay !== undefined ? { "7d": sevenDay } : {}),
    },
  };
}

function wireCredential(
  { auth, snapshot, limits, ...credential }: GatewayCredential,
  base: string | undefined,
): LlmUsageCredential {
  return {
    ...credential,
    ...(auth !== undefined ? { auth: wireAuth(auth, base) } : {}),
    ...(snapshot !== undefined ? { snapshot: wireSnapshot(snapshot) } : {}),
    // The wire leaves `limits` out when there are none (LlmUsageCredential).
    ...(limits !== undefined && limits.length > 0 ? { limits } : {}),
  };
}

/** Split out from the fetch so the shape rules are testable without a
 * Response object. A document that does not read is answered with where it is
 * wrong.
 *
 * `base` is the endpoint this document came from, and the only thing it is
 * used for is turning the gateway's relative `login_path` into an address a
 * browser can follow (resolveLoginUrl). Omitting it drops those links and
 * leaves the rest of the document unchanged. */
export function parseUsagePayload(document: JsonValue, base?: string): LlmUsageResult {
  const read = parseWith(UsageDocumentSchema, document);
  if (!read.ok) return unreadable("usage", ErrorCode.llm_usage_unavailable, read.failure);
  const { credentials, ...rest } = read.value;
  return {
    ok: true,
    data: {
      ok: true,
      ...rest,
      credentials: credentials.map((credential) => wireCredential(credential, base)),
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
      msg: `usage endpoint URL is unusable: ${errorText(e)}`,
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
  // Resolved against the configured endpoint rather than the probe variant of
  // it, so a login link does not carry `?refresh=true` along.
  return parseUsagePayload(res.document, url);
}
