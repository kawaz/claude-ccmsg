// Aggregation for the spend section of /usage, kept out of the component so
// the parts with judgement in them — how a day's total is decided, how days
// roll up into months, how an unattributed credential is labelled — are
// testable without a DOM.
import type { LlmStatsDay, LlmStatsModelUsage, LlmStatsResponse } from "@ccmsg/protocol";

/** The name the gateway gives traffic it cannot attribute to a configured
 * credential. It is a real bucket with real spend in it, so it is shown
 * rather than dropped — just under a label that reads as a category. */
export const UNATTRIBUTED_CREDENTIAL = "-";

export interface ModelTotal {
  model: string;
  usd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface CredentialTotal {
  credential: string;
  usd: number;
  models: ModelTotal[];
}

export interface PeriodTotal {
  /** "2026-07-31" for a day, "2026-07" for a month. */
  key: string;
  usd: number;
  models: ModelTotal[];
  credentials: CredentialTotal[];
}

export interface BucketTotal extends PeriodTotal {
  /** How many days of this bucket the window actually covers. The bucket at
   * the edge of the window is partial, and a reader comparing buckets needs
   * to know which ones are not whole. */
  dayCount: number;
}

/** Human label for a credential name. Only the unattributed bucket is
 * rewritten; every other name is the operator's own and is shown verbatim. */
export function credentialLabel(credential: string): string {
  return credential === UNATTRIBUTED_CREDENTIAL ? "(クレデンシャル未割当)" : credential;
}

function emptyModelTotal(model: string): ModelTotal {
  return {
    model,
    usd: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function addUsage(into: ModelTotal, usage: LlmStatsModelUsage): void {
  into.usd += usage.usd ?? 0;
  into.requests += usage.requests ?? 0;
  into.inputTokens += usage.input_tokens ?? 0;
  into.outputTokens += usage.output_tokens ?? 0;
  into.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  into.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
}

/** Spend first, then name. The screen is read to find what the money went to,
 * so the answer belongs at the top; the name tiebreak keeps rows from
 * swapping places between refreshes when two models cost the same (commonly
 * zero). */
function sortedModels(byModel: Map<string, ModelTotal>): ModelTotal[] {
  return [...byModel.values()].sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
}

/** Sum of every model under every credential. Used as a day's total only when
 * the gateway sent none of its own — see dayTotalUsd. */
function summedUsd(day: LlmStatsDay): number {
  let usd = 0;
  for (const models of Object.values(day.credentials)) {
    for (const usage of Object.values(models)) usd += usage.usd ?? 0;
  }
  return usd;
}

/** The gateway's own figure wins when it sent one: it is the authoritative
 * number for the day and can legitimately exceed the per-model sum when the
 * gateway charges for something it does not break out by model. Falling back
 * to the sum keeps a day renderable when `total_usd` is missing. */
export function dayTotalUsd(day: LlmStatsDay): number {
  return day.total_usd ?? summedUsd(day);
}

function accumulate(
  day: LlmStatsDay,
  byModel: Map<string, ModelTotal>,
  byCredential: Map<string, { usd: number; models: Map<string, ModelTotal> }>,
): void {
  for (const [credential, models] of Object.entries(day.credentials)) {
    let credentialEntry = byCredential.get(credential);
    if (!credentialEntry) {
      credentialEntry = { usd: 0, models: new Map() };
      byCredential.set(credential, credentialEntry);
    }
    for (const [model, usage] of Object.entries(models)) {
      let total = byModel.get(model);
      if (!total) {
        total = emptyModelTotal(model);
        byModel.set(model, total);
      }
      addUsage(total, usage);

      let perCredential = credentialEntry.models.get(model);
      if (!perCredential) {
        perCredential = emptyModelTotal(model);
        credentialEntry.models.set(model, perCredential);
      }
      addUsage(perCredential, usage);
      credentialEntry.usd += usage.usd ?? 0;
    }
  }
}

function finishCredentials(
  byCredential: Map<string, { usd: number; models: Map<string, ModelTotal> }>,
): CredentialTotal[] {
  return [...byCredential.entries()]
    .map(([credential, entry]) => ({
      credential,
      usd: entry.usd,
      models: sortedModels(entry.models),
    }))
    .sort((a, b) => b.usd - a.usd || a.credential.localeCompare(b.credential));
}

/** Newest first, in both the daily and the monthly list: the recent end is
 * what the screen is opened for, and the older rows trail off below it. */
function byKeyDescending<T extends { key: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.key.localeCompare(a.key));
}

export function dailyTotals(days: LlmStatsResponse["days"]): PeriodTotal[] {
  const rows = Object.entries(days).map(([date, day]) => {
    const byModel = new Map<string, ModelTotal>();
    const byCredential = new Map<string, { usd: number; models: Map<string, ModelTotal> }>();
    accumulate(day, byModel, byCredential);
    return {
      key: date,
      usd: dayTotalUsd(day),
      models: sortedModels(byModel),
      credentials: finishCredentials(byCredential),
    };
  });
  return byKeyDescending(rows);
}

/** The four spans the screen offers, and how many days of history each needs
 * from the gateway to fill itself. The counts are deliberately a little wider
 * than the span they draw (32 for a month of days, 96 for ~13 weeks, 397 for
 * 13 months) so the oldest bucket on screen is whole rather than clipped mid
 * -bucket. "yearly" asks for a century of days on purpose: the gateway clamps
 * to its full history, which is what "everything" means here (kawaz r99m17 —
 * no cleverness needed, just a number nothing will ever exceed). */
export const STATS_PERIODS = ["daily", "weekly", "monthly", "yearly"] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

const PERIOD_DAYS: Record<StatsPeriod, number> = {
  daily: 32,
  weekly: 96,
  monthly: 397,
  yearly: 36_524,
};

export function periodDays(period: StatsPeriod): number {
  return PERIOD_DAYS[period];
}

export function isStatsPeriod(value: string): value is StatsPeriod {
  return (STATS_PERIODS as readonly string[]).includes(value);
}

export const PERIOD_LABEL: Record<StatsPeriod, string> = {
  daily: "日別",
  weekly: "週別",
  monthly: "月別",
  yearly: "年別",
};

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO-8601 week key ("2026-W31") for a gateway date. ISO rather than a
 * "7 days back from today" window because a week has to mean the same span
 * every time the screen is opened — otherwise yesterday's numbers move between
 * buckets overnight. Monday starts the week and the week-year can differ from
 * the calendar year at the boundary (2026-12-31 falls in 2027-W01), which is
 * exactly why the year is taken from the ISO calculation and not from the key. */
function isoWeekKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Shift to the Thursday of this week: the ISO week-year is whichever year
  // that Thursday falls in, which is the whole trick to the boundary case.
  const dayOfWeek = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 3);
  const weekYear = date.getUTCFullYear();
  const firstThursday = Date.UTC(weekYear, 0, 4);
  const firstDayOfWeek = (new Date(firstThursday).getUTCDay() + 6) % 7;
  const week1Monday = firstThursday - firstDayOfWeek * 86_400_000;
  const week = Math.round((date.getTime() - week1Monday) / (7 * 86_400_000)) + 1;
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/** Which bucket of the chosen span a gateway date key belongs to. Keys are
 * "YYYY-MM-DD", but one that is not gets its own bucket rather than being
 * dropped or folded into a neighbour's — an unrecognised date is still spend
 * that happened, and showing it under its own name is the only honest place to
 * put it. Every scheme's keys sort lexicographically in chronological order,
 * which is what byKeyDescending relies on. */
export function bucketKey(date: string, period: StatsPeriod): string {
  const match = DATE_KEY.exec(date);
  if (!match) return date;
  if (period === "daily") return date;
  if (period === "monthly") return date.slice(0, 7);
  if (period === "yearly") return date.slice(0, 4);
  return isoWeekKey(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** Human label for a bucket key. Daily keys are already unambiguous; the
 * others would otherwise read as truncated dates. */
export function formatBucket(key: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month) return `${month[1]}年${Number(month[2])}月`;
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `${week[1]}年 第${Number(week[2])}週`;
  const year = /^(\d{4})$/.exec(key);
  if (year) return `${year[1]}年`;
  return key;
}

/** Which of the gateway's token counters a figure came from. Cost is not
 * broken down per counter upstream, so this dimension is measured in tokens —
 * summing dollars across it would mean inventing an apportionment. */
export const CONTEXT_KINDS = ["input", "output", "cacheCreation", "cacheRead"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const CONTEXT_LABEL: Record<ContextKind, string> = {
  input: "入力",
  output: "出力",
  cacheCreation: "キャッシュ書き込み",
  cacheRead: "キャッシュ読み込み",
};

export interface ContextTotal {
  kind: ContextKind;
  tokens: number;
  /** Share of the bucket's total tokens, 0..1. */
  share: number;
}

/** Token counts split by context kind for one bucket, in the fixed order of
 * CONTEXT_KINDS — a stable order matters more than a by-size one here, since
 * the reader is comparing the same four categories across buckets. */
export function contextTotals(models: readonly ModelTotal[]): ContextTotal[] {
  const tokens: Record<ContextKind, number> = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  };
  for (const model of models) {
    tokens.input += model.inputTokens;
    tokens.output += model.outputTokens;
    tokens.cacheCreation += model.cacheCreationTokens;
    tokens.cacheRead += model.cacheReadTokens;
  }
  const total = CONTEXT_KINDS.reduce((sum, kind) => sum + tokens[kind], 0);
  return CONTEXT_KINDS.map((kind) => ({
    kind,
    tokens: tokens[kind],
    share: total > 0 ? tokens[kind] / total : 0,
  }));
}

export function bucketTotals(days: LlmStatsResponse["days"], period: StatsPeriod): BucketTotal[] {
  const months = new Map<
    string,
    {
      usd: number;
      dates: Set<string>;
      byModel: Map<string, ModelTotal>;
      byCredential: Map<string, { usd: number; models: Map<string, ModelTotal> }>;
    }
  >();
  for (const [date, day] of Object.entries(days)) {
    const key = bucketKey(date, period);
    let month = months.get(key);
    if (!month) {
      month = { usd: 0, dates: new Set(), byModel: new Map(), byCredential: new Map() };
      months.set(key, month);
    }
    // Summing the per-day totals rather than the per-model figures keeps the
    // bucket consistent with the days it is made of, including whatever
    // `total_usd` covers that the models do not.
    month.usd += dayTotalUsd(day);
    month.dates.add(date);
    accumulate(day, month.byModel, month.byCredential);
  }
  const rows = [...months.entries()].map(([key, month]) => ({
    key,
    usd: month.usd,
    dayCount: month.dates.size,
    models: sortedModels(month.byModel),
    credentials: finishCredentials(month.byCredential),
  }));
  return byKeyDescending(rows);
}

/** Spend across the whole requested window — the one number that answers
 * "what did this period cost". */
export function windowTotalUsd(days: LlmStatsResponse["days"]): number {
  let usd = 0;
  for (const day of Object.values(days)) usd += dayTotalUsd(day);
  return usd;
}

const USD = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Two decimals with thousands separators, because the real figures run into
 * four digits and "1548.119857" is unreadable at a glance. A nonzero amount
 * that would round to $0.00 is shown as a floor instead, so a model that cost
 * something is never displayed as having cost nothing. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$-";
  if (usd > 0 && usd < 0.005) return "<$0.01";
  if (usd < 0 && usd > -0.005) return ">-$0.01";
  return usd < 0 ? `-$${USD.format(-usd)}` : `$${USD.format(usd)}`;
}

const COUNT = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return COUNT.format(value);
}

