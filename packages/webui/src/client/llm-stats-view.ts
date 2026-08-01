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

export interface MonthTotal extends PeriodTotal {
  /** How many days of this month the window actually covers. A month at the
   * edge of the window is partial, and a reader comparing months needs to
   * know which ones are not whole. */
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

/** The month a gateway date key belongs to. Keys are "YYYY-MM-DD", but a key
 * that is not gets its own bucket rather than being dropped or folded into a
 * neighbour's month — an unrecognised date is still spend that happened, and
 * showing it under its own name is the only honest place to put it. */
export function monthKey(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 7) : date;
}

export function monthlyTotals(days: LlmStatsResponse["days"]): MonthTotal[] {
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
    const key = monthKey(date);
    let month = months.get(key);
    if (!month) {
      month = { usd: 0, dates: new Set(), byModel: new Map(), byCredential: new Map() };
      months.set(key, month);
    }
    // Summing the per-day totals rather than the per-model figures keeps the
    // month consistent with the days listed under it, including whatever
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

/** Share of a total, for the inline bar behind each row. Guards the empty
 * window (every total zero), where every share is 0 rather than NaN. */
export function shareOf(usd: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, usd / total));
}

/** "2026-07" → "2026年7月". The daily keys are already unambiguous, but a
 * bare "2026-07" beside them reads as a truncated date rather than a month. */
export function formatMonth(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  return `${match[1]}年${Number(match[2])}月`;
}
