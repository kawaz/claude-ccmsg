// SessionView Status-tab body (DR-0020 Phase 2): a session's currently
// running workflows / background tasks / TODOs, folded from the daemon's
// session_status_subscribe snapshot. The subscribe/unsubscribe round trip
// itself lives in SessionView (shared with the Timeline mini panel, which
// needs the same live data); session identity metadata is resolved here from
// the shared store so Status uses the same peer/pin/agent fallback as the topbar.
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ErrorResponse,
  SessionBackgroundStatus,
  SessionKillResponse,
  SessionStatusSnapshot,
  SessionTeammate,
  SessionTodo,
  SessionWorkflowStatus,
} from "@ccmsg/protocol";
import {
  buildStatusSections,
  buildWorkflowDrilldown,
  formatContextUsage,
  groupAgentsByPhase,
  shortModel,
  splitTeammates,
  type WorkflowDrilldownAgentView,
  type WorkflowDrilldownGroupView,
} from "../session-status-view.ts";
import { agentTimelineHref } from "../locator.ts";
import { formatClockTime, formatRelativeAge, resolveSessionTopbar } from "../utils.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { useNow } from "../useNow.ts";

/** r38 mid=4: TODO 行の頭状態マーカー。workflow drilldown の agent icon 語彙
 * (✓/⟳/·) と揃えることで Status タブ内の視覚言語を一貫させる。open set の status
 * (upstream が値を追加しうる) は default で pending と同じ空マーカー扱い、独自
 * 分岐は生やさない (未知値に色や記号を勝手に当てないポリシー)。 */
function todoIconGlyph(status: string): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "⟳";
  return "·";
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      class={"status-meta-copy" + (copied ? " copied" : "")}
      title={`${label} をコピー`}
      aria-label={`${label} をコピー`}
      onClick={() => void copy()}
    >
      {copied ? "✓" : "コピー"}
    </button>
  );
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

const ICON_GLYPH: Record<WorkflowDrilldownAgentView["icon"], string> = {
  done: "✓",
  running: "⟳",
  error: "✗",
  pending: "·",
};

function formatTokens(tokens: number | undefined): string | null {
  if (tokens === undefined) return null;
  if (tokens < 1000) return `${tokens}`;
  return `${Math.round(tokens / 1000)}k`;
}

function WorkflowRow({
  wf,
  running,
  sid,
}: {
  wf: SessionWorkflowStatus;
  running: boolean;
  sid: string;
}) {
  const drilldown = buildWorkflowDrilldown(wf);
  const groups = drilldown ? groupAgentsByPhase(drilldown) : [];
  // Header の右肩要約: 宣言 phase がある時は「Phases 完了数/総数」、agents だけの
  // 旧型 / 走行中 (state json 未生成) は「Agents N」。r38 mid=3 で Phase 単位の
  // グループ化は展開後の一覧側に持たせるため、header 側は畳んだ時の要約だけを担う。
  const phasesLabel = drilldown
    ? drilldown.phases.length > 0
      ? `Phases ${drilldown.phases.filter((p) => p.total > 0 && p.done === p.total).length}/${drilldown.phases.length}`
      : `Agents ${drilldown.agents.length}`
    : null;
  const header = (
    <>
      <span class="status-row-name">{wf.name}</span>
      {wf.summary ? <span class="status-row-summary">{wf.summary}</span> : null}
      {phasesLabel ? <span class="status-row-drill">{phasesLabel}</span> : null}
      <span class="status-row-time">
        {formatClockTime(wf.started_at)}
        {wf.ended_at ? ` – ${formatClockTime(wf.ended_at)}` : ""}
      </span>
    </>
  );
  if (!drilldown) {
    return <li class={"status-row" + (running ? " status-row-active" : "")}>{header}</li>;
  }
  // r38 mid=3: 走行中 workflow は Status タブを開いた瞬間に Phase / agent が
  // 見える方が「今何が動いているか」の視認性が高い (kawaz)。完了 workflow は
  // 「完了 (N)」の中に既に 1 段畳まれているため、そこから開いた時点で意図があり
  // 更に 1 段畳んだままにする合理性が薄いので同じく open にする。
  return (
    <li class={"status-row status-wf-drill" + (running ? " status-row-active" : "")}>
      <details open>
        <summary>{header}</summary>
        {groups.length > 0 ? (
          <ul class="status-wf-groups">
            {groups.map((group) => (
              <WorkflowPhaseGroup key={group.title} group={group} sid={sid} runId={wf.run_id} />
            ))}
          </ul>
        ) : null}
      </details>
    </li>
  );
}

/** Phase 見出し + その配下の agent list。TUI で workflow 展開時に見える
 * 「Phase タイトル (done/total ✓) — 下にサブセッション」の構造を webui でも
 * 再現するグループ描画 (r38 mid=3)。合成 group ("(no phase)") は synthetic
 * class で見た目を弱め、宣言 phase 見出しと同格に見えないようにする。 */
