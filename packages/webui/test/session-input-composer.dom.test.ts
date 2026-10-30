// SessionInputComposer をマウントして、下書きと入力欄の配線を DOM で固定する
// (DR-0035 §5)。判定そのもの (otherTabDraft / storedDraftChange) は
// session-input-store.test.ts。ここでは:
// - 入力が下書きとして保存され、開き直すと入力欄に戻る
// - 別タブが下書きを書き換えた storage event は、このタブで編集していない
//   (空か、書き換え前の下書きのまま) 入力欄にだけ映す
// - このタブで書き換えた入力欄は、別タブの書き込みで巻き戻さない
// 別タブの書き込みは、同じ localStorage に saveDraft で書いてから、その書き込み
// が他のタブに出す storage event (key / oldValue / newValue) を window に送る。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { SessionInputComposer } from "../src/client/components/SessionInputComposer.tsx";
import {
  draftKey,
  loadDraft,
  resetSessionInputPageState,
  saveDraft,
} from "../src/client/components/session-input-store.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import type {
  RequestOverride,
  RequestOverrideDelivery,
  RequestOverridePatch,
  RequestOverrideState,
} from "@ccmsg/protocol";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { instanceOf, MemStorage, stubGlobal, stubProperty } from "./helpers.ts";
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

/** 入力欄を開いた SessionInputComposer。 */
async function openComposer(): Promise<HTMLElement> {
  const store = createStore(initialState());
  const ws = createWsClient((action) => store.dispatch(action));
  const root = await mounted.mount(store, ws, h(SessionInputComposer, { sid: SID }));
  const fab = instanceOf(
    root.querySelector(".session-input-fab"),
    HTMLButtonElement,
    "the input FAB",
  );
  await act(() => fab.click());
  return root;
}

function textarea(root: HTMLElement): HTMLTextAreaElement {
  return instanceOf(
    root.querySelector(".session-input-textarea"),
    HTMLTextAreaElement,
    "the input textarea",
  );
}

async function type(root: HTMLElement, value: string): Promise<void> {
  const el = textarea(root);
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 別タブが下書きを `text` に書き換え、このタブに storage event が届く。
 * `oldValue` は書き換える前にそのタブが見ていた本文のキーの値。 */
async function otherTabWrites(text: string, oldValue: string | null): Promise<void> {
  saveDraft(SID, text);
  const newValue = localStorage.getItem(draftKey(SID));
  await act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: draftKey(SID), oldValue, newValue }));
  });
}

describe("SessionInputComposer draft", () => {
  test("what is typed is saved as the draft and comes back when the input is opened again", async () => {
    const root = await openComposer();
    await type(root, "書きかけの文");
    expect(loadDraft(SID)?.text).toBe("書きかけの文");

    await mounted.unmount();
    const again = await openComposer();
    expect(textarea(again).value).toBe("書きかけの文");
  });

  test("another tab's draft shows in an input this tab has not edited", async () => {
    saveDraft(SID, "前からの下書き");
    const before = localStorage.getItem(draftKey(SID));
    const root = await openComposer();
    expect(textarea(root).value).toBe("前からの下書き");

    await otherTabWrites("別タブで書いた文", before);
    expect(textarea(root).value).toBe("別タブで書いた文");
  });

  test("another tab's draft shows in an empty input", async () => {
    const root = await openComposer();
    await otherTabWrites("別タブで書いた文", null);
    expect(textarea(root).value).toBe("別タブで書いた文");
  });

  test("an input this tab has edited is not rolled back by another tab's write", async () => {
    saveDraft(SID, "前からの下書き");
    const before = localStorage.getItem(draftKey(SID));
    const root = await openComposer();
    await type(root, "このタブで直した文");

    // 別タブは「前からの下書き」を見ていて、それを書き換えた。
    await otherTabWrites("別タブで書いた文", before);
    expect(textarea(root).value).toBe("このタブで直した文");
  });
});

