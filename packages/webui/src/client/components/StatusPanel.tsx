// SessionView Status-tab body (DR-0020 Phase 2): a session's identity
// metadata, background tasks and TODOs, folded from the daemon's
// session_status_subscribe snapshot. The subscribe/unsubscribe round trip
// itself lives in SessionView (shared with the Timeline mini panel, which
// needs the same live data); session identity metadata is resolved here from
// the shared store so Status uses the same peer/pin/agent fallback as the topbar.
// Agent/workflow structure is shown by the Timeline's agent tree
// (`AgentTreePanel`), which is the single place for that view.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  type LaunchEffort,
  type LaunchModel,
  type ErrorResponse,
  type SessionBackgroundStatus,
  type SessionEnvResponse,
  type SessionKillResponse,
  type SessionRestartResponse,
  type SessionStatusSnapshot,
  type SessionTodo,
} from "@ccmsg/protocol";
import {
  buildStatusSections,
  formatAgentLiveState,
  formatContextUsage,
  restartOffered,
  restartResultText,
  type TodoSections,
} from "../session-status-view.ts";
import { pinForSid, pinnedSessionTitle } from "../pinned-sessions.ts";
import {
  filterEnvRows,
  isSensitiveEnvName,
  splitColonValue,
  toEnvRows,
  type EnvRow,
} from "../env-filter.ts";
import { agentTimelineHref } from "../locator.ts";
import { buildTerminalPageUrl } from "../terminal-gateway-store.ts";
import {
  clientBuildLabel,
  formatClockTime,
  formatDuration,
  resolveSessionTopbar,
  protocolSkewWarning,
  staleClientWarning,
} from "../utils.ts";
import { useApp } from "../context.ts";
import { sameJson, useStoreState } from "../useStore.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Fold } from "./Fold.tsx";
import { LaunchFold, RestartFold, useStatusLaunch } from "./StatusSessionForms.tsx";
import { sessionRunsAs } from "../status-session-forms.ts";
import { SessionOverrideField, type SessionOverrideChange } from "./RequestOverridePicker.tsx";

/** r38 mid=4: TODO 行の頭状態マーカー。open set の status (upstream が値を
 * 追加しうる) は default で pending と同じ空マーカー扱い、独自分岐は生やさない
 * (未知値に色や記号を勝手に当てないポリシー)。 */
function todoIconGlyph(status: string): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "⟳";
  return "·";
}

function TodoRow({ todo }: { todo: SessionTodo }) {
  const iconClass = "status-todo-icon status-todo-icon-" + todo.status;
  return (
    <li class={"status-todo" + (todo.status === "in_progress" ? " status-todo-active" : "")}>
      <span class={iconClass}>{todoIconGlyph(todo.status)}</span>
      <span class="status-todo-id">#{todo.id}</span>
      <span class="status-todo-subject">{todo.subject}</span>
      {todo.owner ? <span class="status-owner">{todo.owner}</span> : null}
      {todo.blocked_by && todo.blocked_by.length > 0 ? (
        <span class="status-todo-blocked">
          blocked by {todo.blocked_by.map((id) => `#${id}`).join(",")}
        </span>
      ) : null}
    </li>
  );
}

