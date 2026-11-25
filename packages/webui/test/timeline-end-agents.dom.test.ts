// The active agents at the end of the Timeline (DR-0054 §4, kawaz 2026-11-24):
// while the mark of the time since the last turn stands at the end of the
// session's own Timeline and some of its teammates, subagents and workflow
// runs work, a line `● <n> active agent[s]` above the dotted seam over the
// time, the dot the agent list's of an agent at work (its colour and its
// pulse), dot and words the size of the 応答中 line's (kawaz 2026-11-25).
// It tells a main thread waiting on its agents from one that stopped, so it
// shows only with both: no turn answered (the mark), and something at work
// (an idle teammate waits for work, a completed agent or run is done).
import { afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { h } from "preact";
import type {
  AgentTreeGroups,
  AgentTreeNode,
  AgentTreeWorkflowGroup,
  SessionStatusSnapshot,
} from "@ccmsg/protocol";
import { dotProps, workingAgentCount } from "../src/client/components/agent-tree-view.ts";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { activeAgentsWords } from "../src/client/elapsed-words.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { useStoreState } from "../src/client/useStore.ts";
import { withDom } from "./dom.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore, uuidOf } from "./timeline-harness.ts";

withDom();

function node(over: Partial<AgentTreeNode> & Pick<AgentTreeNode, "agent_id">): AgentTreeNode {
  return { kind: "subagent", spawn_depth: 0, state: "unknown", children: [], ...over };
}

function run(id: string, done: number, total: number): AgentTreeWorkflowGroup {
  return { workflow_id: id, done, total, phases: [], unassigned: [] };
}

function tree(over: Partial<AgentTreeGroups>): AgentTreeGroups {
  return { teammates: [], agents: [], workflows: [], ...over };
}

const LAST = "2027-01-12T12:00:00.000Z";
const BASE: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };
const IDLE: SessionStatusSnapshot = { ...BASE, turn: { state: "idle", since: LAST } };
const ONE = tree({ agents: [node({ agent_id: "a1", state: "active" })] });
const TWO = tree({
  teammates: [node({ agent_id: "t1", kind: "teammate", teammate_name: "w", state: "active" })],
  agents: [node({ agent_id: "a1", state: "active" })],
});

describe("workingAgentCount", () => {
  // What the agent list's working groups hold: the top-level rows of its
  // Teammates and Agents sections in active / running / progress, and the
  // runs on the live side of its Workflows section.
  // A teammate spawned works on the prompt it was started with, as an active
  // one works on a later one (kawaz 2026-11-24): both count.
  test("counts the working teammates (spawned too), subagents and runs, not the idle or the done", () => {
    expect(
      workingAgentCount(
        tree({
          teammates: [
            node({ agent_id: "t1", kind: "teammate", state: "active" }),
            node({ agent_id: "t2", kind: "teammate", state: "idle" }),
            node({ agent_id: "t3", kind: "teammate", state: "stopped" }),
            node({ agent_id: "t4", kind: "teammate", state: "spawned" }),
          ],
          agents: [
            node({ agent_id: "a1", state: "active" }),
            node({ agent_id: "a2", state: "completed" }),
            node({ agent_id: "a3", state: "running" }),
            node({ agent_id: "a4", state: "unknown" }),
          ],
          workflows: [run("wf_1", 1, 3), run("wf_2", 0, 0), run("wf_3", 2, 2)],
        }),
      ),
    ).toBe(6);
    expect(workingAgentCount(undefined)).toBe(0);
    expect(workingAgentCount(tree({}))).toBe(0);
  });

  // An agent counts as working while one under it works (spawned too), as the
  // list groups it, and the one under it is not counted again.
  test("an agent with a working agent under it counts once", () => {
    const child = node({ agent_id: "c1", spawn_depth: 1, state: "active" });
    const spawnedChild = node({ agent_id: "c2", spawn_depth: 1, state: "spawned" });
    expect(
      workingAgentCount(
        tree({
          teammates: [
            node({ agent_id: "t9", kind: "teammate", state: "idle", children: [spawnedChild] }),
          ],
        }),
      ),
    ).toBe(1);
    expect(
      workingAgentCount(
        tree({
          teammates: [node({ agent_id: "t1", kind: "teammate", state: "idle", children: [child] })],
        }),
      ),
    ).toBe(1);
    expect(
      workingAgentCount(
        tree({ agents: [node({ agent_id: "a1", state: "active", children: [child] })] }),
      ),
    ).toBe(1);
  });

  // A run is one, however many agents it runs.
  test("a running workflow run counts once, not by its agents", () => {
    const members = ["w1", "w2", "w3"].map((id) =>
      node({ agent_id: id, kind: "workflow_member", state: "running" }),
    );
    expect(
      workingAgentCount(
        tree({
          workflows: [
            {
              ...run("wf_1", 0, 3),
              phases: [{ index: 1, title: "p", done: 0, total: 3, members }],
            },
          ],
        }),
      ),
    ).toBe(1);
  });
});

