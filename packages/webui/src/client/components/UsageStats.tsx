// The spend half of /usage: what the host's LLM credentials cost, per day and
// rolled up per month, broken down by model. Sits beside the quota section
// because both answer "how are the host's credentials doing" and neither
// belongs to a session — one is the limit, the other is the bill.
import { useEffect, useState } from "preact/hooks";
import type { ErrorResponse, LlmStatsResponse } from "@ccmsg/protocol";
import { LLM_STATS_DAYS_MAX, LLM_STATS_DAYS_MIN } from "@ccmsg/protocol";
import {
  credentialLabel,
  dailyTotals,
  formatCount,
  formatMonth,
  formatTokens,
  formatUsd,
  monthlyTotals,
  shareOf,
  windowTotalUsd,
  type CredentialTotal,
  type ModelTotal,
  type MonthTotal,
  type PeriodTotal,
} from "../llm-stats-view.ts";
import { usageHref } from "../locator.ts";
import { pushNavigation } from "../navigation.ts";
import { useApp } from "../context.ts";

/** Spend is settled history plus a partial current day; it does not move on
 * the scale that quota does, and a wide window is an expensive document for
 * the gateway to assemble. Five minutes keeps today's figure current enough
 * to be worth reading without asking for a year of data every minute. */
const REFRESH_MS = 5 * 60_000;

/** The windows worth one click. Everything else goes through the free-form
 * input beside them — these three are "this week", "this month-ish" and "the
 * quarter", which is what the presets are actually being asked for. */
const PRESETS = [7, 30, 90];

function PeriodPicker({ days }: { days: number | null }) {
  // Seeded from the URL, then owned by the field: retyping "1" on the way to
  // "120" must not navigate to a one-day window on the first keystroke.
  const [draft, setDraft] = useState(days === null ? "" : String(days));
  useEffect(() => setDraft(days === null ? "" : String(days)), [days]);

  const submit = (): void => {
    const value = Number(draft);
    if (!/^\d+$/.test(draft.trim())) return;
    if (value < LLM_STATS_DAYS_MIN || value > LLM_STATS_DAYS_MAX) return;
    if (value !== days) pushNavigation(usageHref(value));
  };

  return (
    <div class="stats-period" role="group" aria-label="集計期間">
      {PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          class="stats-period-preset"
          aria-pressed={days === preset}
          onClick={() => {
            if (days !== preset) pushNavigation(usageHref(preset));
          }}
        >
          {preset}日
        </button>
      ))}
      <label class="stats-period-custom">
        <input
          type="number"
          min={LLM_STATS_DAYS_MIN}
          max={LLM_STATS_DAYS_MAX}
          value={draft}
          aria-label={`日数 (${LLM_STATS_DAYS_MIN}〜${LLM_STATS_DAYS_MAX})`}
          placeholder="既定"
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          onBlur={submit}
        />
        <span>日</span>
      </label>
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
        aria-label={`${model.model}: 合計の ${Math.round(shareOf(model.usd, total) * 100)}%`}
      >
        <span
          class="stats-model-bar-fill"
          style={{ width: `${shareOf(model.usd, total) * 100}%` }}
        />
      </span>
      <span class="stats-model-usd">{formatUsd(model.usd)}</span>
      <span class="stats-model-counters">
        <span title="リクエスト数">{formatCount(model.requests)} req</span>
        {" / "}
        <span title="入力 + キャッシュ読み込みトークン">
          in {formatTokens(model.inputTokens + model.cacheReadTokens)}
        </span>
        {" / "}
        <span title="出力トークン">out {formatTokens(model.outputTokens)}</span>
      </span>
    </li>
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

/** One day or one month. Collapsed it is a total with a bar; opened it is the
 * model breakdown, then the same breakdown per credential. `<details>` rather
 * than component state so the browser owns the disclosure — keyboard, find-in
 * -page and the open/closed set surviving a re-render all come for free. */
function PeriodRow({
  period,
  label,
  note,
  windowTotal,
}: {
  period: PeriodTotal;
  label: string;
  note?: string;
  windowTotal: number;
}) {
  return (
    <details class="stats-period-row">
      <summary>
        <span class="stats-period-key">{label}</span>
        {note ? <span class="stats-period-note">{note}</span> : null}
        <span class="stats-period-bar">
          <span
            class="stats-period-bar-fill"
            style={{ width: `${shareOf(period.usd, windowTotal) * 100}%` }}
          />
        </span>
        <span class="stats-period-usd">{formatUsd(period.usd)}</span>
      </summary>
      {period.models.length === 0 ? (
        <p class="stats-empty">この期間の内訳はありません。</p>
      ) : (
        <>
          <ul class="stats-models">
            {period.models.map((model) => (
              <ModelRow key={model.model} model={model} total={period.usd} />
            ))}
          </ul>
          {/* The per-credential view is the second question, not the first:
           * "which model cost this" comes before "on whose key". */}
          {period.credentials.length > 1 ? (
            <details class="stats-by-credential">
              <summary>クレデンシャル別</summary>
              {period.credentials.map((credential) => (
                <CredentialBlock
                  key={credential.credential}
                  credential={credential}
                  total={period.usd}
                />
              ))}
            </details>
          ) : null}
        </>
      )}
    </details>
  );
}

function MonthlyList({ months, windowTotal }: { months: MonthTotal[]; windowTotal: number }) {
  // The widest month in the window, so month bars are compared against each
  // other rather than against a window total that no single month can reach.
  const widest = months.reduce((max, month) => Math.max(max, month.usd), 0);
  return (
    <div class="stats-rows">
      {months.map((month) => (
        <PeriodRow
          key={month.key}
          period={month}
          label={formatMonth(month.key)}
          // Every month carries its day count, because which ones the window
          // truncates is not otherwise visible and comparing a 9-day month
          // against a 31-day one without knowing is the mistake to prevent.
          note={`${month.dayCount} 日分`}
          windowTotal={widest}
        />
      ))}
      {months.length === 0 ? <p class="stats-empty">データがありません。</p> : null}
      <p class="stats-note">
        期間全体の合計: <strong>{formatUsd(windowTotal)}</strong>
      </p>
    </div>
  );
}

function DailyList({ days }: { days: PeriodTotal[] }) {
  const widest = days.reduce((max, day) => Math.max(max, day.usd), 0);
  return (
    <div class="stats-rows">
      {days.map((day) => (
        <PeriodRow key={day.key} period={day} label={day.key} windowTotal={widest} />
      ))}
      {days.length === 0 ? <p class="stats-empty">データがありません。</p> : null}
    </div>
  );
}

export function UsageStats({ days }: { days: number | null }) {
  const { ws } = useApp();
  const [stats, setStats] = useState<LlmStatsResponse | null>(null);
  const [error, setError] = useState<ErrorResponse["error"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A window change replaces the whole document; keeping the old one on
    // screen under the new period's heading would misreport what is shown.
    setStats(null);
    async function load(): Promise<void> {
      try {
        const res = await ws.llmStats(days ?? undefined);
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
  }, [ws, days]);

  const months = stats ? monthlyTotals(stats.days) : [];
  const daily = stats ? dailyTotals(stats.days) : [];
  const windowTotal = stats ? windowTotalUsd(stats.days) : 0;

  return (
    <section id="usage-stats">
      <header class="usage-header">
        <h2>利用料</h2>
        <PeriodPicker days={days} />
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
          <h3 class="stats-subhead">月別</h3>
          <MonthlyList months={months} windowTotal={windowTotal} />
          <h3 class="stats-subhead">日別</h3>
          <DailyList days={daily} />
        </>
      )}
    </section>
  );
}