function BackgroundRow({
  bg,
  running,
  sid,
}: {
  bg: SessionBackgroundStatus;
  running: boolean;
  sid: string;
}) {
  // r44 m6: kind=="agent" は subagent の TL を持つので TL リンク + agent_type
  // バッジを添える。live dot はエージェントツリーと同じ流儀 (running=active、
  // 終端=stopped) で色味を寄せ、webui 全体の視覚言語を一貫させる。
  // 判定は `running` prop (buildStatusSections が status 値から算出) を利用
  // するため、"completed"/"failed"/"killed" 等の open-set terminal 値を
  // ここで列挙する必要はない。
  const isAgent = bg.kind === "agent";
  const agentHref = isAgent ? agentTimelineHref(sid, { agentId: bg.task_id }) : null;
  const dotClass = "status-teammate-dot status-teammate-dot-" + (running ? "active" : "stopped");
  return (
    <li class={"status-row" + (running ? " status-row-active" : "")}>
      {isAgent ? (
        <>
          <span class={dotClass} aria-hidden="true">
            ●
          </span>
          {agentHref ? (
            <a class="status-row-tl" href={agentHref}>
              TL
            </a>
          ) : null}
          <span class="status-row-kind">{bg.agent_type ?? bg.kind}</span>
        </>
      ) : (
        <span class="status-row-kind">{bg.kind}</span>
      )}
      <span class="status-row-summary">{bg.description}</span>
      <span class="status-row-time">
        {formatClockTime(bg.started_at)}
        {bg.ended_at ? ` – ${formatClockTime(bg.ended_at)}` : ""}
      </span>
    </li>
  );
}

/** Terminal (non-running) rows are collapsed behind a `<details>` (DR-0020
 * §2.1 "完了は畳む") — the running/active section above stays always-open
 * since that's the whole point of the tab (what's the session doing right
 * now). Renders nothing (not even the `<details>`) when both are empty, so
 * an idle-and-never-ran section doesn't leave a dangling empty toggle. */
function Section<T>({
  title,
  running,
  done,
  renderRow,
  emptyRunningText,
}: {
  title: string;
  running: T[];
  done: T[];
  renderRow: (item: T, running: boolean) => JSX.Element;
  emptyRunningText: string;
}) {
  if (running.length === 0 && done.length === 0) return null;
  return (
    <section class="status-section">
      <h3 class="status-section-title">{title}</h3>
      {running.length > 0 ? (
        <ul class="status-list">{running.map((item) => renderRow(item, true))}</ul>
      ) : (
        <p class="status-empty">{emptyRunningText}</p>
      )}
      {done.length > 0 ? (
        <Fold class="status-done" summary={`完了 (${done.length})`}>
          <ul class="status-list">{done.map((item) => renderRow(item, false))}</ul>
        </Fold>
      ) : null}
    </section>
  );
}

/** The session's TODO list, closed until opened with the count in its heading
 * (kawaz 2026-10-25: a long list is in the way and matters less than the rest
 * of the tab). Nothing when the session has no TODO, like Background. */
function TodoSection({ todos }: { todos: TodoSections }) {
  const count = todos.inProgress.length + todos.pending.length + todos.completed.length;
  if (count === 0) return null;
  return (
    <section class="status-section">
      <Fold class="status-todos" summaryClass="status-fold-summary" summary={`TODO (${count})`}>
        {todos.inProgress.length > 0 ? (
          <ul class="status-list">
            {todos.inProgress.map((t) => (
              <TodoRow key={t.id} todo={t} />
            ))}
          </ul>
        ) : (
          <p class="status-empty">in_progress の TODO なし</p>
        )}
        {todos.pending.length > 0 ? (
          <Fold class="status-done" open summary={`pending (${todos.pending.length})`}>
            <ul class="status-list">
              {todos.pending.map((t) => (
                <TodoRow key={t.id} todo={t} />
              ))}
            </ul>
          </Fold>
        ) : null}
        {todos.completed.length > 0 ? (
          <Fold class="status-done" summary={`completed (${todos.completed.length})`}>
            <ul class="status-list">
              {todos.completed.map((t) => (
                <TodoRow key={t.id} todo={t} />
              ))}
            </ul>
          </Fold>
        ) : null}
      </Fold>
    </section>
  );
}

/** DR-0028 danger zone: terminate the OS process behind this session.
 * Deliberately at the very bottom of the Status tab (kawaz: "普段触らない
 * 場所" — a prominent placement like the Sidebar would be a mis-click
 * hazard) and guarded by window.confirm, the same confirm convention as
 * MemberChip's kick. The ws send itself is injected via `onKill` so this
 * component stays presentation-only (StatusPanel's existing division of
 * labor with SessionView). `terminated: false` on a successful reply is not
 * an error — the daemon sent both SIGTERMs but couldn't observe the process
 * disappear within its grace (protocol doc). */
