// LLM gateway upstream-service proxy (op `llm_status`).
//
// Fetch and byte-bounding live in llm-gateway.ts, shared with `llm_usage` and
// `llm_stats`; what is here is the shape this endpoint's document has to have,
// plus the one thing the other two have no equivalent of — a report the daemon
// re-reads on its own when the gateway tells it an upstream just failed.
//
// The gateway owns every verdict in this document (DR-0021 §3 in the gateway
// repo): ccmsg normalizes the vocabulary and drops what it cannot draw, but
// never recomputes a severity. A second opinion here would put the webui and
// the gateway's own CLI at odds over the same report.
import {
  ErrorCode,
  type ErrorCode as ErrorCodeType,
  type LlmStatusComponent,
  type LlmStatusIncident,
  type LlmStatusObserved,
  type LlmStatusObservedState,
  type LlmStatusOfficial,
  type LlmStatusOfficialState,
  type LlmStatusOverall,
  type LlmStatusReport,
  type LlmStatusService,
  type LlmStatusSeverity,
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

/** A handful of services, each with a few components and unresolved
 * incidents. The incident prose is the only part that can grow, and the
 * gateway already caps it; a megabyte here is the same "this URL points at
 * something else entirely" guard the quota proxy uses. */
const RESPONSE_MAX_BYTES = 1024 * 1024;

/** Served from the gateway's memory snapshot, so this is the round trip to a
 * local process. Matched to the quota fetch rather than tightened: the two
 * travel the same path and a shorter budget would only differ on a host too
 * loaded to answer either. */
export const LLM_STATUS_TIMEOUT_MS = 10_000;

/** A refresh makes the gateway re-read every configured status page before it
 * answers. Its own per-source budget is seconds; this leaves room for several
 * of them in series without letting the request hang the screen. */
export const LLM_STATUS_PROBE_TIMEOUT_MS = 30_000;

export type LlmStatusResult =
  | { ok: true; data: LlmStatusReport }
  | { ok: false; code: ErrorCodeType; msg: string };

const SEVERITIES: readonly LlmStatusSeverity[] = ["ok", "warning", "critical", "unknown"];
const OFFICIAL_STATES: readonly LlmStatusOfficialState[] = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
];
const OBSERVED_STATES: readonly LlmStatusObservedState[] = ["reachable", "failing", "unknown"];

/** Map a word onto a fixed vocabulary, or onto "unknown". Normalizing at the
 * boundary rather than in the view is what makes forward compatibility a
 * daemon concern: a gateway that grows a seventh official state reaches the
 * screen as a grey row, never as a colour the stylesheet does not define or a
 * severity comparison that silently orders wrong. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function parseComponent(value: unknown): LlmStatusComponent | null {
  if (!isRecord(value)) return null;
  const name = optionalString(value.name);
  // A component with no name cannot be labelled, and its state alone says
  // nothing a reader could act on — the service's own row already carries the
  // roll-up.
  if (name === undefined) return null;
  const id = optionalString(value.id);
  return {
    ...(id !== undefined ? { id } : {}),
    name,
    state: oneOf(value.state, OFFICIAL_STATES, "unknown"),
  };
}

/** An incident is worth showing as soon as it has a title; everything else
 * degrades to absent and the line still reads. Dropped without one for
 * parseComponent's reason — an untitled incident is a bullet with nothing in
 * it. */
function parseIncident(value: unknown): LlmStatusIncident | null {
  if (!isRecord(value)) return null;
  const name = optionalString(value.name);
  if (name === undefined) return null;
  const incident: LlmStatusIncident = { name };
  for (const key of [
    "id",
    "state",
    "impact",
    "created_at",
    "updated_at",
    "url",
    "latest_update",
    "scope",
  ] as const) {
    const text = optionalString(value[key]);
    if (text !== undefined) incident[key] = text;
  }
  return incident;
}

function parseOfficial(value: unknown): LlmStatusOfficial | undefined {
  if (!isRecord(value)) return undefined;
  const source = optionalString(value.source);
  const sourceUrl = optionalString(value.source_url);
  const observedAt = optionalNumber(value.observed_at);
  const error = optionalString(value.error);
  return {
    state: oneOf(value.state, OFFICIAL_STATES, "unknown"),
    ...(source !== undefined ? { source } : {}),
    ...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
    ...(observedAt !== undefined ? { observed_at: observedAt } : {}),
    ...(value.stale === true ? { stale: true } : {}),
    components: Array.isArray(value.components)
      ? value.components.map(parseComponent).filter((c): c is LlmStatusComponent => c !== null)
      : [],
    incidents: Array.isArray(value.incidents)
      ? value.incidents.map(parseIncident).filter((i): i is LlmStatusIncident => i !== null)
      : [],
    ...(error !== undefined ? { error } : {}),
  };
}

function parseObserved(value: unknown): LlmStatusObserved | undefined {
  if (!isRecord(value)) return undefined;
  const observed: LlmStatusObserved = {
    state: oneOf(value.state, OBSERVED_STATES, "unknown"),
  };
  for (const key of ["observed_at", "expires_at", "last_success_at"] as const) {
    const num = optionalNumber(value[key]);
    if (num !== undefined) observed[key] = num;
  }
  if (isRecord(value.last_failure)) {
    const at = optionalNumber(value.last_failure.at);
    const kind = optionalString(value.last_failure.kind);
    const status = optionalNumber(value.last_failure.status);
    observed.last_failure = {
      ...(at !== undefined ? { at } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(status !== undefined ? { status } : {}),
    };
  }
  return observed;
}

/** A service without an id cannot be keyed or told apart from its
 * neighbours, so it is dropped; its name falls back to the id, and both
 * signals degrade to absent while the row still renders its severity. */
function parseService(value: unknown): LlmStatusService | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  if (id === undefined) return null;
  const official = parseOfficial(value.official);
  const observed = parseObserved(value.observed);
  return {
    id,
    name: optionalString(value.name) ?? id,
    severity: oneOf(value.severity, SEVERITIES, "unknown"),
    routes: Array.isArray(value.routes)
      ? value.routes.filter((route): route is string => typeof route === "string" && route !== "")
      : [],
    ...(official ? { official } : {}),
    ...(observed ? { observed } : {}),
  };
}

