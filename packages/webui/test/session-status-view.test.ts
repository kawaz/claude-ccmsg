// DR-0020 Phase 2/3: unit tests for the pure snapshot->display folds used by
// StatusPanel.tsx, Timeline.tsx's mini panel, and SessionList.tsx's sidebar
// badge. No store/DOM dependency — these operate on a bare
// SessionStatusSnapshot.
import { describe, expect, test } from "bun:test";
import type {
  SessionBackgroundStatus,
  SessionStatusSnapshot,
  SessionTodo,
  SessionWorkflowStatus,
} from "@ccmsg/protocol";
import {
  buildStatusSections,
  formatSidebarBadge,
  miniSummaryLines,
  splitBackground,
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

const EMPTY_SNAPSHOT: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };

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
    };
    expect(miniSummaryLines(snapshot)).toEqual([]);
  });

  test("running workflow before in_progress todo, both under the cap", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "in_progress", subject: "fix bug" })],
      workflows: [workflow({ task_id: "w1", status: "running", name: "release" })],
      background: [],
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
    };
    const lines = miniSummaryLines(snapshot);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ kind: "workflow", text: "wf" });
    expect(lines[1]).toEqual({ kind: "more", text: "他 2 件" });
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
    };
    expect(formatSidebarBadge(snapshot)).toBe("todo:2/3");
  });

  test("all three axes present join with a single space, in wf/bg/todo order", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [todo({ id: "t1", status: "pending" })],
      workflows: [workflow({ task_id: "w1", status: "running" })],
      background: [background({ task_id: "b1", status: "running" })],
    };
    expect(formatSidebarBadge(snapshot)).toBe("wf:1 bg:1 todo:0/1");
  });
});
