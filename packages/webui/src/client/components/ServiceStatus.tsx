// Service status strip on /usage: is the provider up, and does this gateway
// agree? Sits above the quota/spend tabs because it answers the question
// asked first — "is it them or is it me" — and because both tabs below it
// read differently once a provider is down.
//
// The two signals stay in their own columns. The provider's page is a claim
// about everyone; the observed column is what this gateway's own traffic did.
// Folding them into one word would lose exactly the case this exists for: a
// provider still reporting "operational" while every route here gets 529.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ErrorResponse, LlmStatusIncident } from "@ccmsg/protocol";
import {
  countsSummary,
  formatStatusAge,
  headerBadge,
  serviceRows,
  severityLabel,
  severityMark,
  severityTone,
  type ServiceRow,
} from "../llm-status-view.ts";
import { useApp } from "../context.ts";
import type { AppState } from "../store.ts";

/** Anchor the header badge links to (gateway DR-0021 §5). */
export const SERVICE_STATUS_ANCHOR = "service-status";

/** Every string below comes from a provider's status page, so each one is a
 * text node and the link is `noopener noreferrer` — the same posture the
 * quota screen's login link takes toward the gateway's own URL. */
function Incident({ incident }: { incident: LlmStatusIncident }) {
  return (
    <li class="status-incident">
      <div class="status-incident-head">
        {incident.url ? (
          <a href={incident.url} target="_blank" rel="noopener noreferrer">
            {incident.name}
          </a>
        ) : (
          <span>{incident.name}</span>
        )}
        {incident.impact ? <span class="status-incident-impact">{incident.impact}</span> : null}
        {incident.state ? <span class="status-incident-state">{incident.state}</span> : null}
        {/* Said rather than shown by omission: an incident the provider never
         * mapped to a component did not raise this service's severity, and a
         * reader comparing the bullet against the row would otherwise take
         * the row for wrong. */}
        {incident.scope === "page" ? (
          <span class="status-incident-scope" title="この service に紐づかない、ページ全体の告知">
            参考
          </span>
        ) : null}
      </div>
      {incident.latest_update ? (
        <p class="status-incident-update">{incident.latest_update}</p>
      ) : null}
    </li>
  );
}

