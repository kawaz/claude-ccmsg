// SessionView Status-tab body (DR-0020): the gauges of what the session runs
// as now, the one table of what it is and its identifiers, its environment,
// the secrets handed to it (SecretHandoff, DR-0052), the operations on it and
// the danger zone, from the daemon's session_status_subscribe snapshot
// (the context) and the shared store. The subscribe/unsubscribe round trip
// itself lives in SessionView (shared with the Timeline mini panel, which
// needs the same live data); session identity metadata is resolved here from
// the shared store so Status uses the same peer/pin/agent fallback as the topbar.
// Background tasks, TODOs, agents and workflows are not listed here (kawaz
// 2026-11-09): agents and workflows are the Timeline's agent tree's
// (`AgentTreePanel`), and how many are running is the sidebar badge's.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  type AgentInfo,
  type ErrorResponse,
  type SessionEnvResponse,
  type SessionKillResponse,
  type SessionRestartResponse,
  type SessionStatusSnapshot,
} from "@ccmsg/protocol";
import {
  formatAgentLiveState,
  formatContextUsage,
  restartOffered,
  restartResultText,
} from "../session-status-view.ts";
import { pinForSid, pinnedSessionTitle } from "../pinned-sessions.ts";
import {
  filterEnvRows,
  isSensitiveEnvName,
  splitColonValue,
  toEnvRows,
  type EnvRow,
} from "../env-filter.ts";
import { buildTerminalPageUrl } from "../terminal-gateway-store.ts";
import {
  clientBuildLabel,
  formatDuration,
  resolveSessionTopbar,
  protocolSkewWarning,
  staleClientWarning,
} from "../utils.ts";
import { useApp } from "../context.ts";
import { sameJson, useStoreState } from "../useStore.ts";
import type { SessionRestartAsk } from "../ws.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Fold } from "./Fold.tsx";
import { ActionRow, SessionActions, useStatusLaunch } from "./StatusSessionForms.tsx";
import { SessionOverrideField, type SessionOverrideChange } from "./RequestOverridePicker.tsx";
import { SecretHandoff } from "./SecretHandoff.tsx";

/** DR-0028 danger zone: terminate the OS process behind this session.
 * Deliberately at the very bottom of the Status tab (kawaz: "普段触らない
 * 場所" — a prominent placement like the Sidebar would be a mis-click
 * hazard), a row of the operations list's shape in the danger colour, and
 * guarded by window.confirm, the same confirm convention as MemberChip's kick.
 * The ws send itself is injected via `onKill` so this component stays
 * presentation-only (StatusPanel's existing division of labor with
 * SessionView). `terminated: false` on a successful reply is not an error —
 * the daemon sent both SIGTERMs but couldn't observe the process disappear
 * within its grace (protocol doc).
 *
 * r38 mid=6: SIGTERM で落ちなかった時に SIGKILL へ 2 段エスカレーションする。
 * DR-0028 の「daemon は勝手に SIGKILL しない」原則を維持しつつ、ユーザーが
 * SIGTERM の未確認を目視して opt-in できる動線を UI 側で提供する:
 *
 *   1. 初回押下: SIGTERM 2 連発 (DR-0028 通常経路)
 *   2. 応答が `terminated: false` (シグナル送信済み、終了未確認) だったら
 *      行が「強制終了 (-KILL)」に切り替わり、押すと `force: true` で SIGKILL
 *      を送る
 *   3. `terminated: true` / `not_found` / エラー、あるいは sid が変わった場合は
 *      通常状態にリセット
 *
 * confirm は force 時も必ず出し、文言に SIGKILL である旨と不可逆性を明記する
 * (kawaz の「-KILL モードに変化させて欲しい」= 表示だけでなく操作にも一段
 * 追加のガードを掛ける意).
 *
 * The session actions above it (新セッションを起動, 再起動) are not dangerous
 * and sit outside the zone; while one of them runs, the kill waits
 * (`blocked`), and while the kill runs, they do. The kill's own running is
 * held by `SessionControls` for that reason. */
