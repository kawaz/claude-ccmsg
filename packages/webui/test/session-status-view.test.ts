// DR-0020 Phase 2/3: unit tests for the pure snapshot->display folds used by
// StatusPanel.tsx, Timeline.tsx's mini panel, and SessionList.tsx's sidebar
// badge. No store/DOM dependency — these operate on a bare
// SessionStatusSnapshot.
import { describe, expect, test } from "bun:test";
import type {
  SessionBackgroundStatus,
  SessionStatusSnapshot,
  SessionTeammate,
  SessionTodo,
  SessionWorkflowStatus,
} from "@ccmsg/protocol";
import {
  buildStatusSections,
  estimateContextLimit,
  formatContextUsage,
  formatSidebarBadge,
  miniSummaryLines,
  splitBackground,
  splitTeammates,
  splitTodos,
  splitWorkflows,
} from "../src/client/session-status-view.ts";

function todo(overrides: Partial<SessionTodo> & { id: string; status: string }): SessionTodo {
  return { subject: overrides.id, ...overrides };
}

function workflow(
  overrides: Partial<SessionWorkflowStatus> & { task_id: string; status: string },
): SessionWorkflowStatus {
  return { name: overrides.task_id, started_at: "2026-07-16T00:00:00.000Z", ...overrides };
}

function background(
  overrides: Partial<SessionBackgroundStatus> & { task_id: string; status: string },
): SessionBackgroundStatus {
  return {
    kind: "bash",
    description: overrides.task_id,
    started_at: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_SNAPSHOT: SessionStatusSnapshot = {
  todos: [],
  workflows: [],
  background: [],
  teammates: [],
};

describe("splitTodos", () => {
  test("zero todos: all buckets empty", () => {
    expect(splitTodos([])).toEqual({ pending: [], inProgress: [], completed: [] });
  });

  test("buckets by status, preserving snapshot order within each bucket", () => {
    const todos = [
      todo({ id: "t1", status: "pending" }),
      todo({ id: "t2", status: "in_progress" }),
      todo({ id: "t3", status: "completed" }),
      todo({ id: "t4", status: "pending" }),
    ];
    const sections = splitTodos(todos);
    expect(sections.pending.map((t) => t.id)).toEqual(["t1", "t4"]);
    expect(sections.inProgress.map((t) => t.id)).toEqual(["t2"]);
    expect(sections.completed.map((t) => t.id)).toEqual(["t3"]);
  });
});

describe("splitWorkflows / splitBackground", () => {
  test("zero entries: both buckets empty", () => {
    expect(splitWorkflows([])).toEqual({ running: [], done: [] });
    expect(splitBackground([])).toEqual({ running: [], done: [] });
  });

  test("only 'running' counts as running, any other status is done (open-set terminal values)", () => {
    const workflows = [
      workflow({ task_id: "w1", status: "running" }),
      workflow({ task_id: "w2", status: "completed" }),
      workflow({ task_id: "w3", status: "failed" }), // unrecognized-but-terminal value
    ];
    const sections = splitWorkflows(workflows);
    expect(sections.running.map((w) => w.task_id)).toEqual(["w1"]);
    expect(sections.done.map((w) => w.task_id)).toEqual(["w2", "w3"]);
  });

  test("background follows the same running/done split", () => {
    const background_ = [
      background({ task_id: "b1", status: "running" }),
      background({ task_id: "b2", status: "done" }),
    ];
    const sections = splitBackground(background_);
    expect(sections.running.map((b) => b.task_id)).toEqual(["b1"]);
    expect(sections.done.map((b) => b.task_id)).toEqual(["b2"]);
  });
});

describe("buildStatusSections", () => {
  test("folds all three snapshot arrays in one call", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "in_progress" })],
      workflows: [workflow({ task_id: "w1", status: "running" })],
      background: [background({ task_id: "b1", status: "running" })],
      teammates: [],
    };
    const sections = buildStatusSections(snapshot);
    expect(sections.todos.inProgress).toHaveLength(1);
    expect(sections.workflows.running).toHaveLength(1);
    expect(sections.background.running).toHaveLength(1);
  });
});

describe("miniSummaryLines", () => {
  test("zero running workflows and zero in_progress todos: empty (panel hidden)", () => {
    expect(miniSummaryLines(EMPTY_SNAPSHOT)).toEqual([]);
    // completed todos / done workflows alone must not surface a line.
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "completed" })],
      workflows: [workflow({ task_id: "w1", status: "completed" })],
      background: [],
      teammates: [],
    };
    expect(miniSummaryLines(snapshot)).toEqual([]);
  });

  test("running workflow before in_progress todo, both under the cap", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "in_progress", subject: "fix bug" })],
      workflows: [workflow({ task_id: "w1", status: "running", name: "release" })],
      background: [],
      teammates: [],
    };
    expect(miniSummaryLines(snapshot)).toEqual([
      { kind: "workflow", text: "release" },
      { kind: "todo", text: "fix bug" },
    ]);
  });

  test("over the 2-line cap collapses the remainder into a 'more' line", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [
        todo({ id: "t1", status: "in_progress", subject: "a" }),
        todo({ id: "t2", status: "in_progress", subject: "b" }),
      ],
      workflows: [workflow({ task_id: "w1", status: "running", name: "wf" })],
      background: [],
      teammates: [],
    };
    const lines = miniSummaryLines(snapshot);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ kind: "workflow", text: "wf" });
    expect(lines[1]).toEqual({ kind: "more", text: "他 2 件" });
  });
});

