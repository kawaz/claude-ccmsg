// The input box's split button (btw, 後で, 送る) and the FAB's queue (DR-0062
// §15, P13), mounted: 送る is chosen by default and the choice is kept
// nowhere; a side not chosen takes the choice and runs nothing, the chosen
// side runs; 後で pressed twice puts the text in the daemon's queue
// (prompt_queue_add) and sends nothing to the session (no user_prompt); the
// closed FAB shows how many drafts the queue holds; a queued draft opened to
// change (the preview area's 直す) is changed with prompt_queue_update at the
// version it was opened at, and the box's own draft comes back after it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import type { PromptDraftAttachment, PromptDraftRecord } from "@ccmsg/protocol";
import {
  SessionInputComposer,
  type ComposerOpenRequest,
} from "../src/client/components/SessionInputComposer.tsx";
import {
  loadDraft,
  resetSessionInputPageState,
  saveDraft,
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
let storage: MemStorage;

beforeEach(() => {
  resetSessionInputPageState();
  storage = new MemStorage();
  restores = [stubGlobal("localStorage", storage)];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

type Call =
  | { op: "user_prompt"; text: string }
  | { op: "prompt_queue_add"; text: string; attachments: PromptDraftAttachment[] }
  | {
      op: "prompt_queue_update";
      id: string;
      seen: string;
      text: string;
      attachments: PromptDraftAttachment[];
    };

function draft(
  id: string,
  status: PromptDraftRecord["status"],
  text = "下書き",
): PromptDraftRecord {
  return {
    kind: "draft",
    id,
    session_id: SID,
    written: { at: "2026-11-23T00:00:00.000Z" },
    updated_at: `v-${id}`,
    text,
    attachments: [],
    status,
  };
}

/** Asks the mounted composer to open with a queued draft to change, as the
 * preview area's 直す does through SessionView. */
let editDraft: (queued: PromptDraftRecord) => void = () => {};

function Host() {
  const [request, setRequest] = useState<ComposerOpenRequest>({ seq: 0 });
  editDraft = (queued) => setRequest((prev) => ({ seq: prev.seq + 1, draft: queued }));
  return h(SessionInputComposer, { sid: SID, openRequest: request });
}

/** The composer of session SID over a store, its queue holding `drafts`. */
async function mountWith(
  drafts: PromptDraftRecord[] = [],
): Promise<{ root: HTMLElement; calls: Call[]; store: Store }> {
  const store = createStore(initialState());
  store.dispatch({ type: "comments/loaded", sid: SID, comments: [], threads: [], drafts });
  const calls: Call[] = [];
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    userPrompt: async (_sid, text) => {
      calls.push({ op: "user_prompt", text });
      return { ok: true, outcome: "accepted" };
    },
    promptQueueAdd: async (_sid, text, attachments) => {
      calls.push({ op: "prompt_queue_add", text, attachments: [...attachments] });
      return { ok: true, draft: { ...draft("d-new", "queued"), text } };
    },
    promptQueueUpdate: async (_sid, id, seen, text, attachments) => {
      calls.push({ op: "prompt_queue_update", id, seen, text, attachments: [...attachments] });
      return { ok: true, draft: { ...draft(id, "queued"), text } };
    },
  };
  const root = await mounted.mount(store, ws, h(Host, {}));
  return { root, calls, store };
}

function fab(root: HTMLElement): HTMLButtonElement {
  return instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
}

async function openBox(root: HTMLElement): Promise<void> {
  const button = fab(root);
  await act(() => button.click());
}

type SideName = "btw" | "later" | "now";

function side(root: HTMLElement, name: SideName): HTMLButtonElement {
  return instanceOf(
    root.querySelector(`.send-split-${name}`),
    HTMLButtonElement,
    `the ${name} side`,
  );
}

/** The side chosen on the split button. */
function chosen(root: HTMLElement): SideName | null {
  const sides: SideName[] = ["btw", "later", "now"];
  return sides.find((name) => side(root, name).getAttribute("aria-current") === "true") ?? null;
}

function textarea(root: HTMLElement): HTMLTextAreaElement {
  return instanceOf(
    root.querySelector(".session-input-textarea"),
    HTMLTextAreaElement,
    "the textarea",
  );
}

async function type(root: HTMLElement, value: string): Promise<void> {
  const el = textarea(root);
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const drained = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Press the chosen side of the split button: it runs. */
async function send(root: HTMLElement): Promise<void> {
  const button = instanceOf(
    root.querySelector('.send-split > [aria-current="true"]'),
    HTMLButtonElement,
    "the chosen side",
  );
  await act(async () => {
    button.click();
    await drained();
  });
}

describe("the FAB's split button (btw, 後で, 送る)", () => {
  // 並びは左から effort、btw、後で、送る。3 つで 1 つの部品で、既定は送るが選ばれている:
  // 今までの FAB の送信 (すぐ送る) と同じ。区画の字は選択によらず btw・後で・送る。
  test("送る is chosen by default, and the sides stand right of the effort: btw, 後で, 送る", async () => {
    const { root } = await mountWith();
    await openBox(root);
    expect(chosen(root)).toBe("now");
    const split = root.querySelector(".send-split");
    expect(split?.getAttribute("role")).toBe("group");
    expect([...(split?.children ?? [])].map((el) => el.textContent)).toEqual([
      "btw",
      "後で",
      "送る",
    ]);
    const order = [
      root.querySelector('[aria-label="送信の effort"]'),
      side(root, "btw"),
      side(root, "later"),
      side(root, "now"),
    ];
    const follows = (here: Element | null, next: Element | null) =>
      here !== null &&
      next !== null &&
      (here.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(order.slice(1).map((el, i) => follows(order[i] ?? null, el))).toEqual([
      true,
      true,
      true,
    ]);
  });

  // 後でを押すと選択が後でに移るだけで何も送らない。もう一度 (同じ所を) 押すと daemon の
  // キューに置くだけで、セッションには何も送らない (user_prompt を呼ばない)。置けたら送信と
  // 同じく入力欄は空になって閉じる。キューの下書きは effort を持たない (U8) ので、後での
  // 間は effort を選ばせない。
  test("後で pressed twice puts the text in the queue and sends nothing to the session", async () => {
    const { root, calls } = await mountWith();
    await openBox(root);
    await type(root, "  あとで見て  ");
    await act(() => side(root, "later").click());
    expect(chosen(root)).toBe("later");
    expect(calls).toEqual([]);
    expect(
      root
        .querySelector('button.override-value[aria-label="送信の effort"]')
        ?.hasAttribute("disabled"),
    ).toBe(true);
    expect(side(root, "later").getAttribute("aria-label")).toBe("後で 溜める");
    await send(root);
    expect(calls).toEqual([{ op: "prompt_queue_add", text: "あとで見て", attachments: [] }]);
    expect(loadDraft(SID)).toBeNull();
    expect(root.querySelector(".session-input-panel")).toBeNull();
    // Taken, 送る is chosen again, as after a btw's send.
    await openBox(root);
    expect(chosen(root)).toBe("now");
  });

  // 選ばれるのは 1 つだけ (kawaz 2026-11-24): 選ばれていない区画を押すと選択がそこへ移り、
  // 何も実行しない。どの区画も押せる (本文があれば選ばれている区画も)。区画の字は変わらず、
  // 名前は選ばれている時が実行すること、選ばれていない時が切り替えること。
  test("a side not chosen takes the choice and runs nothing; the texts stay and the names say what a press does", async () => {
    const { root, calls } = await mountWith();
    await openBox(root);
    await type(root, "文");
    const state = () => [
      chosen(root),
      [...root.querySelectorAll(".send-split > button")].map((el) => [
        el.textContent,
        el.getAttribute("aria-label"),
        el instanceof HTMLButtonElement && el.disabled,
      ]),
    ];
    expect(state()).toEqual([
      "now",
      [
        ["btw", "btw に切り替える", false],
        ["後で", "後で に切り替える", false],
        ["送る", "送る", false],
      ],
    ]);
    await act(() => side(root, "btw").click());
    expect(state()).toEqual([
      "btw",
      [
        ["btw", "btw で聞く", false],
        ["後で", "後で に切り替える", false],
        ["送る", "送る に切り替える", false],
      ],
    ]);
    await act(() => side(root, "later").click());
    expect(chosen(root)).toBe("later");
    await act(() => side(root, "btw").click());
    expect(chosen(root)).toBe("btw");
    await act(() => side(root, "now").click());
    expect(chosen(root)).toBe("now");
    expect(calls).toEqual([]);
    expect(textarea(root).value).toBe("文");
  });

  // 後でを選んでから送るを選び直せば、後でに戻らず通常の送る。
  test("後で chosen and then 送る sends the prompt now", async () => {
    const { root, calls } = await mountWith();
    await openBox(root);
    await type(root, "q");
    await act(() => side(root, "later").click());
    await act(() => side(root, "now").click());
    await send(root);
    expect(calls).toEqual([{ op: "user_prompt", text: "q" }]);
  });

  // 入力欄の placeholder はどの選択でも同じ文。
  test("the placeholder is one text whichever side is chosen", async () => {
    const { root } = await mountWith();
    await openBox(root);
    const placeholder = () =>
      root.querySelector(".session-input-textarea")?.getAttribute("placeholder");
    const seen = [placeholder()];
    await act(() => side(root, "btw").click());
    seen.push(placeholder());
    await act(() => side(root, "later").click());
    seen.push(placeholder());
    expect(seen).toEqual(["⌘+Enter で送信", "⌘+Enter で送信", "⌘+Enter で送信"]);
  });

  // ⌘Enter は選ばれている区画を実行する (押すのと同じ)。
  test("⌘Enter runs the chosen side", async () => {
    const { root, calls } = await mountWith();
    await openBox(root);
    await type(root, "あとで");
    await act(() => side(root, "later").click());
    await act(async () => {
      textarea(root).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
      await drained();
    });
    expect(calls).toEqual([{ op: "prompt_queue_add", text: "あとで", attachments: [] }]);
  });

  // 実行できない時 (本文が空) は、選ばれている区画は押せず何も送らない。選ばれていない区画への
  // 切り替えはできる。
  test("with nothing to send, the chosen side cannot run, and the choice can still move", async () => {
    const { root, calls } = await mountWith();
    await openBox(root);
    expect(side(root, "now").disabled).toBe(true);
    await act(() => side(root, "now").click());
    expect(calls).toEqual([]);
    expect(side(root, "later").disabled).toBe(false);
    await act(() => side(root, "later").click());
    expect(chosen(root)).toBe("later");
    expect(side(root, "later").disabled).toBe(true);
    expect(side(root, "now").disabled).toBe(false);
    await act(() => side(root, "later").click());
    expect(calls).toEqual([]);
    await act(() => side(root, "now").click());
    expect(chosen(root)).toBe("now");
  });

  // 本文の欄に居る時に区画を押しても、フォーカスとキャレットは本文の欄に残る (compose-focus.ts)。
  test("a press on a side leaves the textarea's focus and caret where they were", async () => {
    const { root } = await mountWith();
    await openBox(root);
    await type(root, "あいうえお");
    const el = textarea(root);
    el.focus();
    el.setSelectionRange(2, 2);
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    side(root, "later").dispatchEvent(down);
    await act(() => side(root, "later").click());
    expect(down.defaultPrevented).toBe(true);
    expect(chosen(root)).toBe("later");
    expect(document.activeElement).toBe(el);
    expect([el.selectionStart, el.selectionEnd]).toEqual([2, 2]);
  });

  // 選択は覚えない: 後でを選んだまま開き直しても (マウントし直しても) 送るが選ばれている。
  test("the choice is not kept: a remounted box starts with 送る chosen", async () => {
    const first = await mountWith();
    await openBox(first.root);
    await act(() => side(first.root, "later").click());
    expect(chosen(first.root)).toBe("later");
    expect(storage.getItem(`ccmsg.fab.later.${SID}`)).toBeNull();
    await mounted.unmount();
    const again = await mountWith();
    await openBox(again.root);
    expect(chosen(again.root)).toBe("now");
  });
});

describe("the FAB's count of queued drafts", () => {
  // FAB 自身にキューの下書き (まだ送っていない・届いたか分からない) の数を出す (§15)。
  // 送った (sent) ものは数えない (届くと記録ごと消える途中)。0 は出さない。
  test("the closed FAB shows the drafts not sent, and none at 0", async () => {
    const { root, store } = await mountWith([
      draft("d1", "queued"),
      draft("d2", "unconfirmed"),
      draft("d3", "sent"),
    ]);
    expect(fab(root).querySelector(".session-input-fab-count")?.textContent).toBe("2");
    expect(fab(root).title).toContain("2 件");
    await act(() =>
      store.dispatch({ type: "comments/loaded", sid: SID, comments: [], threads: [], drafts: [] }),
    );
    expect(fab(root).querySelector(".session-input-fab-count")).toBeNull();
  });
});

describe("changing a queued draft in the box", () => {
  // プレビューのエリアの「直す」は、下書きをこの入力欄に読み込む。書きかけの文は脇に置き、
  // 直し終えると戻す。直すのは開いた時の版で (seen_updated_at)、添付はそのまま渡す。
  test("the draft is changed at the version opened, and the box's own draft comes back", async () => {
    saveDraft(SID, "書きかけ", []);
    const queued: PromptDraftRecord = {
      ...draft("d1", "queued", "[FILE3] を見て"),
      attachments: [{ n: 3, name: "a.png", path: "/state/sessions/s.att-x.png" }],
    };
    const { root, calls } = await mountWith([queued]);
    await act(() => editDraft(queued));
    expect(root.querySelector(".session-input-editing")?.textContent).toContain("直しています");
    expect(textarea(root).value).toBe("[FILE3] を見て");
    // Neither 後で nor btw nor the effort: a draft has none of them. 送る
    // stands alone, as 直す.
    expect(root.querySelector(".send-split-later")).toBeNull();
    expect(root.querySelector(".send-split-btw")).toBeNull();
    expect(side(root, "now").textContent).toBe("直す");
    await type(root, "[FILE3] を見て直した");
    // The change is not the box's own draft.
    expect(loadDraft(SID)?.text).toBe("書きかけ");
    await send(root);
    expect(calls).toEqual([
      {
        op: "prompt_queue_update",
        id: "d1",
        seen: "v-d1",
        text: "[FILE3] を見て直した",
        attachments: [{ n: 3, name: "a.png", path: "/state/sessions/s.att-x.png" }],
      },
    ]);
    await openBox(root);
    expect(textarea(root).value).toBe("書きかけ");
    expect(root.querySelector(".session-input-editing")).toBeNull();
  });

  // 「閉じる」は何も送らず、書きかけの文が戻る。
  test("閉じる sends nothing and gives the box's own draft back", async () => {
    saveDraft(SID, "書きかけ", []);
    const queued = draft("d1", "queued", "直す前");
    const { root, calls } = await mountWith([queued]);
    await act(() => editDraft(queued));
    const cancel = instanceOf(
      root.querySelector(".session-input-editing-cancel"),
      HTMLButtonElement,
      "閉じる",
    );
    expect(cancel.textContent).toBe("閉じる");
    await act(() => cancel.click());
    expect(calls).toEqual([]);
    expect(textarea(root).value).toBe("書きかけ");
  });
});