describe("activeAgentsWords", () => {
  test("singular for one agent, plural otherwise", () => {
    expect(activeAgentsWords(1)).toBe("1 active agent");
    expect(activeAgentsWords(2)).toBe("2 active agents");
    expect(activeAgentsWords(3)).toBe("3 active agents");
  });
});

describe("the active agents at the end of the Timeline", () => {
  const mounted = new Mounted();
  const rows = [
    jsonl(userContentRow("question 1", { uuid: uuidOf("u", 1), timestamp: LAST })),
    jsonl(assistantContentRow([textBlock("answer 1")], { uuid: uuidOf("a", 1), timestamp: LAST })),
  ];

  beforeEach(() => {
    localStorage.clear();
    setSystemTime(Date.parse(LAST) + 83_000);
  });
  afterEach(async () => {
    await mounted.unmount();
    setSystemTime();
  });

  function TimelineOf({
    status,
    agent,
  }: {
    status: SessionStatusSnapshot;
    agent: AgentRef | null;
  }) {
    const { store } = useApp();
    const sessionTree = useStoreState(store, (s) => s.sessionTrees.get(SID));
    if (sessionTree === undefined) return null;
    return h(Timeline, {
      key: SID,
      sid: SID,
      timeline: sessionTree.timeline,
      search: sessionTree.timelineSearch,
      sessionStatus: status,
      agent,
      active: true,
      visible: true,
    });
  }

  async function open(status: SessionStatusSnapshot, agent: AgentRef | null = null) {
    const store = timelineStore(agent !== null ? { agent } : {});
    const ws = new FakeTranscriptWs(store);
    const root = await mounted.mount(store, ws.handle, h(TimelineOf, { status, agent }));
    await ws.lastRead().answer(page(rows));
    return {
      root,
      setStatus: (next: SessionStatusSnapshot) =>
        mounted.rerender(store, ws.handle, h(TimelineOf, { status: next, agent })),
    };
  }

  function idleMark(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>("[data-tl-marker='idle']");
  }

  /** What the end says of the agents (the words after the dot): null with no
   * mark, "" with the mark and no agents. */
  function agentsSaid(root: HTMLElement): string | null {
    const mark = idleMark(root);
    if (mark === null) return null;
    return mark.querySelector<HTMLElement>(".tl-elapsed-agents")?.dataset.label ?? "";
  }

  test("goes with the time since the last turn, singular for one, and goes as they end", async () => {
    const view = await open({ ...IDLE, agent_tree: TWO });
    expect(agentsSaid(view.root)).toBe("2 active agents");
    // The time below it is the mark's own, unchanged.
    expect(
      idleMark(view.root)?.querySelector(".tl-elapsed-label")?.getAttribute("data-detail"),
    ).toBe("1m23s");

    await view.setStatus({ ...IDLE, agent_tree: ONE });
    expect(agentsSaid(view.root)).toBe("1 active agent");

    await view.setStatus({ ...IDLE, agent_tree: tree({}) });
    expect(agentsSaid(view.root)).toBe("");
    await view.setStatus(IDLE);
    expect(agentsSaid(view.root)).toBe("");
  });

  // Not words of the DOM: drawn by app.css from the attribute, as the time is,
  // so a selection across the end does not take them in; no hover text.
  // The dot is the agent list's dot of an agent at work: the same classes,
  // so the same colour, pulse and reduced-motion rule (DR-0054 §4).
  test("is an attribute of the mark, not text, with no hover text, after the list's working dot", async () => {
    const view = await open({ ...IDLE, agent_tree: TWO });
    const mark = idleMark(view.root);
    const dot = mark?.querySelector(".tl-elapsed-agents > .status-teammate-dot");
    expect(dot?.getAttribute("class")).toBe(dotProps("active").class);
    expect(mark?.textContent).toBe("");
    expect(mark?.hasAttribute("title")).toBe(false);
  });

  test("not while only idle teammates and done agents are there", async () => {
    const view = await open({
      ...IDLE,
      agent_tree: tree({
        teammates: [
          node({ agent_id: "t1", kind: "teammate", state: "idle" }),
          node({ agent_id: "t2", kind: "teammate", state: "idle" }),
        ],
        agents: [node({ agent_id: "a1", state: "completed" })],
        workflows: [run("wf_1", 2, 2)],
      }),
    });
    expect(agentsSaid(view.root)).toBe("");
  });

  test("a running workflow run alone shows it", async () => {
    const view = await open({ ...IDLE, agent_tree: tree({ workflows: [run("wf_1", 1, 4)] }) });
    expect(agentsSaid(view.root)).toBe("1 active agent");
  });

  // While the main thread answers a turn there is no mark at the end (応答中
  // stands there), so nothing of the agents either.
  test("not while the main thread answers a turn", async () => {
    const view = await open({
      ...BASE,
      turn: { state: "responding", since: LAST },
      agent_tree: TWO,
    });
    expect(agentsSaid(view.root)).toBeNull();
    await view.setStatus({ ...IDLE, agent_tree: TWO });
    expect(agentsSaid(view.root)).toBe("2 active agents");
  });

  // An agent's Timeline ends with the agent's own mark: what the main thread
  // waits on is not said there.
  test("not on an agent's Timeline", async () => {
    const view = await open({ ...IDLE, agent_tree: TWO, subagents: [] }, { agentId: "a9" });
    expect(agentsSaid(view.root)).toBe("");
  });
});