/** Compact token counts: the columns sit beside a dollar figure and the exact
 * digit count of 267,628,570 is never the question being asked — the order of
 * magnitude is. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** A share as a percentage. A nonzero share that would round to 0% is shown
 * as a floor instead — 300M input tokens beside a cache-read column 400x its
 * size is still 300M tokens, and "0%" reads as "none". */
export function formatShare(share: number): string {
  if (!Number.isFinite(share)) return "-";
  if (share > 0 && share < 0.005) return "<1%";
  if (share < 1 && share >= 0.995) return ">99%";
  return `${Math.round(share * 100)}%`;
}

/** Share of a total, for the inline bar behind each row. Guards the empty
 * window (every total zero), where every share is 0 rather than NaN. */
export function shareOf(usd: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, usd / total));
}

// ---------------------------------------------------------------------------
// Chart data. The geometry is computed here, in fractions of the plot, so the
// component only multiplies by its pixel box — which keeps the awkward parts
// (which models get a colour, where a segment starts and ends, what the axis
// ticks are) testable without a DOM.

/** How many models get their own colour before the tail folds into one
 * bucket. The categorical palette is eight slots and a ninth series is never a
 * generated hue, so the ninth model onward becomes "その他". */
export const MAX_CHART_SERIES = 8;

/** Name of the folded tail. Not a model, so it is drawn in a neutral rather
 * than taking a categorical slot. */