// DR-0041 §6.3: the effort of one send. The select's groups are default /
// turn (⏱️, carried by the user_prompt) / session (📌 and 🏛️, a
// request_override sent ahead of the user_prompt); choosing sends nothing,
// the send applies it.
describe("SessionInputComposer effort", () => {
  /** What the composer asked the ws, in order. */
  type Call =
    | { op: "request_override"; patch: RequestOverridePatch }
    | { op: "user_prompt"; text: string; override?: RequestOverride };
  /** The composer, opened, over a ws that records what it is asked: its
   * userPrompt answers `outcome`, its requestOverride answers when the test
   * says (`answerOverride`). The session runs on fable / low; `overrides`
   * is what ev:"request_override" says of it. */
  async function openWith(
    outcome: "accepted" | "unconfirmed",
    overrides?: RequestOverrideState,
    delivery: RequestOverrideDelivery = "applied",
  ): Promise<{ root: HTMLElement; calls: Call[]; answerOverride: () => Promise<void> }> {
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
      },
    });
    if (overrides !== undefined) {
      store.dispatch({
        type: "request-overrides/loaded",
        sessions: [{ session_id: SID, ...overrides }],
      });
    }
    const calls: Call[] = [];
    const waiting: (() => void)[] = [];
    const ws: WsHandle = {
      ...createWsClient((action) => store.dispatch(action)),
      requestOverride: (_sid, patch) => {
        calls.push({ op: "request_override", patch });
        return new Promise((resolve) => {
          waiting.push(() => resolve({ ok: true, delivery }));
        });
      },
      userPrompt: async (_sid, text, override) => {
        calls.push({ op: "user_prompt", text, ...(override !== undefined ? { override } : {}) });
        return { ok: true, outcome };
      },
    };
    const root = await mounted.mount(store, ws, h(SessionInputComposer, { sid: SID }));
    const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
    await act(() => fab.click());
    const answerOverride = async () => {
      await act(async () => {
        for (const answer of waiting.splice(0)) answer();
        await drained();
      });
    };
    return { root, calls, answerOverride };
  }
  /** The effort at rest: the text that opens its select. */
  function text(root: HTMLElement): HTMLButtonElement {
    return instanceOf(
      root.querySelector('button.override-value[aria-label="送信の effort"]'),
      HTMLButtonElement,
      "the effort at rest",
    );
  }
  /** Press the effort's text: its select is drawn in its place. */
  async function select(root: HTMLElement): Promise<HTMLSelectElement> {
    const at = text(root);
    await act(() => at.click());
    return instanceOf(
      root.querySelector('select[aria-label="送信の effort"]'),
      HTMLSelectElement,
      "the effort select",
    );
  }
  /** What the effort shows at rest: the chosen option's label. */
  const collapsed = (root: HTMLElement) => text(root).textContent ?? "";
  async function choose(root: HTMLElement, label: string): Promise<void> {
    const el = await select(root);
    const option = [...el.options].find((o) => o.textContent === label);
    if (option === undefined) throw new Error(`no option ${label}`);
    await act(() => {
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  /** Every promise the send chained (the replies, the composer's own
   * continuations) has settled: a task runs only once the microtasks before
   * it have. */
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

  test("the effort alone, in the default, turn and session groups (§6.2's example)", async () => {
    const { root } = await openWith("accepted");
    // At rest the text, no select; pressed, the one select of the effort.
    expect(root.querySelectorAll(".session-input-panel select")).toHaveLength(0);
    expect(collapsed(root)).toBe("low");
    const el = await select(root);
    expect(root.querySelectorAll(".session-input-panel select")).toHaveLength(1);
    // Open, it stays in the send's row, left of the send.
    expect(el.parentElement?.classList.contains("session-input-actions")).toBe(true);
    expect(el.nextElementSibling?.classList.contains("session-input-send")).toBe(true);
    expect(document.activeElement).toBe(el);
    expect(
      [...el.querySelectorAll("optgroup")].map((group) => [
        group.label,
        [...group.querySelectorAll("option")].map((option) => option.textContent),
      ]),
    ).toEqual([
      ["default", ["low"]],
      ["turn", ["⏱️low", "⏱️medium", "⏱️high", "⏱️xhigh", "⏱️max"]],
      ["session", ["🏛️low", "📌medium", "📌high", "📌xhigh", "📌max"]],
    ]);
    // Escape: back to the text, which takes the focus.
    await act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).toBe(text(root));
    // Chosen and not sent yet: the text shows what was chosen.
    await choose(root, "📌high");
    expect(root.querySelectorAll(".session-input-panel select")).toHaveLength(0);
    expect(collapsed(root)).toBe("📌high");
  });

  // §6.3: the effort takes no row of its own. At rest it is the send's left
  // neighbour in the row of the attach button and the send.
  test("at rest, the effort is the send's left neighbour in the send's row", async () => {
    const { root } = await openWith("accepted");
    const effort = text(root);
    const row = instanceOf(effort.parentElement, HTMLElement, "the effort's row");
    expect(row.classList.contains("session-input-actions")).toBe(true);
    expect(effort.nextElementSibling?.classList.contains("session-input-send")).toBe(true);
    expect(row.querySelector(".composer-attach-btn")).not.toBeNull();
  });

  test("the default shows the layer in force and its value", async () => {
    const { root } = await openWith("accepted", {
      session: { model: "fable", effort: "xhigh" },
      once: { model: null, effort: "high" },
    });
    expect(collapsed(root)).toBe("⏱️high");
  });

  test("⏱️ goes with the user_prompt, and the select goes back to the default once accepted", async () => {
    const { root, calls } = await openWith("accepted");
    await type(root, "軽く答えて");
    await choose(root, "⏱️high");
    await send(root);
    expect(calls).toEqual([
      { op: "user_prompt", text: "軽く答えて", override: { effort: "high" } },
    ]);
    const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
    await act(() => fab.click());
    expect(collapsed(root)).toBe("low");
  });

  test("📌 sends the request_override first, and the user_prompt once it is answered", async () => {
    const { root, calls, answerOverride } = await openWith("accepted");
    await type(root, "x");
    await choose(root, "📌high");
    await send(root);
    expect(calls).toEqual([{ op: "request_override", patch: { effort: "high" } }]);
    await answerOverride();
    expect(calls).toEqual([
      { op: "request_override", patch: { effort: "high" } },
      { op: "user_prompt", text: "x", override: {} },
    ]);
  });

  // §6.5: 🏛️ clears the effort's session and one-shot overrides.
  test("🏛️ sends the effort as null ahead of the user_prompt", async () => {
    const { root, calls, answerOverride } = await openWith("accepted", {
      session: { model: "fable", effort: "max" },
      once: { model: null, effort: null },
    });
    expect(collapsed(root)).toBe("📌max");
    await type(root, "x");
    await choose(root, "🏛️low");
    await send(root);
    await answerOverride();
    expect(calls).toEqual([
      { op: "request_override", patch: { effort: null } },
      { op: "user_prompt", text: "x", override: {} },
    ]);
  });

  // The session override stays apart from the prompt: one no module took is
  // said in the FAB, and the prompt goes all the same.
  test("a request_override no module took is said, and the user_prompt still goes", async () => {
    const { root, calls, answerOverride } = await openWith("unconfirmed", undefined, "no_module");
    expect(root.querySelector(".session-input-override-notice")).toBeNull();
    await type(root, "x");
    await choose(root, "📌high");
    await send(root);
    await answerOverride();
    expect(calls.map((call) => call.op)).toEqual(["request_override", "user_prompt"]);
    expect(root.querySelector(".session-input-override-notice")?.textContent).toContain(
      "受け口 (hooks module) が無い",
    );
    expect(collapsed(root)).toBe("📌high");
  });

  test("kept with the text when the send is not confirmed", async () => {
    const { root, calls } = await openWith("unconfirmed");
    await type(root, "x");
    await choose(root, "⏱️max");
    await send(root);
    expect(calls).toEqual([{ op: "user_prompt", text: "x", override: { effort: "max" } }]);
    expect(collapsed(root)).toBe("⏱️max");
  });
});