function WorkflowPhaseGroup({
  group,
  sid,
  runId,
}: {
  group: WorkflowDrilldownGroupView;
  sid: string;
  runId?: string;
}) {
  const cls =
    "status-wf-group" +
    (group.complete ? " status-wf-group-complete" : "") +
    (group.synthetic ? " status-wf-group-synthetic" : "");
  return (
    <li class={cls}>
      <div class="status-wf-group-header">
        <span class="status-wf-group-title">{group.title}</span>
        <span class="status-wf-group-count">
          {group.done}/{group.total}
        </span>
        {group.complete ? <span class="status-wf-group-check">✓</span> : null}
      </div>
      {group.agents.length > 0 ? (
        <ul class="status-wf-agents">
          {group.agents.map((agent) => (
            <WorkflowAgentLink key={agent.agentId} agent={agent} sid={sid} runId={runId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Bridges `AgentDrillRow` (which has no runId in scope) to `WorkflowRow`
 * (which knows the runId of the whole workflow). Kept as a thin wrapper so
 * the row renderer stays a pure presentation function against
 * `WorkflowDrilldownAgentView` — the TL link is the only place that needs
 * the runId, and forwarding it through props keeps the shape uniform. */
function WorkflowAgentLink({
  agent,
  sid,
  runId,
}: {
  agent: WorkflowDrilldownAgentView;
  sid: string;
  runId?: string;
}) {
  const href = agentTimelineHref(sid, {
    agentId: agent.agentId,
    ...(runId ? { runId } : {}),
  });
  const tokensLabel = formatTokens(agent.tokens);
  const iconClass = `status-wf-agent-icon status-wf-agent-icon-${agent.icon}`;
  const hasDetails = !!(agent.resultPreview || agent.lastTool || agent.error);
  return (
    <li class="status-wf-agent">
      {hasDetails ? (
        <details class="status-wf-agent-details">
          <summary>
            <span class={iconClass}>{ICON_GLYPH[agent.icon]}</span>
            <span class="status-wf-agent-label">{agent.label}</span>
            {agent.model ? <span class="status-wf-agent-model">{agent.model}</span> : null}
            {tokensLabel ? <span class="status-wf-agent-tokens">{tokensLabel}</span> : null}
            <a class="status-wf-agent-tl" href={href}>
              TL
            </a>
          </summary>
          {agent.error ? <p class="status-wf-agent-error">{agent.error}</p> : null}
          {agent.lastTool ? <p class="status-wf-agent-tool">{agent.lastTool}</p> : null}
          {agent.resultPreview ? (
            <p class="status-wf-agent-preview">{agent.resultPreview}</p>
          ) : null}
        </details>
      ) : (
        <div class="status-wf-agent-summary">
          <span class={iconClass}>{ICON_GLYPH[agent.icon]}</span>
          <span class="status-wf-agent-label">{agent.label}</span>
          {agent.model ? <span class="status-wf-agent-model">{agent.model}</span> : null}
          {tokensLabel ? <span class="status-wf-agent-tokens">{tokensLabel}</span> : null}
          <a class="status-wf-agent-tl" href={href}>
            TL
          </a>
        </div>
      )}
    </li>
  );
}

function BackgroundRow({ bg, running }: { bg: SessionBackgroundStatus; running: boolean }) {
  return (
    <li class={"status-row" + (running ? " status-row-active" : "")}>
      <span class="status-row-kind">{bg.kind}</span>
      <span class="status-row-summary">{bg.description}</span>
      <span class="status-row-time">
        {formatClockTime(bg.started_at)}
        {bg.ended_at ? ` – ${formatClockTime(bg.ended_at)}` : ""}
      </span>
    </li>
  );
}

/** r38 mid=5: teammate state を日本語ラベル + カラードットで視覚化する。
 *
 * daemon 側 (`session-status.ts`) が state を transcript 観測から推定済み:
 *
 * - `active`: teammate からの relay body が `idle_notification` 以外の
 *   通常メッセージだった時、または (spawn 直後で) 自分が SendMessage で
 *   先に話しかけた時。「今しゃべっている / 応答待ち中」
 * - `idle`: relay body が `{"type":"idle_notification"...}` (subagent が idle
 *   に落ちた自己申告) だった時。「一区切りついて next input 待ち」
 * - `spawned`: Agent tool の `teammate_spawned` result が観測されたが、以降
 *   send/receive が無い状態。「起動直後、まだ何もやり取りしていない」
 * - `stopped`: TaskStop で明示的に殺した teammate。「終了済み、以後の観測なし」
 *
 * 判定根拠を daemon 側の transcript 実観測に置いているため、ここでは UI の
 * 語彙揃えだけを担う (mtime ベースの staleness 判定を UI で足すと『新規
 * setInterval 追加禁止』要件と衝突する。時系列的な rawer 情報が要る場面は
 * 既存の send/受信 timestamp が担っている)。 */
const TEAMMATE_STATE_LABEL: Record<string, string> = {
  active: "活動中",
  idle: "idle 中",
  spawned: "起動済み",
  stopped: "停止",
};

function TeammateRow({
  teammate,
  sid,
  now,
}: {
  teammate: SessionTeammate;
  sid: string;
  now: number;
}) {
  const href = agentTimelineHref(sid, { teammate: teammate.name });
  const label = TEAMMATE_STATE_LABEL[teammate.state] ?? teammate.state;
  const dotClass = "status-teammate-dot status-teammate-dot-" + teammate.state;
  const sentAge = formatRelativeAge(teammate.last_sent_at ?? null, now);
  const receivedAge = formatRelativeAge(teammate.last_received_at ?? null, now);
  return (
    <li class={"status-row status-teammate status-teammate-" + teammate.state}>
      <span class={dotClass} aria-hidden="true">
        ●
      </span>
      <a class="status-wf-agent-tl status-teammate-tl" href={href}>
        TL
      </a>
      <span class="status-row-name">{teammate.name}</span>
      {teammate.agent_type ? <span class="status-row-kind">{teammate.agent_type}</span> : null}
      {teammate.model ? <span class="status-row-kind">{shortModel(teammate.model)}</span> : null}
      <span class="status-row-summary status-teammate-state-label">{label}</span>
      <span class="status-row-time status-teammate-time">
        <span title={teammate.last_sent_at ?? undefined}>{sentAge ? `送 ${sentAge}` : ""}</span>
        <span aria-hidden="true">{sentAge && receivedAge ? "·" : ""}</span>
        <span title={teammate.last_received_at ?? undefined}>
          {receivedAge ? `受 ${receivedAge}` : ""}
        </span>
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
        <details class="status-done">
          <summary>完了 ({done.length})</summary>
          <ul class="status-list">{done.map((item) => renderRow(item, false))}</ul>
        </details>
      ) : null}
    </section>
  );
}

function TeamsSection({ teammates, sid }: { teammates: SessionTeammate[]; sid: string }) {
  const now = useNow();
  if (teammates.length === 0) return null;
  return (
    <section class="status-section">
      <h3 class="status-section-title">Teams</h3>
      <p class="status-estimate-note">transcript 観測ベースの推定 (TUI 内部状態は非観測)</p>
      <ul class="status-list">
        {splitTeammates(teammates).map((teammate) => (
          <TeammateRow key={teammate.name} teammate={teammate} sid={sid} now={now} />
        ))}
      </ul>
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

export function StatusPanel({
  snapshot,
  sid,
  onKill,
}: {
  snapshot: SessionStatusSnapshot | undefined;
  sid: string;
  onKill: (opts?: { force?: boolean }) => Promise<SessionKillResponse | ErrorResponse>;
}) {
  const { store } = useApp();
  const state = useStoreState(store);
  const cwd = resolveSessionTopbar(state, sid).cwd;
  if (!snapshot) {
    return (
      <div class="status-view">
        <p class="status-loading">読み込み中…</p>
      </div>
    );
  }
  const sections = buildStatusSections(snapshot);
  const context = snapshot.context ? formatContextUsage(snapshot.context) : null;
  // Context is nearly always present and Teams is an independent observation.
  // Keep the empty-state predicate scoped to DR-0020's three operational axes.
  const nothingAtAll =
    sections.todos.pending.length === 0 &&
    sections.todos.inProgress.length === 0 &&
    sections.todos.completed.length === 0 &&
    sections.workflows.running.length === 0 &&
    sections.workflows.done.length === 0 &&
    sections.background.running.length === 0 &&
    sections.background.done.length === 0;
  return (
    <div class="status-view">
      <dl class="status-meta">
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
        <p class="status-empty">このセッションの workflow / background / TODO はまだありません</p>
      ) : (
        <>
          <Section
            title="Workflows"
            running={sections.workflows.running}
            done={sections.workflows.done}
            renderRow={(wf, running) => (
              <WorkflowRow key={wf.task_id} wf={wf} running={running} sid={sid} />
            )}
            emptyRunningText="走行中の workflow なし"
          />
          <Section
            title="Background"
            running={sections.background.running}
            done={sections.background.done}
            renderRow={(bg, running) => (
              <BackgroundRow key={bg.task_id} bg={bg} running={running} />
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
              <details class="status-done" open>
                <summary>pending ({sections.todos.pending.length})</summary>
                <ul class="status-list">
                  {sections.todos.pending.map((t) => (
                    <TodoRow key={t.id} todo={t} />
                  ))}
                </ul>
              </details>
            ) : null}
            {sections.todos.completed.length > 0 ? (
              <details class="status-done">
                <summary>completed ({sections.todos.completed.length})</summary>
                <ul class="status-list">
                  {sections.todos.completed.map((t) => (
                    <TodoRow key={t.id} todo={t} />
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        </>
      )}
      <TeamsSection teammates={snapshot.teammates ?? []} sid={sid} />
      <KillZone key={sid} sid={sid} onKill={onKill} />
    </div>
  );
}