function KillZone({
  sid,
  onKill,
  killing,
  setKilling,
  blocked,
}: {
  sid: string;
  onKill: (opts?: { force?: boolean }) => Promise<SessionKillResponse | ErrorResponse>;
  killing: boolean;
  setKilling: (killing: boolean) => void;
  blocked: boolean;
}) {
  const [result, setResult] = useState<string | null>(null);
  const [forceMode, setForceMode] = useState(false);

  function handleKill(): void {
    const force = forceMode;
    const confirmMsg = force
      ? `セッション ${sid} に SIGKILL を送ります。プロセスは即時に強制終了され、transcript の flush が途中で切れる可能性があります。実行しますか?`
      : `セッション ${sid} のプロセスを終了しますか?`;
    if (!window.confirm(confirmMsg)) return;
    setKilling(true);
    setResult(null);
    void onKill(force ? { force: true } : undefined)
      .then((res) => {
        if (res.ok) {
          if (res.terminated) {
            setResult(
              force ? "SIGKILL でプロセスの終了を確認しました" : "プロセスの終了を確認しました",
            );
            setForceMode(false);
          } else {
            // DR-0028: `terminated: false` = signals delivered but the pid
            // was still observable when the grace expired. force 経路でここに
            // 到達したら zombie 等の稀ケース (これ以上打つ手がなく、ボタンは
            // 押しっぱなしにできても意味がないので force モードを維持しつつ
            // 事実だけ通知する)。
            setResult(
              force
                ? "SIGKILL 送信済みですが、まだ pid が観測されています (zombie の可能性)"
                : "シグナル送信済み (終了は未確認)。強制終了に切り替えました",
            );
            setForceMode(true);
          }
        } else {
          // 再起動の結果と同じ組み立てで code と daemon の msg をそのまま出す。
          // not_found の msg は「pid が引けない」と「pid は引けたが claude と
          // 確かめられない」(プロセスは生きている) を言い分けるので、決まった
          // 文に置き換えない (DR-0028)。
          setResult(`終了できなかった (${res.error.code}): ${res.error.msg}`);
          // not_found は止める相手がいないので通常状態に戻す。それ以外の
          // エラーは force モードを維持 (直前の状態がユーザーの意図)
          if (res.error.code === "not_found") setForceMode(false);
        }
      })
      .catch((e: unknown) => setResult(`エラー: ${String(e)}`))
      .finally(() => setKilling(false));
  }

  const buttonLabel = killing
    ? forceMode
      ? "強制終了中…"
      : "終了処理中…"
    : forceMode
      ? "強制終了"
      : "終了";
  const buttonCls = "status-kill-button" + (forceMode ? " status-kill-button-force" : "");
  return (
    <section class="status-section status-kill-zone">
      <h3 class="status-section-title">危険ゾーン</h3>
      <ul class="status-actions status-actions-danger">
        <ActionRow
          name={forceMode ? "強制終了 (-KILL)" : "セッションを終了"}
          description={
            forceMode
              ? "SIGTERM では終了を確かめられなかった。SIGKILL でプロセスをすぐ止める"
              : "プロセスに SIGTERM を送って止める"
          }
        >
          <button
            type="button"
            class={buttonCls}
            disabled={killing || blocked}
            onClick={handleKill}
          >
            {buttonLabel}
          </button>
        </ActionRow>
      </ul>
      {result ? <p class="status-kill-result">{result}</p> : null}
    </section>
  );
}

/** The bottom of the Status tab: セッション操作 (DR-0028 「restart」) above
 * the danger zone. One thing of the three operations runs at a time, so this
 * holds what each is doing. The actions are offered only where the daemon can
 * launch; 再起動 also needs the session's process (`restartOffered`), and
 * stays while a restart runs. */
