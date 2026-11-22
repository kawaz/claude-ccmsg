// The input box's btw (DR-0060 §8), mounted: the check left of the effort,
// the effort narrowed to the in-effect and ⏱️ values while it is checked, a
// send that goes as btw_ask (and neither user_prompt nor request_override),
// the box left as a send leaves it (cleared, closed, unchecked) once the
// daemon took it, and kept with the reason when it did not. A subagent's
// input has no btw.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { BtwAskResponse, ErrorResponse, LaunchEffort } from "@ccmsg/protocol";
import { SessionInputComposer } from "../src/client/components/SessionInputComposer.tsx";
import {
  loadDraft,
  resetSessionInputPageState,
} from "../src/client/components/session-input-store.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
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

type Call =
  | { op: "btw_ask"; prompt: string; effort: LaunchEffort | undefined }
  | { op: "user_prompt" }
  | { op: "request_override" };

const TAKEN: BtwAskResponse = {
  ok: true,
  btw: {
    id: "b1",
    session_id: SID,
    ts: "2026-11-22T00:00:00.000Z",
    prompt: "q",
    response: "",
    status: "running",
  },
};

const BUSY: ErrorResponse = {
  ok: false,
  error: { code: "btw_busy", msg: "4 btws are running already; wait for one to end" },
};

/** The composer, opened, for a fable / low session, and the subagent `a1`
 * running when `timelineAgentId` names it. btwAsk answers `reply`. */
async function openWith(
  reply: BtwAskResponse | ErrorResponse = TAKEN,
  timelineAgentId: string | null = null,
): Promise<{ root: HTMLElement; calls: Call[] }> {
  const store = createStore(initialState());
  store.dispatch({
    type: "session-status/loaded",
    sid: SID,
    snapshot: {
      todos: [],
      workflows: [],
      background: [],
      context: {
        model: "claude-fable-5-1",
        effort: "low",
        timestamp: "t",
        engine: { model: "claude-fable-5-1", effort: "low" },
      },
      ...(timelineAgentId !== null
        ? { subagents: [{ id: timelineAgentId, type: "Explore", description: "調査" }] }
        : {}),
    },
  });
  const calls: Call[] = [];
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    btwAsk: async (_sid, prompt, effort) => {
      calls.push({ op: "btw_ask", prompt, effort });
      return reply;
    },
    userPrompt: async () => {
      calls.push({ op: "user_prompt" });
      return { ok: true, outcome: "accepted" };
    },
    requestOverride: async () => {
      calls.push({ op: "request_override" });
      return { ok: true, delivery: "applied" };
    },
  };
  const root = await mounted.mount(
    store,
    ws,
    h(SessionInputComposer, { sid: SID, timelineAgentId }),
  );
  await open(root);
  return { root, calls };
}

async function open(root: HTMLElement): Promise<void> {
  const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
  await act(() => fab.click());
}

function checkbox(root: HTMLElement): HTMLInputElement {
  return instanceOf(
    root.querySelector(".session-input-btw input"),
    HTMLInputElement,
    "the btw check",
  );
}

async function check(root: HTMLElement): Promise<void> {
  const box = checkbox(root);
  await act(() => box.click());
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

async function effortSelect(root: HTMLElement): Promise<HTMLSelectElement> {
  const at = instanceOf(
    root.querySelector('button.override-value[aria-label="送信の effort"]'),
    HTMLButtonElement,
    "the effort at rest",
  );
  await act(() => at.click());
  return instanceOf(
    root.querySelector('select[aria-label="送信の effort"]'),
    HTMLSelectElement,
    "the effort select",
  );
}

async function choose(root: HTMLElement, label: string): Promise<void> {
  const el = await effortSelect(root);
  const option = [...el.options].find((o) => o.textContent === label);
  if (option === undefined) throw new Error(`no option ${label}`);
  await act(() => {
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("the input box's btw", () => {
  test("the check stands left of the effort, unchecked", async () => {
    const { root } = await openWith();
    const actions = instanceOf(
      root.querySelector(".session-input-actions"),
      HTMLElement,
      "the actions row",
    );
    const label = instanceOf(actions.querySelector(".session-input-btw"), HTMLElement, "btw");
    expect(label.textContent).toBe("btw");
    const effort = actions.querySelector('[aria-label="送信の effort"]');
    expect(
      effort !== null && label.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(checkbox(root).checked).toBe(false);
  });

  test("checked, the effort offers the in-effect and ⏱️ values only, and the box says so", async () => {
    const { root } = await openWith();
    await check(root);
    const groups = [...(await effortSelect(root)).querySelectorAll("optgroup")].map((g) =>
      g.getAttribute("label"),
    );
    expect(groups).toEqual(["in effect", "turn"]);
    expect(root.querySelector(".session-input-send")?.textContent).toBe("btw で聞く");
    expect(root.querySelector(".session-input-textarea")?.getAttribute("placeholder")).toStartWith(
      "btw で聞く...",
    );
  });

  test("a send goes as btw_ask with the ⏱️ effort, nothing else; taken, the box is cleared, closed and unchecked", async () => {
    const { root, calls } = await openWith();
    await check(root);
    await choose(root, "⏱️high");
    await type(root, "この関数は何をしている?");
    await send(root);
    expect(calls).toEqual([{ op: "btw_ask", prompt: "この関数は何をしている?", effort: "high" }]);
    expect(loadDraft(SID)).toBeNull();
    expect(root.querySelector(".session-input-panel")).toBeNull();
    await open(root);
    expect(checkbox(root).checked).toBe(false);
  });

  test("with the in-effect effort, the btw names none (the session's)", async () => {
    const { root, calls } = await openWith();
    await check(root);
    await type(root, "q");
    await send(root);
    expect(calls).toEqual([{ op: "btw_ask", prompt: "q", effort: undefined }]);
  });

  test("not taken, the text and the check stay, and the reason shows", async () => {
    const { root, calls } = await openWith(BUSY);
    await check(root);
    await type(root, "q");
    await send(root);
    expect(calls).toEqual([{ op: "btw_ask", prompt: "q", effort: undefined }]);
    expect(checkbox(root).checked).toBe(true);
    expect(loadDraft(SID)?.text).toBe("q");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("上限");
  });

  test("unchecked, a send is the prompt's as before", async () => {
    const { root, calls } = await openWith();
    await type(root, "q");
    await send(root);
    expect(calls).toEqual([{ op: "user_prompt" }]);
  });

  test("a subagent's input has no btw", async () => {
    const { root } = await openWith(TAKEN, "a1");
    expect(root.querySelector(".session-input-btw")).toBeNull();
  });
});
