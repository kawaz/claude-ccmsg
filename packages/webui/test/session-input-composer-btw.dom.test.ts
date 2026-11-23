// The input box's btw (DR-0062 §14), mounted: the pill right of the effort,
// the effort narrowed to the in-effect and ⏱️ values while it is on, a send
// that goes as a btw comment at the moment of the conversation (comment_add,
// with the ⏱️ effort and the attachments; neither user_prompt nor
// request_override), asked now or, with 後で, kept unsent; the box left as a
// send leaves it (cleared, closed, unchecked) once the daemon took it, and
// kept with the reason when it did not. A subagent's input has no btw.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type {
  CommentAddResponse,
  ErrorResponse,
  LaunchEffort,
  PromptDraftAttachment,
  UserComment,
} from "@ccmsg/protocol";
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
  | {
      op: "comment_add";
      body: string;
      btw: boolean;
      effort: LaunchEffort | undefined;
      anchor: string;
      attachments: readonly PromptDraftAttachment[];
      sendNow: boolean;
    }
  | { op: "user_prompt" }
  | { op: "request_override" };

const KEPT: UserComment = {
  kind: "comment",
  author: "user",
  cid: "c0001",
  session_id: SID,
  anchor: { kind: "timing" },
  body: "q",
  written: { at: "2026-11-22T00:00:00.000Z" },
  updated_at: "2026-11-22T00:00:00.000Z",
  btw: true,
  status: "sent",
};

const TAKEN: CommentAddResponse = {
  ok: true,
  comment: KEPT,
  outcome: { kind: "comment", id: "c0001", outcome: "btw_started" },
};

const NOT_STARTED: CommentAddResponse = {
  ok: true,
  comment: { ...KEPT, status: "draft", send_error: "btw_launch_unavailable" },
  outcome: {
    kind: "comment",
    id: "c0001",
    outcome: "not_delivered",
    reason: "btw_launch_unavailable",
  },
};

const REFUSED: ErrorResponse = {
  ok: false,
  error: { code: "session_not_found", msg: "no transcript of session x is found" },
};

/** The composer, opened, for a fable / low session, and the subagent `a1`
 * running when `timelineAgentId` names it. commentAdd answers `reply`. */
async function openWith(
  reply: CommentAddResponse | ErrorResponse = TAKEN,
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
    commentAdd: async (_sid, comment) => {
      calls.push({
        op: "comment_add",
        body: comment.body,
        btw: comment.btw,
        effort: comment.effort,
        anchor: comment.anchor.kind,
        attachments: comment.attachments,
        sendNow: comment.sendNow,
      });
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

function btwPill(root: HTMLElement): HTMLButtonElement {
  return instanceOf(root.querySelector(".session-input-btw"), HTMLButtonElement, "the btw pill");
}

function isOn(root: HTMLElement): boolean {
  return btwPill(root).getAttribute("aria-pressed") === "true";
}

async function check(root: HTMLElement): Promise<void> {
  const box = btwPill(root);
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
  test("the pill stands right of the effort, off", async () => {
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
      effort !== null && effort.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(isOn(root)).toBe(false);
  });

  test("checked, the effort offers the in-effect and ⏱️ values only, and the box says so", async () => {
    const { root } = await openWith();
    await check(root);
    const groups = [...(await effortSelect(root)).querySelectorAll("optgroup")].map((g) =>
      g.getAttribute("label"),
    );
    expect(groups).toEqual(["in effect", "turn"]);
    expect(
      root.querySelector(".session-input-send > span:not(.session-input-send-off)")?.textContent,
    ).toBe("btw");
    expect(root.querySelector(".session-input-textarea")?.getAttribute("placeholder")).toBe(
      "⌘+Enter で送信",
    );
  });

  const asked = (
    body: string,
    patch: Partial<Extract<Call, { op: "comment_add" }>> = {},
  ): Call => ({
    op: "comment_add",
    body,
    btw: true,
    effort: undefined,
    anchor: "timing",
    attachments: [],
    sendNow: true,
    ...patch,
  });

  test("a send goes as a btw comment at the moment, with the ⏱️ effort, nothing else; taken, the box is cleared, closed and unchecked", async () => {
    const { root, calls } = await openWith();
    await check(root);
    await choose(root, "⏱️high");
    await type(root, "この関数は何をしている?");
    await send(root);
    expect(calls).toEqual([asked("この関数は何をしている?", { effort: "high" })]);
    expect(loadDraft(SID)).toBeNull();
    expect(root.querySelector(".session-input-panel")).toBeNull();
    await open(root);
    expect(isOn(root)).toBe(false);
  });

  test("with the in-effect effort, the btw names none (the session's)", async () => {
    const { root, calls } = await openWith();
    await check(root);
    await type(root, "q");
    await send(root);
    expect(calls).toEqual([asked("q")]);
  });

  // btw はすぐ聞くもの (裁定 10): btw と「後で」は 1 つのピルで同時には入らず、
  // 「後で」を入れてから btw を押すと「後で」は切れ、今すぐ聞く。どちらも押せる。
  test("pressing btw after 後で switches 後で off (both stay pressable), and the btw is asked now", async () => {
    const { root, calls } = await openWith();
    const later = instanceOf(
      root.querySelector(".session-input-later"),
      HTMLButtonElement,
      "the 後で pill",
    );
    await act(() => later.click());
    await check(root);
    expect(later.disabled).toBe(false);
    expect(later.getAttribute("aria-pressed")).toBe("false");
    await type(root, "q");
    await send(root);
    expect(calls).toEqual([asked("q")]);
  });

  test("refused, the text and the pill stay, and the reason shows", async () => {
    const { root, calls } = await openWith(REFUSED);
    await check(root);
    await type(root, "q");
    await send(root);
    expect(calls).toEqual([asked("q")]);
    expect(isOn(root)).toBe(true);
    expect(loadDraft(SID)?.text).toBe("q");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("セッション");
  });

  // 保存はされて fork を起こせなかった時は、文を消して (未送信の btw として残る) 理由を出す。
  test("kept and not asked, the text goes (it waits unsent) and the reason shows", async () => {
    const { root, calls } = await openWith(NOT_STARTED);
    await check(root);
    await type(root, "q");
    await send(root);
    expect(calls).toEqual([asked("q")]);
    expect(loadDraft(SID)).toBeNull();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("起動コマンド");
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
