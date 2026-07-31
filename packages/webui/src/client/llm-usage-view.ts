// Presentation math for the Usage screen, kept out of the component so the
// awkward parts — deriving how far into a window we are, and deciding when
// "ahead of pace" is worth a colour — are testable without a DOM.
import type { LlmUsageSnapshot, LlmUsageWindow } from "@ccmsg/protocol";

/** Snapshots older than this carry their age in the UI. Below it the reading
 * is effectively "now" and a "(0 分前)" on every row would be noise. */
const STALE_AFTER_MS = 60_000;

/** How far utilization may run ahead of the clock before it reads as a
 * warning. Being marginally ahead is ordinary — usage is bursty and no one
 * spends their quota at a constant rate — so a strict `utilization > elapsed`
 * would light up half the rows half the time and stop meaning anything. Five
 * points is wide enough to absorb that and still flag the case that matters:
 * a credential on course to hit its limit before the window resets. */
const PACE_MARGIN = 0.05;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Colour bucket for a window. `bad` = upstream is refusing requests now;
 * `warn` = allowed but heading for trouble (upstream said so, or the burn
 * rate says so). */
export type UsageTone = "ok" | "warn" | "bad";

export interface WindowProgress {
  /** Upstream's key for the window, e.g. "5h" — also its label. */
  key: string;
  utilization: number;
  status: string;
  /** Fraction of the window already elapsed, 0..1. null when the window's
   * length or reset time is unknown, in which case there is nothing to
   * compare the utilization against and no pace verdict is offered. */
  elapsed: number | null;
  /** Milliseconds until the quota resets; null when upstream sent no reset,
   * clamped at 0 for a reset that has already passed (a stale snapshot). */
  remainingMs: number | null;
  /** Utilization is meaningfully ahead of elapsed time. */
  overPace: boolean;
  tone: UsageTone;
}

/** Length of a window from its own key ("5h" → 5 hours). The key is the only
 * place upstream states it — there is no duration field — and deriving it is
 * what makes the elapsed percentage possible. Unknown syntax yields null
 * rather than a guess, and the window still renders with its utilization. */
export function parseWindowDurationMs(key: string): number | null {
  const match = /^(\d+)([smhdw])$/.exec(key);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2] ?? ""];
  if (!unit || amount <= 0) return null;
  return amount * unit;
}

/** "1h29m" under a day, "02d02h" at or above one — the CLI's format, which
 * keeps the two magnitudes visually distinct at a glance. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  if (days > 0) {
    return `${String(days).padStart(2, "0")}d${String(hours).padStart(2, "0")}h`;
  }
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

/** Age of an observation in Japanese, or null while it is fresh enough that
 * saying so adds nothing. */
export function formatAge(ageMs: number): string | null {
  if (ageMs < STALE_AFTER_MS) return null;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  return `${Math.floor(hours / 24)} 日前`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function toneFor(status: string, overPace: boolean): UsageTone {
  if (status === "rejected") return "bad";
  if (status === "allowed_warning" || overPace) return "warn";
  return "ok";
}

export function windowProgress(key: string, window: LlmUsageWindow, nowMs: number): WindowProgress {
  const duration = parseWindowDurationMs(key);
  const remainingMs = window.reset === undefined ? null : Math.max(0, window.reset * 1000 - nowMs);
  const elapsed =
    duration === null || remainingMs === null
      ? null
      : Math.min(1, Math.max(0, (duration - remainingMs) / duration));
  const overPace = elapsed !== null && window.utilization > elapsed + PACE_MARGIN;
  return {
    key,
    utilization: window.utilization,
    status: window.status,
    elapsed,
    remainingMs,
    overPace,
    tone: toneFor(window.status, overPace),
  };
}

/** Windows shortest-first, so the row reads 5h then 7d regardless of the
 * order the gateway serialized them in. Keys whose length is unknown sort
 * last, alphabetically among themselves — they cannot be placed on the scale,
 * and appending them keeps the known windows in a stable position. */
export function sortedWindows(snapshot: LlmUsageSnapshot, nowMs: number): WindowProgress[] {
  return Object.entries(snapshot.windows)
    .sort(([a], [b]) => {
      const da = parseWindowDurationMs(a);
      const db = parseWindowDurationMs(b);
      if (da === null && db === null) return a.localeCompare(b);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    })
    .map(([key, window]) => windowProgress(key, window, nowMs));
}

/** Age of the snapshot's observation, or null when upstream sent no
 * observation time or the reading is still fresh. */
export function snapshotAge(snapshot: LlmUsageSnapshot, nowMs: number): string | null {
  if (snapshot.observed_at === undefined) return null;
  return formatAge(Math.max(0, nowMs - snapshot.observed_at * 1000));
}

/** What "support" means for a credential, for the tooltip beside the raw
 * token (the token itself stays visible — it is what the CLI prints and what
 * the gateway's own docs call it). */
export function supportDescription(support: string): string {
  switch (support) {
    case "observed":
      return "クオータを観測できるクレデンシャル";
    case "not_applicable":
      return "クオータの概念がないクレデンシャル";
    case "upstream_dependent":
      return "上流サービス側のクオータに従うため、ここからは観測できない";
    default:
      return "クオータの観測可否が不明";
  }
}