function SessionControls({
  sid,
  cwd,
  onKill,
  restartOffered,
  restart,
}: {
  sid: string;
  cwd: string | null;
  onKill: (opts?: { force?: boolean }) => Promise<SessionKillResponse | ErrorResponse>;
  restartOffered: boolean;
  restart: SessionRestart;
}) {
  const { store } = useApp();
  const launchAvailable = useStoreState(store, (s) => s.launchAvailable);
  const [killing, setKilling] = useState(false);
  const launch = useStatusLaunch();
  const launching = launch.state.status === "running";
  const anyBusy = killing || restart.busy || launching;
  return (
    <>
      {launchAvailable || launching ? (
        <SessionActions
          cwd={cwd}
          launch={launch}
          restart={restart}
          restartShown={restartOffered || restart.busy}
          blocked={anyBusy}
        />
      ) : null}
      <KillZone
        sid={sid}
        onKill={onKill}
        killing={killing}
        setKilling={setKilling}
        blocked={restart.busy || launching}
      />
    </>
  );
}

/** What a restart came to (`restartResultText`). */
export type SessionRestartResult = ReturnType<typeof restartResultText>;

/** A restart of one session as it runs and what it came to (DR-0028
 * 「restart」). Held by the session's view rather than the Status tab: the
 * restart stops the process, and the tab's panel goes while the session is
 * between its old process and the resumed one, which would take the result
 * with it. */
export interface SessionRestart {
  busy: boolean;
  result: SessionRestartResult | null;
  /** Restart as `ask` says (the resumed session's first prompt, model and
   * effort); settles with what it came to. */
  start: (ask: SessionRestartAsk) => Promise<SessionRestartResult>;
}

/** How long 「再起動しました」 stays under the operations before it goes: the
 * session is back and the line has nothing more to say. A restart that did
 * not resume stays until the next one, as its reason is what to act on. */
export const RESTART_DONE_NOTE_MS = 5_000;

/** The restart of `sid`, kept across the Status panel coming and going. A
 * restart started for another sid is not this one's. */
export function useSessionRestart(
  sid: string,
  restart: (sid: string, ask: SessionRestartAsk) => Promise<SessionRestartResponse | ErrorResponse>,
): SessionRestart {
  const [state, setState] = useState<{
    sid: string;
    busy: boolean;
    result: SessionRestartResult | null;
  }>({ sid, busy: false, result: null });
  const own = state.sid === sid ? state : { sid, busy: false, result: null };
  const done = own.result?.ok === true ? own.result : null;
  useEffect(() => {
    if (done === null) return;
    const timer = setTimeout(
      () =>
        setState((current) => (current.result === done ? { ...current, result: null } : current)),
      RESTART_DONE_NOTE_MS,
    );
    return () => clearTimeout(timer);
  }, [done]);
  return {
    busy: own.busy,
    result: own.result,
    start: (ask) => {
      setState({ sid, busy: true, result: null });
      return restart(sid, ask)
        .then((reply) => restartResultText(reply))
        .catch(
          (e: unknown): SessionRestartResult => ({
            ok: false,
            text: `再起動できなかった: ${String(e)}`,
          }),
        )
        .then((result) => {
          setState((current) => (current.sid === sid ? { sid, busy: false, result } : current));
          return result;
        });
    },
  };
}

/** The NAME row's value: an input from the start, the place to rename the
 * session (DR-0047 §4). It shows the agents rows' name and follows it, except
 * while the person is editing — what they typed is not overwritten by a name
 * that arrives meanwhile. Enter sends the trimmed draft with `session_rename`,
 * Escape puts the shown name back.
 *
 * The outcome is shown by the input's own look, with no text beside it: a
 * send in flight pulses its brightness, an answer of `renamed` or `queued`
 * returns it to normal, and an error marks it in the danger colour (the
 * message in its `title`) until the person changes the value. A sent name
 * stays in the input as typed, rather than the old name coming back while the
 * session has yet to take it; once the agents rows' name changes (at once for
 * `renamed`, after the turn for `queued`) the input follows it again. A
 * failed send keeps the draft so it can be fixed or retried without retyping. A session no hooks module speaks for answers `no_module`,
 * which shows as that error. An IME's confirming Enter arrives with
 * `isComposing` and is left to the IME. */