/** r38 mid=6: SIGTERM で落ちなかった時に SIGKILL へ 2 段エスカレーションする
 * ボタン。DR-0028 の「daemon は勝手に SIGKILL しない」原則を維持しつつ、
 * ユーザーが SIGTERM の未確認を目視して opt-in できる動線を UI 側で提供する:
 *
 *   1. 初回押下: SIGTERM 2 連発 (DR-0028 通常経路)
 *   2. 応答が `terminated: false` (シグナル送信済み、終了未確認) だったら
 *      ボタン表示を「強制終了 (-KILL)」に切り替え、押すと `force: true` で
 *      SIGKILL を送る
 *   3. `terminated: true` / `not_found` / エラー、あるいは sid が変わった場合は
 *      通常状態にリセット
 *
 * confirm は force 時も必ず出し、文言に SIGKILL である旨と不可逆性を明記する
 * (kawaz の「-KILL モードに変化させて欲しい」= 表示だけでなく操作にも一段
 * 追加のガードを掛ける意)。
 *
 * The session forms above it (新セッションを起動, 再起動) are not dangerous and
 * sit outside the zone; while one of them runs, the kill waits (`blocked`),
 * and while the kill runs, they do. The kill's own running is held by
 * `SessionControls` for that reason. */
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
        } else if (res.error.code === "not_found") {
          setResult("プロセスが見つかりません (既に終了済みの可能性)");
          setForceMode(false);
        } else {
          setResult(`エラー: ${res.error.msg}`);
          // エラー時は force モードを維持 (直前の状態がユーザーの意図)
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
      ? "強制終了 (-KILL)"
      : "セッションを終了";
  const buttonCls = "status-kill-button" + (forceMode ? " status-kill-button-force" : "");
  return (
    <section class="status-section status-kill-zone">
      <h3 class="status-section-title">危険ゾーン</h3>
      <div class="status-kill-buttons">
        <button type="button" class={buttonCls} disabled={killing || blocked} onClick={handleKill}>
          {buttonLabel}
        </button>
      </div>
      {result ? <p class="status-kill-result">{result}</p> : null}
    </section>
  );
}

/** The forms and the danger zone at the bottom of the Status tab: 新セッション
 * を起動 and 再起動 (DR-0028 「restart」), each a fold, above the kill. One
 * thing of the three runs at a time, so this holds what each is doing. The
 * forms are offered only where the daemon can launch; 再起動 also needs the
 * session's process (`restartOffered`), and stays while a restart runs. */
