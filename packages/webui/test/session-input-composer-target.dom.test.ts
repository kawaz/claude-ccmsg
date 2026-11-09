// The composer's destination (DR-0039 §6): the header's select of the main
// thread and the subagents the module says are running a turn, the subagent
// whose Timeline is on screen chosen by default (and again once the Timeline
// shows another), and which op a send takes — `user_prompt` for the main
// thread, `user_message` for a subagent, with the note that it grants nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { RequestOverride, SessionSubagent, UserMessageResponse } from "@ccmsg/protocol";
import { AGENT_INPUT_NOTE } from "../src/client/components/agent-input.ts";
import { SessionInputComposer } from "../src/client/components/SessionInputComposer.tsx";
import {
  loadDraft,
  resetSessionInputPageState,
} from "../src/client/components/session-input-store.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { Mounted, SID } from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
let restores: Array<() => void> = [];

beforeEach(() => {
  resetSessionInputPageState();
  restores = [stubGlobal("localStorage", new MemStorage())];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

const EXPLORE: SessionSubagent = {
  id: "a1",
  type: "Explore",
  description: "調査",
};
const PLAN: SessionSubagent = { id: "b2", type: "Plan", description: "設計" };

type Call =
  | { op: "user_prompt"; text: string; override?: RequestOverride }
  | { op: "user_message"; agentId: string; text: string };

interface Harness {
  root: HTMLElement;
  store: Store;
  ws: WsHandle;
  calls: Call[];
}

/** The composer, opened, for a session whose module says `subagents` are
 * running (undefined: it says nothing of them), with `timelineAgentId` the
 * subagent whose Timeline is on screen. `userMessage` answers `reply`. */
async function openWith(
  subagents: readonly SessionSubagent[] | undefined,
  timelineAgentId: string | null,
  reply: UserMessageResponse = { ok: true, outcome: "appended" },
): Promise<Harness> {
  const store = createStore(initialState());
  store.dispatch({
    type: "session-status/loaded",
    sid: SID,
    snapshot: {
      todos: [],
      workflows: [],
      background: [],
      agent_tree: {
        teammates: [],
        agents: [
          {
            agent_id: "a1",
            agent_type: "Explore",
            name: "explorer",
            spawn_depth: 1,
            kind: "subagent",
            state: "running",
            children: [],
          },
          {
            agent_id: "b2",
            agent_type: "Plan",
            spawn_depth: 1,
            kind: "subagent",
            state: "running",
            children: [],
          },
        ],
        workflows: [],
      },
      ...(subagents !== undefined ? { subagents } : {}),
    },
  });
  const calls: Call[] = [];
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    userPrompt: async (_sid, text, override) => {
      calls.push({
        op: "user_prompt",
        text,
        ...(override !== undefined ? { override } : {}),
      });
      return { ok: true, outcome: "accepted" };
    },
    userMessage: async (_sid, agentId, text) => {
      calls.push({ op: "user_message", agentId, text });
      return reply;
    },
  };
  const root = await mounted.mount(
    store,
    ws,
    h(SessionInputComposer, { sid: SID, timelineAgentId }),
  );
  const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
  await act(() => fab.click());
  return { root, store, ws, calls };
}

function targetSelect(root: HTMLElement): HTMLSelectElement | null {
  const el = root.querySelector(".session-input-panel-header select");
  return el instanceof HTMLSelectElement ? el : null;
}

function options(root: HTMLElement): Array<[string, string]> {
  const el = targetSelect(root);
  return el === null ? [] : [...el.options].map((o) => [o.value, o.textContent ?? ""]);
}

async function pick(root: HTMLElement, value: string): Promise<void> {
  const el = instanceOf(targetSelect(root), HTMLSelectElement, "the destination select");
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(root: HTMLElement, value: string): Promise<void> {
  const el = instanceOf(
    root.querySelector(".session-input-textarea"),
    HTMLTextAreaElement,
    "the textarea",
  );
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Every promise the send chained has settled: a task runs only once the
 * microtasks before it have. */
const drained = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function send(root: HTMLElement): Promise<void> {
  const button = instanceOf(
    root.querySelector(".session-input-send"),
    HTMLButtonElement,
    "the send button",
  );
  await act(async () => {
    button.click();
    await drained();
  });
}

describe("SessionInputComposer destination", () => {
  test("offers main and each running subagent, main chosen on the main thread's Timeline", async () => {
    const { root } = await openWith([EXPLORE, PLAN], null);
    expect(options(root).map(([value]) => value)).toEqual(["", "a1", "b2"]);
    expect(options(root)[0]?.[1]).toBe("main");
    // The label is the agent's name alone; without a name, its id.
    expect(options(root)[1]?.[1]).toBe("explorer");
    expect(options(root)[2]?.[1]).toBe("b2");
    expect(targetSelect(root)?.value).toBe("");
    expect(root.textContent).not.toContain(AGENT_INPUT_NOTE);
  });

  test("no select where the module says nothing of subagents, or none runs", async () => {
    const silent = await openWith(undefined, null);
    expect(targetSelect(silent.root)).toBeNull();
    await mounted.unmount();
    const none = await openWith([], null);
    expect(targetSelect(none.root)).toBeNull();
  });

  test("the subagent whose Timeline is on screen is chosen, and the note is shown", async () => {
    const { root } = await openWith([EXPLORE, PLAN], "b2");
    expect(targetSelect(root)?.value).toBe("b2");
    expect(root.textContent).toContain(AGENT_INPUT_NOTE);
    // A send to a subagent carries no effort.
    expect(root.querySelector('[aria-label="送信の effort"]')).toBeNull();
  });

  test("a Timeline's subagent that is not running is an option of its own, chosen", async () => {
    const { root } = await openWith([EXPLORE], "gone");
    expect(options(root).map(([value]) => value)).toEqual(["", "a1", "gone"]);
    expect(options(root)[2]?.[1]).toBe("gone");
    expect(targetSelect(root)?.value).toBe("gone");
  });

  test("the person's choice holds until the Timeline shows another agent", async () => {
    const { root, store, ws } = await openWith([EXPLORE, PLAN], "a1");
    await pick(root, "");
    expect(targetSelect(root)?.value).toBe("");
    await mounted.rerender(store, ws, h(SessionInputComposer, { sid: SID, timelineAgentId: "b2" }));
    expect(targetSelect(root)?.value).toBe("b2");
    await mounted.rerender(store, ws, h(SessionInputComposer, { sid: SID, timelineAgentId: null }));
    expect(targetSelect(root)?.value).toBe("");
  });

  test("changing the destination keeps the draft", async () => {
    const { root } = await openWith([EXPLORE], null);
    await type(root, "書きかけ");
    await pick(root, "a1");
    await pick(root, "");
    expect(loadDraft(SID)?.text).toBe("書きかけ");
  });
});

describe("SessionInputComposer send by destination", () => {
  test("main goes as user_prompt", async () => {
    const { root, calls } = await openWith([EXPLORE], null);
    await type(root, "本体へ");
    await send(root);
    expect(calls).toEqual([{ op: "user_prompt", text: "本体へ", override: {} }]);
  });

  test("a subagent goes as user_message to it; appended clears the draft", async () => {
    const { root, calls } = await openWith([EXPLORE, PLAN], null);
    await pick(root, "b2");
    await type(root, "設計へ");
    await send(root);
    expect(calls).toEqual([{ op: "user_message", agentId: "b2", text: "設計へ" }]);
    expect(loadDraft(SID)).toBeNull();
  });

  test("a subagent no longer running: the reason is shown and the text stays", async () => {
    const { root, calls } = await openWith([EXPLORE], "gone", {
      ok: true,
      outcome: "not_delivered",
      reason: "not_running",
    });
    await type(root, "終わった子へ");
    await send(root);
    expect(calls).toEqual([{ op: "user_message", agentId: "gone", text: "終わった子へ" }]);
    expect(root.textContent).toContain("もう走っていない");
    expect(loadDraft(SID)?.text).toBe("終わった子へ");
  });
});
