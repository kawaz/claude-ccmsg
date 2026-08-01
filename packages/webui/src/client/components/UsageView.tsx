// /usage — the host's LLM credentials: how much of each quota window is spent,
// and what they have cost. Host-wide rather than per session, since the
// credentials are the daemon machine's and every session draws on the same
// pool. The daemon proxies the gateway (no CORS headers there) via the
// `llm_usage` and `llm_stats` ops, which are configured independently — each
// section appears only when its own endpoint is set up.
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ErrorResponse, LlmUsageCredential, LlmUsageResponse } from "@ccmsg/protocol";
import {
  formatPercent,
  formatRemaining,
  limitKindDurationMs,
  limitLabel,
  parseWindowDurationMs,
  probeRecordOf,
  probeView,
  snapshotAge,
  sortedLimits,
  sortedWindows,
  supportDescription,
  type BarProgress,
  type LimitProgress,
  type ProbeRecord,
  type WindowProgress,
} from "../llm-usage-view.ts";
import type { AppState } from "../store.ts";
import { useApp } from "../context.ts";
import { ErrorView } from "./ErrorView.tsx";
import { UsageStats } from "./UsageStats.tsx";

/** Quota moves on the scale of hours; a minute of staleness is invisible to
 * the reader and the gateway's own snapshots lag by more than that anyway.
 * Polling is not a shortcut here — the gateway offers no push channel, so
 * asking again is the only way to learn anything new. The interval lives and
 * dies with the mounted view, so a backgrounded tab on another screen costs
 * the gateway nothing. */
const REFRESH_MS = 60_000;

/** Glyph from the period's length, carried over from the CLI rendering kawaz
 * asked to reproduce: a short period is a clock, a long one a calendar. Length
 * rather than a key lookup so a limit and a window of the same span get the
 * same mark, and a period of unknown length gets the hourglass. */
function periodGlyph(durationMs: number | null): string {
  if (durationMs === null) return "⏳";
  return durationMs <= 86_400_000 ? "⏰" : "📆";
}

/** Two stacked tracks on one bar: consumption on top, how far the period has
 * elapsed underneath. Reading the screen *is* comparing the two, and stacking
 * them makes "spending faster than the clock" a shape rather than arithmetic
 * — the top track running past the bottom one. */
function UsageBar({ progress, label }: { progress: BarProgress; label: string }) {
  const filled = Math.min(100, Math.max(0, progress.utilization * 100));
  return (
    <div
      class={`usage-bar tone-${progress.tone}`}
      role="img"
      aria-label={
        progress.elapsed === null
          ? `${label}: 使用率 ${formatPercent(progress.utilization)}`
          : `${label}: 使用率 ${formatPercent(progress.utilization)}、経過 ${formatPercent(progress.elapsed)}`
      }
    >
      <div class="usage-bar-fill" style={{ width: `${filled}%` }} />
      {progress.elapsed === null ? null : (
        <div class="usage-bar-elapsed" style={{ width: `${progress.elapsed * 100}%` }} />
      )}
    </div>
  );
}

/** One bar row — a quota window or a provider limit. Both carry a label, the
 * same two-track bar and the same figures, so they share a row rather than
 * each growing a near-copy that would drift apart. */
function TrackRow({
  progress,
  label,
  glyph,
  keyTitle,
  extra,
}: {
  progress: BarProgress;
  label: string;
  glyph: string;
  keyTitle?: string;
  extra?: ComponentChildren;
}) {
  return (
    <div class="usage-window">
      <span class="usage-window-key" title={keyTitle}>
        {glyph} {label}
        {extra}
      </span>
      <UsageBar progress={progress} label={label} />
      <span class="usage-window-figures">
        <span class={`usage-utilization tone-${progress.tone}`}>
          {formatPercent(progress.utilization)}
        </span>
        {progress.elapsed === null ? null : (
          <span class="usage-elapsed" title="窓の経過率 (この割合を超えていればペース超過)">
            /{formatPercent(progress.elapsed)}
          </span>
        )}
        {progress.remainingMs === null ? null : (
          <span class="usage-reset" title="リセットされるまでの残り時間">
            /{formatRemaining(progress.remainingMs)}
          </span>
        )}
      </span>
    </div>
  );
}

