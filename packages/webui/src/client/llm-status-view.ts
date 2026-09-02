// Reading rules for the gateway's upstream-service report: how a severity is
// coloured and named, how the two signals are worded so they cannot be
// mistaken for each other, and which rows sort to the top.
//
// The gateway decides every verdict (its DR-0021 §3) — nothing here derives a
// severity from an official or observed state. What is here is language and
// order: turning the wire's vocabulary into words a reader can act on, and
// putting the service in trouble at the top of the strip.
import type {
  LlmStatusIncident,
  LlmStatusObservedState,
  LlmStatusOfficialState,
  LlmStatusReport,
  LlmStatusService,
  LlmStatusSeverity,
} from "@ccmsg/protocol";

/** Colour classes. The first three are the stylesheet's existing usage tones,
 * so a status row and a quota bar in trouble look the same; "unknown" is its
 * own because "we could not find out" is not a degree of bad. */
export type StatusTone = "ok" | "warn" | "bad" | "unknown";

const TONES: Record<LlmStatusSeverity, StatusTone> = {
  ok: "ok",
  warning: "warn",
  critical: "bad",
  unknown: "unknown",
};

export function severityTone(severity: LlmStatusSeverity): StatusTone {
  return TONES[severity] ?? "unknown";
}

/** A mark rather than a coloured dot alone: colour is the fast read, but it
 * is also the one a colour-blind reader does not get, and these rows are
 * where an outage is announced. */
const MARKS: Record<LlmStatusSeverity, string> = {
  ok: "●",
  warning: "▲",
  critical: "■",
  unknown: "?",
};

export function severityMark(severity: LlmStatusSeverity): string {
  return MARKS[severity] ?? MARKS.unknown;
}

const SEVERITY_LABELS: Record<LlmStatusSeverity, string> = {
  ok: "正常",
  warning: "注意",
  critical: "障害",
  unknown: "不明",
};

export function severityLabel(severity: LlmStatusSeverity): string {
  return SEVERITY_LABELS[severity] ?? SEVERITY_LABELS.unknown;
}

/** Provider-side words. Kept distinct from the observed vocabulary below so
 * the two columns can never be read as one scale — "稼働中" is a claim by the
 * provider, "疎通" is something this gateway did. */
const OFFICIAL_LABELS: Record<LlmStatusOfficialState, string> = {
  operational: "稼働中",
  degraded: "性能低下",
  partial_outage: "一部障害",
  major_outage: "大規模障害",
  maintenance: "メンテナンス",
  unknown: "不明",
};

export function officialLabel(state: LlmStatusOfficialState): string {
  return OFFICIAL_LABELS[state] ?? OFFICIAL_LABELS.unknown;
}

const OBSERVED_LABELS: Record<LlmStatusObservedState, string> = {
  reachable: "疎通",
  failing: "失敗",
  unknown: "未観測",
};

export function observedLabel(state: LlmStatusObservedState): string {
  return OBSERVED_LABELS[state] ?? OBSERVED_LABELS.unknown;
}

/** How long ago, in the units a reader of an outage screen cares about:
 * seconds while it is happening, coarser once it is history. Empty for an
 * absent instant — the column stays, so a service with no reading does not
 * pull the rows around it out of line. */
export function formatStatusAge(atSeconds: number | undefined, nowMs: number): string {
  if (atSeconds === undefined || !Number.isFinite(atSeconds)) return "";
  const ageMs = Math.max(0, nowMs - atSeconds * 1000);
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  return `${Math.floor(hours / 24)} 日前`;
}

/** Worst first: the strip exists to be glanced at, and the row that is about
 * to matter must not be third. `unknown` sorts below `ok` — not knowing is
 * less urgent than a known problem, and the gateway's own roll-up treats it
 * the same way. Ties keep the gateway's order, which is the configured one. */
const SEVERITY_RANK: Record<LlmStatusSeverity, number> = {
  critical: 0,
  warning: 1,
  ok: 2,
  unknown: 3,
};

export function compareServices(a: LlmStatusService, b: LlmStatusService): number {
  const rank = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
  return rank !== 0 ? rank : 0;
}

/** What one row of the strip draws. Assembled here rather than in the
 * component so the wording and the ordering are testable without a DOM. */
export interface ServiceRow {
  id: string;
  name: string;
  severity: LlmStatusSeverity;
  tone: StatusTone;
  mark: string;
  severityText: string;
  routes: string[];
  official: {
    label: string;
    /** True when the provider's page has not been read recently enough for
     * this to be a current claim. */
    stale: boolean;
    age: string;
    sourceUrl?: string;
    /** Why the last read of the status page failed, if it did. The label
     * beside it is still the last successful reading. */
    error?: string;
  } | null;
  observed: {
    label: string;
    age: string;
    /** "HTTP 529" / "transport" — what the gateway last saw go wrong, when
     * the observed state is a failure. */
    failure?: string;
  } | null;
  incidents: LlmStatusIncident[];
}

function failureText(failure: NonNullable<LlmStatusService["observed"]>["last_failure"]): string {
  if (!failure) return "";
  if (failure.status !== undefined) return `HTTP ${failure.status}`;
  return failure.kind ?? "";
}

export function serviceRows(report: LlmStatusReport, nowMs: number): ServiceRow[] {
  return [...report.services].sort(compareServices).map((service) => {
    const official = service.official;
    const observed = service.observed;
    const failure = observed ? failureText(observed.last_failure) : "";
    return {
      id: service.id,
      name: service.name,
      severity: service.severity,
      tone: severityTone(service.severity),
      mark: severityMark(service.severity),
      severityText: severityLabel(service.severity),
      routes: service.routes,
      official: official
        ? {
            label: officialLabel(official.state),
            stale: official.stale === true,
            age: formatStatusAge(official.observed_at, nowMs),
            ...(official.source_url !== undefined ? { sourceUrl: official.source_url } : {}),
            ...(official.error !== undefined ? { error: official.error } : {}),
          }
        : null,
      observed: observed
        ? {
            label: observedLabel(observed.state),
            age: formatStatusAge(observed.observed_at, nowMs),
            ...(failure !== "" ? { failure } : {}),
          }
        : null,
      incidents: official?.incidents ?? [],
    };
  });
}

/** The global header's badge, or null for "say nothing". Only a known problem
 * earns one: `ok` needs no announcement, and `unknown` must not turn a whole
 * header red because one provider publishes no status page — it stays grey
 * inside the strip, where there is room to say what is unknown about it. */
export function headerBadge(
  report: LlmStatusReport | null,
): { severity: LlmStatusSeverity; tone: StatusTone; mark: string; label: string } | null {
  if (!report) return null;
  const severity = report.overall.severity;
  if (severity !== "warning" && severity !== "critical") return null;
  return {
    severity,
    tone: severityTone(severity),
    mark: severityMark(severity),
    label: severityLabel(severity),
  };
}

/** "正常 2 / 不明 1" — the breakdown the roll-up hides. Ordered worst first
 * like the rows, and silent about severities no service holds. */
export function countsSummary(report: LlmStatusReport): string {
  const order: LlmStatusSeverity[] = ["critical", "warning", "ok", "unknown"];
  return order
    .filter((severity) => (report.overall.service_counts[severity] ?? 0) > 0)
    .map((severity) => `${severityLabel(severity)} ${report.overall.service_counts[severity]}`)
    .join(" / ");
}
