// Presentation math for the Usage screen, kept out of the component so the
// awkward parts — deriving how far into a window we are, and deciding when
// "ahead of pace" is worth a colour — are testable without a DOM.
import type {
  LlmUsageCredential,
  LlmUsageLimit,
  LlmUsageSnapshot,
  LlmUsageWindow,
} from "@ccmsg/protocol";

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

/** What the two-track bar needs to draw one row, whether that row came from a
 * quota window or from a provider limit. The two arrive in different units and
 * with different verdict vocabularies; normalizing to this shape is what lets
 * them share a bar instead of each growing their own. */
export interface BarProgress {
  /** Upstream's identifier for the row — the window key ("5h") or the limit
   * kind ("weekly_scoped"). Also the label. */
  key: string;
  /** Consumed share, 0..1. Limits arrive as 0..100 and are divided here. */
  utilization: number;
  /** Fraction of the period already elapsed, 0..1. null when the period's
   * length or reset time is unknown, in which case there is nothing to
   * compare the utilization against and no pace verdict is offered. */
  elapsed: number | null;
  /** Milliseconds until the counter resets; null when upstream sent no reset,
   * clamped at 0 for a reset that has already passed (a stale reading). */
  remainingMs: number | null;
  /** The reset instant itself, for the absolute form of the same figure. Kept
   * beside `remainingMs` rather than derived from it at render time, since
   * that derivation would drift by however long the reading has been on
   * screen. Null whenever `remainingMs` is. */
  resetAtMs: number | null;
  /** Consumption is meaningfully ahead of elapsed time. */
  overPace: boolean;
  tone: UsageTone;
}

export interface WindowProgress extends BarProgress {
  status: string;
}