function WindowRow({ progress }: { progress: WindowProgress }) {
  return (
    <TrackRow
      progress={progress}
      label={progress.key}
      glyph={periodGlyph(parseWindowDurationMs(progress.key))}
      keyTitle={progress.status}
    />
  );
}

function LimitRow({ progress }: { progress: LimitProgress }) {
  return (
    <TrackRow
      progress={progress}
      label={limitLabel(progress)}
      glyph={periodGlyph(limitKindDurationMs(progress.key))}
      keyTitle={`severity: ${progress.severity}`}
      extra={
        // Marked, not toned: "upstream is counting against this one" is a
        // different fact from "this one is in trouble", and an inactive limit
        // at 100% still matters.
        progress.isActive ? (
          <span class="usage-limit-active" title="upstream が現在この枠を計測中">
            ●
          </span>
        ) : null
      }
    />
  );
}

function CredentialRow({
  credential,
  retained,
  now,
}: {
  credential: LlmUsageCredential;
  retained: ProbeRecord | undefined;
  now: number;
}) {
  const snapshot = credential.snapshot;
  const windows = snapshot ? sortedWindows(snapshot, now) : [];
  // Limits and probe failures exist only in a probe's answer; the polling
  // reads are silent about them, so what is drawn falls back to the last
  // probe and says how old that was.
  const probe = probeView(credential, retained, now);
  const limits = sortedLimits(probe.limits, now);
  const age = snapshot ? snapshotAge(snapshot, now) : null;
  const overage = snapshot?.overage;
  return (
    <li class="usage-credential">
      <div class="usage-credential-head">
        <span class="usage-credential-name">{credential.name}</span>
        {credential.type ? <span class="usage-credential-type">{credential.type}</span> : null}
        {/* The observation's own age, not the fetch's: a gateway that has not
         * seen traffic on this credential recently serves a reading from
         * minutes ago, and acting on it as if it were current is the mistake
         * this label exists to prevent. */}
        {age ? (
          <span class="usage-age" title="この観測値の鮮度">
            ({age})
          </span>
        ) : null}
      </div>
      {windows.length > 0 || limits.length > 0 ? (
        <div class="usage-windows">
          {windows.map((progress) => (
            <WindowRow key={progress.key} progress={progress} />
          ))}
          {/* Provider limits below the rolling windows: the windows are the
           * quota every request draws on, the limits are extra ceilings on
           * top of it. Keyed by label because a gateway can report several
           * scoped limits, which share the `weekly_scoped` kind. */}
          {limits.map((progress) => (
            <LimitRow key={limitLabel(progress)} progress={progress} />
          ))}
          {/* The observation's own age, not the button press's: a probe that
           * upstream refused returns a reading from before it, and dating
           * these by when we asked would overstate how current they are. */}
          {probe.retainedAge ? (
            <div class="usage-probe-age" title="直近の「更新」で upstream が観測した時刻">
              リミットの観測時刻: {probe.retainedAge}
            </div>
          ) : null}
        </div>
      ) : (
        <div class="usage-support" title={supportDescription(credential.support)}>
          {credential.support}
        </div>
      )}
      {/* Kept beside the readings rather than replacing them: a failed probe
       * does not invalidate the last observation, it just dates it. */}
      {probe.probeError ? (
        <div class="usage-probe-error">
          取得失敗: {probe.probeError}
          {probe.retainedAge ? ` (観測: ${probe.retainedAge})` : ""}
        </div>
      ) : null}
      {overage && overage.status !== "allowed" ? (
        <div class="usage-overage">
          追加利用: {overage.status}
          {overage.disabled_reason ? ` (${overage.disabled_reason})` : ""}
        </div>
      ) : null}
    </li>
  );
}

