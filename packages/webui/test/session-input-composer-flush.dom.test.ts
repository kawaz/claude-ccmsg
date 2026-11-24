// The FAB's plain send takes the FAB's queued drafts and the unsent comments
// along (DR-0062 §11, §15, kawaz 2026-11-23, 2026-11-24), mounted.
//
// A person who put prompts aside with 「後で」 and then sends one now wants the
// session to get them all, in the order written: sending only the newest is not
// what a plain send does (to send one draft alone, the 💬 filter has a send per
// draft). So, with neither btw nor 後で on and no queued draft being changed:
//
// - the open panel's send button carries the same count the closed FAB shows
//   (the drafts not sent: queued, sending, unconfirmed), so the person sees
//   before pressing that more than the text goes;
// - pressing it first sends the queued drafts, oldest first, one prompt each
//   (queue_send, the daemon puts them in the session's line of sends one by
//   one), and only once that send has answered, the text (user_prompt). The
//   text waits for the answer because the daemon's queue_send reaches the
//   line of sends only after reading and writing the drafts' records, while a
//   user_prompt goes to the line at once: sent side by side, the text could go
//   in before the drafts;
// - a draft not put in (not_delivered) stops the rest, the daemon's P7, and the
//   text is not sent either, kept in the box with why, as a failed send of the
//   text says it: sending it then would put it in before the drafts it follows.
//
// With btw (a question asked now, beside the conversation) or 後で (the text
// goes in the queue itself) on, the send is that alone: no count, no drafts sent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import type {
  ErrorResponse,
  PromptDraftRecord,
  QueueSendItem,
  QueueSendResponse,
  UserComment,
} from "@ccmsg/protocol";
import {
  SessionInputComposer,
  type ComposerOpenRequest,
} from "../src/client/components/SessionInputComposer.tsx";
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
  | { op: "queue_send"; ids: string[] }
  | { op: "user_prompt"; text: string }
  | { op: "prompt_queue_add"; text: string }
  | { op: "comment_add"; body: string };

function draft(
  id: string,
  writtenAt: string,
  status: PromptDraftRecord["status"] = "queued",
): PromptDraftRecord {
  return {
    kind: "draft",
    id,
    session_id: SID,
    written: { at: writtenAt },
    updated_at: `v-${id}`,
    text: `下書き ${id}`,
    attachments: [],
    status,
  };
}

/** Two queued drafts, the newer one first in the store (the order they came
 * in), so the send's order shows it is by when they were written. */
const TWO_QUEUED = [
  draft("d-new", "2026-11-23T00:02:00.000Z"),
  draft("d-old", "2026-11-23T00:01:00.000Z"),
];

/** A comment kept unsent (後で) at `writtenAt`. */
function unsent(cid: string, writtenAt: string, btw = false): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid,
    session_id: SID,
    anchor: { kind: "timing" },
    body: `コメント ${cid}`,
    btw,
    written: { at: writtenAt },
    updated_at: `v-${cid}`,
    status: "draft",
  };
}

/** What queue_send answers: every draft put in. */
const allSent = (items: readonly QueueSendItem[]): QueueSendResponse => ({
  ok: true,
  results: items.map((item) => ({
    kind: "draft" as const,
    id: item.kind === "draft" ? item.id : "",
    outcome: "sent" as const,
  })),
});

/** Asks the mounted composer to open with a queued draft to change, as the
 * 💬 filter's 直す does through SessionView. */
let editDraft: (queued: PromptDraftRecord) => void = () => {};

function Host() {
  const [request, setRequest] = useState<ComposerOpenRequest>({ seq: 0 });
  editDraft = (queued) => setRequest((prev) => ({ seq: prev.seq + 1, draft: queued }));
  return h(SessionInputComposer, { sid: SID, openRequest: request });
}

/** The composer of session SID, opened, its queue holding `drafts`;
 * queue_send answers what `answer` makes of the items. */