function SessionTitleInput({ sid, title }: { sid: string; title: string }) {
  const { ws } = useApp();
  // null = not editing: the input shows `title` and follows it.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The last send's error message; null = no failure to show.
  const [failure, setFailure] = useState<string | null>(null);
  // The name shown when a send was answered, while the input keeps what was
  // sent: once the agents rows' name moves off it, the input follows again
  // (react.dev "Adjusting some state when a prop changes").
  const [sentOver, setSentOver] = useState<string | null>(null);
  if (sentOver !== null && title !== sentOver) {
    setSentOver(null);
    setDraft(null);
  }

  async function send(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setDraft(null);
      setSentOver(null);
      setFailure(null);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const res = await ws.sessionRename(sid, trimmed);
      if (res.ok) {
        setDraft(trimmed);
        setSentOver(title);
      } else setFailure(res.error.msg);
    } catch {
      setFailure("接続エラーのため送信できませんでした");
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void {
    if (e.isComposing || saving) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setDraft(null);
      setSentOver(null);
      setFailure(null);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    void send(e.currentTarget.value);
  }

  return (
    <input
      type="text"
      class={
        "status-title-input" +
        (saving ? " status-title-input-saving" : "") +
        (failure !== null ? " status-title-input-failed" : "")
      }
      aria-label="NAME"
      aria-busy={saving}
      aria-invalid={failure !== null}
      value={draft ?? title}
      // Held while a send is out, so that what the answer settles is what was
      // sent. readOnly, not disabled: disabling the focused input blurs it,
      // and a failed send's draft would be left in an input the person has to
      // click back into.
      readOnly={saving}
      maxLength={200}
      placeholder="名前を入力して Enter"
      title={failure ?? "Enter で名前を変更、Escape で元に戻す"}
      onInput={(e) => {
        setDraft(e.currentTarget.value);
        setSentOver(null);
        setFailure(null);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

/** One value cell. A sensitive name (r55m134) renders as a button that swaps
 * between a fixed-width mask and the real value — fixed-width because the
 * mask's length would otherwise leak the secret's length. Non-sensitive
 * values render as plain text with no affordance, so the click target exists
 * only where it means something.
 *
 * The colon split applies to the revealed value only: masked rows have
 * nothing to split, and applying it to the mask would turn one placeholder
 * into a column of them. */
function EnvValue({
  row,
  splitColons,
  revealed,
  onToggleReveal,
}: {
  row: EnvRow;
  splitColons: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
}) {
  const parts = splitColons ? (
    splitColonValue(row.value).map((part, i) => (
      // Index keys are correct here: the parts are a positional split of one
      // string, with no identity of their own to preserve.
      <div key={i} class="status-env-value-part">
        {part}
      </div>
    ))
  ) : (
    <>{row.value}</>
  );
  if (!isSensitiveEnvName(row.name)) return parts;
  return (
    <button
      type="button"
      class={"status-env-reveal" + (revealed ? " revealed" : "")}
      aria-pressed={revealed}
      title={revealed ? "クリックで隠す" : "クリックで表示"}
      onClick={onToggleReveal}
    >
      {revealed ? parts : "••••••••"}
    </button>
  );
}

/** ENV panel (kawaz r55m132): the session process's environment, folded away
 * by default and fetched lazily on first open — the daemon has to resolve
 * sid→pid and shell out to `ps`, so paying that on every Status render would
 * be waste for a panel most visits never open. Re-opening refetches, since a
 * long-lived session can gain variables (and a stale list is worse than a
 * brief spinner for a debugging view).
 *
 * Values whose NAME matches a sensitive pattern start masked and reveal on
 * click (kawaz r55m134). The transport already restricts the viewer to the
 * owner of these secrets (tailnet + Origin verification), so the masking is
 * not an access control — it's a shoulder-surfing / screen-share guard, which
 * is why one click is enough to lift it and why nothing is hidden from the
 * search index below. */
function EnvPanel({
  sid,
  onLoadEnv,
}: {
  sid: string;
  onLoadEnv: () => Promise<SessionEnvResponse | ErrorResponse>;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "loaded"; rows: EnvRow[] }
    | {
        kind: "error";
        msg: string;
      }
  >({ kind: "idle" });
  const [query, setQuery] = useState("");
  const [splitColons, setSplitColons] = useState(false);
  /** Names the user has explicitly revealed this session. Kept as a set of
   * names (not a per-row flag) so a re-fetch or a change of filter doesn't
   * silently re-hide what the user just chose to look at. */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  function toggleReveal(name: string): void {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  function handleToggle(e: JSX.TargetedEvent<HTMLDetailsElement, Event>): void {
    if (!e.currentTarget.open) return;
    setState({ kind: "loading" });
    void onLoadEnv()
      .then((res) => {
        if (res.ok) setState({ kind: "loaded", rows: toEnvRows(res.env) });
        else setState({ kind: "error", msg: res.error.msg });
      })
      .catch((e: unknown) => setState({ kind: "error", msg: String(e) }));
  }

  const rows = state.kind === "loaded" ? filterEnvRows(state.rows, query) : [];
  return (
    <>
      <Fold
        class="status-fold status-env"
        summaryClass="status-fold-summary"
        key={sid}
        summary="ENV"
        onToggle={handleToggle}
      >
        {state.kind === "loading" ? <p class="status-empty">読み込み中…</p> : null}
        {state.kind === "error" ? <p class="status-env-error">{state.msg}</p> : null}
        {state.kind === "loaded" ? (
          <>
            <div class="status-env-controls">
              <input
                type="search"
                class="status-env-search"
                placeholder="空白区切りで AND 検索 (名前・値の両方)"
                aria-label="環境変数を検索"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <label class="status-env-split">
                <input
                  type="checkbox"
                  checked={splitColons}
                  onChange={(e) => setSplitColons(e.currentTarget.checked)}
                />
                コロンを改行で表示
              </label>
            </div>
            {/* How many the search leaves, only while it narrows the list. */}
            {rows.length < state.rows.length ? (
              <p class="status-env-count">
                {state.rows.length} 件中 {rows.length} 件
              </p>
            ) : null}
            {rows.length > 0 ? (
              <div class="status-env-table" role="table" aria-label="環境変数">
                {rows.map((row) => (
                  <div key={row.name} class="status-env-row" role="row">
                    <div class="status-env-name" role="cell">
                      <div class="status-scroll">{row.name}</div>
                    </div>
                    <div class="status-env-value" role="cell">
                      <CopyButton value={row.value} label={row.name} />
                      <div class="status-scroll">
                        <EnvValue
                          row={row}
                          splitColons={splitColons}
                          revealed={revealed.has(row.name)}
                          onToggleReveal={() => toggleReveal(row.name)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p class="status-empty">一致する環境変数なし</p>
            )}
          </>
        ) : null}
      </Fold>
    </>
  );
}

/** One row of a facts table: the term, and its value in one line that
 * scrolls sideways when it is longer than the cell (no scrollbar shown), so a
 * long value never makes its row taller. A value that can be copied has its
 * copy button before it. */
function Fact({
  term,
  copy,
  title,
  children,
}: {
  term: string;
  /** What the copy button copies; no button without it. */
  copy?: string;
  title?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="status-fact">
      <dt>{term}</dt>
      <dd class="status-fact-value" title={title}>
        {copy !== undefined ? <CopyButton value={copy} label={term} /> : null}
        <span class="status-scroll">{children}</span>
      </dd>
    </div>
  );
}

/** The LIVE dot's tone: responding (the session is in a turn), waiting (for
 * a permission or the like), idle, or none when nothing speaks for the
 * session. */
function liveTone(agent: AgentInfo | undefined): string {
  if (agent?.status === "waiting") return "waiting";
  return agent?.turn?.state ?? "none";
}

export function StatusPanel({
  snapshot,
  sid,
  shown,
  onKill,
  restart,
  onLoadEnv,
  onOverride,
}: {
  snapshot: SessionStatusSnapshot | undefined;
  sid: string;
  /** The tab is in front: its panel stays mounted while hidden, so what is
   * to happen as it comes to the front (the secret handoff's ask and reset)
   * goes by this rather than by mounting. */
  shown: boolean;
  onKill: (opts?: { force?: boolean }) => Promise<SessionKillResponse | ErrorResponse>;
  restart: SessionRestart;
  onLoadEnv: () => Promise<SessionEnvResponse | ErrorResponse>;
  onOverride: SessionOverrideChange;
}) {
  const { store } = useApp();
  const cwd = useStoreState(store, (s) => resolveSessionTopbar(s, sid).cwd);
  const agent = useStoreState(
    store,
    (s) => s.agents.find((candidate) => candidate.sessionId === sid),
    sameJson,
  );
  const liveState = formatAgentLiveState(agent);
  const restartable = useStoreState(store, (s) =>
    restartOffered(
      s.agents.find((candidate) => candidate.sessionId === sid),
      s.launchAvailable,
    ),
  );
  // The session's own title — what `/rename` sets — resolved through the same
  // live-agent-first rule the pinned rows use, so the tab can't disagree with
  // the Sessions list about what a session is called. Unlike `sessionRowTitle`
  // there is no cwd/sid tail here: CWD and SESSION_ID are their own rows right
  // below, and repeating one of them under the NAME label would read as a
  // name the session doesn't have.
  const pinned = useStoreState(store, (s) => pinForSid(s.pinnedSessions, sid));
  const title = pinned ? pinnedSessionTitle(pinned, agent) : (agent?.name ?? "");
  // HYOUI_SESSION_ID の値はその端末そのものの名前なので、hyoui web gateway が
  // 設定されている環境ではその端末のページへのリンクにする (Terminal タブと
  // 同じ gateway URL 源 = hello の terminal_gateway_url)。gateway 未設定なら
  // リンクにせず値をそのまま出す。
  const terminalGatewayUrl = useStoreState(store, (s) => s.terminalGatewayUrl);
  const terminalPageUrl = buildTerminalPageUrl(terminalGatewayUrl, agent?.hyoui_session_id);
  // このセッションの ccmsg クライアント。CWD や PID と同じ「今この session が
  // 何で動いているか」の一部なので identity 表に並べる。古い client (protocol
  // の major 違いで断られている) が居るときは警告、minor 違いで繋がっている
  // ときは黄色の印に変わり、それ以外は版数だけを黙って出す (DR-0002 §4)。
  const peer = useStoreState(
    store,
    (s) => s.peers.find((candidate) => candidate.sid === sid),
    sameJson,
  );
  const staleClient = peer ? staleClientWarning(peer) : null;
  // The repository's web page as the daemon derived it (any forge), shown as
  // the URL itself and linked when it is an http(s) URL.
  const repoUrl = peer?.repo_url ?? "";
  const repoLinked = /^https?:\/\//.test(repoUrl);
  const daemonProtocol = useStoreState(store, (s) => s.daemonInfo?.protocol, sameJson);
  const protocolSkew = protocolSkewWarning(peer?.protocol, daemonProtocol);
  // What the overrides put on the main thread's requests (DR-0041 §5), the
  // same in every tab.
  const overrides = useStoreState(store, (s) => s.requestOverrides.get(sid), sameJson);
  const clientBuild = peer ? clientBuildLabel(peer) : "—";
  if (!snapshot) {
    return (
      <div class="status-view">
        <p class="status-loading">読み込み中…</p>
      </div>
    );
  }
  const startedText = agent ? new Date(agent.startedAt).toLocaleString() : undefined;
  const uptimeText = agent ? formatDuration(Date.now() - agent.startedAt) : undefined;
  const context = snapshot.context ? formatContextUsage(snapshot.context, overrides) : null;
  return (
    <div class="status-view">
      <dl class="status-meta status-gauges">
        <div class="status-gauge status-gauge-live">
          <dt>LIVE</dt>
          <dd class="status-live">
            <span class={`status-live-dot status-live-dot-${liveTone(agent)}`} aria-hidden="true" />
            {liveState ?? "—"}
          </dd>
        </div>
        {/* The session's model and effort, each as the requests are sent
         * (DR-0041 §6.1's collapsed face: `fable`, `📌high`), pressed to
         * choose another for the session (§6.4). */}
        <div class="status-gauge">
          <dt>MODEL</dt>
          <dd class="status-override">
            <SessionOverrideField
              field="model"
              state={overrides}
              context={snapshot.context}
              onChange={onOverride}
            />
          </dd>
        </div>
        <div class="status-gauge">
          <dt>EFFORT</dt>
          <dd class="status-override">
            <SessionOverrideField
              field="effort"
              state={overrides}
              context={snapshot.context}
              onChange={onOverride}
            />
          </dd>
        </div>
        <div class="status-gauge status-gauge-context">
          <dt>CONTEXT</dt>
          <dd class="status-context" title={context?.title}>
            {context ? (
              <>
                <span class="status-context-fill">{context.fill}</span>
                {context.ratio !== null ? (
                  <meter
                    class="status-context-meter"
                    min={0}
                    max={1}
                    value={context.ratio}
                    aria-label="context window の使用率"
                  />
                ) : null}
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      {/* セッション情報: the session's facts and, folded under them, its
       * environment. One section, headed like セッション操作 and the danger
       * zone below it. */}
      <section class="status-section status-session-info">
        <h3 class="status-section-title">セッション情報</h3>
        <dl class="status-meta status-facts">
          <Fact term="CWD" copy={cwd ?? undefined}>
            {cwd ?? "—"}
          </Fact>
          <Fact term="REPOSITORY" copy={repoUrl !== "" ? repoUrl : undefined}>
            {repoLinked ? (
              <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                {repoUrl}
              </a>
            ) : repoUrl !== "" ? (
              repoUrl
            ) : (
              "—"
            )}
          </Fact>
          <div class="status-fact">
            <dt>NAME</dt>
            <dd class="status-fact-value">
              {title ? <CopyButton value={title} label="NAME" /> : null}
              <SessionTitleInput key={sid} sid={sid} title={title} />
            </dd>
          </div>
          <Fact term="HYOUI_SESSION_ID" copy={agent?.hyoui_session_id}>
            {agent?.hyoui_session_id ? (
              terminalPageUrl ? (
                <a
                  href={terminalPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="この端末を hyoui web で開く"
                >
                  {agent.hyoui_session_id}
                </a>
              ) : (
                agent.hyoui_session_id
              )
            ) : (
              "—"
            )}
          </Fact>
          <Fact term="SESSION_ID" copy={sid}>
            {sid}
          </Fact>
          <Fact term="PID" copy={agent ? String(agent.pid) : undefined}>
            {agent ? String(agent.pid) : "—"}
          </Fact>
          <Fact
            term="CCMSG"
            copy={staleClient ? staleClient.build : peer ? clientBuild : undefined}
            title={staleClient?.text ?? protocolSkew?.text}
          >
            {staleClient ? (
              <span class="status-stale-client">
                {staleClient.marker} {staleClient.build}
              </span>
            ) : protocolSkew ? (
              <span class="status-protocol-skew">
                {protocolSkew.marker} {clientBuild}
              </span>
            ) : (
              clientBuild
            )}
          </Fact>
          <Fact term="KIND" copy={agent?.kind}>
            {agent?.kind ?? "—"}
          </Fact>
          <Fact term="ENTRYPOINT" copy={agent?.entrypoint}>
            {agent?.entrypoint ?? "—"}
          </Fact>
          <Fact
            term="STARTED"
            copy={startedText}
            title={agent ? new Date(agent.startedAt).toISOString() : undefined}
          >
            {startedText ?? "—"}
          </Fact>
          <Fact term="UPTIME" copy={uptimeText}>
            {uptimeText ?? "—"}
          </Fact>
        </dl>
        <EnvPanel sid={sid} onLoadEnv={onLoadEnv} />
      </section>
      <SecretHandoff key={sid} sid={sid} shown={shown} />
      <SessionControls
        key={sid}
        sid={sid}
        cwd={cwd}
        onKill={onKill}
        restartOffered={restartable}
        restart={restart}
      />
    </div>
  );
}