function QuotaSection({ state }: { state: AppState }) {
  const { ws, store } = useApp();
  const [usage, setUsage] = useState<LlmUsageResponse | null>(null);
  const [error, setError] = useState<ErrorResponse["error"] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [probing, setProbing] = useState(false);
  // Both paths await a round trip that can outlive the view (a probe takes
  // seconds), so every state write after the await is gated on still being
  // mounted rather than on a flag captured by one effect run.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One loader for both paths. `refresh` is what separates them and it is
  // never set by the interval: a probe calls out to every upstream provider
  // and can spend rate limit, so polling one would burn quota on a screen
  // nobody is looking at.
  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      try {
        const res = await ws.llmUsage(refresh ? { refresh: true } : undefined);
        if (!mounted.current) return;
        setNow(Date.now());
        if (res.ok) {
          setUsage(res);
          setError(null);
          // Whatever the probe learned outlives this response, since the
          // cached reads that follow carry none of it.
          const records = new Map<string, ProbeRecord>();
          for (const credential of res.credentials) {
            const record = probeRecordOf(credential);
            if (record) records.set(credential.name, record);
          }
          store.dispatch({ type: "llm-usage/probed", records });
        } else {
          setError(res.error);
        }
      } catch (e) {
        // A closed socket during a reconnect: keep whatever is on screen
        // (labelled by its own age) rather than replacing it with an error
        // that the next tick will clear anyway.
        if (mounted.current) setError({ code: "connection_closed", msg: String(e) });
      }
    },
    [ws, store],
  );

  useEffect(() => {
    void load(false);
    const id = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const probe = async (): Promise<void> => {
    setProbing(true);
    try {
      await load(true);
    } finally {
      if (mounted.current) setProbing(false);
    }
  };

  if (!usage) {
    if (error) {
      return (
        <ErrorView
          mark="!"
          tone="danger"
          title="クオータを取得できません"
          detail={error.msg}
          hint="daemon config.json の `llm_usage_url` と、その先の gateway が動いているか確認してください。"
        />
      );
    }
    return <p class="usage-loading">読み込み中…</p>;
  }

  return (
    <section id="usage-quota">
      <header class="usage-header">
        <h2>クオータ</h2>
        {/* The only path that probes upstream. Manual because a probe costs
         * rate limit on every configured credential — the automatic reads
         * beside it are served from the gateway's cache — and because the
         * limits it returns are not in any other response. */}
        <button
          id="usage-probe"
          type="button"
          disabled={probing}
          title="upstream に問い合わせて最新のリミットを取得する (レートリミットを消費します)"
          onClick={() => void probe()}
        >
          {probing ? "更新中…" : "更新"}
        </button>
        {/* A stale read stays on screen with the failure beside it: the last
         * known numbers are still the best information available, and blanking
         * them would lose more than the error adds. */}
        {error ? <span class="usage-stale">更新できていません: {error.msg}</span> : null}
      </header>
      {usage.credentials.length === 0 ? (
        <p class="usage-empty">gateway はクレデンシャルを 1 つも報告していません。</p>
      ) : (
        <ul class="usage-list">
          {usage.credentials.map((credential) => (
            <CredentialRow
              key={credential.name}
              credential={credential}
              retained={state.llmUsageProbes.get(credential.name)}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function UsageView({ state }: { state: AppState }) {
  // Each section is gated on its own hello capability: an operator who
  // configured only one of the two endpoints sees only that one, rather than a
  // heading over an error the other section could never stop showing.
  return (
    <main id="usage-view">
      {state.llmUsageAvailable ? <QuotaSection state={state} /> : null}
      {state.llmStatsAvailable ? <UsageStats days={state.usageDays} /> : null}
    </main>
  );
}