async function openWith(
  drafts: PromptDraftRecord[],
  answer: (
    items: readonly QueueSendItem[],
  ) => Promise<QueueSendResponse | ErrorResponse> | QueueSendResponse | ErrorResponse = allSent,
  comments: UserComment[] = [],
): Promise<{ root: HTMLElement; calls: Call[] }> {
  const store = createStore(initialState());
  store.dispatch({ type: "comments/loaded", sid: SID, comments, threads: [], drafts });
  const calls: Call[] = [];
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    queueSend: async (_sid, items) => {
      calls.push({
        op: "queue_send",
        ids: items.map((item) => (item.kind === "draft" ? item.id : item.cid)),
      });
      return answer(items);
    },
    userPrompt: async (_sid, text) => {
      calls.push({ op: "user_prompt", text });
      return { ok: true, outcome: "accepted" };
    },
    promptQueueAdd: async (_sid, text) => {
      calls.push({ op: "prompt_queue_add", text });
      return { ok: true, draft: { ...draft("d-added", "2026-11-23T00:03:00.000Z"), text } };
    },
    commentAdd: async (_sid, comment) => {
      calls.push({ op: "comment_add", body: comment.body });
      return {
        ok: true,
        comment: {
          kind: "comment",
          cid: "c1",
          session_id: SID,
          author: "user",
          anchor: { kind: "timing" },
          body: comment.body,
          btw: true,
          written: { at: "2026-11-23T00:03:00.000Z" },
          updated_at: "v-c1",
          status: "sent",
          attachments: [],
        },
      };
    },
  };
  const root = await mounted.mount(store, ws, h(Host, {}));
  const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
  await act(() => fab.click());
  return { root, calls };
}

function sendButton(root: HTMLElement): HTMLButtonElement {
  return instanceOf(
    root.querySelector(".session-input-send"),
    HTMLButtonElement,
    "the send button",
  );
}

/** The count over the send button, null when none is shown. */
function sendCount(root: HTMLElement): string | null {
  return sendButton(root).querySelector(".session-input-send-count")?.textContent ?? null;
}