describe("context usage display", () => {
  test("200k 帯は推定マーカー付きの 200k 分母で表示する", () => {
    // transcript から分母を直接観測できないため、100k は 200k と推定し、生値と推定理由を title に残す。
    const formatted = formatContextUsage({
      tokens: 100_000,
      model: "claude-haiku-4-5-20251001",
      timestamp: "2026-07-17T00:00:00.000Z",
    });
    expect(formatted.text).toBe("ctx 100k/200k* (50%)");
    expect(formatted.title).toContain("100,000 tokens");
    expect(formatted.title).toContain("estimated");
  });

  test("200k を超えた観測値は 1M セッションの証拠として扱う", () => {
    // [1m] suffix が transcript に載らない実形でも、522k という値自体が 200k 上限を否定する。
    expect(
      formatContextUsage({
        tokens: 522_000,
        model: "claude-fable-5",
        timestamp: "2026-07-17T00:00:00.000Z",
      }).text,
    ).toBe("ctx 522k/1M* (52%)");
  });

  test("200k 境界は超過した場合だけ 1M 推定へ切り替える", () => {
    // 200k ちょうどは 200k モデルでも成立し、200001 だけが 200k 上限では説明不能になる。
    expect(estimateContextLimit(200_000)).toBe(200_000);
    expect(estimateContextLimit(200_001)).toBe(1_000_000);
    expect(formatContextUsage({ tokens: 200_000, model: "m", timestamp: "t" }).text).toBe(
      "ctx 200k/200k* (100%)",
    );
  });

  test("100% 超を丸め込まず推定外れの手掛かりとして表示する", () => {
    // 推定分母より大きい観測値を clamp すると診断情報を失うため、1.1M は 110% のまま出す。
    expect(formatContextUsage({ tokens: 1_100_000, model: "m", timestamp: "t" }).text).toBe(
      "ctx 1100k/1M* (110%)",
    );
  });
});

describe("splitTeammates", () => {
  test("spawn・送信・受信を合わせた最終観測時刻の降順で並べる", () => {
    // Teams 一覧は TUI 内部状態でなく transcript 上の最後の活動を先頭に出す。
    const teammates: SessionTeammate[] = [
      {
        name: "spawn-only",
        spawned: true,
        state: "spawned",
        spawned_at: "2026-07-17T00:03:00.000Z",
      },
      {
        name: "sent",
        spawned: false,
        state: "active",
        last_sent_at: "2026-07-17T00:01:00.000Z",
      },
      {
        name: "received",
        spawned: false,
        state: "active",
        last_received_at: "2026-07-17T00:02:00.000Z",
      },
    ];
    expect(splitTeammates(teammates).map((teammate) => teammate.name)).toEqual([
      "spawn-only",
      "received",
      "sent",
    ]);
  });
});

describe("formatSidebarBadge", () => {
  test("no snapshot (not subscribed / not yet arrived): null", () => {
    expect(formatSidebarBadge(undefined)).toBeNull();
  });

  test("all-zero snapshot: null (no badge segments)", () => {
    expect(formatSidebarBadge(EMPTY_SNAPSHOT)).toBeNull();
  });

  test("running-only counts for wf/bg, zero axes omitted", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [
        workflow({ task_id: "w1", status: "running" }),
        workflow({ task_id: "w2", status: "completed" }),
      ],
      background: [],
      teammates: [],
    };
    expect(formatSidebarBadge(snapshot)).toBe("wf:1");
  });

  test("todo fraction excludes completed from both numerator and denominator", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [
        todo({ id: "t1", status: "in_progress" }),
        todo({ id: "t2", status: "in_progress" }),
        todo({ id: "t3", status: "pending" }),
        todo({ id: "t4", status: "completed" }),
        todo({ id: "t5", status: "completed" }),
      ],
      workflows: [],
      background: [],
      teammates: [],
    };
    expect(formatSidebarBadge(snapshot)).toBe("todo:2/3");
  });

  test("all three axes present join with a single space, in wf/bg/todo order", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "pending" })],
      workflows: [workflow({ task_id: "w1", status: "running" })],
      background: [background({ task_id: "b1", status: "running" })],
      teammates: [],
    };
    expect(formatSidebarBadge(snapshot)).toBe("wf:1 bg:1 todo:0/1");
  });
});