/** The roll-up as the gateway computed it. A report without a usable one is
 * reported as `unknown` with no counts rather than being recomputed from the
 * services: the gateway's rule for combining the two signals is the one the
 * CLI shows, and a rule reimplemented here would drift from it. */
function parseOverall(value: unknown): LlmStatusOverall {
  if (!isRecord(value)) return { severity: "unknown", service_counts: {} };
  const counts: Record<string, number> = {};
  if (isRecord(value.service_counts)) {
    for (const [key, count] of Object.entries(value.service_counts)) {
      const num = optionalNumber(count);
      if (num !== undefined) counts[key] = num;
    }
  }
  return { severity: oneOf(value.severity, SEVERITIES, "unknown"), service_counts: counts };
}

/** Split out from the fetch so the shape rules are testable without a
 * Response object. Rejects only what the UI cannot work around: a body that
 * is not an object with a `services` array. `schema_version` is passed
 * through rather than gated on — every field below it degrades on its own, so
 * a newer gateway reads as unknowns instead of as an error the operator can
 * do nothing about. */
export function parseStatusPayload(parsed: unknown): LlmStatusResult {
  if (!isRecord(parsed) || !Array.isArray(parsed.services)) {
    return {
      ok: false,
      code: ErrorCode.llm_status_unavailable,
      msg: "status endpoint returned no services array",
    };
  }
  const schemaVersion = optionalNumber(parsed.schema_version);
  const generatedAt = optionalNumber(parsed.generated_at);
  return {
    ok: true,
    data: {
      ...(schemaVersion !== undefined ? { schema_version: schemaVersion } : {}),
      ...(generatedAt !== undefined ? { generated_at: generatedAt } : {}),
      overall: parseOverall(parsed.overall),
      services: parsed.services
        .map(parseService)
        .filter((service): service is LlmStatusService => service !== null),
    },
  };
}

/** Ask the gateway to re-read the providers' status pages before answering. */
export function statusUrlWithRefresh(base: string, refresh?: boolean): string {
  return refresh === true ? withQueryParam(base, "refresh", "true") : base;
}

/** Fetch and normalize the gateway's status report, optionally forcing it to
 * re-read the status pages first. */
export async function fetchLlmStatus(
  url: string,
  refresh?: boolean,
  deps: LlmGatewayDeps = productionGatewayDeps,
  timeoutMs: number = LLM_STATUS_TIMEOUT_MS,
): Promise<LlmStatusResult> {
  let target: string;
  try {
    target = statusUrlWithRefresh(url, refresh);
  } catch (e) {
    return {
      ok: false,
      code: ErrorCode.llm_status_unavailable,
      msg: `status endpoint URL is unusable: ${String(e)}`,
    };
  }
  const res = await fetchGatewayJson(
    {
      url: target,
      label: "status",
      code: ErrorCode.llm_status_unavailable,
      maxBytes: RESPONSE_MAX_BYTES,
      timeoutMs: refresh === true ? LLM_STATUS_PROBE_TIMEOUT_MS : timeoutMs,
    },
    deps,
  );
  if (!res.ok) return res;
  return parseStatusPayload(res.parsed);
}

/** How long a 529 waits before the daemon asks the gateway what happened.
 * An outage arrives as a burst — every route of a service fails at once, and
 * every retry after them — so the useful read is the one taken after the
 * burst, not one per event. The gateway refreshes its own sources on the same
 * trigger, so the delay also gives its fetch a head start. */
export const STATUS_REFRESH_DEBOUNCE_MS = 5_000;

export interface StatusRefreshDeps {
  fetch: () => Promise<LlmStatusResult>;
  /** Where a successful re-read goes; the daemon broadcasts it. A failed one
   * is dropped rather than pushed — the clients are holding the last good
   * report, and replacing it with "the gateway did not answer" would lose the
   * outage the trigger was about. */
  onReport: (report: LlmStatusReport) => void;
  onError?: (msg: string) => void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Re-reads the status endpoint after the gateway reports a failing upstream,
 * at most one read at a time (DR-0021 §6's debounce + single-flight).
 *
 * Both guards are needed and neither implies the other: the debounce collapses
 * the burst of events an outage produces, and the single flight covers the
 * case where the next burst lands while a slow read from the previous one is
 * still open. A trigger during a flight is not lost — it re-arms once that
 * read settles, so the last word is always a read taken after the last 529. */
export class LlmStatusRefresher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private again = false;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly deps: StatusRefreshDeps) {
    this.debounceMs = deps.debounceMs ?? STATUS_REFRESH_DEBOUNCE_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** Note that an upstream just failed. Cheap and idempotent within the
   * debounce window, so callers can hand it every failing event they see. */
  trigger(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  /** Drop a pending re-read. For daemon shutdown: a timer left armed keeps
   * the process alive past the point it has anything to answer. */
  stop(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return;
    }
    this.inflight = true;
    try {
      const result = await this.deps.fetch();
      if (result.ok) this.deps.onReport(result.data);
      else this.deps.onError?.(result.msg);
    } catch (e) {
      this.deps.onError?.(String(e));
    } finally {
      this.inflight = false;
      if (this.again) {
        this.again = false;
        this.trigger();
      }
    }
  }
}
