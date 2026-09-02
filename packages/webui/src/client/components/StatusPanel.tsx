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
import type {
  ErrorResponse,
  SessionBackgroundStatus,
  SessionEnvResponse,
  SessionKillResponse,
  SessionStatusSnapshot,
  SessionTodo,
} from "@ccmsg/protocol";
import {
  buildStatusSections,
  formatAgentLiveState,
  formatContextUsage,
  formatHyouiNamespace,
} from "../session-status-view.ts";
import { pinnedSessionTitle } from "../pinned-sessions.ts";
import {
  filterEnvRows,
  isSensitiveEnvName,
  splitColonValue,
  toEnvRows,
  type EnvRow,
} from "../env-filter.ts";
import { agentTimelineHref } from "../locator.ts";
import { formatClockTime, resolveSessionTopbar } from "../utils.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Fold } from "./Fold.tsx";

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
 * 追加のガードを掛ける意)。 */
function KillZone({
  sid,
  onKill,
}: {
  sid: string;
  onKill: (opts?: { force?: boolean }) => Promise<SessionKillResponse | ErrorResponse>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [forceMode, setForceMode] = useState(false);

  function handleKill(): void {
    const force = forceMode;
    const confirmMsg = force
      ? `セッション ${sid} に SIGKILL を送ります。プロセスは即時に強制終了され、transcript の flush が途中で切れる可能性があります。実行しますか?`
      : `セッション ${sid} のプロセスを終了しますか?`;
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
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
      .finally(() => setBusy(false));
  }

  const buttonLabel = busy
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
      <button type="button" class={buttonCls} disabled={busy} onClick={handleKill}>
        {buttonLabel}
      </button>
      {result ? <p class="status-kill-result">{result}</p> : null}
    </section>
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

  function handleToggle(e: Event): void {
    if (!(e.currentTarget as HTMLDetailsElement).open) return;
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
        summaryClass="status-env-summary"
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
                onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
              />
              <label class="status-env-split">
                <input
                  type="checkbox"
                  checked={splitColons}
                  onChange={(e) => setSplitColons((e.currentTarget as HTMLInputElement).checked)}
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
  onLoadEnv,
}: {
  snapshot: SessionStatusSnapshot | undefined;
  sid: string;
  onKill: (opts?: { force?: boolean }) => Promise<SessionKillResponse | ErrorResponse>;
  onLoadEnv: () => Promise<SessionEnvResponse | ErrorResponse>;
}) {
  const { store } = useApp();
  const state = useStoreState(store);
  const cwd = resolveSessionTopbar(state, sid).cwd;
  const agent = state.agents.find((candidate) => candidate.sessionId === sid);
  const liveState = formatAgentLiveState(agent);
  // The session's own title — what `/rename` sets — resolved through the same
  // live-agent-first rule the pinned rows use, so the tab can't disagree with
  // the Sessions list about what a session is called. Unlike `sessionRowTitle`
  // there is no cwd/sid tail here: CWD and SESSION_ID are their own rows right
  // below, and repeating one of them under a "TITLE" label would read as a
  // title the session doesn't have.
  const pinned = state.pinnedSessions.get(sid);
  const title = pinned ? pinnedSessionTitle(pinned, agent) : (agent?.name ?? "");
  const namespace = formatHyouiNamespace(agent);
  if (!snapshot) {
    return (
      <div class="status-view">
        <p class="status-loading">読み込み中…</p>
      </div>
    );
  }
  const sections = buildStatusSections(snapshot);
  const context = snapshot.context ? formatContextUsage(snapshot.context) : null;
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
        <dd class="status-meta-value" title={title || undefined}>
          {title ? (
            <>
              <span>{title}</span>
              <CopyButton value={title} label="TITLE" />
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>CWD</dt>
        <dd class="status-meta-value" title={cwd ?? undefined}>
          <span>{cwd ?? "—"}</span>
          {cwd ? <CopyButton value={cwd} label="CWD" /> : null}
        </dd>
        <dt>SESSION_ID</dt>
        <dd class="status-meta-value">
          <span>{sid}</span>
          <CopyButton value={sid} label="SESSION_ID" />
        </dd>
        <dt>PID</dt>
        <dd class="status-meta-value">
          {agent ? (
            <>
              <span>{agent.pid}</span>
              <CopyButton value={String(agent.pid)} label="PID" />
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>HYOUI_SESSION_ID</dt>
        <dd class="status-meta-value">
          {agent?.hyoui_session_id ? (
            <>
              <span>{agent.hyoui_session_id}</span>
              <CopyButton value={agent.hyoui_session_id} label="HYOUI_SESSION_ID" />
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>HYOUI_NAMESPACE</dt>
        <dd class="status-meta-value">
          {namespace ? (
            <>
              <span
                class={namespace.inferred ? "status-meta-inferred" : undefined}
                title={
                  namespace.inferred
                    ? "HYOUI_NAMESPACE 未設定 — hyoui はこれを default namespace として扱う"
                    : undefined
                }
              >
                {namespace.text}
              </span>
              <CopyButton value={namespace.text} label="HYOUI_NAMESPACE" />
            </>
          ) : (
            "—"
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
        <dt>CTX</dt>
        <dd title={context?.title}>
          {context ? (
            <>
              {context.text} <span class="status-context-note">上限は推定</span>
            </>
          ) : (
            "—"
          )}
        </dd>
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
          <section class="status-section">
            <h3 class="status-section-title">TODO</h3>
            {sections.todos.inProgress.length > 0 ? (
              <ul class="status-list">
                {sections.todos.inProgress.map((t) => (
                  <TodoRow key={t.id} todo={t} />
                ))}
              </ul>
            ) : (
              <p class="status-empty">in_progress の TODO なし</p>
            )}
            {sections.todos.pending.length > 0 ? (
              <Fold class="status-done" open summary={`pending (${sections.todos.pending.length})`}>
                <ul class="status-list">
                  {sections.todos.pending.map((t) => (
                    <TodoRow key={t.id} todo={t} />
                  ))}
                </ul>
              </Fold>
            ) : null}
            {sections.todos.completed.length > 0 ? (
              <Fold class="status-done" summary={`completed (${sections.todos.completed.length})`}>
                <ul class="status-list">
                  {sections.todos.completed.map((t) => (
                    <TodoRow key={t.id} todo={t} />
                  ))}
                </ul>
              </Fold>
            ) : null}
          </section>
        </>
      )}
      <EnvPanel sid={sid} onLoadEnv={onLoadEnv} />
      <KillZone key={sid} sid={sid} onKill={onKill} />
    </div>
  );
}
