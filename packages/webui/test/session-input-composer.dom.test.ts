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
import type { RequestOverride } from "@ccmsg/protocol";
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

// DR-0041 §4: the one-shot override of one send, carried by the user_prompt.
describe("SessionInputComposer one-shot override", () => {
  /** The composer, opened, over a ws whose userPrompt answers `outcome` and
   * records what it was asked. */
  async function openWith(
    outcome: "accepted" | "unconfirmed",
  ): Promise<{ root: HTMLElement; sent: { text: string; override?: RequestOverride }[] }> {
    const store = createStore(initialState());
    const sent: { text: string; override?: RequestOverride }[] = [];
    const ws: WsHandle = {
      ...createWsClient((action) => store.dispatch(action)),
      userPrompt: async (_sid, text, override) => {
        sent.push({ text, ...(override !== undefined ? { override } : {}) });
        return { ok: true, outcome };
      },
    };
    const root = await mounted.mount(store, ws, h(SessionInputComposer, { sid: SID }));
    const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
    await act(() => fab.click());
    return { root, sent };
  }
  function select(root: HTMLElement, field: "model" | "effort"): HTMLSelectElement {
    return instanceOf(
      root.querySelector(`select[aria-label="この送信だけの上書き: ${field}"]`),
      HTMLSelectElement,
      `the one-shot ${field}`,
    );
  }
  async function pick(root: HTMLElement, field: "model" | "effort", value: string): Promise<void> {
    const el = select(root, field);
    await act(() => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  async function send(root: HTMLElement): Promise<void> {
    const button = instanceOf(
      root.querySelector(".session-input-send"),
      HTMLButtonElement,
      "the send button",
    );
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }

  // The effort is at hand; the model is a step further in.
  test("the effort first; the model behind a disclosure that names it once picked", async () => {
    const { root } = await openWith("accepted");
    const fields = instanceOf(root.querySelector(".override-fields"), HTMLElement, "the fields");
    expect(fields.firstElementChild).toBe(select(root, "effort"));
    const model = instanceOf(root.querySelector(".override-model"), HTMLDetailsElement, "model");
    expect(model.open).toBe(false);
    expect(model.contains(select(root, "model"))).toBe(true);
    await pick(root, "model", "haiku");
    expect(model.querySelector("summary")?.textContent).toBe("model: haiku");
  });

  test("none by default; what is picked goes with the send, and goes back to none once accepted", async () => {
    const { root, sent } = await openWith("accepted");
    expect(select(root, "model").value).toBe("");
    expect(select(root, "effort").value).toBe("");
    await type(root, "軽く答えて");
    await pick(root, "effort", "low");
    await pick(root, "model", "haiku");
    await send(root);
    expect(sent).toEqual([{ text: "軽く答えて", override: { model: "haiku", effort: "low" } }]);
    const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
    await act(() => fab.click());
    expect(select(root, "model").value).toBe("");
    expect(select(root, "effort").value).toBe("");
  });

  test("kept with the text when the send is not confirmed", async () => {
    const { root, sent } = await openWith("unconfirmed");
    await type(root, "x");
    await pick(root, "effort", "max");
    await send(root);
    expect(sent).toEqual([{ text: "x", override: { effort: "max" } }]);
    expect(select(root, "effort").value).toBe("max");
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