// The textarea's top-left grip: dragging it moves the top edge, the bottom
// edge staying (the browser's own resize stays at the bottom-right). happy-dom
// lays nothing out, so the boxes are stubbed: the textarea's bottom at 500 and
// its CSS min-height 112, the panel's top at 300 (room for 300 more).
describe("SessionInputComposer textarea top grip", () => {
  const BOTTOM = 500;
  const MIN = 112;

  async function openWithBoxes() {
    const root = await openComposer();
    const el = textarea(root);
    const panel = instanceOf(root.querySelector(".session-input-panel"), HTMLElement, "the panel");
    const height = () => Math.max(MIN, Number.parseFloat(el.style.height) || MIN);
    restores.push(
      stubProperty(el, "getBoundingClientRect", {
        value: () => new DOMRect(0, BOTTOM - height(), 300, height()),
      }),
      stubProperty(panel, "getBoundingClientRect", {
        value: () => new DOMRect(0, 300, 360, 400),
      }),
    );
    const grip = instanceOf(
      root.querySelector(".session-input-textarea-ring > .session-input-resize-top"),
      HTMLElement,
      "the top grip",
    );
    return { root, el, panel, grip };
  }

  async function drag(target: HTMLElement, from: number, ...to: number[]): Promise<void> {
    await act(() => {
      target.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientY: from }),
      );
    });
    for (const y of to) {
      await act(() => {
        target.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: y }),
        );
      });
    }
    await act(() => {
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });
  }

  test("the grip sits on the textarea's corner, apart from the layout", async () => {
    const { root, grip } = await openWithBoxes();
    // Inside the textarea's ring, after the textarea: no row of its own.
    expect(grip.previousElementSibling).toBe(textarea(root));
    expect(grip.getAttribute("role")).toBe("separator");
  });

  test("dragging it up makes the textarea taller by as much, down shorter", async () => {
    const { el, panel, grip } = await openWithBoxes();
    // Grabbed 5px below the top edge, the top edge follows 5px above the
    // pointer.
    await drag(grip, BOTTOM - MIN + 5, BOTTOM - MIN - 45);
    expect(el.style.height).toBe(`${MIN + 50}px`);
    await drag(grip, BOTTOM - MIN - 50 + 5, BOTTOM - MIN - 20 + 5);
    expect(el.style.height).toBe(`${MIN + 20}px`);
    // Past the bottom edge: 0, which the min-height raises.
    await drag(grip, BOTTOM - MIN - 20, BOTTOM + 100);
    expect(el.style.height).toBe("0px");
    // The panel's own drag did not start: it stays where the CSS puts it.
    expect(panel.style.top).toBe("");
  });

  test("it grows no further than the panel's top can go and stay in view", async () => {
    const { el, grip } = await openWithBoxes();
    await drag(grip, BOTTOM - MIN, -1000);
    expect(el.style.height).toBe(`${MIN + 300}px`);
  });

  test("a panel moved by hand (placed by its top) moves up as the textarea grows", async () => {
    const { root, el, panel, grip } = await openWithBoxes();
    const header = instanceOf(
      root.querySelector(".session-input-panel-header"),
      HTMLElement,
      "the panel header",
    );
    await drag(header, 310, 290);
    // The click a browser fires after the pointerup, which the drag swallows
    // (left waiting, it would swallow the next test's click).
    await act(() => header.click());
    expect(panel.style.top).toBe("280px");
    await drag(grip, BOTTOM - MIN, BOTTOM - MIN - 50);
    expect(el.style.height).toBe(`${MIN + 50}px`);
    expect(panel.style.top).toBe("230px");
  });
});