export const OTHER_SERIES = "その他";

export interface ChartSegment {
  model: string;
  usd: number;
  /** Fraction of the tallest bar at which this segment starts and ends,
   * measured from the baseline. */
  start: number;
  end: number;
}

export interface ChartBar {
  key: string;
  /** Full label, for the hover readout. */
  label: string;
  /** Shortened for the axis, where the same year repeats under every tick and
   * carries no information the window does not already state. */
  axisLabel: string;
  usd: number;
  segments: ChartSegment[];
}

export interface ChartData {
  /** Models in colour-assignment order — by total spend across the whole
   * window, so a model keeps its colour as the reader moves along the axis.
   * Colour follows the entity, never its rank within one bar. */
  models: string[];
  bars: ChartBar[];
  /** Tallest bar's total, which the fractions above are relative to. */
  max: number;
  /** Gridline values from 0 to a rounded ceiling at or above `max`. */
  ticks: number[];
}

/** A "nice" axis ceiling at or above `value`: 1, 2 or 5 times a power of ten,
 * so the ticks land on numbers a reader can do arithmetic with. */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/** Axis ticks from 0 to a nice ceiling. Four intervals is enough to read a
 * magnitude off and few enough to stay a recessive hairline grid. */
export function axisTicks(max: number, intervals = 4): number[] {
  const ceiling = niceCeiling(max);
  if (ceiling === 0) return [0];
  return Array.from({ length: intervals + 1 }, (_, i) => (ceiling / intervals) * i);
}

