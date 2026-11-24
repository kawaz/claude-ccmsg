// A session's comments in its Timeline (DR-0062 §3, §12, §13), mounted.
// 何を保証するか:
//   - 送ったコメントのブロックだけでできた人の発言の行は、ブロックごとのコメントの
//     吹き出しになり、普通の発言の吹き出しにならない
//   - 応答の吹き出しと SendMessage の項目は「返信」を持ち、押すとフォームが TL の項目の
//     並びの外に浮いて開き (どの項目へのコメントかを頭に出し、本文にフォーカス、Esc で
//     閉じて「返信」にフォーカスを戻す)、
//     送るとその行の uuid と冒頭の文字 (msg_start_with) のアンカーの comment_add になる。
//     say と tool の呼び出しは「返信」を持たない
//   - フォームの下の行は FAB と同じ btw と「後で」の 1 つのピル: どちらも切れている (既定、
//     保存して溜めたものと一緒に送る)・btw・「後で」(送らずに保存) の 3 つで、同時には入らず、入って
//     いる方をもう一度押すと切れる。送信のボタンの字は「送る」/「btw」/「後で」。状態は覚えず
//     (localStorage に書かない)、開き直すと切れている
//   - コメントの付いた項目は 💬 と数を持つ
//   - 送ったが transcript にまだ出ていないコメントは、送った時点の行の後に記録から
//     描かれる
//   - 💬 のフィルタは、未送信のコメントと FAB の下書きを送ったものと同じ並びに同じ吹き出し
//     (コメントの吹き出し / ユーザの発言の吹き出し) で出し、未送信の印 (data-unsent と
//     未送信と入った名前) を付ける。プレビューのエリア・セクション・状態の字は出さない
//   - ヘッダ (TL のツールバーの中) のチェックボックスは sent / comment / btw / resolved の順で、
//     既定は前の 3 つが入っていて、入り切りは行の列の data-comment-show の語になる。
//     フィルタに入り直すたびに既定に戻る
//   - 「全部送信 (N)」は溜めた未送信のコメントと FAB の下書きの全部を、書いた時刻の順に
//     queue_send で送る。チェックボックスで隠れているもの・解決済みのスレッドのものも送る。
//     未送信が無ければ押せない
//   - フォームの「送る」は comment_add で保存してから、溜めたものの後ろにそのコメントを置いた
//     queue_send で送る。「後で」は保存だけ、btw は send_now で 1 件だけ聞く
//   - 未送信のコメントの 送る・直す・消す は、見ていた版でそのコメント 1 件に効く
//   - 解決済みのスレッドの吹き出しは解決済みの印を持ち、resolved で行の列に印が付く
//   - 記録された comment_reply の呼び出しの行はエージェントの返信の吹き出しになり、
//     頭に返信先の cid と引用と元のコメントへの道を、本文を markdown で持つ。「返信」で
//     送るのはその返信の cid への comment_add。💬 のフィルタの間も出て、窓の外の返信は
//     記録の本文の冒頭 (body_start) で出る。🔍 の検索は返信の本文に当たる
//   - 返信の後の 1 行で comment_reply_done を言うだけの応答は吹き出しにならず、「N items」の
//     畳みの中の 1 項目 (「assistant: comment_reply_done」) になる。この語を含む複数行の
//     本文は普通の吹き出しのまま。返信の吹き出しはどちらでも出る
import { afterEach, describe, expect, test } from "bun:test";
import { resetCommentFormDrafts } from "../src/client/components/timeline/comment-form-drafts.ts";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  CCMSG_TOOLS,
  commentBlockText,
  commentsPromptText,
  type CommentRecord,
  type QueueSendItem,
  type PromptDraftRecord,
  type ThreadState,
  type UserComment,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  exchange,
  FakeTranscriptWs,
  Mounted,
  page,
  SID,
  timelineStore,
  uuidOf,
} from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
const restores: Array<() => void> = [];

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.splice(0)) restore();
  resetCommentFormDrafts();
});

function TimelineOf() {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent: null,
    active: true,
    visible: true,
  });
}

function comment(patch: Partial<UserComment> & Pick<UserComment, "cid">): UserComment {
  return {
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: { kind: "message", uuid: uuidOf("a", 1), msg_start_with: "answer 1" },
    body: "ここは?",
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: uuidOf("a", 1) },
    updated_at: "2030-01-01T00:00:00.000Z",
    btw: false,
    status: "draft",
    ...patch,
  };
}

interface Opened {
  root: HTMLElement;
  store: Store;
  adds: Array<Parameters<FakeTranscriptWs["handle"]["commentAdd"]>[1]>;
  sends: QueueSendItem[][];
  updates: Array<{ cid: string; seen: string; body: string | undefined }>;
  deletes: Array<{ cid: string; seen: string }>;
}

type AddReply = Awaited<ReturnType<FakeTranscriptWs["handle"]["commentAdd"]>>;
type SendReply = Awaited<ReturnType<FakeTranscriptWs["handle"]["queueSend"]>>;

async function open(
  lines: readonly string[],
  records: readonly CommentRecord[] = [],
  filter: "comment" | "prompt" | "search" | null = null,
  options: {
    addReply?: (added: UserComment) => AddReply;
    /** What queue_send answers (each item sent when absent). */
    sendReply?: (items: readonly QueueSendItem[]) => SendReply;
    threads?: ThreadState[];
    drafts?: PromptDraftRecord[];
  } = {},
): Promise<Opened> {
  restores.push(stubGlobal("localStorage", new MemStorage()));
  const store = timelineStore();
  if (filter !== null) {
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid: SID, filter },
      sidebar: CLOSED_SIDEBAR,
    });
  }
  store.dispatch({
    type: "comments/loaded",
    sid: SID,
    comments: [...records],
    threads: options.threads ?? [],
    drafts: options.drafts ?? [],
  });
  const ws = new FakeTranscriptWs(store);
  const adds: Opened["adds"] = [];
  const sends: QueueSendItem[][] = [];
  const updates: Opened["updates"] = [];
  const deletes: Opened["deletes"] = [];
  const handle = {
    ...ws.handle,
    commentAdd: (sid: string, input: Opened["adds"][number]) => {
      adds.push(input);
      const added = comment({ cid: "c9999", session_id: sid, body: input.body });
      return Promise.resolve(options.addReply?.(added) ?? { ok: true as const, comment: added });
    },
    queueSend: (_sid: string, items: readonly QueueSendItem[]) => {
      sends.push([...items]);
      // A sendReply that throws is a send whose answer never came (the
      // connection lost).
      try {
        return Promise.resolve(
          options.sendReply?.(items) ?? {
            ok: true as const,
            results: items.map((item) =>
              item.kind === "comment"
                ? { kind: "comment" as const, id: item.cid, outcome: "sent" as const }
                : { kind: "draft" as const, id: item.id, outcome: "sent" as const },
            ),
          },
        );
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    commentUpdate: (_sid: string, cid: string, seen: string, body?: string) => {
      updates.push({ cid, seen, body });
      return Promise.resolve({ ok: true as const, comment: comment({ cid, body: body ?? "" }) });
    },
    commentDelete: (_sid: string, cid: string, seen: string) => {
      deletes.push({ cid, seen });
      return Promise.resolve({ ok: true as const });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...lines]));
  return { root, store, adds, sends, updates, deletes };
}

describe("comments sent, in the Timeline", () => {
  test("a prompt of comment blocks is drawn as one comment bubble per block", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "一つ目" },
      { comment: "c0002", on: { kind: "comment", value: "c0001" }, body: "二つ目" },
    ]);
    const { root } = await open([
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
    ]);
    const bubbles = [...root.querySelectorAll(".tl-bubble-comment")];
    expect(bubbles.map((b) => b.querySelector(".tl-comment-body")?.textContent)).toEqual([
      "一つ目",
      "二つ目",
    ]);
    // Not drawn as the person's plain prompt as well.
    expect(root.textContent).not.toContain('"comment"');
    // Each is a comment (the 💬 filter's) and the person's prompt still (the
    // 👤 filter's, DR-0062 §12 does not take it out).
    for (const bubble of bubbles) {
      expect(bubble.closest(".tl-item")?.getAttribute("data-notif")).toBe("prompt comment");
    }
  });

  test("a person's prompt of JSON that is not only comment blocks stays the person's prompt", async () => {
    const block = commentBlockText({ comment: "c0001", body: "一つ目" });
    const prompts = [
      '{"comment":"c0001","body":"x","on":"応答"}',
      '{"a":1}',
      `${block}\nそれと、もう一つ`,
    ];
    const { root } = await open([
      ...exchange(1),
      ...prompts.map((prompt, i) => jsonl(userContentRow(prompt, { uuid: uuidOf("u", 10 + i) }))),
    ]);
    expect(root.querySelector(".tl-bubble-comment")).toBeNull();
    const shown = ['"on":"応答"', '{"a":1}', "それと、もう一つ"];
    for (const [i, text] of shown.entries()) {
      expect(itemOf(root, uuidOf("u", 10 + i)).textContent).toContain(text);
    }
  });

  test("one sent and not in the transcript yet is drawn from its record where it was sent", async () => {
    const { root } = await open(
      [...exchange(1), ...exchange(2)],
      [
        comment({
          cid: "c0003",
          status: "sent",
          body: "送った",
          sent: { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) },
        }),
      ],
    );
    const items = [...root.querySelectorAll(".tl-lines > .tl-item")].map((item) =>
      item.querySelector(".tl-bubble-comment") !== null
        ? "comment"
        : (/(question|answer) \d/.exec(item.textContent ?? "")?.[0] ?? "?"),
    );
    expect(items).toEqual(["question 1", "answer 1", "comment", "question 2", "answer 2"]);
    // Sent: not marked unsent, no words of its state and no buttons (DR-0062 §13).
    const bubble = instanceOf(root.querySelector(".tl-bubble-comment"), HTMLElement, "the bubble");
    expect(bubble.hasAttribute("data-unsent")).toBe(false);
    expect(bubble.querySelector(".tl-comment-actions")).toBeNull();
    expect(bubble.textContent).not.toContain("transcript に出るのを待っている");
  });

  for (const filter of [null, "comment"] as const) {
    test(`one waiting its turn, and one left unknown with no point sent, are drawn where written (filter ${filter ?? "none"})`, async () => {
      // DR-0062 §11: no moment where a comment is out of both the unsent list
      // and the Timeline. The daemon stopped on `unconfirmed` leaves no `sent`.
      const { root } = await open(
        [...exchange(1), ...exchange(2)],
        [
          comment({ cid: "c0003", status: "sending", body: "順番待ち" }),
          comment({ cid: "c0004", status: "unconfirmed", body: "分からない" }),
        ],
        filter,
      );
      const bubbles = [...root.querySelectorAll(".tl-bubble-comment")];
      expect(bubbles.map((b) => b.querySelector(".tl-comment-body")?.textContent)).toEqual([
        "順番待ち",
        "分からない",
      ]);
      const unknown = instanceOf(bubbles[1], HTMLElement, "the unconfirmed bubble");
      expect(
        [...unknown.querySelectorAll(".tl-comment-actions button")].map((b) => b.textContent),
      ).toEqual(["下書きに戻す", "送った扱いにする"]);
      const order = [...root.querySelectorAll(".tl-lines > .tl-item")].map((item) =>
        item.querySelector(".tl-bubble-comment") !== null
          ? "comment"
          : (/(question|answer) \d/.exec(item.textContent ?? "")?.[0] ?? "?"),
      );
      expect(order).toEqual([
        "question 1",
        "answer 1",
        "comment",
        "comment",
        "question 2",
        "answer 2",
      ]);
    });
  }
});

