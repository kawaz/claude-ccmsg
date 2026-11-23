// The input box's 「今すぐ送る」 and the FAB's queue (DR-0062 §15, P13), mounted:
// the check is on by default and kept per session under a key of its own (not
// the comment form's); a send with it off puts the text in the daemon's queue
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

function sendNowBox(root: HTMLElement): HTMLInputElement {
  return instanceOf(
    root.querySelector(".session-input-send-now input"),
    HTMLInputElement,
    "the 今すぐ送る check",
  );
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

describe("the FAB's 今すぐ送る", () => {
  // 既定は付いている: 今までの FAB の送信 (すぐ送る) と同じ。並びは btw の左。
  test("is on by default, left of btw", async () => {
    const { root } = await mountWith();
    await openBox(root);
    expect(sendNowBox(root).checked).toBe(true);
    const btw = root.querySelector(".session-input-btw");
    const label = root.querySelector(".session-input-send-now");
    expect(
      label !== null &&
        btw !== null &&
        label.compareDocumentPosition(btw) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // 外して送ると daemon のキューに置くだけで、セッションには何も送らない (user_prompt を
  // 呼ばない)。置けたら送信と同じく入力欄は空になって閉じる。キューの下書きは effort を
  // 持たない (U8) ので、外している間は effort を選ばせない。
  test("off, a send puts the text in the queue and sends nothing to the session", async () => {
    const { root, calls } = await mountWith();
    await openBox(root);
    await act(() => sendNowBox(root).click());
    expect(
      root
        .querySelector('button.override-value[aria-label="送信の effort"]')
        ?.hasAttribute("disabled"),
    ).toBe(true);
    await type(root, "  あとで見て  ");
    expect(root.querySelector(".session-input-send")?.textContent).toContain("後で送る");
    await send(root);
    expect(calls).toEqual([{ op: "prompt_queue_add", text: "あとで見て", attachments: [] }]);
    expect(loadDraft(SID)).toBeNull();
    expect(root.querySelector(".session-input-panel")).toBeNull();
  });

  // チェックの状態はセッションごとに localStorage に覚え、コメントのフォームの「今すぐ送る」
  // とは別のキー (P13)。開き直しても外したまま。
  test("its state is kept per session under a key of its own", async () => {
    const first = await mountWith();
    await openBox(first.root);
    await act(() => sendNowBox(first.root).click());
    expect(storage.getItem(`ccmsg.fab.sendNow.${SID}`)).toBe("0");
    expect(storage.getItem(`ccmsg.comments.sendNow.${SID}`)).toBeNull();
    await mounted.unmount();
    const again = await mountWith();
    await openBox(again.root);
    expect(sendNowBox(again.root).checked).toBe(false);
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
    // Neither 今すぐ送る nor btw nor the effort: a draft has none of them.
    expect(root.querySelector(".session-input-send-now")).toBeNull();
    expect(root.querySelector(".session-input-btw")).toBeNull();
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

  // やめると何も送らず、書きかけの文が戻る。
  test("giving up sends nothing and gives the box's own draft back", async () => {
    saveDraft(SID, "書きかけ", []);
    const queued = draft("d1", "queued", "直す前");
    const { root, calls } = await mountWith([queued]);
    await act(() => editDraft(queued));
    const cancel = instanceOf(
      root.querySelector(".session-input-editing-cancel"),
      HTMLButtonElement,
      "やめる",
    );
    await act(() => cancel.click());
    expect(calls).toEqual([]);
    expect(textarea(root).value).toBe("書きかけ");
  });
});