function SessionControls({
  sid,
  cwd,
  runsAs,
  onKill,
  restartOffered,
  restart,
}: {
  sid: string;
  cwd: string | null;
  runsAs: { model?: LaunchModel; effort?: LaunchEffort };
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
        <section class="status-section status-session-forms">
          <LaunchFold cwd={cwd} runsAs={runsAs} launch={launch} blocked={anyBusy} />
          {restartOffered || restart.busy ? (
            <RestartFold cwd={cwd} restart={restart} blocked={anyBusy} />
          ) : null}
        </section>
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

/** A restart of one session as it runs and what it came to (DR-0028
 * 「restart」). Held by the session's view rather than the Status tab: the
 * restart stops the process, and the tab's panel goes while the session is
 * between its old process and the resumed one, which would take the result
 * with it. */
export interface SessionRestart {
  busy: boolean;
  result: ReturnType<typeof restartResultText> | null;
  /** Restart, the resumed session starting with `prompt`; settles once the
   * result is in. */
  start: (prompt: string) => Promise<void>;
}

/** The restart of `sid`, kept across the Status panel coming and going. A
 * restart started for another sid is not this one's. */
export function useSessionRestart(
  sid: string,
  restart: (sid: string, prompt: string) => Promise<SessionRestartResponse | ErrorResponse>,
): SessionRestart {
  const [state, setState] = useState<{
    sid: string;
    busy: boolean;
    result: ReturnType<typeof restartResultText> | null;
  }>({ sid, busy: false, result: null });
  const own = state.sid === sid ? state : { sid, busy: false, result: null };
  return {
    busy: own.busy,
    result: own.result,
    start: (prompt) => {
      setState({ sid, busy: true, result: null });
      return restart(sid, prompt)
        .then((reply) => restartResultText(reply))
        .catch((e: unknown) => ({ text: `再起動できなかった: ${String(e)}` }))
        .then((result) =>
          setState((current) => (current.sid === sid ? { sid, busy: false, result } : current)),
        );
    },
  };
}

/** The TITLE row's value: an input from the start, the place to rename the
 * session (DR-0047 §4). It shows the agents rows' name and follows it, except
 * while the person is editing — what they typed is not overwritten by a name
 * that arrives meanwhile. Enter sends the trimmed draft with `session_rename`,
 * Escape puts the shown name back.
 *
 * The outcome is shown by the input's own look, with no text beside it: a
 * send in flight pulses its brightness, an answer of `renamed` or `queued`
 * returns it to normal, and an error marks it in the danger colour (the
 * message in its `title`) until the person changes the value. A sent name is
 * not written into the input ahead of the session: the input goes back to the
 * agents rows' name, which follows once Claude Code takes it (after the turn
 * for `queued`). A failed send keeps the draft so it can be fixed or retried
 * without retyping. A session no hooks module speaks for answers `no_module`,
 * which shows as that error. An IME's confirming Enter arrives with
 * `isComposing` and is left to the IME. */
function SessionTitleInput({ sid, title }: { sid: string; title: string }) {
  const { ws } = useApp();
  // null = not editing: the input shows `title` and follows it.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The last send's error message; null = no failure to show.
  const [failure, setFailure] = useState<string | null>(null);

  async function send(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setDraft(null);
      setFailure(null);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const res = await ws.sessionRename(sid, trimmed);
      if (res.ok) setDraft(null);
      else setFailure(res.error.msg);
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
      aria-label="TITLE"
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
    | { kind: "loaded"; pid: number; rows: EnvRow[] }
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
        if (res.ok) setState({ kind: "loaded", pid: res.pid, rows: toEnvRows(res.env) });
        else setState({ kind: "error", msg: res.error.msg });
      })
      .catch((e: unknown) => setState({ kind: "error", msg: String(e) }));
  }

  const rows = state.kind === "loaded" ? filterEnvRows(state.rows, query) : [];
  return (
    <section class="status-section">
      <Fold
        class="status-env"
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
            <p class="status-env-count">
              {rows.length}/{state.rows.length} 件 · pid {state.pid}
            </p>
            {rows.length > 0 ? (
              <table class="status-env-table">
                <thead>
                  <tr>
                    <th scope="col">名前</th>
                    <th scope="col">値</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.name}>
                      <td class="status-env-name">{row.name}</td>
                      <td class="status-env-value">
                        <EnvValue
                          row={row}
                          splitColons={splitColons}
                          revealed={revealed.has(row.name)}
                          onToggleReveal={() => toggleReveal(row.name)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p class="status-empty">一致する環境変数なし</p>
            )}
          </>
        ) : null}
      </Fold>
    </section>
  );
}