describe("commenting on a bubble", () => {
  test("返信 opens the form, and saving it adds a comment on that row", async () => {
    const { root, adds, sends } = await open([...exchange(1)]);
    const answer = itemOf(root, uuidOf("a", 1));
    const reply = instanceOf(answer.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信");
    await act(() => reply.click());
    await writeAndSubmit(root, "ここは?");
    // Kept first, then sent with everything stocked (none here) by queue_send.
    expect(adds).toEqual([
      {
        anchor: { kind: "message", uuid: uuidOf("a", 1), msg_start_with: "answer 1" },
        body: "ここは?",
        attachments: [],
        btw: false,
        sendNow: false,
      },
    ]);
    expect(sends).toEqual([
      [{ kind: "comment", cid: "c9999", seen_updated_at: "2030-01-01T00:00:00.000Z" }],
    ]);
    expect(root.querySelector(".tl-comment-float")).toBeNull();
    expect(document.activeElement).toBe(reply);
  });

  // 何を保証するか (DR-0062 §3、§15、kawaz 2026-11-23): フォームのピルは FAB のピルと同じ
  // 決まり。btw と「後で」は排他で、3 つの状態を行き来し、送信のボタンの字が追従する。
  test("the form's pill: neither, btw or 後で, never both, and the send button says which", async () => {
    const { root } = await open([...exchange(1)]);
    await openReply(root);
    const float = openForm(root);
    const btw = instanceOf(float.querySelector(".session-input-btw"), HTMLButtonElement, "btw");
    const later = instanceOf(
      float.querySelector(".session-input-later"),
      HTMLButtonElement,
      "後で",
    );
    expect(btw.closest("[role=group]")?.getAttribute("aria-label")).toBe("送信の形");
    expect(float.querySelector("input[type=checkbox]")).toBeNull();
    const state = () => [
      btw.getAttribute("aria-pressed"),
      later.getAttribute("aria-pressed"),
      sendLabelOf(float),
    ];
    expect(state()).toEqual(["false", "false", "送る"]);
    await act(() => btw.click());
    expect(state()).toEqual(["true", "false", "btw"]);
    await act(() => later.click());
    expect(state()).toEqual(["false", "true", "後で"]);
    await act(() => btw.click());
    expect(state()).toEqual(["true", "false", "btw"]);
    await act(() => btw.click());
    expect(state()).toEqual(["false", "false", "送る"]);
    await act(() => later.click());
    expect(state()).toEqual(["false", "true", "後で"]);
    await act(() => later.click());
    expect(state()).toEqual(["false", "false", "送る"]);
  });

  test("後で keeps the comment unsent; btw asks it now as a btw", async () => {
    const { root, adds } = await open([...exchange(1)]);
    await openReply(root);
    await act(() => pillOf(openForm(root), "後で").click());
    await writeAndSubmit(root, "後で送る");
    await openReply(root);
    await act(() => pillOf(openForm(root), "btw").click());
    await writeAndSubmit(root, "btw で聞く");
    const anchor = { kind: "message" as const, uuid: uuidOf("a", 1), msg_start_with: "answer 1" };
    expect(adds).toEqual([
      { anchor, body: "後で送る", attachments: [], btw: false, sendNow: false },
      { anchor, body: "btw で聞く", attachments: [], btw: true, sendNow: true },
    ]);
  });

  test("the pill is kept nowhere: opened again it is off, and nothing is written to localStorage", async () => {
    const { root } = await open([...exchange(1)]);
    const keys = () =>
      Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "").toSorted(
        (a, b) => a.localeCompare(b),
      );
    const before = keys();
    await openReply(root);
    await act(() => pillOf(openForm(root), "後で").click());
    expect(pillOf(openForm(root), "後で").getAttribute("aria-pressed")).toBe("true");
    const close = instanceOf(
      openForm(root).querySelector(".composer-panel-close"),
      HTMLButtonElement,
      "✕",
    );
    await act(() => close.click());
    expect(root.querySelector(".tl-comment-float")).toBeNull();
    await openReply(root);
    const float = openForm(root);
    expect(pillOf(float, "btw").getAttribute("aria-pressed")).toBe("false");
    expect(pillOf(float, "後で").getAttribute("aria-pressed")).toBe("false");
    expect(sendLabelOf(float)).toBe("送る");
    expect(keys()).toEqual(before);
  });

  // 何を保証するか (DR-0062 §3、kawaz 2026-11-23): フォームは TL の項目の並びに
  // 差し込まれず、TL の外に浮く。並びに要素が増えると、開いた所から下の項目が
  // 押し下げられて見ていた場所が動き、狭い画面ではフォームが見ていた箇所から離れる。
  // 並びの外に出るので、どの項目へのコメントかをフォームの頭に出す。
  test("the form floats outside the Timeline's items, and says what it is on", async () => {
    const { root } = await open([...exchange(1)]);
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, "the Timeline's items");
    const before = lines.querySelectorAll("*").length;
    const reply = instanceOf(
      itemOf(root, uuidOf("a", 1)).querySelector(".tl-comment-reply"),
      HTMLButtonElement,
      "返信",
    );
    await act(() => reply.click());
    const float = openForm(root);
    expect(lines.contains(float)).toBe(false);
    expect(root.querySelector(".timeline-view")?.contains(float)).toBe(false);
    expect(lines.querySelectorAll("*").length).toBe(before);
    expect(float.getAttribute("role")).toBe("dialog");
    expect(float.querySelector(".tl-comment-on .tl-comment-quote")?.textContent).toBe("answer 1");
    expect(reply.getAttribute("aria-expanded")).toBe("true");
  });

  // 何を保証するか (DR-0062 §3): 開くと本文の欄にフォーカスが移り (書き始めるのに
  // もう一度押さない)、Esc で閉じるとフォーカスは押した「返信」に戻る (キーボードで
  // 続けて TL を辿れる)。IME の変換中の Esc は変換の取り消しで、フォームを閉じない。
  test("it focuses its text, Esc closes it, and the focus goes back to 返信", async () => {
    const { root, adds } = await open([...exchange(1)]);
    const reply = instanceOf(
      itemOf(root, uuidOf("a", 1)).querySelector(".tl-comment-reply"),
      HTMLButtonElement,
      "返信",
    );
    await act(() => reply.click());
    const input = instanceOf(
      openForm(root).querySelector(".tl-comment-input"),
      HTMLTextAreaElement,
      "input",
    );
    expect(document.activeElement).toBe(input);
    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
      );
    });
    expect(root.querySelector(".tl-comment-float")).not.toBeNull();
    await act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(root.querySelector(".tl-comment-float")).toBeNull();
    expect(document.activeElement).toBe(reply);
    expect(reply.getAttribute("aria-expanded")).toBe("false");
    expect(adds).toEqual([]);
  });

  test("a reply's form says the cid it answers and the start of that comment", async () => {
    const prompt = commentsPromptText([{ comment: "c0001", body: "一つ目のコメント" }]);
    const { root } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [
        comment({
          cid: "c0001",
          status: "delivered",
          body: "一つ目のコメント",
          row_uuid: uuidOf("u", 2),
        }),
      ],
    );
    const bubble = instanceOf(root.querySelector(".tl-bubble-comment"), HTMLElement, "bubble");
    const reply = instanceOf(bubble.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信");
    await act(() => reply.click());
    const on = openForm(root).querySelector(".tl-comment-on");
    expect(on?.querySelector(".tl-comment-reply-to")?.textContent).toBe("↩ c0001 への返信");
    expect(on?.querySelector(".tl-comment-quote")?.textContent).toBe("一つ目のコメント");
  });

  test("an item with comments shows 💬 and how many", async () => {
    const { root } = await open(
      [...exchange(1)],
      [comment({ cid: "c0001" }), comment({ cid: "c0002" })],
    );
    const answer = instanceOf(
      root.querySelector(`[data-timeline-uuid="${uuidOf("a", 1)}"]`),
      HTMLElement,
      "the answer's item",
    );
    expect(answer.querySelector(".tl-item-comments")?.textContent).toBe("💬2");
    const question = root.querySelector(`[data-timeline-uuid="${uuidOf("u", 1)}"]`);
    expect(question?.querySelector(".tl-item-comments")).toBeNull();
  });
});

