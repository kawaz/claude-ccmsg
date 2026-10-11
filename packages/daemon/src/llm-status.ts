// LLM gateway upstream-service proxy (op `llm_status`).
//
// Fetch and byte-bounding live in llm-gateway.ts, shared with `llm_usage` and
// `llm_stats`; what is here is the shape this endpoint's document has to have,
// plus the one thing the other two have no equivalent of — a report the daemon
// re-reads on its own when the gateway tells it an upstream just failed.
//
// The gateway owns every verdict in this document (DR-0021 §3 in the gateway
// repo): ccmsg relays it as the gateway wrote it and never recomputes a
// severity. A second opinion here would put the webui and the gateway's own
// CLI at odds over the same report. A word of its vocabulary the webui does
// not know is the webui's to show as unknown.
import {
  ErrorCode,
  errorText,
  LlmStatusReportSchema,
  parseWith,
  type ErrorCode as ErrorCodeType,
  type JsonValue,
  type LlmStatusReport,
} from "@ccmsg/protocol";
import {
  fetchGatewayJson,
  productionGatewayDeps,
  unreadable,
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

/** Split out from the fetch so the shape rules are testable without a
 * Response object. The document is read by the wire's own report schema (the
 * gateway's `status.rs` Report): the two are one shape, relayed as written.
 * `schema_version` is passed through rather than gated on. A document that
 * does not read is answered with where it is wrong. */
export function parseStatusPayload(document: JsonValue): LlmStatusResult {
  const read = parseWith(LlmStatusReportSchema, document);
  return read.ok
    ? { ok: true, data: read.value }
    : unreadable("status", ErrorCode.llm_status_unavailable, read.failure);
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
      msg: `status endpoint URL is unusable: ${errorText(e)}`,
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
  return parseStatusPayload(res.document);
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
      this.deps.onError?.(errorText(e));
    } finally {
      this.inflight = false;
      if (this.again) {
        this.again = false;
        this.trigger();
      }
    }
  }
}