function pill(root: HTMLElement, name: "later" | "btw"): HTMLButtonElement {
  return instanceOf(
    root.querySelector(`.session-input-${name}`),
    HTMLButtonElement,
    `the ${name} pill`,
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

async function press(root: HTMLElement): Promise<void> {
  const button = sendButton(root);
  await act(async () => {
    button.click();
    await drained();
  });
}

describe("the send button's count of queued drafts", () => {
  // 通常の送るでは、閉じた FAB と同じ数 (送っていない・届いたか分からない下書き。
  // 送った sent は数えない) を送信のボタンに重ねる。押す前に、今の文の他にも送る
  // ものがあると分かるように。
  test("a plain send shows the closed FAB's count", async () => {
    const { root } = await openWith([
      ...TWO_QUEUED,
      draft("d-unconfirmed", "2026-11-23T00:00:30.000Z", "unconfirmed"),
      draft("d-sent", "2026-11-23T00:00:10.000Z", "sent"),
    ]);
    expect(sendCount(root)).toBe("3");
    // The title says how many go ahead of the text: the queued ones only.
    expect(sendButton(root).title).toContain("2 件");
  });

  // 下書きが無ければ数は出さない (0 は出さない、閉じた FAB と同じ)。
  test("no queued draft, no count", async () => {
    const { root } = await openWith([]);
    expect(sendCount(root)).toBeNull();
    expect(sendButton(root).title).toBe("");
  });

  // btw (今すぐ聞くだけ) か「後で」(溜めるだけ) が入っている時は、下書きを送らない
  // ので数も出さない。切れば戻る。
  test("btw or 後で on hides it, and it comes back with both off", async () => {
    const { root } = await openWith(TWO_QUEUED);
    await act(() => pill(root, "btw").click());
    expect(sendCount(root)).toBeNull();
    await act(() => pill(root, "later").click());
    expect(sendCount(root)).toBeNull();
    await act(() => pill(root, "later").click());
    expect(sendCount(root)).toBe("2");
  });

  // 下書きを直している間の送信は「直す」(その下書きを直すだけ) なので数を出さない。
  test("changing a queued draft hides it", async () => {
    const { root } = await openWith(TWO_QUEUED);
    const [queued] = TWO_QUEUED;
    if (queued === undefined) throw new Error("no draft");
    await act(() => editDraft(queued));
    expect(sendButton(root).textContent).toContain("直す");
    expect(sendCount(root)).toBeNull();
  });
});

describe("a plain send takes the queued drafts along", () => {
  // 下書きを古い順 (書いた時刻の順。届いた順ではない) に 1 回の queue_send で送り、
  // その後に今の文を user_prompt で送る。どれも別々のプロンプト。
  test("the drafts go oldest first, then the text", async () => {
    const { root, calls } = await openWith(TWO_QUEUED);
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([
      { op: "queue_send", ids: ["d-old", "d-new"] },
      { op: "user_prompt", text: "今の文" },
    ]);
    // The text was taken: the box is left as a send's, cleared and closed.
    expect(loadDraft(SID)).toBeNull();
    expect(root.querySelector(".session-input-panel")).toBeNull();
  });

  // 送るのは送れる状態 (queued) の下書きだけ。届いたか分からない・送信中の下書きを
  // 送り直すと二重に入りうる。
  test("drafts not queued are not sent again", async () => {
    const { root, calls } = await openWith([
      draft("d-q", "2026-11-23T00:02:00.000Z"),
      draft("d-u", "2026-11-23T00:01:00.000Z", "unconfirmed"),
      draft("d-s", "2026-11-23T00:00:30.000Z", "sending"),
    ]);
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([
      { op: "queue_send", ids: ["d-q"] },
      { op: "user_prompt", text: "今の文" },
    ]);
  });

  // 今の文は queue_send の返事を待ってから送る: daemon の queue_send は下書きの
  // 記録を読み書きしてから送信の列に並ぶので、続けて投げた user_prompt が先に列に
  // 入りうる。返事を待つ間は送信中で、文は固定される。
  test("the text waits for the drafts' send to answer", async () => {
    let answer: (reply: QueueSendResponse) => void = () => {};
    const { root, calls } = await openWith(
      TWO_QUEUED,
      () => new Promise<QueueSendResponse>((resolve) => (answer = resolve)),
    );
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([{ op: "queue_send", ids: ["d-old", "d-new"] }]);
    expect(textarea(root).readOnly).toBe(true);
    expect(sendButton(root).textContent).toContain("送信中...");
    await act(async () => {
      answer({
        ok: true,
        results: [
          { kind: "draft", id: "d-old", outcome: "sent" },
          { kind: "draft", id: "d-new", outcome: "sent" },
        ],
      });
      await drained();
    });
    expect(calls.at(-1)).toEqual({ op: "user_prompt", text: "今の文" });
  });

  // 下書きが無ければ今までどおり今の文だけ (queue_send を呼ばない)。
  test("with none queued, only the text is sent", async () => {
    const { root, calls } = await openWith([
      draft("d-u", "2026-11-23T00:01:00.000Z", "unconfirmed"),
    ]);
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([{ op: "user_prompt", text: "今の文" }]);
  });

  // 下書きが届かなかった (not_delivered) ら、残りの下書きと同じく今の文も送らない
  // (P7)。送れば止まった下書きより先に入る。文は入力欄に残り、理由は今の文の送信が
  // 届かなかった時と同じ注記で出る。
  test("a draft not put in stops the text, kept in the box with why", async () => {
    const { root, calls } = await openWith(TWO_QUEUED, () => ({
      ok: true,
      results: [
        { kind: "draft", id: "d-old", outcome: "not_delivered", reason: "no_module" },
        { kind: "draft", id: "d-new", outcome: "not_delivered", reason: "no_module" },
      ],
    }));
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([{ op: "queue_send", ids: ["d-old", "d-new"] }]);
    expect(textarea(root).value).toBe("今の文");
    expect(loadDraft(SID)?.text).toBe("今の文");
    expect(root.querySelector(".session-input-notice-title")?.textContent).toBe("届きませんでした");
    expect(
      root.querySelector('[role="alert"] .session-input-notice-detail')?.textContent,
    ).toContain("module");
  });

  // 届いたか分からない (unconfirmed) 下書きは、daemon が残りの下書きを止めないのと
  // 同じく今の文を止めない。
  test("a draft not known to have arrived does not stop the text", async () => {
    const { root, calls } = await openWith(TWO_QUEUED, () => ({
      ok: true,
      results: [
        { kind: "draft", id: "d-old", outcome: "unconfirmed" },
        { kind: "draft", id: "d-new", outcome: "sent" },
      ],
    }));
    await type(root, "今の文");
    await press(root);
    expect(calls.at(-1)).toEqual({ op: "user_prompt", text: "今の文" });
  });

  // queue_send の返事を受け取れなかった (送れたか分からない) 時も、今の文は送らず
  // 残す: 下書きが入ったかが分からないまま文を入れると順が保てない。
  test("a drafts' send not answered stops the text", async () => {
    const { root, calls } = await openWith(TWO_QUEUED, () => ({
      ok: false,
      error: { code: "request_timeout", msg: "timed out" },
    }));
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([{ op: "queue_send", ids: ["d-old", "d-new"] }]);
    expect(textarea(root).value).toBe("今の文");
    expect(root.querySelector(".session-input-notice-title")?.textContent).toBe("送れませんでした");
  });

  // ⌘+Enter もボタンと同じ送信。
  test("⌘+Enter sends the same way", async () => {
    const { root, calls } = await openWith(TWO_QUEUED);
    await type(root, "今の文");
    const el = textarea(root);
    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
      await drained();
    });
    expect(calls).toEqual([
      { op: "queue_send", ids: ["d-old", "d-new"] },
      { op: "user_prompt", text: "今の文" },
    ]);
  });
});