describe("the 💬 filter", () => {
  /** The 💬 filter's head: its boxes by their label, and 全部送信. */
  function head(root: HTMLElement): {
    boxes: Map<string, HTMLInputElement>;
    sendAll: HTMLButtonElement;
  } {
    const at = instanceOf(root.querySelector(".tl-comments-head"), HTMLElement, "the head");
    const boxes = new Map(
      [...at.querySelectorAll("label")].map((label) => [
        label.textContent ?? "",
        instanceOf(label.querySelector("input"), HTMLInputElement, "a box"),
      ]),
    );
    const sendAll = instanceOf(
      at.querySelector(".tl-comments-send-all"),
      HTMLButtonElement,
      "全部送信",
    );
    return { boxes, sendAll };
  }

  test("the unsent comments and drafts stand among what is sent, in the same bubbles, marked unsent", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "送った" },
    ]);
    const records = [
      comment({ cid: "c0001", status: "delivered", body: "送った", row_uuid: uuidOf("u", 9) }),
      comment({
        cid: "c0002",
        body: "未送信",
        anchor: { kind: "message", uuid: uuidOf("a", 2), msg_start_with: "answer 2" },
      }),
    ];
    const drafts: PromptDraftRecord[] = [
      {
        kind: "draft",
        id: "d1",
        session_id: SID,
        written: { at: "2030-01-01T00:00:00.000Z", after_uuid: uuidOf("a", 1) },
        updated_at: "dv",
        text: "下書き",
        attachments: [],
        status: "queued",
      },
    ];
    const { root } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 9) })), ...exchange(2)],
      records,
      "comment",
      { drafts },
    );
    const items = [...root.querySelectorAll(".tl-lines > .tl-item")].map((item) => {
      const bubble = item.querySelector("[data-comment-kind]");
      if (bubble === null) return /(question|answer) \d/.exec(item.textContent ?? "")?.[0] ?? "?";
      const body =
        bubble.querySelector(".tl-comment-body")?.textContent ??
        bubble.querySelector(".md")?.textContent?.trim();
      return `${bubble.getAttribute("data-comment-kind")}${bubble.hasAttribute("data-unsent") ? " unsent" : ""}: ${body}`;
    });
    // The draft after the row it was written at, the comment sent at its row,
    // the unsent comment after the item it is on.
    expect(items).toContain("draft unsent: 下書き");
    expect(items).toContain("comment: 送った");
    expect(items).toContain("comment unsent: 未送信");
    expect(items.indexOf("draft unsent: 下書き")).toBe(items.indexOf("answer 1") + 1);
    expect(items.indexOf("comment unsent: 未送信")).toBe(items.indexOf("answer 2") + 1);
    // The same bubbles as what is sent: a comment's, and the person's prompt's.
    const unsentComment = instanceOf(
      root.querySelector(".tl-bubble-comment[data-unsent]"),
      HTMLElement,
      "the unsent comment",
    );
    expect(unsentComment.classList.contains("tl-bubble-right")).toBe(true);
    expect(unsentComment.getAttribute("aria-label")).toBe("未送信のコメント");
    expect(
      [...unsentComment.querySelectorAll(".tl-comment-actions button")].map((b) => b.textContent),
    ).toEqual(["消す", "直す", "送る"]);
    const draft = instanceOf(
      root.querySelector(".tl-bubble-draft[data-unsent]"),
      HTMLElement,
      "the draft",
    );
    expect(draft.classList.contains("tl-bubble-right")).toBe(true);
    expect(draft.getAttribute("aria-label")).toBe("未送信の FAB の下書き");
    const sent = instanceOf(
      root.querySelector(".tl-bubble-comment:not([data-unsent])"),
      HTMLElement,
      "the comment sent",
    );
    expect(sent.hasAttribute("aria-label")).toBe(false);
    // One list: no preview area, sections or words of state.
    expect(root.querySelector(".tl-comments-preview, .tl-drafts-preview, h3")).toBeNull();
    for (const word of ["未送信", "FAB の下書き", "全部送る", "コメント ("]) {
      expect(root.querySelector(".tl-lines")?.textContent ?? "").not.toContain(
        word === "未送信" ? "未送信 (" : word,
      );
    }
  });

  test("the head's boxes are sent, comment, btw and resolved, the first three checked", async () => {
    const { root } = await open([...exchange(1)], [], "comment");
    const { boxes } = head(root);
    expect([...boxes.keys()]).toEqual(["sent", "comment", "btw", "resolved"]);
    expect([...boxes.values()].map((box) => box.checked)).toEqual([true, true, true, false]);
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, "lines");
    expect(lines.getAttribute("data-comment-show")).toBe("sent comment btw");
    // Each box says what is shown; taking one off takes its word out.
    for (const [label, words] of [
      ["sent", "comment btw"],
      ["btw", "comment"],
      ["resolved", "comment resolved"],
    ] as const) {
      const box = boxes.get(label);
      if (box === undefined) throw new Error(`no box ${label}`);
      await act(() => box.click());
      expect(lines.getAttribute("data-comment-show")).toBe(words);
    }
  });

  test("the head is the filter's only, and the boxes are as they were each time it is entered", async () => {
    const { root, store } = await open([...exchange(1)], [], "comment");
    const at = instanceOf(root.querySelector(".tl-comments-head"), HTMLElement, "the head");
    expect(at.hidden).toBe(false);
    expect(at.closest(".tl-toolbar")).not.toBeNull();
    const sentBox = head(root).boxes.get("sent");
    await act(() => sentBox?.click());
    expect(head(root).boxes.get("sent")?.checked).toBe(false);
    for (const filter of [null, "comment"] as const) {
      await act(() =>
        store.dispatch({
          type: "locator/changed",
          locator: { view: "timeline", sid: SID, ...(filter !== null ? { filter } : {}) },
          sidebar: CLOSED_SIDEBAR,
        }),
      );
    }
    expect(head(root).boxes.get("sent")?.checked).toBe(true);
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    expect(at.hidden).toBe(true);
  });

  // 全部送信は FAB とフォームの「送る」と同じ「全部送る」(kawaz 2026-11-24): 溜めたコメントと
  // FAB の下書きの全部を、書いた時刻の順に 1 つの queue_send で渡す。チェックボックスで隠した
  // ものも入り、数はその全部の数。同じ時刻ならコメントが先。
  test("全部送信 sends everything stocked in the order written, whatever the boxes hide", async () => {
    const first = comment({ cid: "c0001", body: "一つ目", updated_at: "v1" });
    const second = comment({
      cid: "c0002",
      body: "二つ目",
      written: { at: "2030-01-01T00:00:05.000Z", after_uuid: uuidOf("a", 1) },
      updated_at: "v2",
    });
    const drafts: PromptDraftRecord[] = [
      {
        kind: "draft",
        id: "d1",
        session_id: SID,
        written: { at: "2030-01-01T00:00:01.000Z" },
        updated_at: "dv",
        text: "下書き",
        attachments: [],
        status: "queued",
      },
    ];
    const { root, sends } = await open([...exchange(1)], [second, first], "comment", { drafts });
    const { sendAll, boxes } = head(root);
    expect(sendAll.textContent).toBe("全部送信 (3)");
    await act(async () => {
      sendAll.click();
      await Promise.resolve();
    });
    const all: QueueSendItem[] = [
      { kind: "comment", cid: "c0001", seen_updated_at: "v1" },
      { kind: "draft", id: "d1", seen_updated_at: "dv" },
      { kind: "comment", cid: "c0002", seen_updated_at: "v2" },
    ];
    expect(sends).toEqual([all]);
    // The comments hidden (comment off) are sent all the same.
    await act(() => boxes.get("comment")?.click());
    expect(head(root).sendAll.textContent).toBe("全部送信 (3)");
    await act(async () => {
      head(root).sendAll.click();
      await Promise.resolve();
    });
    expect(sends[1]).toEqual(all);
  });

  test("全部送信 is not pressed with no unsent one shown", async () => {
    const prompt = commentsPromptText([{ comment: "c0001", body: "送った" }]);
    const { root, sends } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [comment({ cid: "c0001", status: "delivered", body: "送った" })],
      "comment",
    );
    const { sendAll } = head(root);
    expect(sendAll.textContent).toBe("全部送信 (0)");
    expect(sendAll.disabled).toBe(true);
    await act(() => sendAll.click());
    expect(sends).toEqual([]);
  });

  // 解決済みのスレッドに付いた未送信のコメントも全部送信の対象 (resolved が切れて隠れていても)。
  test("an unsent comment in a resolved thread is sent while resolved is unchecked", async () => {
    const prompt = commentsPromptText([{ comment: "c0001", body: "済んだ話" }]);
    const { root, sends } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [
        comment({ cid: "c0001", status: "delivered", body: "済んだ話" }),
        comment({ cid: "c0002", body: "続き", anchor: { kind: "comment", cid: "c0001" } }),
      ],
      "comment",
      { threads: [{ kind: "thread", session_id: SID, root: "c0001", resolved_at: "t" }] },
    );
    expect(head(root).boxes.get("resolved")?.checked).toBe(false);
    expect(head(root).sendAll.disabled).toBe(false);
    await act(async () => {
      head(root).sendAll.click();
      await Promise.resolve();
    });
    expect(sends).toEqual([
      [{ kind: "comment", cid: "c0002", seen_updated_at: "2030-01-01T00:00:00.000Z" }],
    ]);
  });

  test("an unsent comment's 送る / 直す / 消す act on it at the version shown", async () => {
    const { root, sends, updates, deletes } = await open(
      [...exchange(1)],
      [comment({ cid: "c0001", body: "元の文", updated_at: "v1" })],
      "comment",
    );
    const bubble = (): HTMLElement =>
      instanceOf(root.querySelector(".tl-bubble-comment[data-unsent]"), HTMLElement, "bubble");
    const button = (label: string): HTMLButtonElement =>
      instanceOf(
        [...bubble().querySelectorAll(".tl-comment-actions button")].find(
          (b) => b.textContent === label,
        ),
        HTMLButtonElement,
        label,
      );
    await act(async () => {
      button("送る").click();
      await Promise.resolve();
    });
    expect(sends).toEqual([[{ kind: "comment", cid: "c0001", seen_updated_at: "v1" }]]);
    await act(async () => {
      button("消す").click();
      await Promise.resolve();
    });
    expect(deletes).toEqual([{ cid: "c0001", seen: "v1" }]);
    // 直す changes the text in the bubble, and 保存 puts it at the version shown.
    await act(() => button("直す").click());
    const input = instanceOf(
      bubble().querySelector(".tl-comment-input"),
      HTMLTextAreaElement,
      "the text being changed",
    );
    expect(input.value).toBe("元の文");
    await act(() => {
      input.value = "直した文";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button("保存").click();
      await Promise.resolve();
    });
    expect(updates).toEqual([{ cid: "c0001", seen: "v1", body: "直した文" }]);
    expect(bubble().querySelector(".tl-comment-input")).toBeNull();
  });

  test("a resolved thread's bubble is marked, and resolved marks the list", async () => {
    const prompt = commentsPromptText([{ comment: "c0001", body: "済んだ話" }]);
    const delivered = comment({ cid: "c0001", status: "delivered", body: "済んだ話" });
    const { root, store } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [delivered],
      "comment",
    );
    await act(() =>
      store.dispatch({
        type: "comment-thread/changed",
        thread: { kind: "thread", session_id: SID, root: "c0001", resolved_at: "t" },
      }),
    );
    const bubble = instanceOf(root.querySelector(".tl-bubble-comment"), HTMLElement, "bubble");
    expect(bubble.hasAttribute("data-resolved")).toBe(true);
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, "lines");
    expect(lines.getAttribute("data-comment-show")?.split(" ")).not.toContain("resolved");
    await act(() => head(root).boxes.get("resolved")?.click());
    expect(lines.getAttribute("data-comment-show")?.split(" ")).toContain("resolved");
  });
});