function ServiceRowView({ row }: { row: ServiceRow }) {
  return (
    <li class={`status-service tone-${row.tone}`}>
      <div class="status-service-head">
        <span class="status-mark" role="img" aria-label={row.severityText}>
          {row.mark}
        </span>
        <span class="status-name" title={row.routes.length > 0 ? row.routes.join(", ") : undefined}>
          {row.name}
        </span>
        <span class="status-severity">{row.severityText}</span>
        {/* Two labelled cells rather than one status word: which of the two
         * disagrees with the other is the whole diagnosis. */}
        <span class="status-signal">
          <span class="status-signal-label">公式</span>
          {row.official ? (
            <>
              {row.official.sourceUrl ? (
                <a
                  class="status-signal-value"
                  href={row.official.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {row.official.label}
                </a>
              ) : (
                <span class="status-signal-value">{row.official.label}</span>
              )}
              {row.official.stale ? (
                <span class="status-stale" title="公式ページを最近読めていません">
                  古い
                </span>
              ) : null}
              {row.official.age ? <span class="status-age">{row.official.age}</span> : null}
            </>
          ) : (
            <span class="status-signal-value">—</span>
          )}
        </span>
        <span class="status-signal">
          <span class="status-signal-label" title="この gateway 自身の実通信">
            実測
          </span>
          {row.observed ? (
            <>
              <span class="status-signal-value">{row.observed.label}</span>
              {row.observed.failure ? (
                <span class="status-failure">{row.observed.failure}</span>
              ) : null}
              {row.observed.age ? <span class="status-age">{row.observed.age}</span> : null}
            </>
          ) : (
            <span class="status-signal-value">—</span>
          )}
        </span>
      </div>
      {/* Beside the reading, not instead of it: a status page this gateway
       * could not read leaves the last successful state on screen, dated. */}
      {row.official?.error ? (
        <div class="status-source-error">公式ページの取得失敗: {row.official.error}</div>
      ) : null}
      {row.incidents.length > 0 ? (
        <details class="status-incidents">
          <summary>
            告知 {row.incidents.length} 件: {row.incidents[0]?.name}
          </summary>
          <ul>
            {row.incidents.map((incident, index) => (
              <Incident key={incident.id ?? `${incident.name}:${index}`} incident={incident} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** The strip itself. Reads the report the store already holds — put there by
 * the fetch this client made when it connected, or by the daemon's push after
 * a 529 — and re-reads it on open so a screen the user came back to is not
 * showing a report from before they left. */
export function ServiceStatus({ state }: { state: AppState }) {
  const { ws, store } = useApp();
  const [error, setError] = useState<ErrorResponse["error"] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      try {
        const res = await ws.llmStatus(refresh ? { refresh: true } : undefined);
        if (!mounted.current) return;
        setNow(Date.now());
        if (res.ok) {
          const { ok: _ok, ...report } = res;
          store.dispatch({ type: "llm-status/loaded", report });
          setError(null);
        } else {
          setError(res.error);
        }
      } catch (e) {
        if (mounted.current) setError({ code: "connection_closed", msg: String(e) });
      }
    },
    [ws, store],
  );

  // On open only. No interval: the report changes when an upstream starts
  // failing, and that moment reaches this tab as the daemon's push rather
  // than as the poll that happened to land after it.
  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  const report = state.llmStatus;
  const rows = report ? serviceRows(report, now) : [];
  const overall = report?.overall.severity ?? "unknown";
  return (
    <section id={SERVICE_STATUS_ANCHOR} class="status-strip">
      <header class="status-strip-head">
        <h2>
          <span class={`status-mark tone-${severityTone(overall)}`} role="img" aria-label="全体">
            {severityMark(overall)}
          </span>
          upstream
          <span class="status-overall">{severityLabel(overall)}</span>
        </h2>
        {report ? <span class="status-counts">{countsSummary(report)}</span> : null}
        {report?.generated_at !== undefined ? (
          <span class="status-age" title="gateway がこのレポートを作った時刻">
            {formatStatusAge(report.generated_at, now)}
          </span>
        ) : null}
        {/* The gateway answers from its cache unless asked; this button is the
         * only path that makes it re-read the providers' pages. */}
        <button
          id="status-refresh"
          type="button"
          disabled={refreshing}
          title="公式ステータスページを読み直す"
          onClick={() => void refresh()}
        >
          {refreshing ? "更新中…" : "更新"}
        </button>
      </header>
      {error ? <p class="status-error">取得できません: {error.msg}</p> : null}
      {report === null ? (
        error ? null : (
          <p class="status-loading">読み込み中…</p>
        )
      ) : rows.length === 0 ? (
        <p class="status-empty">gateway は upstream service を 1 つも報告していません。</p>
      ) : (
        <ul class="status-services">
          {rows.map((row) => (
            <ServiceRowView key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The header badge, or nothing at all. Placed in the global topbar because
 * an upstream outage explains what every screen is doing, not just this one.
 * Silent while things are fine, and silent about "unknown" — a badge that is
 * always lit is one nobody reads. */
export function ServiceStatusBadge({ state }: { state: AppState }) {
  const badge = headerBadge(state.llmStatus);
  if (!badge) return null;
  return (
    <a
      id="app-service-status"
      class={`status-badge tone-${badge.tone}`}
      href={`/usage#${SERVICE_STATUS_ANCHOR}`}
      title={`upstream: ${badge.label}`}
      aria-label={`upstream ${badge.label}`}
    >
      {badge.mark}
    </a>
  );
}