export interface LimitProgress extends BarProgress {
  /** Upstream's own word for this limit, untranslated. */
  severity: string;
  /** Model family the limit is scoped to, when it is scoped to one. */
  model?: string;
  /** Whether upstream is currently counting against this limit. Shown as a
   * marker, not as a tone: an inactive limit is not a healthy one and an
   * active limit is not a breached one. */
  isActive: boolean;
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

/** A period's length as the compact form its own key uses ("5h", "7d"), for
 * the denominator beside a remaining time. Windows already carry this in
 * their key; limits do not, so it is derived from the duration and both end
 * up spelled the same way. Null length renders as nothing — the column still
 * takes its width so the rows stay aligned. */
export function formatDurationShort(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "";
  // Days, hours, minutes — deliberately no weeks: upstream's own key for the
  // long window is "7d", and a denominator reading "/1w" beside a row labelled
  // "7d" would look like a different period.
  for (const [unit, size] of [
    ["d", UNIT_MS.d!],
    ["h", UNIT_MS.h!],
    ["m", UNIT_MS.m!],
  ] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / UNIT_MS.m!)}m`;
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

/** The reset instant as a short local wall-clock stamp ("08-02 09:00"). Local
 * rather than UTC because the reader compares it against their own clock, and
 * without a year because a quota window never resets more than days out. */
export function formatResetAt(atMs: number): string {
  const at = new Date(atMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
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

/** How far into a period we are, given its total length and what remains.
 * Shared by windows and limits because the arithmetic is the same once each
 * has produced a duration and a remaining time. */
function paceOf(
  durationMs: number | null,
  remainingMs: number | null,
  utilization: number,
): { elapsed: number | null; overPace: boolean } {
  const elapsed =
    durationMs === null || remainingMs === null
      ? null
      : Math.min(1, Math.max(0, (durationMs - remainingMs) / durationMs));
  return { elapsed, overPace: elapsed !== null && utilization > elapsed + PACE_MARGIN };
}

export function windowProgress(key: string, window: LlmUsageWindow, nowMs: number): WindowProgress {
  const resetAtMs = window.reset === undefined ? null : window.reset * 1000;
  const remainingMs = resetAtMs === null ? null : Math.max(0, resetAtMs - nowMs);
  const { elapsed, overPace } = paceOf(parseWindowDurationMs(key), remainingMs, window.utilization);
  return {
    key,
    utilization: window.utilization,
    status: window.status,
    elapsed,
    remainingMs,
    resetAtMs,
    overPace,
    tone: toneFor(window.status, overPace),
  };
}

/** How long a limit's period is, from its kind. Upstream states the reset
 * instant but never the length, and without a length there is no elapsed
 * fraction to draw — so the two kinds whose period is known by name get one,
 * and anything else (including a kind added later) renders as consumption
 * alone rather than against a guessed clock. */
export function limitKindDurationMs(kind: string): number | null {
  if (kind === "session") return 5 * UNIT_MS.h!;
  if (kind.startsWith("weekly_")) return 7 * UNIT_MS.d!;
  return null;
}

/** Upstream's verdict for a limit, on the same three-way scale the windows
 * use. An unrecognised severity reads as "ok" rather than as alarming: the
 * gateway may add a word, and colouring an unknown one red would invent a
 * problem the reading does not state. */
export function severityTone(severity: string): UsageTone {
  if (severity === "critical") return "bad";
  if (severity === "warning") return "warn";
  return "ok";
}

/** Normalize one limit for display. The unit conversion lives here and only
 * here: `percent` is 0..100 on the wire while every bar on this screen is
 * drawn from a 0..1 fraction, and mixing the two would render a 47% limit as
 * a full bar. */
export function limitProgress(limit: LlmUsageLimit, nowMs: number): LimitProgress {
  const utilization = limit.percent / 100;
  const parsed = limit.resets_at === undefined ? Number.NaN : Date.parse(limit.resets_at);
  const resetAtMs = Number.isNaN(parsed) ? null : parsed;
  const remainingMs = resetAtMs === null ? null : Math.max(0, resetAtMs - nowMs);
  const { elapsed, overPace } = paceOf(limitKindDurationMs(limit.kind), remainingMs, utilization);
  const tone = severityTone(limit.severity);
  return {
    key: limit.kind,
    utilization,
    elapsed,
    remainingMs,
    resetAtMs,
    overPace,
    // Upstream's own verdict wins when it says anything is wrong; the pace
    // reading can only raise a "normal" limit to a warning, never talk a
    // critical one down.
    tone: tone === "ok" && overPace ? "warn" : tone,
    severity: limit.severity,
    ...(limit.model !== undefined ? { model: limit.model } : {}),
    isActive: limit.is_active === true,
  };
}

/** Limits shortest-period-first for sortedWindows' reason, with kinds of
 * unknown length last. Ties keep upstream's order, which groups the scoped
 * limits with the total they are carved out of. */
export function sortedLimits(limits: readonly LlmUsageLimit[], nowMs: number): LimitProgress[] {
  return limits
    .map((limit, index) => ({ limit, index }))
    .sort((a, b) => {
      const da = limitKindDurationMs(a.limit.kind);
      const db = limitKindDurationMs(b.limit.kind);
      if (da === db) return a.index - b.index;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    })
    .map(({ limit }) => limitProgress(limit, nowMs));
}

/** Label for a limit row: the kind verbatim, with the model family appended
 * when the limit is scoped to one. Upstream's words are not translated — they
 * are what the gateway's own output and docs call these. */
export function limitLabel(progress: LimitProgress): string {
  return progress.model === undefined ? progress.key : `${progress.key} (${progress.model})`;
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

/** What one probe told us about one credential. Retained after the probe
 * because the gateway's cached document — everything the screen loads by
 * itself — carries neither field, so without this the limits would flash up
 * once and vanish at the next poll. */
export interface ProbeRecord {
  limits: LlmUsageLimit[];
  probeError?: string;
  /** `observed_at` of the snapshot the probe produced (epoch seconds), which
   * is what dates the retained figures. */
  observedAt?: number;
}

/** Pull the probe-only fields out of a response's credential, or null when
 * the response carries none (every cached read). */
export function probeRecordOf(credential: LlmUsageCredential): ProbeRecord | null {
  const limits = credential.limits ?? [];
  const probeError = credential.probe_error;
  if (limits.length === 0 && probeError === undefined) return null;
  return {
    limits,
    ...(probeError !== undefined ? { probeError } : {}),
    ...(credential.snapshot?.observed_at !== undefined
      ? { observedAt: credential.snapshot.observed_at }
      : {}),
  };
}

export interface ProbeView {
  limits: LlmUsageLimit[];
  probeError: string | null;
  /** Age of the retained reading — of its `observed_at`, not of the request
   * that fetched it, since a probe upstream refused returns an observation
   * from before it. Set only when what is shown came from an earlier probe
   * rather than from the response in hand: an age on a live reading would be
   * wrong, and on an empty one meaningless. */
  retainedAge: string | null;
}

/** Decide what to draw for a credential: the response's own probe fields when
 * it has them, otherwise the last probe's, labelled with its age. A live
 * response that carries none does NOT clear the retained record — a cached
 * read is silent about limits, not evidence that they went away. */
export function probeView(
  credential: LlmUsageCredential,
  retained: ProbeRecord | undefined,
  nowMs: number,
): ProbeView {
  const live = probeRecordOf(credential);
  if (live) {
    return { limits: live.limits, probeError: live.probeError ?? null, retainedAge: null };
  }
  if (!retained) return { limits: [], probeError: null, retainedAge: null };
  return {
    limits: retained.limits,
    probeError: retained.probeError ?? null,
    retainedAge:
      retained.observedAt === undefined
        ? null
        : (formatAge(Math.max(0, nowMs - retained.observedAt * 1000)) ?? "直前"),
  };
}
