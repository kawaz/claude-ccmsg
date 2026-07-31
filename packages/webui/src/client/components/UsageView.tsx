// /usage — the host's LLM credentials and how much of each quota window is
// spent. Host-wide rather than per session: the credentials are the daemon
// machine's, and every session draws on the same pool. The daemon proxies the
// gateway (no CORS headers there) via the `llm_usage` op.
import { useEffect, useState } from "preact/hooks";
import type { ErrorResponse, LlmUsageCredential, LlmUsageResponse } from "@ccmsg/protocol";
import {
  formatPercent,
  formatRemaining,
  snapshotAge,
  sortedWindows,
  supportDescription,
  type WindowProgress,
} from "../llm-usage-view.ts";
import { useApp } from "../context.ts";
import { ErrorView } from "./ErrorView.tsx";

/** Quota moves on the scale of hours; a minute of staleness is invisible to
 * the reader and the gateway's own snapshots lag by more than that anyway.
 * Polling is not a shortcut here — the gateway offers no push channel, so
 * asking again is the only way to learn anything new. The interval lives and
 * dies with the mounted view, so a backgrounded tab on another screen costs
 * the gateway nothing. */
const REFRESH_MS = 60_000;

/** Glyphs carried over from the CLI rendering kawaz asked to reproduce: the
 * short window is a clock, the long one a calendar. */
const WINDOW_GLYPH: Record<string, string> = { "5h": "⏰", "7d": "📆" };

function windowGlyph(key: string): string {
  return WINDOW_GLYPH[key] ?? "⏳";
}

/** utilization as the filled bar, elapsed time as a mark laid over it: the
 * comparison between the two *is* the reading, so putting them on one track
 * makes "ahead of pace" visible without doing arithmetic. */
function UsageBar({ progress }: { progress: WindowProgress }) {
  const filled = Math.min(100, Math.max(0, progress.utilization * 100));
  return (
    <div
      class={`usage-bar tone-${progress.tone}`}
      role="img"
      aria-label={
        progress.elapsed === null
          ? `${progress.key}: 使用率 ${formatPercent(progress.utilization)}`
          : `${progress.key}: 使用率 ${formatPercent(progress.utilization)}、経過 ${formatPercent(progress.elapsed)}`
      }
    >
      <div class="usage-bar-fill" style={{ width: `${filled}%` }} />
      {progress.elapsed === null ? null : (
        <div class="usage-bar-pace" style={{ left: `${progress.elapsed * 100}%` }} />
      )}
    </div>
  );
}

function WindowRow({ progress }: { progress: WindowProgress }) {
  return (
    <div class="usage-window">
      <span class="usage-window-key" title={progress.status}>
        {windowGlyph(progress.key)} {progress.key}
      </span>
      <UsageBar progress={progress} />
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
          <span class="usage-reset" title="クオータがリセットされるまでの残り時間">
            /{formatRemaining(progress.remainingMs)}
          </span>
        )}
      </span>
    </div>
  );
}

function CredentialRow({ credential, now }: { credential: LlmUsageCredential; now: number }) {
  const snapshot = credential.snapshot;
  const windows = snapshot ? sortedWindows(snapshot, now) : [];
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
      {windows.length > 0 ? (
        <div class="usage-windows">
          {windows.map((progress) => (
            <WindowRow key={progress.key} progress={progress} />
          ))}
        </div>
      ) : (
        <div class="usage-support" title={supportDescription(credential.support)}>
          {credential.support}
        </div>
      )}
      {overage && overage.status !== "allowed" ? (
        <div class="usage-overage">
          追加利用: {overage.status}
          {overage.disabled_reason ? ` (${overage.disabled_reason})` : ""}
        </div>
      ) : null}
    </li>
  );
}

export function UsageView() {
  const { ws } = useApp();
  const [usage, setUsage] = useState<LlmUsageResponse | null>(null);
  const [error, setError] = useState<ErrorResponse["error"] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const res = await ws.llmUsage();
        if (cancelled) return;
        setNow(Date.now());
        if (res.ok) {
          setUsage(res);
          setError(null);
        } else {
          setError(res.error);
        }
      } catch (e) {
        // A closed socket during a reconnect: keep whatever is on screen
        // (labelled by its own age) rather than replacing it with an error
        // that the next tick will clear anyway.
        if (!cancelled) setError({ code: "connection_closed", msg: String(e) });
      }
    }
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ws]);

  if (!usage) {
    if (error) {
      return (
        <ErrorView
          fill
          mark="!"
          tone="danger"
          title="クオータを取得できません"
          detail={error.msg}
          hint="daemon config.json の `llm_usage_url` と、その先の gateway が動いているか確認してください。"
        />
      );
    }
    return (
      <main id="usage-view" class="usage-loading">
        読み込み中…
      </main>
    );
  }

  return (
    <main id="usage-view">
      <header class="usage-header">
        <h2>クオータ</h2>
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
            <CredentialRow key={credential.name} credential={credential} now={now} />
          ))}
        </ul>
      )}
    </main>
  );
}