/** Turn bucket rollups into a stacked-bar series set, oldest bucket first —
 * the chart reads left to right in time, which is the opposite of the table's
 * newest-first order and the right choice for each. */
export function chartData(
  buckets: readonly BucketTotal[],
  maxSeries = MAX_CHART_SERIES,
): ChartData {
  const byModel = new Map<string, number>();
  for (const bucket of buckets) {
    for (const model of bucket.models) {
      byModel.set(model.model, (byModel.get(model.model) ?? 0) + model.usd);
    }
  }
  const ranked = [...byModel.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model]) => model);
  const named = ranked.slice(0, maxSeries);
  const folded = new Set(ranked.slice(maxSeries));
  const models = folded.size > 0 ? [...named, OTHER_SERIES] : named;

  const chronological = [...buckets].sort((a, b) => a.key.localeCompare(b.key));
  const max = chronological.reduce((peak, bucket) => Math.max(peak, bucket.usd), 0);

  const bars = chronological.map((bucket) => {
    const usdByModel = new Map<string, number>();
    for (const model of bucket.models) {
      const name = folded.has(model.model) ? OTHER_SERIES : model.model;
      usdByModel.set(name, (usdByModel.get(name) ?? 0) + model.usd);
    }
    // Stacked in the series order, not in this bar's own order, so a model
    // sits at the same height in every bar and the bands read across the axis.
    let cursor = 0;
    const segments: ChartSegment[] = [];
    for (const model of models) {
      const usd = usdByModel.get(model) ?? 0;
      if (usd <= 0) continue;
      const start = cursor;
      cursor += usd;
      segments.push({
        model,
        usd,
        start: max > 0 ? start / max : 0,
        end: max > 0 ? cursor / max : 0,
      });
    }
    return {
      key: bucket.key,
      label: formatBucket(bucket.key),
      axisLabel: axisBucketLabel(bucket.key),
      usd: bucket.usd,
      segments,
    };
  });

  return { models, bars, max, ticks: axisTicks(max) };
}

/** Axis form of a bucket label. Daily keys drop the year ("07-28") and weekly
 * keys drop the week-year ("W31"); monthly and yearly buckets are few enough
 * that their full labels fit. The hover readout and the table keep the whole
 * key either way, so nothing is lost — only repeated. */
export function axisBucketLabel(key: string): string {
  const day = DATE_KEY.exec(key);
  if (day) return `${day[2]}-${day[3]}`;
  const week = /^\d{4}-(W\d{2})$/.exec(key);
  if (week) return week[1]!;
  return formatBucket(key);
}

/** Show every Nth bucket label, so a month of daily bars does not collide.
 * The newest bucket is always labelled — it is the one being read — and the
 * rest step back from it. */
export function labelStride(barCount: number, maxLabels = 8): number {
  return Math.max(1, Math.ceil(barCount / maxLabels));
}

export function showsLabel(index: number, barCount: number, maxLabels = 8): boolean {
  const stride = labelStride(barCount, maxLabels);
  return (barCount - 1 - index) % stride === 0;
}
