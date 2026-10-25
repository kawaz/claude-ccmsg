// The Status tab's TODO list and the session's uptime, as mounted (kawaz
// 2026-10-25): the TODO list starts closed with its count in the heading and
// opens to the rows; UPTIME says how long the process has run; the Timeline's
// ctx line ends with the uptime and the Claude Code version the process runs.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  AgentInfo,
  ErrorResponse,
  SessionEnvResponse,
  SessionKillResponse,
  SessionRestartResponse,
  SessionStatusSnapshot,
  UserMessageResponse,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, useStoreState, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore } from "./timeline-harness.ts";

withDom();

const MIN = 60_000;
const HOUR = 60 * MIN;

let roots: HTMLElement[] = [];
const mounted = new Mounted();

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  await mounted.unmount();
});

/** The session's process row, started `ago` ms before now. A little over the
 * whole minute, so a slow test does not cross into the next one. */
function agentRow(ago: number, version?: string): AgentInfo {
  return {
    pid: 4242,
    cwd: "/w",
    kind: "interactive",
    startedAt: Date.now() - ago - 10_000,
    sessionId: SID,
    config_dir: "/home/u/.claude-personal",
    ...(version !== undefined ? { version } : {}),
  };
}

async function mountStatus(
  snapshot: SessionStatusSnapshot,
  agent?: AgentInfo,
): Promise<HTMLElement> {
  const store = createStore(initialState());
  if (agent) store.dispatch({ type: "agents/loaded", agents: [agent] });
  const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => new Promise(() => {});
  const onKill = (): Promise<SessionKillResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, terminated: true });
  const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, pid: 4242, env: {} });
  const onAgentInput = (): Promise<UserMessageResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, outcome: "appended" });
  const ws = createWsClient((action) => store.dispatch(action));
  function Host() {
    const restart = useSessionRestart(SID, onRestart);
    return h(StatusPanel, { snapshot, sid: SID, onKill, restart, onLoadEnv, onAgentInput });
  }
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(h(AppContext.Provider, { value: { store, ws } }, h(Host, null)), root));
  return root;
}

/** The `<details>` whose own summary reads `label`. */
function foldTitled(root: HTMLElement, label: string): HTMLDetailsElement {
  const summary = [...root.querySelectorAll("summary")].find((s) => s.textContent === label);
  if (!summary) throw new Error(`no fold titled ${label}`);
  return instanceOf(summary.parentElement, HTMLDetailsElement, `the fold of ${label}`);
}

/** The value cell the Status tab's identity table puts under `term`. */
function metaValue(root: HTMLElement, term: string): string | null {
  const dt = [...root.querySelectorAll(".status-meta dt")].find((d) => d.textContent === term);
  return dt?.nextElementSibling?.textContent ?? null;
}

const TODOS: SessionStatusSnapshot = {
  todos: [
    { id: "1", subject: "write the parser", status: "in_progress" },
    { id: "2", subject: "wire the op", status: "pending" },
    { id: "3", subject: "read the spec", status: "completed" },
  ],
  workflows: [],
  background: [],
};

describe("Status tab TODO list", () => {
  test("starts closed with the count of every TODO in its heading", async () => {
    const root = await mountStatus(TODOS);
    const fold = foldTitled(root, "TODO (3)");
    expect(fold.open).toBe(false);
  });

  test("opens to the rows, in_progress first and pending open inside", async () => {
    const root = await mountStatus(TODOS);
    const fold = foldTitled(root, "TODO (3)");
    await act(() => {
      fold.open = true;
    });
    const subjects = [...fold.querySelectorAll(".status-todo-subject")].map((s) => s.textContent);
    expect(subjects).toEqual(["write the parser", "wire the op", "read the spec"]);
    expect(foldTitled(root, "pending (1)").open).toBe(true);
    expect(foldTitled(root, "completed (1)").open).toBe(false);
  });

  test("a session with no TODO shows no TODO heading", async () => {
    const root = await mountStatus({
      todos: [],
      workflows: [],
      background: [
        {
          task_id: "b1",
          kind: "bash",
          description: "watch",
          status: "running",
          started_at: "2026-10-25T00:00:00.000Z",
        },
      ],
    });
    expect([...root.querySelectorAll("summary")].map((s) => s.textContent)).not.toContain(
      "TODO (0)",
    );
    expect(root.textContent).not.toContain("TODO");
  });
});

describe("Status tab UPTIME", () => {
  test("how long the session's process has run", async () => {
    const root = await mountStatus(TODOS, agentRow(5 * HOUR + 12 * MIN));
    expect(metaValue(root, "UPTIME")).toBe("5h12m");
  });

  test("a dash without the session's process", async () => {
    const root = await mountStatus(TODOS);
    expect(metaValue(root, "UPTIME")).toBe("—");
  });
});

function TimelineOf({ snapshot }: { snapshot: SessionStatusSnapshot }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: snapshot,
    agent: null,
    active: true,
    visible: true,
  });
}

async function mountTimeline(store: Store, snapshot: SessionStatusSnapshot): Promise<HTMLElement> {
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, { snapshot }));
  const read = ws.reads.at(-1);
  if (read === undefined) throw new Error("expected the initial read");
  await read.answer(page([]));
  return root;
}

describe("Timeline ctx line", () => {
  const SNAPSHOT: SessionStatusSnapshot = {
    todos: [],
    workflows: [],
    background: [],
    context: {
      tokens: 120_000,
      window: 1_000_000,
      model: "claude-fable-5[1m]",
      effort: "low",
      timestamp: "2026-10-25T00:00:00.000Z",
    },
  };

  test("ends with the uptime and the Claude Code version", async () => {
    const restore = stubGlobal("navigation", { navigate() {} });
    try {
      const store = timelineStore();
      store.dispatch({
        type: "agents/loaded",
        agents: [agentRow(2 * 24 * HOUR + 15 * HOUR, "2.1.310")],
      });
      const root = await mountTimeline(store, SNAPSHOT);
      expect(root.querySelector(".tl-status-mini-context")?.textContent).toBe(
        "ctx 120k/1M (12%) · fable-5[1m] · low · 2d15h · claude v2.1.310",
      );
    } finally {
      restore();
    }
  });

  test("without the session's process the line is the context alone", async () => {
    const restore = stubGlobal("navigation", { navigate() {} });
    try {
      const root = await mountTimeline(timelineStore(), SNAPSHOT);
      expect(root.querySelector(".tl-status-mini-context")?.textContent).toBe(
        "ctx 120k/1M (12%) · fable-5[1m] · low",
      );
    } finally {
      restore();
    }
  });
});
