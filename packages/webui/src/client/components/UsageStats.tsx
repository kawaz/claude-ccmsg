// The spend tab of /usage: what the host's LLM credentials cost, bucketed at
// the span the reader picked, with a stacked-bar chart above the table. Chart
// and table are the same numbers twice on purpose — the chart answers "which
// way is this going", the table answers "what exactly was it".
import { useEffect, useState } from "preact/hooks";
import type { ErrorResponse, LlmStatsResponse } from "@ccmsg/protocol";
import {
  CONTEXT_LABEL,
  PERIOD_LABEL,
  STATS_PERIODS,
  bucketTotals,
  chartData,
  contextTotals,
  formatBucket,
  credentialLabel,
  formatCount,
  formatShare,
  formatTokens,
  formatUsd,
  periodDays,
  shareOf,
  windowTotalUsd,
  type BucketTotal,
  type CredentialTotal,
  type ModelTotal,
  type StatsPeriod,
} from "../llm-stats-view.ts";
import { usageStatsHref } from "../locator.ts";
import { pushNavigation } from "../navigation.ts";
import { useApp } from "../context.ts";
import { UsageChart } from "./UsageChart.tsx";

/** Spend is settled history plus a partial current bucket; it does not move on
 * the scale that quota does, and a wide span is an expensive document for the
 * gateway to assemble. Five minutes keeps the current bucket current enough to
 * be worth reading without asking for a year of data every minute. */
const REFRESH_MS = 5 * 60_000;

/** One row above everything it scopes, never inside a chart card. */
function PeriodPicker({ period }: { period: StatsPeriod }) {
  return (
    <div class="stats-period" role="group" aria-label="集計単位">
      {STATS_PERIODS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          class="stats-period-preset"
          aria-pressed={period === candidate}
          onClick={() => {
            if (period !== candidate) pushNavigation(usageStatsHref(candidate));
          }}
        >
          {PERIOD_LABEL[candidate]}
        </button>
      ))}
    </div>
  );
}

function ModelRow({ model, total }: { model: ModelTotal; total: number }) {
  return (
    <li class="stats-model">
      <span class="stats-model-name" title={model.model}>
        {model.model}
      </span>
      <span
        class="stats-model-bar"
        role="img"
        aria-label={`${model.model}: 合計の ${formatShare(shareOf(model.usd, total))}`}
      >
        <span
          class="stats-model-bar-fill"
          style={{ width: `${shareOf(model.usd, total) * 100}%` }}
        />
      </span>
      <span class="stats-model-usd">{formatUsd(model.usd)}</span>
      <span class="stats-model-counters">{formatCount(model.requests)} req</span>
    </li>
  );
}

/** Token volume per context kind. Measured in tokens rather than dollars
 * because upstream does not price the counters separately — apportioning the
 * bucket's cost across them would be an invention, not a reading. */
function ContextBreakdown({ models }: { models: readonly ModelTotal[] }) {
  const totals = contextTotals(models);
  if (!totals.some((entry) => entry.tokens > 0)) return null;
  return (
    <ul class="stats-models">
      {totals.map((entry) => (
        <li key={entry.kind} class="stats-model">
          <span class="stats-model-name">{CONTEXT_LABEL[entry.kind]}</span>
          <span
            class="stats-model-bar"
            role="img"
            aria-label={`${CONTEXT_LABEL[entry.kind]}: トークン全体の ${formatShare(entry.share)}`}
          >
            <span class="stats-model-bar-fill" style={{ width: `${entry.share * 100}%` }} />
          </span>
          <span class="stats-model-usd">{formatTokens(entry.tokens)}</span>
          <span class="stats-model-counters">{formatShare(entry.share)}</span>
        </li>
      ))}
    </ul>
  );
}

function CredentialBlock({ credential, total }: { credential: CredentialTotal; total: number }) {
  return (
    <div class="stats-credential">
      <div class="stats-credential-head">
        <span class="stats-credential-name">{credentialLabel(credential.credential)}</span>
        <span class="stats-credential-usd">{formatUsd(credential.usd)}</span>
      </div>
      <ul class="stats-models">
        {credential.models.map((model) => (
          <ModelRow key={model.model} model={model} total={total} />
        ))}
      </ul>
    </div>
  );
}