// 何を保証するか (DR-0062 §11、§15、kawaz 2026-11-24): 通常の送るは、溜めた未送信のコメント
// (btw のコメントは除く) も FAB の下書きと一緒に書いた時刻の順で先に送る (コメントと
// プロンプトを区別しない)。コメントが届けられなかった時も今の文は送らない。送信のボタンの
// 数は今までどおり FAB の下書きの数で、title は先に送る全部の件数を言う。
describe("a plain send takes the stocked comments along too", () => {
  const COMMENTS = [
    unsent("c-mid", "2026-11-23T00:01:30.000Z"),
    unsent("c-btw", "2026-11-23T00:01:40.000Z", true),
    { ...unsent("c-sent", "2026-11-23T00:01:50.000Z"), status: "sent" as const },
  ];

  test("the comments and drafts go in the order written, then the text", async () => {
    const { root, calls } = await openWith(TWO_QUEUED, allSent, COMMENTS);
    expect(sendCount(root)).toBe("2");
    expect(sendButton(root).title).toContain("3 件");
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([
      { op: "queue_send", ids: ["d-old", "c-mid", "d-new"] },
      { op: "user_prompt", text: "今の文" },
    ]);
  });

  test("with only comments stocked, they go first too", async () => {
    const { root, calls } = await openWith([], allSent, COMMENTS);
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([
      { op: "queue_send", ids: ["c-mid"] },
      { op: "user_prompt", text: "今の文" },
    ]);
  });

  test("a comment not put in stops the text, kept in the box", async () => {
    const { root, calls } = await openWith(
      [],
      () => ({
        ok: true,
        results: [{ kind: "comment", id: "c-mid", outcome: "not_delivered", reason: "no_module" }],
      }),
      COMMENTS,
    );
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([{ op: "queue_send", ids: ["c-mid"] }]);
    expect(textarea(root).value).toBe("今の文");
    expect(root.querySelector(".session-input-notice-title")?.textContent).toBe("届きませんでした");
  });
});

describe("btw and 後で send the text alone", () => {
  // 「後で」は今の文をキューに足すだけで、溜まっている下書きを送らない。
  test("後で only puts the text in the queue", async () => {
    const { root, calls } = await openWith(TWO_QUEUED);
    await act(() => pill(root, "later").click());
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([{ op: "prompt_queue_add", text: "今の文" }]);
  });

  // btw は今すぐ聞くだけで、本体の会話に下書きを入れない。
  test("btw only asks the text", async () => {
    const { root, calls } = await openWith(TWO_QUEUED);
    await act(() => pill(root, "btw").click());
    await type(root, "今の文");
    await press(root);
    expect(calls).toEqual([{ op: "comment_add", body: "今の文" }]);
  });
});