export function StatusPanel({
  snapshot,
  sid,
  onKill,
  restart,
  onLoadEnv,
  onOverride,
}: {
  snapshot: SessionStatusSnapshot | undefined;
  sid: string;
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
  // below, and repeating one of them under a "TITLE" label would read as a
  // title the session doesn't have.
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
  const sections = buildStatusSections(snapshot);
  const context = snapshot.context ? formatContextUsage(snapshot.context, overrides) : null;
  // Context is nearly always present, so the empty-state predicate stays
  // scoped to the operational axes this tab renders.
  const nothingAtAll =
    sections.todos.pending.length === 0 &&
    sections.todos.inProgress.length === 0 &&
    sections.todos.completed.length === 0 &&
    sections.background.running.length === 0 &&
    sections.background.done.length === 0;
  return (
    <div class="status-view">
      <dl class="status-meta">
        <dt>TITLE</dt>
        <dd class="status-meta-value">
          {title ? <CopyButton value={title} label="TITLE" /> : null}
          <SessionTitleInput key={sid} sid={sid} title={title} />
        </dd>
        <dt>CWD</dt>
        <dd class="status-meta-value" title={cwd ?? undefined}>
          {cwd ? <CopyButton value={cwd} label="CWD" /> : null}
          <span>{cwd ?? "—"}</span>
        </dd>
        <dt>SESSION_ID</dt>
        <dd class="status-meta-value">
          <CopyButton value={sid} label="SESSION_ID" />
          <span>{sid}</span>
        </dd>
        <dt>PID</dt>
        <dd class="status-meta-value">
          {agent ? (
            <>
              <CopyButton value={String(agent.pid)} label="PID" />
              <span>{agent.pid}</span>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>HYOUI_SESSION_ID</dt>
        <dd class="status-meta-value">
          {agent?.hyoui_session_id ? (
            <>
              <CopyButton value={agent.hyoui_session_id} label="HYOUI_SESSION_ID" />
              {terminalPageUrl ? (
                <a
                  href={terminalPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="この端末を hyoui web で開く"
                >
                  {agent.hyoui_session_id}
                </a>
              ) : (
                <span>{agent.hyoui_session_id}</span>
              )}
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>CCMSG</dt>
        <dd class="status-meta-value" title={staleClient?.text ?? protocolSkew?.text}>
          {staleClient ? (
            <span class="status-stale-client">
              {staleClient.marker} {staleClient.build}
            </span>
          ) : protocolSkew ? (
            <span class="status-protocol-skew">
              {protocolSkew.marker} {clientBuild}
            </span>
          ) : (
            <span>{clientBuild}</span>
          )}
        </dd>
        <dt>LIVE</dt>
        <dd>{liveState ?? "—"}</dd>
        <dt>KIND</dt>
        <dd>{agent?.kind ?? "—"}</dd>
        <dt>STARTED</dt>
        <dd title={agent ? new Date(agent.startedAt).toISOString() : undefined}>
          {agent ? new Date(agent.startedAt).toLocaleString() : "—"}
        </dd>
        <dt>UPTIME</dt>
        <dd>{agent ? formatDuration(Date.now() - agent.startedAt) : "—"}</dd>
        {/* The session's model and effort, each as the requests are sent
         * (DR-0041 §6.1's collapsed face: `fable`, `📌high`), pressed to
         * choose another for the session (§6.4). */}
        <dt>MODEL</dt>
        <dd class="status-override">
          <SessionOverrideField
            field="model"
            state={overrides}
            context={snapshot.context}
            onChange={onOverride}
          />
        </dd>
        <dt>EFFORT</dt>
        <dd class="status-override">
          <SessionOverrideField
            field="effort"
            state={overrides}
            context={snapshot.context}
            onChange={onOverride}
          />
        </dd>
        <dt>CONTEXT</dt>
        <dd title={context?.title}>{context ? context.text : "—"}</dd>
      </dl>
      {nothingAtAll ? (
        <p class="status-empty">このセッションの background / TODO はまだありません</p>
      ) : (
        <>
          <Section
            title="Background"
            running={sections.background.running}
            done={sections.background.done}
            renderRow={(bg, running) => (
              <BackgroundRow key={bg.task_id} bg={bg} running={running} sid={sid} />
            )}
            emptyRunningText="走行中の background タスクなし"
          />
          <TodoSection todos={sections.todos} />
        </>
      )}
      <EnvPanel sid={sid} onLoadEnv={onLoadEnv} />
      <SessionControls
        key={sid}
        sid={sid}
        cwd={cwd}
        runsAs={sessionRunsAs(snapshot.context, overrides)}
        onKill={onKill}
        restartOffered={restartable}
        restart={restart}
      />
    </div>
  );
}
