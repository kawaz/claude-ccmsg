// SessionView Status-tab body (DR-0020 Phase 2): a session's currently
// running workflows / background tasks / TODOs, folded from the daemon's
// session_status_subscribe snapshot. The subscribe/unsubscribe round trip
// itself lives in SessionView (shared with the Timeline mini panel, which
// needs the same live data) — this component is presentation-only, same
// division of labor as SessionRooms being fed pre-fetched `state.rooms`.
import type { JSX } from "preact";
import type {
  SessionBackgroundStatus,
  SessionStatusSnapshot,
  SessionTodo,
  SessionWorkflowStatus,
} from "@ccmsg/protocol";
import { buildStatusSections } from "../session-status-view.ts";
import { formatClockTime } from "../utils.ts";

function TodoRow({ todo }: { todo: SessionTodo }) {
  return (
    <li class={"status-todo" + (todo.status === "in_progress" ? " status-todo-active" : "")}>
      <span class="status-todo-subject">{todo.subject}</span>
      {todo.owner ? <span class="status-owner">{todo.owner}</span> : null}
    </li>
  );
}

function WorkflowRow({ wf, running }: { wf: SessionWorkflowStatus; running: boolean }) {
  return (
    <li class={"status-row" + (running ? " status-row-active" : "")}>
      <span class="status-row-name">{wf.name}</span>
      {wf.summary ? <span class="status-row-summary">{wf.summary}</span> : null}
      <span class="status-row-time">
        {formatClockTime(wf.started_at)}
        {wf.ended_at ? ` – ${formatClockTime(wf.ended_at)}` : ""}
      </span>
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

export function StatusPanel({ snapshot }: { snapshot: SessionStatusSnapshot | undefined }) {
  if (!snapshot) {
    return (
      <div class="status-view">
        <p class="status-loading">読み込み中…</p>
      </div>
    );
  }
  const sections = buildStatusSections(snapshot);
  const nothingAtAll =
    sections.todos.pending.length === 0 &&
    sections.todos.inProgress.length === 0 &&
    sections.todos.completed.length === 0 &&
    sections.workflows.running.length === 0 &&
    sections.workflows.done.length === 0 &&
    sections.background.running.length === 0 &&
    sections.background.done.length === 0;
  if (nothingAtAll) {
    return (
      <div class="status-view">
        <p class="status-empty">このセッションの workflow / background / TODO はまだありません</p>
      </div>
    );
  }
  return (
    <div class="status-view">
      <Section
        title="Workflows"
        running={sections.workflows.running}
        done={sections.workflows.done}
        renderRow={(wf, running) => <WorkflowRow key={wf.task_id} wf={wf} running={running} />}
        emptyRunningText="走行中の workflow なし"
      />
      <Section
        title="Background"
        running={sections.background.running}
        done={sections.background.done}
        renderRow={(bg, running) => <BackgroundRow key={bg.task_id} bg={bg} running={running} />}
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
    </div>
  );
}
