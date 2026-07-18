// SessionView Status-tab body (DR-0020 Phase 2): a session's currently
// running workflows / background tasks / TODOs, folded from the daemon's
// session_status_subscribe snapshot. The subscribe/unsubscribe round trip
// itself lives in SessionView (shared with the Timeline mini panel, which
// needs the same live data) — this component is presentation-only, same
// division of labor as SessionRooms being fed pre-fetched `state.rooms`.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
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
  shortModel,
  splitTeammates,
  type WorkflowDrilldownAgentView,
} from "../session-status-view.ts";
import { agentTimelineHref } from "../locator.ts";
import { formatClockTime } from "../utils.ts";

function TodoRow({ todo }: { todo: SessionTodo }) {
  return (
    <li class={"status-todo" + (todo.status === "in_progress" ? " status-todo-active" : "")}>
      <span class="status-todo-subject">{todo.subject}</span>
      {todo.owner ? <span class="status-owner">{todo.owner}</span> : null}
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
  return (
    <li class={"status-row status-wf-drill" + (running ? " status-row-active" : "")}>
      <details>
        <summary>{header}</summary>
        {drilldown.phases.length > 0 ? (
          <ul class="status-wf-phases">
            {drilldown.phases.map((p) => (
              <li key={p.title} class="status-wf-phase">
                <span class="status-wf-phase-title">{p.title}</span>
                <span class="status-wf-phase-count">
                  {p.done}/{p.total}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {drilldown.agents.length > 0 ? (
          <ul class="status-wf-agents">
            {drilldown.agents.map((agent) => (
              <WorkflowAgentLink key={agent.agentId} agent={agent} sid={sid} runId={wf.run_id} />
            ))}
          </ul>
        ) : null}
      </details>
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

function TeammateRow({ teammate, sid }: { teammate: SessionTeammate; sid: string }) {
  const href = agentTimelineHref(sid, { teammate: teammate.name });
  return (
    <li class={"status-row status-teammate status-teammate-" + teammate.state}>
      <span class="status-row-name">{teammate.name}</span>
      {teammate.agent_type ? <span class="status-row-kind">{teammate.agent_type}</span> : null}
      {teammate.model ? <span class="status-row-kind">{shortModel(teammate.model)}</span> : null}
      <span class="status-row-summary">{teammate.state}</span>
      <a class="status-wf-agent-tl" href={href}>
        TL
      </a>
      <span class="status-row-time">
        {teammate.last_sent_at ? `送 ${formatClockTime(teammate.last_sent_at)}` : ""}
        {teammate.last_sent_at && teammate.last_received_at ? " · " : ""}
        {teammate.last_received_at ? `受 ${formatClockTime(teammate.last_received_at)}` : ""}
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
  if (teammates.length === 0) return null;
  return (
    <section class="status-section">
      <h3 class="status-section-title">Teams</h3>
      <p class="status-estimate-note">transcript 観測ベースの推定 (TUI 内部状態は非観測)</p>
      <ul class="status-list">
        {splitTeammates(teammates).map((teammate) => (
          <TeammateRow key={teammate.name} teammate={teammate} sid={sid} />
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
function KillZone({
  sid,
  onKill,
}: {
  sid: string;
  onKill: () => Promise<SessionKillResponse | ErrorResponse>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  function handleKill(): void {
    if (!window.confirm(`セッション ${sid} のプロセスを終了しますか?`)) return;
    setBusy(true);
    setResult(null);
    void onKill()
      .then((res) => {
        if (res.ok) {
          setResult(
            res.terminated ? "プロセスの終了を確認しました" : "シグナル送信済み (終了は未確認)",
          );
        } else if (res.error.code === "not_found") {
          setResult("プロセスが見つかりません (既に終了済みの可能性)");
        } else {
          setResult(`エラー: ${res.error.msg}`);
        }
      })
      .catch((e: unknown) => setResult(`エラー: ${String(e)}`))
      .finally(() => setBusy(false));
  }

  return (
    <section class="status-section status-kill-zone">
      <h3 class="status-section-title">危険ゾーン</h3>
      <button type="button" class="status-kill-button" disabled={busy} onClick={handleKill}>
        {busy ? "終了処理中…" : "セッションを終了"}
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
  onKill: () => Promise<SessionKillResponse | ErrorResponse>;
}) {
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
      {context ? (
        // The "*" alone doesn't explain itself and the title attribute is
        // hover-only (invisible on touch), so the estimation caveat gets a
        // visible inline note — the issue's acceptance criterion is that the
        // estimated nature is stated on the UI itself.
        <p class="status-context" title={context.title}>
          {context.text} <span class="status-context-note">上限は推定</span>
        </p>
      ) : null}
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