describe("app.css", () => {
  beforeAll(async () => {
    const style = document.createElement("style");
    style.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    document.head.append(style);
  });

  // The line above the seam is the 応答中 line's size (kawaz 2026-11-25): its
  // words in the Timeline's letters (the mark's small letters are its time's
  // only), its dot the 応答中 dot's size painted in the agent list's working
  // dot's colour and pulse, the same gap between them. It takes no colour or
  // motion of its own. The seam stands over the middle of the time's main
  // words (`1分`), in the column of the main words (sized by them), without
  // measuring them in script.
  test("the line above the seam is the 応答中 line's size, and the seam stands over the main words", () => {
    const rules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText);
    const rule = (selector: string) => rules.find((text) => text.startsWith(`${selector} {`)) ?? "";
    const decl = (text: string, property: string) =>
      new RegExp(`(?:^|[ {;])${property}: ([^;]+);`).exec(text)?.[1];
    const responding = rule(".tl-turn-responding");
    const respondingDot = rule(".tl-turn-responding-dot");
    const line = rule(".tl-elapsed-agents");
    const dot = rule(".tl-elapsed-agents > .status-teammate-dot");
    expect(decl(line, "gap")).toBe(decl(responding, "gap"));
    expect(decl(dot, "width")).toBe(decl(respondingDot, "width"));
    expect(decl(dot, "height")).toBe(decl(respondingDot, "height"));
    expect(decl(rule(".tl-elapsed"), "font-size")).toBeUndefined();
    expect(decl(rule(".tl-elapsed-label"), "font-size")).toBe("var(--font-size-sm)");
    for (const text of rules.filter((t) => t.includes("tl-elapsed-agents"))) {
      expect(text).not.toContain("font-size");
      expect(text).not.toMatch(/(^|[ ;{])color:/);
      expect(text).not.toContain("animation");
    }

    const mark = rule('.tl-elapsed[data-tl-marker="idle"]');
    expect(decl(mark, "grid-template-columns")).toBe("max-content max-content 1fr");
    const seam = rule('.tl-elapsed[data-tl-marker="idle"]::before');
    expect(decl(seam, "grid-column")).toBe("1");
    expect(decl(seam, "justify-self")).toBe("center");
    const words = rule('.tl-elapsed[data-tl-marker="idle"] > .tl-elapsed-label');
    expect(decl(words, "grid-template-columns")).toBe("subgrid");
  });
});