// DR-0040 §7: 許可する on a permit bubble opens this composer through
// SessionView's count (OpenComposerContext). Each new count opens it as the FAB
// does, focus included; a re-render with the same count does not.
describe("SessionInputComposer opened from outside", () => {
  test("a new open request opens the panel with the textarea focused, once per request", async () => {
    const store = createStore(initialState());
    const ws = createWsClient((action) => store.dispatch(action));
    let ask = (): void => {};
    function Host() {
      const [requests, setRequests] = useState(0);
      ask = () => setRequests((n) => n + 1);
      return h(SessionInputComposer, { sid: SID, openRequest: requests });
    }
    const root = await mounted.mount(store, ws, h(Host, null));
    expect(root.querySelector(".session-input-fab")).not.toBeNull();
    expect(root.querySelector(".session-input-textarea")).toBeNull();

    await act(() => ask());
    expect(document.activeElement).toBe(textarea(root));
    expect(root.querySelector(".session-input-fab")).toBeNull();

    // Closed by the person, it stays closed until the next request.
    const close = instanceOf(
      root.querySelector(".composer-panel-close"),
      HTMLButtonElement,
      "the close button",
    );
    await act(() => close.click());
    expect(root.querySelector(".session-input-textarea")).toBeNull();
    await act(() => store.dispatch({ type: "agents/loaded", agents: [] }));
    expect(root.querySelector(".session-input-textarea")).toBeNull();
    await act(() => ask());
    expect(document.activeElement).toBe(textarea(root));
  });
});