/** One bucket. Collapsed it is a total with a bar; opened it is the model
 * breakdown, then the context kinds, then the same split per credential.
 * `<details>` rather than component state so the browser owns the disclosure —
 * keyboard, find-in-page and the open set surviving a re-render come free. */
function BucketRow({ bucket, widest }: { bucket: BucketTotal; widest: number }) {
  return (
    <details class="stats-period-row">
      <summary>
        <span class="stats-period-key">{formatBucket(bucket.key)}</span>
        <span class="stats-period-note">{bucket.dayCount} 日分</span>
        <span class="stats-period-bar">
          <span
            class="stats-period-bar-fill"
            style={{ width: `${shareOf(bucket.usd, widest) * 100}%` }}
          />
        </span>
        <span class="stats-period-usd">{formatUsd(bucket.usd)}</span>
      </summary>
      {bucket.models.length === 0 ? (
        <p class="stats-empty">この期間の内訳はありません。</p>
      ) : (
        <>
          <h4 class="stats-breakdown-head">モデル別</h4>
          <ul class="stats-models">
            {bucket.models.map((model) => (
              <ModelRow key={model.model} model={model} total={bucket.usd} />
            ))}
          </ul>
          <h4 class="stats-breakdown-head">コンテキスト種類別 (トークン)</h4>
          <ContextBreakdown models={bucket.models} />
          {/* The per-credential view is the third question, not the first:
           * "which model" and "what kind of context" both come before
           * "on whose key". */}
          {bucket.credentials.length > 1 ? (
            <details class="stats-by-credential">
              <summary>クレデンシャル別</summary>
              {bucket.credentials.map((credential) => (
                <CredentialBlock
                  key={credential.credential}
                  credential={credential}
                  total={bucket.usd}
                />
              ))}
            </details>
          ) : null}
        </>
      )}
    </details>
  );
}

export function UsageStats({ period }: { period: StatsPeriod }) {
  const { ws } = useApp();
  const [stats, setStats] = useState<LlmStatsResponse | null>(null);
  const [error, setError] = useState<ErrorResponse["error"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A span change replaces the whole document; keeping the old one on screen
    // under the new selector would misreport what is shown.
    setStats(null);
    async function load(): Promise<void> {
      try {
        const res = await ws.llmStats(periodDays(period));
        if (cancelled) return;
        if (res.ok) {
          setStats(res);
          setError(null);
        } else {
          setError(res.error);
        }
      } catch (e) {
        if (!cancelled) setError({ code: "connection_closed", msg: String(e) });
      }
    }
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ws, period]);

  const buckets = stats ? bucketTotals(stats.days, period) : [];
  const windowTotal = stats ? windowTotalUsd(stats.days) : 0;
  const widest = buckets.reduce((peak, bucket) => Math.max(peak, bucket.usd), 0);
  const chart = chartData(buckets);

  return (
    <section id="usage-stats">
      <header class="usage-header">
        <PeriodPicker period={period} />
        {error ? <span class="usage-stale">更新できていません: {error.msg}</span> : null}
      </header>
      {!stats ? (
        error ? (
          <p class="usage-empty">
            利用料を取得できません: {error.msg}
            <br />
            daemon config.json の `llm_stats_url` と、その先の gateway を確認してください。
          </p>
        ) : (
          <p class="usage-loading">読み込み中…</p>
        )
      ) : (
        <>
          <UsageChart
            data={chart}
            caption={`${PERIOD_LABEL[period]}のモデル別利用料 (期間合計 ${formatUsd(windowTotal)})`}
          />
          <div class="stats-rows">
            {buckets.map((bucket) => (
              <BucketRow key={bucket.key} bucket={bucket} widest={widest} />
            ))}
            {buckets.length === 0 ? <p class="stats-empty">データがありません。</p> : null}
            <p class="stats-note">
              期間全体の合計: <strong>{formatUsd(windowTotal)}</strong>
            </p>
          </div>
        </>
      )}
    </section>
  );
}