// 何を保証するか (DR-0062 §3、kawaz 2026-11-23): 本体に送ったコメント (入れた・届いた・
// 届いたか分からない) の吹き出しは「返信」を持ち、送るとそのコメントの cid への
// comment_add (冒頭の文字を持たない) になる。送信の順番待ち・btw のコメントと、
// 未送信のコメントの吹き出しは「返信」を持たない。
describe("a reply to a comment sent (DR-0062 §3)", () => {
  test("a delivered comment's bubble carries 返信, and it adds a comment on that cid", async () => {
    const prompt = commentsPromptText([{ comment: "c0001", body: "一つ目" }]);
    const { root, adds } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [comment({ cid: "c0001", status: "delivered", body: "一つ目", row_uuid: uuidOf("u", 2) })],
    );
    const bubble = instanceOf(root.querySelector(".tl-bubble-comment"), HTMLElement, "bubble");
    const item = instanceOf(bubble.closest(".tl-item"), HTMLElement, "the comment's item");
    await replyOn(item, "追記");
    expect(adds).toEqual([
      {
        anchor: { kind: "comment", cid: "c0001" },
        body: "追記",
        btw: false,
        attachments: [],
        sendNow: false,
      },
    ]);
  });

  test("one put in or not known carries 返信; one waiting its turn, a btw and an unsent one do not", async () => {
    const sent = { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) };
    const records = [
      comment({ cid: "c0001", status: "sent", body: "入れた", sent }),
      comment({ cid: "c0002", status: "unconfirmed", body: "分からない", sent }),
      comment({ cid: "c0003", status: "sending", body: "順番待ち" }),
      comment({ cid: "c0004", status: "sent", body: "btw の質問", btw: true, sent }),
      comment({ cid: "c0005", status: "draft", body: "未送信" }),
    ];
    const { root } = await open([...exchange(1)], records, "comment");
    const hasReply = (body: string): boolean => {
      const holder = [...root.querySelectorAll(".tl-bubble-comment")].find(
        (node) => node.querySelector(".tl-comment-body")?.textContent === body,
      );
      if (holder === undefined) throw new Error(`no bubble of ${body}`);
      return holder.querySelector(".tl-comment-reply") !== null;
    };
    expect(["入れた", "分からない", "順番待ち", "btw の質問", "未送信"].map(hasReply)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

/** Opens the form of `item` by its 返信, writes `text` and submits it. */
async function replyOn(item: HTMLElement, text: string): Promise<void> {
  const reply = instanceOf(item.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信");
  await act(() => reply.click());
  const root = item.closest(".timeline-view")?.parentElement;
  if (!(root instanceof HTMLElement)) throw new Error("no Timeline around the item");
  await writeAndSubmit(root, text);
}

/** The comment form open in the Timeline under `root` (over it, not among
 * its items). */
function openForm(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the comment form");
}

/** Opens the form of the answer of exchange 1 by its 返信. */
async function openReply(root: HTMLElement): Promise<void> {
  const reply = instanceOf(
    itemOf(root, uuidOf("a", 1)).querySelector(".tl-comment-reply"),
    HTMLButtonElement,
    "返信",
  );
  await act(() => reply.click());
}

/** The side `label` of the form's pill of btw and 後で. */
function pillOf(float: HTMLElement, label: "btw" | "後で"): HTMLButtonElement {
  return instanceOf(
    float.querySelector(label === "btw" ? ".session-input-btw" : ".session-input-later"),
    HTMLButtonElement,
    label,
  );
}

/** The text the form's send button shows (the other modes' texts are drawn hidden). */
function sendLabelOf(float: HTMLElement): string | null | undefined {
  return float.querySelector(".tl-comment-send > span:not(.session-input-send-off)")?.textContent;
}

/** Writes `text` in the open comment form and submits it. */
async function writeAndSubmit(root: HTMLElement, text: string): Promise<void> {
  const float = openForm(root);
  const input = instanceOf(float.querySelector(".tl-comment-input"), HTMLTextAreaElement, "input");
  await act(() => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = instanceOf(float.querySelector(".tl-comment-form"), HTMLFormElement, "form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    root.querySelector(`[data-timeline-uuid="${uuid}"]`),
    HTMLElement,
    `the item of ${uuid}`,
  );
}

describe("a prompt of comments is the person's prompt still (DR-0062 §12)", () => {
  test("its first bubble carries ↑前 | 次↓, and the way back to the newest prompt is kept", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "一つ目" },
      { comment: "c0002", on: { kind: "msg_start_with", value: "answer 1" }, body: "二つ目" },
    ]);
    const { root } = await open([
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
    ]);
    const items = [...root.querySelectorAll(".tl-bubble-comment")].map((bubble) =>
      instanceOf(bubble.closest(".tl-item"), HTMLElement, "the comment's item"),
    );
    expect(items.map((item) => item.querySelector(".tl-item-prompt-steps") !== null)).toEqual([
      true,
      false,
    ]);
    const prev = instanceOf(
      items[0]?.querySelector(".tl-item-prompt-step"),
      HTMLButtonElement,
      "↑前",
    );
    expect(prev.disabled).toBe(false);
    // The newest prompt is the comments' row: the button stays for it.
    expect(root.querySelector(".tl-latest-prompt")).not.toBeNull();
  });
});

describe("which items carry 返信 (DR-0062 §3, §4, P2)", () => {
  test("a SendMessage carries 返信 and a comment on it names whom it tells; a say and a tool's call carry none", async () => {
    const sayRow = jsonl(
      assistantContentRow(
        [{ type: "tool_use", id: "toolu_s1", name: CCMSG_TOOLS.say, input: { text: "終わった" } }],
        { uuid: uuidOf("a", 7) },
      ),
    );
    const toolRow = jsonl(
      assistantContentRow([toolUseBlock("Grep", { pattern: "x" }, "toolu_g1")], {
        uuid: uuidOf("a", 8),
      }),
    );
    const sendRow = jsonl(
      assistantContentRow(
        [toolUseBlock("SendMessage", { to: "w1", summary: "直して", message: "全文" }, "toolu_m1")],
        { uuid: uuidOf("a", 9) },
      ),
    );
    const { root, adds } = await open([...exchange(1), toolRow, sendRow, sayRow, ...exchange(2)]);
    // DR-0062 §3: 返信 only on the items a person answers in a thread.
    expect(itemOf(root, uuidOf("a", 7)).querySelector(".tl-comment-reply")).toBeNull();
    // The tool's and the SendMessage's rows are in a fold: open it to reach
    // their items.
    const fold = instanceOf(root.querySelector(".tl-fold-group"), HTMLDetailsElement, "fold");
    await act(() => {
      fold.open = true;
      fold.dispatchEvent(new Event("toggle"));
    });
    expect(itemOf(root, uuidOf("a", 8)).querySelector(".tl-comment-reply")).toBeNull();
    await replyOn(itemOf(root, uuidOf("a", 9)), "それで進めて");
    expect(adds.map((add) => [add.anchor, add.body])).toEqual([
      [{ kind: "message", uuid: uuidOf("a", 9), msg_start_with: "直して" }, "それで進めて"],
    ]);
  });

  test("a block of a comment the daemon has no record of carries neither 返信 nor ✔️", async () => {
    const prompt = commentsPromptText([{ comment: "c0001", body: "掃除された" }]);
    const { root } = await open([
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
    ]);
    const bubble = instanceOf(root.querySelector(".tl-bubble-comment"), HTMLElement, "bubble");
    expect(bubble.querySelector(".tl-comment-reply")).toBeNull();
    expect(bubble.querySelector(".tl-comment-resolve")).toBeNull();
  });
});

describe("what the form says when the comment is not sent (DR-0062 §11)", () => {
  test("kept and not put in: the form stays, says why in words, and makes no second comment", async () => {
    const { root, adds } = await open([...exchange(1)], [], null, {
      sendReply: (items) => ({
        ok: true,
        results: items.map((item) =>
          item.kind === "comment"
            ? {
                kind: "comment" as const,
                id: item.cid,
                outcome: "not_delivered" as const,
                reason: "no_module" as const,
              }
            : {
                kind: "draft" as const,
                id: item.id,
                outcome: "not_delivered" as const,
                reason: "no_module" as const,
              },
        ),
      }),
    });
    const answer = itemOf(root, uuidOf("a", 1));
    await replyOn(answer, "ここは?");
    const failure = openForm(root).querySelector(".tl-comment-failure")?.textContent ?? "";
    expect(failure).toContain("届けられなかった");
    expect(failure).toContain("plugin を更新して");
    expect(failure).not.toContain("no_module");
    const submit = instanceOf(
      openForm(root).querySelector(".tl-comment-form button[type=submit]"),
      HTMLButtonElement,
      "送信",
    );
    expect(submit.disabled).toBe(true);
    expect(adds).toHaveLength(1);
  });

  test("no answer: it says to look at the list, and the same text is not asked again", async () => {
    const { root, adds } = await open([...exchange(1)], [], null, {
      addReply: () => ({
        ok: false,
        error: { code: "request_timeout", msg: "no reply within 60000 ms" },
      }),
    });
    const answer = itemOf(root, uuidOf("a", 1));
    await replyOn(answer, "ここは?");
    const failure = openForm(root).querySelector(".tl-comment-failure")?.textContent ?? "";
    expect(failure).toContain("返事が来なかった");
    expect(failure).toContain("一覧で確かめる");
    expect(failure).not.toContain("no reply");
    await writeAndSubmit(root, "ここは?");
    expect(adds).toHaveLength(1);
    // Other text is a comment of its own.
    await writeAndSubmit(root, "ここは? (書き直し)");
    expect(adds).toHaveLength(2);
  });
});

// 何を保証するか (DR-0062 §3、kawaz 2026-11-24): フォームを閉じる口は右上の ✕ と Esc だけで、
// 「やめる」のボタンは無い。閉じても書きかけ (本文と添付) は対象ごとにページの間だけ覚え、
// 同じ対象のフォームを開き直すと続きから書ける。別の対象に替えて戻っても残る。空で閉じると
// 何も残らず、保存できたら消え、保存に失敗したら残る。localStorage には書かない。
describe("what the form held is kept for its target", () => {
  function inputOf(root: HTMLElement): HTMLTextAreaElement {
    return instanceOf(
      openForm(root).querySelector(".tl-comment-input"),
      HTMLTextAreaElement,
      "the form's text",
    );
  }
  async function write(root: HTMLElement, text: string): Promise<void> {
    const input = inputOf(root);
    await act(() => {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function closeBy(root: HTMLElement, way: "✕" | "Esc"): Promise<void> {
    const float = openForm(root);
    if (way === "✕") {
      const close = instanceOf(
        float.querySelector(".composer-panel-close"),
        HTMLButtonElement,
        "✕",
      );
      await act(() => close.click());
    } else {
      await act(() => {
        inputOf(root).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    }
    expect(root.querySelector(".tl-comment-float")).toBeNull();
  }
  async function openOn(root: HTMLElement, n: number): Promise<void> {
    const reply = instanceOf(
      itemOf(root, uuidOf("a", n)).querySelector(".tl-comment-reply"),
      HTMLButtonElement,
      "返信",
    );
    await act(() => reply.click());
  }

  test("there is no やめる: the form's buttons are 📎, the pill, ✕ and the send button", async () => {
    const { root } = await open([...exchange(1)]);
    await openReply(root);
    const labels = [...openForm(root).querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent ?? "",
    );
    expect(labels.some((label) => label.includes("やめる") || label === "閉じる")).toBe(false);
    expect(labels).toContain("コメントのフォームを閉じる");
  });

  test("closed by ✕ or Esc and opened again, it goes on from what was written", async () => {
    // open() gives the page an empty localStorage: nothing is written to it.
    const { root } = await open([...exchange(1)]);
    await openReply(root);
    await write(root, "書きかけ");
    await closeBy(root, "✕");
    await openReply(root);
    expect(inputOf(root).value).toBe("書きかけ");
    await write(root, "書きかけの続き");
    await closeBy(root, "Esc");
    await openReply(root);
    expect(inputOf(root).value).toBe("書きかけの続き");
    expect(localStorage.length).toBe(0);
  });

  test("another target's form leaves this one's text, and each comes back on its own", async () => {
    const { root } = await open([...exchange(1), ...exchange(2)]);
    await openOn(root, 1);
    await write(root, "一つ目へ");
    await openOn(root, 2);
    expect(inputOf(root).value).toBe("");
    await write(root, "二つ目へ");
    await openOn(root, 1);
    expect(inputOf(root).value).toBe("一つ目へ");
    await openOn(root, 2);
    expect(inputOf(root).value).toBe("二つ目へ");
  });

  test("closed empty, nothing is kept", async () => {
    const { root } = await open([...exchange(1)]);
    await openReply(root);
    await write(root, "書いて");
    await write(root, "");
    await closeBy(root, "✕");
    await openReply(root);
    expect(inputOf(root).value).toBe("");
  });

  test("a comment kept from it forgets it; one refused keeps it", async () => {
    let refuse = true;
    const { root, adds } = await open([...exchange(1)], [], null, {
      addReply: (added) =>
        refuse
          ? { ok: false, error: { code: "state_not_writable", msg: "no" } }
          : { ok: true, comment: added },
    });
    await openReply(root);
    await act(() => pillOf(openForm(root), "後で").click());
    await writeAndSubmit(root, "溜める");
    expect(adds).toHaveLength(1);
    await closeBy(root, "✕");
    await openReply(root);
    expect(inputOf(root).value).toBe("溜める");
    refuse = false;
    await act(() => pillOf(openForm(root), "後で").click());
    await writeAndSubmit(root, "溜める");
    expect(root.querySelector(".tl-comment-float")).toBeNull();
    await openReply(root);
    expect(inputOf(root).value).toBe("");
  });
});

// 何を保証するか (DR-0062 §3、§11、kawaz 2026-11-24): フォームの「送る」は、溜めた未送信の
// コメントと FAB の下書き (btw のコメント・届いたか分からない下書きは除く) を書いた時刻の順に
// 送り、いま書いたコメントを最後に置く (1 つの queue_send)。「後で」は保存だけで何も送らず、
// btw はそのコメント 1 件だけを send_now で聞く。前のものが届けられなければ、いま書いた
// コメントも送らずに未送信に戻り、フォームは理由を出して残る。
describe("the form's 送る takes along everything stocked", () => {
  const stockedComments = (): CommentRecord[] => [
    comment({ cid: "c0001", body: "溜めた", updated_at: "v1" }),
    comment({ cid: "c0002", body: "btw の残り", btw: true, updated_at: "v2" }),
    comment({
      cid: "c0003",
      body: "後で溜めた",
      written: { at: "2030-01-01T00:00:09.000Z", after_uuid: uuidOf("a", 1) },
      updated_at: "v3",
    }),
  ];
  const stockedDrafts = (): PromptDraftRecord[] => [
    {
      kind: "draft",
      id: "d1",
      session_id: SID,
      written: { at: "2030-01-01T00:00:05.000Z" },
      updated_at: "dv1",
      text: "下書き",
      attachments: [],
      status: "queued",
    },
    {
      kind: "draft",
      id: "d2",
      session_id: SID,
      written: { at: "2030-01-01T00:00:06.000Z" },
      updated_at: "dv2",
      text: "届いたか分からない",
      attachments: [],
      status: "unconfirmed",
    },
  ];

  test("送る sends the stocked ones in the order written, the new comment last", async () => {
    const { root, adds, sends } = await open([...exchange(1)], stockedComments(), null, {
      drafts: stockedDrafts(),
    });
    await replyOn(itemOf(root, uuidOf("a", 1)), "いま書いた");
    expect(adds.map((add) => [add.body, add.sendNow])).toEqual([["いま書いた", false]]);
    expect(sends).toEqual([
      [
        { kind: "comment", cid: "c0001", seen_updated_at: "v1" },
        { kind: "draft", id: "d1", seen_updated_at: "dv1" },
        { kind: "comment", cid: "c0003", seen_updated_at: "v3" },
        { kind: "comment", cid: "c9999", seen_updated_at: "2030-01-01T00:00:00.000Z" },
      ],
    ]);
    expect(root.querySelector(".tl-comment-float")).toBeNull();
  });

  test("後で only keeps the comment, and btw asks it alone", async () => {
    const { root, adds, sends } = await open([...exchange(1)], stockedComments(), null, {
      drafts: stockedDrafts(),
    });
    await openReply(root);
    await act(() => pillOf(openForm(root), "後で").click());
    await writeAndSubmit(root, "溜める");
    await openReply(root);
    await act(() => pillOf(openForm(root), "btw").click());
    await writeAndSubmit(root, "聞く");
    expect(adds.map((add) => [add.body, add.btw, add.sendNow])).toEqual([
      ["溜める", false, false],
      ["聞く", true, true],
    ]);
    expect(sends).toEqual([]);
  });

  // 2 つの op の 1 つ目 (保存) が通って 2 つ目 (送る) の返事が来なかった時: コメントは保存
  // されて未送信のまま溜まっている。フォームは書いた文を残して保存したことと理由を言い、
  // 同じ文ではもう一度保存しない (同じコメントを 2 つ作らない)。
  test("kept and the send lost: the form keeps the text, says it was kept, and makes no second", async () => {
    const { root, adds, sends } = await open([...exchange(1)], [], null, {
      sendReply: () => {
        throw new Error("connection closed");
      },
    });
    await replyOn(itemOf(root, uuidOf("a", 1)), "いま書いた");
    expect(sends).toHaveLength(1);
    const float = openForm(root);
    expect(float.querySelector(".tl-comment-failure")?.textContent ?? "").toContain("保存した");
    const input = instanceOf(
      float.querySelector(".tl-comment-input"),
      HTMLTextAreaElement,
      "input",
    );
    expect(input.value).toBe("いま書いた");
    await writeAndSubmit(root, "いま書いた");
    expect(adds).toHaveLength(1);
  });

  test("one before it not put in: the new comment is not sent either, and the form says why", async () => {
    const { root, sends } = await open([...exchange(1)], stockedComments(), null, {
      drafts: stockedDrafts(),
      sendReply: (items) => ({
        ok: true,
        results: items.map((item) =>
          item.kind === "comment"
            ? {
                kind: "comment" as const,
                id: item.cid,
                outcome: "not_delivered" as const,
                reason: "dialog" as const,
              }
            : {
                kind: "draft" as const,
                id: item.id,
                outcome: "not_delivered" as const,
                reason: "dialog" as const,
              },
        ),
      }),
    });
    await replyOn(itemOf(root, uuidOf("a", 1)), "いま書いた");
    expect(sends).toHaveLength(1);
    const failure = openForm(root).querySelector(".tl-comment-failure")?.textContent ?? "";
    expect(failure).toContain("保存した");
    expect(failure).toContain("届けられなかった");
  });
});

describe("the 💬 filter, outside the window and from an item's 💬 (DR-0062 §12, §13)", () => {
  test("a delivered comment whose row is not read is drawn from its record", async () => {
    const delivered = comment({
      cid: "c0001",
      status: "delivered",
      body: "前に届いた",
      sent: { at: "2029-12-31T00:00:00.000Z", after_uuid: "older-row" },
      row_uuid: "older-row",
    });
    const { root } = await open([...exchange(1)], [delivered], "comment");
    const bodies = [...root.querySelectorAll(".tl-bubble-comment .tl-comment-body")].map(
      (body) => body.textContent,
    );
    expect(bodies).toEqual(["前に届いた"]);
    expect(root.querySelector(".tl-filter-empty")).toBeNull();
  });

  test("「コメントはありません」 when every comment there is of a resolved thread", async () => {
    const delivered = comment({
      cid: "c0001",
      status: "delivered",
      sent: { at: "2029-12-31T00:00:00.000Z", after_uuid: "older-row" },
      row_uuid: "older-row",
    });
    const { root } = await open([...exchange(1)], [delivered], "comment", {
      threads: [{ kind: "thread", session_id: SID, root: "c0001", resolved_at: "t" }],
    });
    expect(root.querySelector(".tl-filter-empty")?.textContent).toBe("コメントはありません");
  });

  // 何を保証するか (DR-0062 §6、kawaz 2026-11-24): 解決済みのスレッドに新しい記録 (人の返信、
  // エージェントの返信、btw の答え) が付くと daemon が解決を外して配る。届いたらそのスレッドは
  // 💬 のフィルタの既定の並びに戻る (付いた記録と一緒に)。
  test("a resolved thread the daemon opens again for a new record comes back to the filter", async () => {
    const delivered = comment({
      cid: "c0001",
      status: "delivered",
      sent: { at: "2029-12-31T00:00:00.000Z", after_uuid: "older-row" },
      row_uuid: "older-row",
    });
    const { root, store } = await open([...exchange(1)], [delivered], "comment", {
      threads: [{ kind: "thread", session_id: SID, root: "c0001", resolved_at: "t" }],
    });
    expect(root.querySelector(".tl-filter-empty")).not.toBeNull();
    await act(() => {
      store.dispatch({
        type: "comment/changed",
        comment: comment({
          cid: "c0002",
          body: "解決の後の返信",
          anchor: { kind: "comment", cid: "c0001" },
        }),
      });
      store.dispatch({
        type: "comment-thread/changed",
        thread: { kind: "thread", session_id: SID, root: "c0001" },
      });
    });
    expect(root.querySelector(".tl-filter-empty")).toBeNull();
    expect(root.querySelector("[data-resolved]")).toBeNull();
    const bodies = [...root.querySelectorAll(".tl-bubble-comment .tl-comment-body")].map(
      (body) => body.textContent,
    );
    expect(bodies).toContain("解決の後の返信");
  });

  test("an item's 💬 keeps the position and selects its comments in the filter", async () => {
    const onAnswer = comment({ cid: "c0001", body: "答えに" });
    const onQuestion = comment({
      cid: "c0002",
      body: "問いに",
      anchor: { kind: "message", uuid: uuidOf("u", 1), msg_start_with: "question 1" },
    });
    const { root, store } = await open([...exchange(1)], [onAnswer, onQuestion]);
    // The person stands at the question.
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, position: uuidOf("u", 1) },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    const mark = instanceOf(
      itemOf(root, uuidOf("a", 1)).querySelector(".tl-item-comments"),
      HTMLAnchorElement,
      "💬",
    );
    expect(mark.getAttribute("href")).toContain("filter=comment");
    expect(mark.getAttribute("href")).toContain(uuidOf("u", 1));
    await act(() => {
      mark.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
    });
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, filter: "comment" },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    const selected = [...root.querySelectorAll(".tl-bubble-comment[data-comment-selected]")].map(
      (bubble) => bubble.querySelector(".tl-comment-body")?.textContent,
    );
    expect(selected).toEqual(["答えに"]);
  });
});

describe("the agent's replies (comment_reply)", () => {
  const RECORDED = (replied: string, cid: string) =>
    `${replied} (「ここは?」) への返信を記録した。この返信の cid は ${cid} (人がこれに返信すると "on":"comment:${cid}" で届く)`;
  /** The rows of a `comment_reply` call `n` answering `replied` as `cid`. */
  const replyRows = (n: number, replied: string, cid: string, body: string) => [
    jsonl(
      assistantContentRow(
        [toolUseBlock(CCMSG_TOOLS.comment_reply, { cid: replied, body }, `toolu_r${String(n)}`)],
        { uuid: uuidOf("a", 700 + n), timestamp: "2030-01-01T00:00:05.000Z" },
      ),
    ),
    jsonl(
      userContentRow(
        [
          {
            type: "tool_result",
            tool_use_id: `toolu_r${String(n)}`,
            content: RECORDED(replied, cid),
          },
        ],
        { uuid: uuidOf("u", 700 + n), timestamp: "2030-01-01T00:00:05.000Z" },
      ),
    ),
  ];
  const delivered = comment({
    cid: "c0001",
    status: "delivered",
    row_uuid: uuidOf("u", 2),
    body: "ここは?",
    sent: { at: "2030-01-01T00:00:01.000Z" },
  });
  const kept = (cid: string, replied: string): CommentRecord => ({
    kind: "comment",
    author: "agent",
    cid,
    session_id: SID,
    anchor: { kind: "comment", cid: replied },
    body_start: "外の返信の先頭",
    written: { at: "2030-01-01T00:00:05.000Z" },
    updated_at: "2030-01-01T00:00:05.000Z",
    tool_use_id: "toolu_x",
  });

  /** The 💬 filter's items as they stand (by data-thread-order), each by
   * the body of its bubble, with "|" before one a line stands above. */
  const placed = (root: HTMLElement): string[] =>
    [...root.querySelectorAll(".tl-lines > .tl-item[data-thread-order]")]
      .map((item) => ({
        order: Number(item.getAttribute("data-thread-order")),
        text:
          (item.hasAttribute("data-thread-sep") ? "|" : "") +
          (item.querySelector(".tl-comment-body, .tl-bubble-comment-reply strong")?.textContent ??
            "?"),
      }))
      .sort((a, b) => a.order - b.order)
      .map((item) => item.text);

  // DR-0062 §12 (kawaz 2026-11-24): 返信で言い切った後の応答 (1 行で comment_reply_done を
  // 言うだけ) は、同じコメントへの 2 つ目の吹き出しにせず、畳みの中の項目にする。
  test("a one-line comment_reply_done after the reply folds as an item; a longer body stays a bubble", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "ここは?" },
    ]);
    const done = (n: number, text: string) =>
      jsonl(
        assistantContentRow([{ type: "text", text }], {
          uuid: uuidOf("a", 800 + n),
          timestamp: "2030-01-01T00:00:06.000Z",
        }),
      );
    const lines = (text: string) => [
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
      ...replyRows(1, "c0001", "c0011", "**返信 c0011**"),
      done(1, text),
    ];
    const records = [delivered, kept("c0011", "c0001")];

    const folded = await open(lines("\n`comment_reply_done`。\n"), records);
    expect(folded.root.querySelector(".tl-bubble-comment-reply strong")?.textContent).toBe(
      "返信 c0011",
    );
    // No bubble for it: a fold of one item stands after the reply.
    expect(
      folded.root.querySelectorAll(".tl-bubble-assistant:not(.tl-bubble-comment-reply)"),
    ).toHaveLength(1);
    const group = instanceOf(
      [...folded.root.querySelectorAll("details.tl-fold-group")].at(-1),
      HTMLDetailsElement,
      "the fold after the reply",
    );
    expect(group.querySelector(":scope > summary")?.textContent).toBe("1 items");
    await act(() => {
      group
        .querySelector(":scope > summary")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const item = instanceOf(
      group.querySelector(`[data-timeline-uuid="${uuidOf("a", 801)}"]`),
      HTMLElement,
      "the done response's row in the fold",
    );
    expect(item.querySelector(".tl-bubble")).toBeNull();
    expect(item.querySelector(".tl-fold-label")?.textContent).toBe("assistant: comment_reply_done");

    const spoken = await open(lines("comment_reply_done\nあと 1 点、xx も直した。"), records);
    const bubble = spoken.root.querySelector(
      `[data-timeline-uuid="${uuidOf("a", 801)}"] .tl-bubble-assistant`,
    );
    expect(bubble?.textContent).toContain("xx も直した");
    expect(spoken.root.querySelector(".tl-bubble-comment-reply strong")?.textContent).toBe(
      "返信 c0011",
    );
  });

  // DR-0062 §13、P10、kawaz 2026-11-23: 💬 のフィルタはスレッドごとに並べ、スレッドの間に
  // 線を引く。TL の普通の表示は transcript の順のまま (並びの位置を持たない)。
  test("under the 💬 filter, 3 comments sent together and their 3 replies stand by thread, lines between", async () => {
    const prompt = commentsPromptText(
      ["c0001", "c0002", "c0003"].map((cid) => ({
        comment: cid,
        on: { kind: "msg_start_with" as const, value: "answer 1" },
        body: `コメント ${cid}`,
      })),
    );
    const records = ["c0001", "c0002", "c0003"].map((cid) =>
      comment({ cid, status: "delivered", body: `コメント ${cid}`, row_uuid: uuidOf("u", 2) }),
    );
    const lines = [
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
      ...replyRows(1, "c0001", "c0011", "**返信 c0011**"),
      ...replyRows(2, "c0002", "c0012", "**返信 c0012**"),
      ...replyRows(3, "c0003", "c0013", "**返信 c0013**"),
    ];
    const kepts = [kept("c0011", "c0001"), kept("c0012", "c0002"), kept("c0013", "c0003")];
    const { root } = await open(lines, [...records, ...kepts], "comment");
    expect(placed(root)).toEqual([
      "コメント c0001",
      "返信 c0011",
      "|コメント c0002",
      "返信 c0012",
      "|コメント c0003",
      "返信 c0013",
    ]);
    // The Timeline without a filter keeps the transcript's order: no place.
    const plain = await open(lines, [...records, ...kepts]);
    expect(plain.root.querySelector("[data-thread-order], [data-thread-sep]")).toBeNull();
  });

  // DR-0062 §13 (kawaz 2026-11-24): 💬 のフィルタは人のコメントだけを並べ、エージェントの
  // 返信は選んだスレッドでだけ出す。人のコメントを押す (キーボードでも) とそのスレッドを
  // 選び、別のスレッドを選ぶと前のスレッドの返信は隠れる。スレッドの間に線がある。
  test("only the person's comments by default; one pressed opens its thread, another closes it", async () => {
    const prompt = commentsPromptText(
      ["c0001", "c0002", "c0003"].map((cid) => ({
        comment: cid,
        on: { kind: "msg_start_with" as const, value: "answer 1" },
        body: `コメント ${cid}`,
      })),
    );
    const records = ["c0001", "c0002", "c0003"].map((cid) =>
      comment({ cid, status: "delivered", body: `コメント ${cid}`, row_uuid: uuidOf("u", 2) }),
    );
    const lines = [
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
      ...replyRows(1, "c0001", "c0011", "**返信 c0011**"),
      ...replyRows(2, "c0002", "c0012", "**返信 c0012**"),
      ...replyRows(3, "c0003", "c0013", "**返信 c0013**"),
    ];
    const kepts = [kept("c0011", "c0001"), kept("c0012", "c0002"), kept("c0013", "c0003")];
    const { root } = await open(lines, [...records, ...kepts], "comment");
    const itemOf = (text: string): HTMLElement =>
      instanceOf(
        [...root.querySelectorAll(".tl-lines > .tl-item[data-thread-order]")].find(
          (item) =>
            (item.querySelector(".tl-comment-body, .tl-bubble-comment-reply strong")?.textContent ??
              "") === text,
        ),
        HTMLElement,
        text,
      );
    const open3 = () =>
      ["返信 c0011", "返信 c0012", "返信 c0013"].filter((text) =>
        itemOf(text).hasAttribute("data-thread-open"),
      );
    // The agent's side is marked and no thread is open: the CSS hides them.
    for (const text of ["返信 c0011", "返信 c0012", "返信 c0013"]) {
      expect(itemOf(text).hasAttribute("data-comment-agent")).toBe(true);
    }
    expect(open3()).toEqual([]);
    // A line above each thread but the first, on its person's comment.
    expect(
      ["コメント c0001", "コメント c0002", "コメント c0003"].map((text) =>
        itemOf(text).hasAttribute("data-thread-sep"),
      ),
    ).toEqual([false, true, true]);
    // A press of the comment (its text, not a control) opens its thread.
    await act(() => {
      itemOf("コメント c0002")
        .querySelector(".tl-comment-body")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(open3()).toEqual(["返信 c0012"]);
    // From the keyboard and assistive technology: the head's 「💬 コメント」 is
    // the thread's disclosure button (Enter / Space press it); the item itself
    // is not a control.
    const third = itemOf("コメント c0003");
    expect(third.hasAttribute("tabindex")).toBe(false);
    expect(third.hasAttribute("role")).toBe(false);
    const toggle = instanceOf(
      third.querySelector(".tl-comment-on > button.tl-comment-label"),
      HTMLButtonElement,
      "💬 コメント",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(() => toggle.click());
    expect(open3()).toEqual(["返信 c0013"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // A press on a control in the bubble (its 返信) selects nothing.
    const replyButton = instanceOf(
      itemOf("コメント c0001").querySelector(".tl-comment-reply"),
      HTMLButtonElement,
      "返信",
    );
    await act(() => {
      replyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(open3()).toEqual(["返信 c0013"]);
  });

  // DR-0062 §13 (kawaz 2026-11-24): 項目の 💬 から来た時は、その項目のコメントのスレッドが
  // 開いた (返信が出た) 状態で、ほかの項目のコメントのスレッドは閉じている。
  test("come by an item's 💬: the threads of its comments are open, another item's not", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "答えに" },
      { comment: "c0002", on: { kind: "msg_start_with", value: "question 1" }, body: "問いに" },
    ]);
    const records = [
      comment({ cid: "c0001", status: "delivered", body: "答えに", row_uuid: uuidOf("u", 2) }),
      comment({
        cid: "c0002",
        status: "delivered",
        body: "問いに",
        row_uuid: uuidOf("u", 2),
        anchor: { kind: "message", uuid: uuidOf("u", 1), msg_start_with: "question 1" },
      }),
      kept("c0011", "c0001"),
      kept("c0012", "c0002"),
    ];
    const lines = [
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
      ...replyRows(1, "c0001", "c0011", "**返信 c0011**"),
      ...replyRows(2, "c0002", "c0012", "**返信 c0012**"),
    ];
    const { root, store } = await open(lines, records);
    const mark = instanceOf(
      itemOf(root, uuidOf("a", 1)).querySelector(".tl-item-comments"),
      HTMLAnchorElement,
      "💬",
    );
    await act(() => {
      mark.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
    });
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, filter: "comment" },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    const opened = [...root.querySelectorAll(".tl-lines > .tl-item[data-comment-agent]")].map(
      (item) => [
        item.querySelector(".tl-bubble-comment-reply strong")?.textContent,
        item.hasAttribute("data-thread-open"),
      ],
    );
    expect(opened).toEqual([
      ["返信 c0011", true],
      ["返信 c0012", false],
    ]);
  });

  test("a reply to a reply and an unsent reply stand in their thread; a hidden thread leaves no line", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "一つ目" },
      { comment: "c0002", on: { kind: "msg_start_with", value: "answer 1" }, body: "二つ目" },
    ]);
    const records: CommentRecord[] = [
      comment({ cid: "c0001", status: "delivered", body: "一つ目", row_uuid: uuidOf("u", 2) }),
      comment({ cid: "c0002", status: "delivered", body: "二つ目", row_uuid: uuidOf("u", 2) }),
      kept("c0011", "c0001"),
      comment({
        cid: "c0021",
        body: "返信への返信 (未送信)",
        anchor: { kind: "comment", cid: "c0011" },
        written: { at: "2030-01-01T00:00:09.000Z" },
      }),
    ];
    const { root } = await open(
      [
        ...exchange(1),
        jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
        ...replyRows(1, "c0001", "c0011", "**返信 c0011**"),
      ],
      records,
      "comment",
    );
    expect(placed(root)).toEqual(["一つ目", "返信 c0011", "返信への返信 (未送信)", "|二つ目"]);
    // Without sent, the first thread shows its unsent reply alone, and the
    // second (all sent) is hidden with its line.
    const sentBox = instanceOf(
      [...root.querySelectorAll(".tl-comments-head label")]
        .find((label) => label.textContent === "sent")
        ?.querySelector("input"),
      HTMLInputElement,
      "sent",
    );
    await act(() => sentBox.click());
    expect(placed(root)).toEqual(["一つ目", "返信 c0011", "返信への返信 (未送信)", "二つ目"]);
  });

  test("a call recorded is the reply's bubble, and its 返信 answers the reply", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "ここは?" },
    ]);
    const { root, adds } = await open(
      [
        ...exchange(1),
        jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
        ...replyRows(1, "c0001", "c0002", "そう、**undefined** を返す"),
      ],
      [delivered, kept("c0002", "c0001")],
    );
    const bubble = instanceOf(
      root.querySelector(".tl-bubble-comment-reply"),
      HTMLElement,
      "the reply's bubble",
    );
    expect(bubble.querySelector(".tl-comment-reply-head")?.textContent).toContain("c0001 への返信");
    expect(bubble.querySelector(".tl-comment-reply-head .tl-comment-quote")?.textContent).toBe(
      "ここは?",
    );
    expect(bubble.querySelector("strong")?.textContent).toBe("undefined");
    expect(bubble.closest(".tl-item")?.getAttribute("data-notif")).toBe("comment");
    const place = instanceOf(
      bubble.querySelector(".tl-comment-place"),
      HTMLButtonElement,
      "元のコメントへ",
    );
    expect(place.textContent).toBe("元のコメントへ");
    const item = instanceOf(bubble.closest(".tl-item"), HTMLElement, "the reply's item");
    await replyOn(item, "ありがとう");
    expect(adds).toEqual([
      {
        anchor: { kind: "comment", cid: "c0002" },
        body: "ありがとう",
        attachments: [],
        btw: false,
        sendNow: false,
      },
    ]);
  });

  // DR-0062 §12 (kawaz 2026-11-24): 返信の続き (それに返信した人のコメント) と返信の間に別の
  // 項目が挟まっている時だけ、返信の吹き出しの下端の真ん中に「↓続きへ↓」を出し、押すと続きの
  // 行へ移る。すぐ下に続きがある時・続きが無い時は出さない。続きが 2 つあれば古い方へ移る。
  // DR-0062 §13 (kawaz 2026-11-24): スレッドの 2 つ目の人のコメント (返信への返信) を持つ
  // 並び。先頭を押すと開き、もう一度押すと閉じる。2 つ目を押しても閉じない。開いたスレッドの
  // 項目は高さを抑えず、閉じたスレッドの人のコメントは本文の字だけを抑える。番号「1 / 2」。
  describe("a thread of two of the person's comments", () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "一つ目" },
    ]);
    const second = commentsPromptText([
      { comment: "c0021", on: { kind: "comment", value: "c0011" }, body: "二つ目" },
    ]);
    const lines = [
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
      ...replyRows(1, "c0001", "c0011", "**返信 c0011**"),
      ...exchange(3),
      jsonl(userContentRow(second, { uuid: uuidOf("u", 4) })),
    ];
    const records = [
      comment({
        cid: "c0001",
        status: "delivered",
        body: "一つ目",
        row_uuid: uuidOf("u", 2),
        sent: { at: "2030-01-01T00:00:01.000Z" },
      }),
      kept("c0011", "c0001"),
      comment({
        cid: "c0021",
        status: "delivered",
        body: "二つ目",
        anchor: { kind: "comment", cid: "c0011" },
        row_uuid: uuidOf("u", 4),
        sent: { at: "2030-01-01T00:00:09.000Z" },
      }),
    ];
    const itemWith = (root: HTMLElement, text: string): HTMLElement =>
      instanceOf(
        [...root.querySelectorAll(".tl-lines > .tl-item")].find(
          (item) =>
            (item.querySelector(".tl-comment-body, .tl-bubble-comment-reply strong")?.textContent ??
              "") === text,
        ),
        HTMLElement,
        text,
      );
    const press = (item: HTMLElement) =>
      act(() => {
        item
          .querySelector(".tl-comment-body")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

    test("the first comment pressed opens the thread, pressed again closes it; the second does not close it", async () => {
      const { root } = await open(lines, records, "comment");
      const reply = () => itemWith(root, "返信 c0011").hasAttribute("data-thread-open");
      expect(reply()).toBe(false);
      await press(itemWith(root, "一つ目"));
      expect(reply()).toBe(true);
      await press(itemWith(root, "二つ目"));
      expect(reply()).toBe(true);
      await press(itemWith(root, "一つ目"));
      expect(reply()).toBe(false);
      // The head's disclosure button does the same, and says the state.
      const toggle = instanceOf(
        itemWith(root, "一つ目").querySelector("button.tl-comment-label"),
        HTMLButtonElement,
        "💬 コメント",
      );
      // The heads, as assistive technology reads them: a button with its
      // state, or a label.
      const heads = () =>
        ["一つ目", "二つ目"].map((text) => {
          const head = itemWith(root, text).querySelector(".tl-comment-on > .tl-comment-label");
          return head instanceof HTMLButtonElement
            ? `button ${head.getAttribute("aria-expanded") ?? ""}`
            : (head?.tagName.toLowerCase() ?? null);
        });
      // Closed: every comment's head opens it.
      expect(heads()).toEqual(["button false", "button false"]);
      await act(() => toggle.click());
      expect(reply()).toBe(true);
      // Open: the first comment's head closes it; a later one's is a label
      // (a press of it closes nothing), not a disclosure that does not close.
      expect(heads()).toEqual(["button true", "span"]);
      await act(() => toggle.click());
      expect([reply(), toggle.getAttribute("aria-expanded")]).toEqual([false, "false"]);
      // Opened from the second comment: the same.
      const secondToggle = instanceOf(
        itemWith(root, "二つ目").querySelector("button.tl-comment-label"),
        HTMLButtonElement,
        "💬 コメント (2 つ目)",
      );
      await act(() => secondToggle.click());
      expect([reply(), ...heads()]).toEqual([true, "button true", "span"]);
    });

    test("an open thread's items are not clamped; a closed thread's comment clamps its text only", async () => {
      const style = document.createElement("style");
      const css = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
      style.textContent = css.replace(/\s+/g, " ");
      document.head.append(style);
      try {
        const { root } = await open(lines, records, "comment");
        const first = itemWith(root, "一つ目");
        const maxHeight = (item: HTMLElement, selector: string) =>
          getComputedStyle(instanceOf(item.querySelector(selector), HTMLElement, selector))
            .maxHeight;
        // Closed: the text is held to its height; the bubble's head and its
        // 返信 are outside it.
        expect(maxHeight(first, ".tl-comment-body")).toBe("8lh");
        expect(maxHeight(first, ".tl-bubble-body")).not.toBe("8lh");
        await press(first);
        expect(maxHeight(first, ".tl-comment-body")).not.toBe("8lh");
        expect(maxHeight(itemWith(root, "返信 c0011"), ".tl-bubble-body")).not.toBe("8lh");
      } finally {
        style.remove();
      }
    });

    test("「1 / 2」 on the person's comments and on the reply (its comment's number), in and out of the filter; read as 2 件中 1 件目", async () => {
      for (const filter of ["comment", null] as const) {
        const { root } = await open(lines, records, filter);
        const numberOf = (text: string) => {
          const mark = itemWith(root, text).querySelector(".tl-thread-number");
          return mark === null
            ? null
            : [mark.getAttribute("data-label"), mark.getAttribute("aria-label")];
        };
        expect(numberOf("一つ目")).toEqual(["1 / 2", "2 件中 1 件目"]);
        expect(numberOf("返信 c0011")).toEqual(["1 / 2", "2 件中 1 件目"]);
        expect(numberOf("二つ目")).toEqual(["2 / 2", "2 件中 2 件目"]);
      }
    });

    test("a thread of one comment has no number", async () => {
      const { root } = await open(lines.slice(0, -3), records.slice(0, 2), "comment");
      expect(root.querySelector(".tl-thread-number")).toBeNull();
    });
  });

  // DR-0062 §13 (kawaz 2026-11-24): 返信先の人のコメントが一覧に無いエージェントの返信は、
  // 開く手段が無いので隠さずに自分の位置に出す。それしか無い時も「コメントはありません」に
  // しない (判定は並びの見える決まりと同じ)。
  test("an agent's reply whose person's comment is not listed stands shown, and the filter is not empty", async () => {
    const { root } = await open(
      [...exchange(1), ...replyRows(1, "c0099", "c0011", "**返信 c0011**")],
      [kept("c0011", "c0099")],
      "comment",
    );
    const item = instanceOf(
      root.querySelector(".tl-bubble-comment-reply")?.closest(".tl-item"),
      HTMLElement,
      "the reply's item",
    );
    expect(item.hasAttribute("data-comment-agent")).toBe(false);
    expect(root.querySelector(".tl-filter-empty")).toBeNull();
  });

  describe("「↓続きへ↓」", () => {
    const answered = (cid: string, uuid: string, sentAt: string) =>
      comment({
        cid,
        status: "delivered",
        body: `続き ${cid}`,
        anchor: { kind: "comment", cid: "c0011" },
        row_uuid: uuid,
        sent: { at: sentAt },
      });
    const continued = (cid: string, n: number) =>
      jsonl(
        userContentRow(
          commentsPromptText([
            { comment: cid, on: { kind: "comment", value: "c0011" }, body: `続き ${cid}` },
          ]),
          { uuid: uuidOf("u", n) },
        ),
      );
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "ここは?" },
    ]);
    const head = [
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
      ...replyRows(1, "c0001", "c0011", "返信 c0011"),
    ];
    const nextOf = (root: HTMLElement): HTMLButtonElement | null => {
      const bubble = instanceOf(
        root.querySelector(".tl-bubble-comment-reply"),
        HTMLElement,
        "the reply's bubble",
      );
      const next = bubble.querySelector(".tl-comment-reply-row > .tl-comment-next");
      return next === null ? null : instanceOf(next, HTMLButtonElement, "↓続きへ↓");
    };

    test("another conversation between: shown, and a press moves to the next comment's row", async () => {
      const { root } = await open(
        [...head, ...exchange(3), continued("c0021", 4)],
        [
          delivered,
          kept("c0011", "c0001"),
          answered("c0021", uuidOf("u", 4), "2030-01-01T00:00:09.000Z"),
        ],
      );
      const next = nextOf(root);
      expect(next?.getAttribute("aria-label")).toBe("続きへ");
      const urls: string[] = [];
      restores.push(
        stubGlobal("navigation", {
          currentEntry: null,
          navigate: (url: string) => {
            urls.push(url);
          },
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
      );
      await act(() => next?.click());
      expect(urls.length).toBe(1);
      expect(urls[0]).toContain(uuidOf("u", 4));
    });

    test("the next comment right below (past the fold of comment_reply_done): none", async () => {
      const done = jsonl(
        assistantContentRow([textBlock("comment_reply_done")], { uuid: uuidOf("a", 800) }),
      );
      const { root } = await open(
        [...head, done, continued("c0021", 4)],
        [
          delivered,
          kept("c0011", "c0001"),
          answered("c0021", uuidOf("u", 4), "2030-01-01T00:00:09.000Z"),
        ],
      );
      expect(root.querySelector(".tl-fold-group")).not.toBeNull();
      expect(nextOf(root)).toBeNull();
    });

    test("under the 💬 filter (a thread stands together there): none", async () => {
      const { root } = await open(
        [...head, ...exchange(3), continued("c0021", 4)],
        [
          delivered,
          kept("c0011", "c0001"),
          answered("c0021", uuidOf("u", 4), "2030-01-01T00:00:09.000Z"),
        ],
        "comment",
      );
      expect(nextOf(root)).toBeNull();
    });

    test("no reply to it: none", async () => {
      const { root } = await open([...head, ...exchange(3)], [delivered, kept("c0011", "c0001")]);
      expect(nextOf(root)).toBeNull();
    });

    test("two replies to it: the older one's row", async () => {
      const { root } = await open(
        [...head, ...exchange(3), continued("c0021", 4), ...exchange(5), continued("c0022", 6)],
        [
          delivered,
          kept("c0011", "c0001"),
          answered("c0022", uuidOf("u", 6), "2030-01-01T00:00:20.000Z"),
          answered("c0021", uuidOf("u", 4), "2030-01-01T00:00:09.000Z"),
        ],
      );
      const urls: string[] = [];
      restores.push(
        stubGlobal("navigation", {
          currentEntry: null,
          navigate: (url: string) => {
            urls.push(url);
          },
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
      );
      await act(() => nextOf(root)?.click());
      expect(urls.length).toBe(1);
      expect(urls[0]).toContain(uuidOf("u", 4));
    });
  });

  test("the 🔍 search finds the reply's body, as a response's", async () => {
    const { root, store } = await open(
      [...exchange(1), ...replyRows(1, "c0001", "c0002", "検索で見つける返信の本文")],
      [delivered, kept("c0002", "c0001")],
      "search",
    );
    await act(() => {
      store.dispatch({
        type: "timeline/search-changed",
        sid: SID,
        search: { queryText: "見つける返信", caseSensitive: false, regex: false },
      });
    });
    expect(root.querySelector(".tl-search-form-count")?.textContent).toBe(
      "一致 1 項目 (読み込み済みの範囲)",
    );
    const bubble = instanceOf(
      root.querySelector(".tl-bubble-comment-reply"),
      HTMLElement,
      "the reply's bubble",
    );
    expect(bubble.querySelector("[data-search-key]")?.textContent).toContain("見つける返信");
  });

  test("a call refused is no reply's bubble", async () => {
    const { root } = await open([
      ...exchange(1),
      jsonl(
        assistantContentRow([
          toolUseBlock(CCMSG_TOOLS.comment_reply, { cid: "c0001", body: "x" }, "toolu_r9"),
        ]),
      ),
      jsonl(
        userContentRow([
          {
            type: "tool_result",
            tool_use_id: "toolu_r9",
            content: "cid c0001 はこのセッションの本体に届いたコメントに無いので記録していない。",
          },
        ]),
      ),
    ]);
    expect(root.querySelector(".tl-bubble-comment-reply")).toBeNull();
  });

  test("under the 💬 filter, a reply in the window stays, and one outside it is drawn from its record", async () => {
    const { root } = await open(
      [...exchange(1), ...replyRows(1, "c0001", "c0002", "窓の中の返信")],
      [delivered, kept("c0002", "c0001"), kept("c0003", "c0002")],
      "comment",
    );
    const bodies = [...root.querySelectorAll(".tl-bubble-comment-reply")].map(
      (b) => b.querySelector(".tl-comment-body, .tl-text")?.textContent?.trim() ?? "",
    );
    expect(bodies).toContain("窓の中の返信");
    expect(bodies).toContain("外の返信の先頭");
  });

  // 何を保証するか (DR-0062 §6、P14、kawaz 2026-11-24): スレッドの解決のボタンは吹き出しの
  // 内側の下端の行の右端に立ち、「返信」を持つ吹き出し (送ったコメント、comment_reply の応答、
  // 記録から描く窓の外の応答) では「返信」のすぐ左、持たない吹き出し (未送信のコメント) では
  // ボタンだけ。吹き出しの外の足元には無い。
  test("the thread's ✔️ stands just left of 返信 in the body's bottom row, alone where there is no 返信", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "ここは?" },
    ]);
    const rowEnd = (bubble: Element | null): string[] =>
      [
        ...(bubble?.querySelectorAll(
          ".tl-bubble-body > .tl-comment-reply-row > .tl-comment-reply-end > button",
        ) ?? []),
      ].map((button) => button.className);
    const unsent = comment({ cid: "c0003", body: "まだ送らない" });
    const { root } = await open(
      [
        ...exchange(1),
        jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
        ...replyRows(1, "c0001", "c0002", "そう"),
      ],
      [delivered, kept("c0002", "c0001"), unsent],
      "comment",
    );
    const sent = [...root.querySelectorAll(".tl-bubble-comment:not([data-unsent])")];
    expect(sent).toHaveLength(1);
    expect(rowEnd(sent[0] ?? null)).toEqual(["tl-comment-resolve", "tl-comment-reply"]);
    expect(rowEnd(root.querySelector(".tl-bubble-comment-reply"))).toEqual([
      "tl-comment-resolve",
      "tl-comment-reply",
    ]);
    expect(rowEnd(root.querySelector(".tl-bubble-comment[data-unsent]"))).toEqual([
      "tl-comment-resolve",
    ]);
    expect(root.querySelector(".tl-bubble-footer .tl-comment-resolve")).toBeNull();

    // The reply outside the window, drawn from its record.
    const outside = await open(
      [...exchange(1)],
      [
        comment({
          cid: "c0001",
          status: "delivered",
          sent: { at: "2029-12-31T00:00:00.000Z", after_uuid: "older-row" },
          row_uuid: "older-row",
        }),
        kept("c0002", "c0001"),
      ],
      "comment",
    );
    const recorded = outside.root.querySelector(".tl-bubble-comment-reply");
    expect(recorded?.querySelector(".tl-comment-body")?.textContent).toBe("外の返信の先頭");
    expect(rowEnd(recorded)).toEqual(["tl-comment-resolve", "tl-comment-reply"]);
    expect(outside.root.querySelector(".tl-bubble-footer .tl-comment-resolve")).toBeNull();
  });
});
