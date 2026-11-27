// A resolved thread's items on the Timeline, mounted (DR-0062 §12「解決済みのスレッドの
// 吹き出しの畳み」, P36, P37, kawaz 2026-11-26).
// 何を保証するか:
//   - フィルタの無い TL で、解決済みのスレッドの項目 (届いた人のコメント、行が出る前に記録から
//     描く送ったコメント、comment_reply の応答、btw の問答) は、中身が 1 行だけの吹き出しの形の
//     ボタン (aria-expanded="false"、名前は「✅ 解決済み: <本文の冒頭>」) になり、本文の 2 行目
//     以降・頭の行・足元の行を持たない (元の吹き出しは描かない)。人のコメントは右、エージェントの
//     側は左の吹き出しの形
//   - 畳んだ吹き出しは 1 項目に 1 つで、まとめて送ったコメントは吹き出しごとに畳む。畳みの前後で
//     TL の項目の数・位置 (data-timeline-uuid)・fold の切れ目は変わらない
//   - 押すとその 1 項目だけが元の吹き出しに戻り (同じスレッドの他の項目は畳んだまま)、
//     comment_resolve も他の op も送らない。フォーカスは開いた項目の包みに移る
//   - どのフィルタの中でも畳まない (P36)
//   - 解決を外す (別のデバイスからの知らせも、新しい記録で daemon が外したのも同じ
//     comment_thread の push) と、スレッドの項目は全部吹き出しに戻る。付け直すと、開いていた
//     項目も畳んだ形になる。見ている間に解決済みになった項目は縮む動きの印 (data-fold-motion)
//     を持ち、読み込んだ時から解決済みの項目は持たない
//   - 畳んだ項目の位置へ来る (URL の位置) と、開いて着地する
//   - 解決済みのスレッドのコメントは、コメントの付いた項目の 💬 の数に入らない。解決を外すと戻る
// 該当なし: 縦に伸び縮みする動きそのものとスクロール位置は happy-dom に描画が無いので
// 測れない (e2e の resolved-fold で Chromium と WebKit の実物で測る)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  CCMSG_TOOLS,
  commentsPromptText,
  type BtwAnswer,
  type CommentRecord,
  type QueueSendItem,
  type ThreadState,
  type UserComment,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
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
let restores: Array<() => void> = [];
let navigations: string[] = [];

beforeEach(() => {
  navigations = [];
  restores = [
    stubGlobal("localStorage", new MemStorage()),
    stubGlobal("navigation", {
      currentEntry: null,
      navigate(url: string) {
        navigations.push(url);
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  ];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
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

const drained = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));

function comment(patch: Partial<UserComment> & Pick<UserComment, "cid">): UserComment {
  return {
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: { kind: "message", uuid: uuidOf("a", 1), msg_start_with: "answer 1" },
    body: "ここは?",
    written: { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) },
    sent: { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) },
    updated_at: "2030-01-01T00:00:01.000Z",
    btw: false,
    status: "delivered",
    ...patch,
  };
}

const RECORDED = (replied: string, cid: string) =>
  `${replied} (「ここは?」) への返信を記録した。この返信の cid は ${cid} (人がこれに返信すると "on":"comment:${cid}" で届く)`;

/** The rows of a `comment_reply` call `n` answering `replied` as `cid`. */
function replyRows(n: number, replied: string, cid: string, body: string): string[] {
  return [
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
}

function reply(cid: string, replied: string): CommentRecord {
  return {
    kind: "comment",
    author: "agent",
    cid,
    session_id: SID,
    anchor: { kind: "comment", cid: replied },
    body_start: "返信の冒頭",
    written: { at: "2030-01-01T00:00:05.000Z" },
    updated_at: "2030-01-01T00:00:05.000Z",
    tool_use_id: "toolu_r1",
  };
}

const resolvedThread = (root: string): ThreadState => ({
  kind: "thread",
  session_id: SID,
  root,
  resolved_at: "2030-01-01T00:00:09.000Z",
});
const openThread = (root: string): ThreadState => ({ kind: "thread", session_id: SID, root });

/** The person's comment c0001 on answer 1 (row u2), the agent's reply c0011
 * to it (row a701), then another exchange. */
const PROMPT = commentsPromptText([
  { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "一つ目の\n\n  話" },
]);
const ROWS = [
  ...exchange(1),
  jsonl(userContentRow(PROMPT, { uuid: uuidOf("u", 2) })),
  ...replyRows(1, "c0001", "c0011", "**返信** c0011\n\n二段落目"),
  ...exchange(3),
];
const RECORDS = [comment({ cid: "c0001", row_uuid: uuidOf("u", 2) }), reply("c0011", "c0001")];

interface Opened {
  root: HTMLElement;
  store: Store;
  /** Every comment op asked of the daemon, by name. */
  ops: string[];
}

async function open(
  options: {
    rows?: readonly string[];
    records?: readonly CommentRecord[];
    threads?: readonly ThreadState[];
    filter?: TimelineFilter | null;
    position?: string;
  } = {},
): Promise<Opened> {
  const store = timelineStore();
  const filter = options.filter ?? null;
  if (filter !== null || options.position !== undefined) {
    store.dispatch({
      type: "locator/changed",
      locator: {
        view: "timeline",
        sid: SID,
        ...(options.position !== undefined ? { position: options.position } : {}),
        ...(filter !== null ? { filter } : {}),
      },
      sidebar: CLOSED_SIDEBAR,
    });
  }
  store.dispatch({
    type: "comments/loaded",
    readMarks: [],
    sid: SID,
    comments: [...(options.records ?? RECORDS)],
    threads: [...(options.threads ?? [resolvedThread("c0001")])],
    drafts: [],
  });
  const ws = new FakeTranscriptWs(store);
  // The ops a press could ask: comment_resolve is the one the folded bubble
  // must not, and the rest (comment_add, queue_send, …) go to the harness's
  // client, which is not connected and rejects them (a test would see one).
  const ops: string[] = [];
  const handle = {
    ...ws.handle,
    commentResolve: (_sid: string, cid: string) => {
      ops.push(`comment_resolve ${cid}`);
      return Promise.resolve({ ok: true as const, thread: openThread("c0001") });
    },
    queueSend: (_sid: string, items: readonly QueueSendItem[]) => {
      ops.push(`queue_send ${String(items.length)}`);
      return Promise.resolve({ ok: true as const, results: [] });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...(options.rows ?? ROWS)]));
  return { root, store, ops };
}

function lines(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-lines"), HTMLElement, ".tl-lines");
}

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    lines(root).querySelector(`:scope > [data-timeline-uuid="${uuid}"]`),
    HTMLElement,
    `item ${uuid}`,
  );
}

/** The one-line bubble an item is folded to, or null. */
function foldOf(item: Element): HTMLButtonElement | null {
  const folds = item.querySelectorAll(":scope > .tl-item-fold");
  expect(folds.length).toBeLessThanOrEqual(1);
  const fold = folds[0];
  return fold === undefined ? null : instanceOf(fold, HTMLButtonElement, "the folded bubble");
}

/** What the Timeline stands of: each item's position (or none) and fold
 * group, in order. */
function shape(root: HTMLElement): string[] {
  return [...lines(root).children].flatMap((child) =>
    child.classList.contains("tl-item")
      ? [`item ${child.getAttribute("data-timeline-uuid") ?? "-"}`]
      : child.classList.contains("tl-fold-group")
        ? ["fold"]
        : [],
  );
}

async function push(store: Store, thread: ThreadState) {
  await act(() => store.dispatch({ type: "comment-thread/changed", thread }));
}

describe("a resolved thread's items, on the Timeline without a filter", () => {
  test("each is a bubble of one line: 「✅ 解決済み: <start>」, a button, not its bubble", async () => {
    const { root } = await open();
    const asked = itemOf(root, uuidOf("u", 2));
    const answered = itemOf(root, uuidOf("a", 701));
    for (const [item, line, side] of [
      [asked, "✅ 解決済み: 一つ目の 話", "tl-bubble-right"],
      [answered, "✅ 解決済み: **返信** c0011 二段落目", "tl-bubble-left"],
    ] as const) {
      const fold = foldOf(item);
      expect(fold?.getAttribute("type")).toBe("button");
      expect(fold?.getAttribute("aria-expanded")).toBe("false");
      // The name is the words seen; the brackets are CSS's, not in it.
      expect(fold?.textContent).toBe(line);
      expect(fold?.classList.contains(side)).toBe(true);
      // Its bubble is not drawn: no head, text, 返信 or foot.
      for (const selector of [
        ".tl-comment-on",
        ".tl-comment-body",
        ".tl-comment-reply-row",
        ".tl-bubble-footer",
        ".md",
      ]) {
        expect(item.querySelector(selector)).toBeNull();
      }
    }
  });

  test("folding leaves the items, their positions and the folds between them as they are", async () => {
    const unresolved = await open({ threads: [] });
    const before = shape(unresolved.root);
    await mounted.unmount();
    const resolved = await open();
    expect(shape(resolved.root)).toEqual(before);
    expect(foldOf(itemOf(resolved.root, uuidOf("u", 2)))).not.toBeNull();
  });

  test("pressed, that one item opens to its bubble, the rest of the thread stays folded, nothing is asked", async () => {
    const { root, ops } = await open();
    const asked = itemOf(root, uuidOf("u", 2));
    await act(() => foldOf(asked)?.click());
    expect(foldOf(asked)).toBeNull();
    expect(asked.querySelector(".tl-comment-body")?.textContent).toContain("一つ目の");
    // Still resolved: its ✅ says so.
    expect(asked.querySelector(".tl-comment-resolve")?.getAttribute("aria-pressed")).toBe("true");
    expect(foldOf(itemOf(root, uuidOf("a", 701)))).not.toBeNull();
    expect(ops).toEqual([]);
    // The focus goes to the item opened, which takes it from the program only.
    expect(document.activeElement).toBe(asked);
    expect(asked.tabIndex).toBe(-1);
    // A press, not a position chosen.
    expect(asked.classList.contains("tl-position-selected")).toBe(false);
    expect(navigations).toEqual([]);
  });

  test("a prompt of two comments folds each by its own thread", async () => {
    const prompt = commentsPromptText([
      { comment: "c0001", on: { kind: "msg_start_with", value: "answer 1" }, body: "済んだ話" },
      { comment: "c0002", on: { kind: "msg_start_with", value: "answer 1" }, body: "続く話" },
    ]);
    const { root } = await open({
      rows: [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      records: [
        comment({ cid: "c0001", row_uuid: uuidOf("u", 2), body: "済んだ話" }),
        comment({ cid: "c0002", row_uuid: uuidOf("u", 2), body: "続く話" }),
      ],
    });
    const items = [
      ...lines(root).querySelectorAll(`:scope > [data-timeline-uuid="${uuidOf("u", 2)}"]`),
    ];
    expect(items.map((item) => foldOf(item)?.textContent ?? null)).toEqual([
      "✅ 解決済み: 済んだ話",
      null,
    ]);
    expect(items[1]?.querySelector(".tl-comment-body")?.textContent).toBe("続く話\n");
  });

  test("a comment sent and not seen yet, and a btw, fold as well", async () => {
    const question: UserComment = comment({
      cid: "c0041",
      anchor: { kind: "timing" },
      body: "xx て何?",
      btw: true,
      status: "sent",
    });
    const answer: BtwAnswer = {
      kind: "comment",
      author: "btw",
      cid: "c0042",
      session_id: SID,
      anchor: { kind: "comment", cid: "c0041" },
      body: "答えの文",
      written: { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) },
      updated_at: "2030-01-01T00:00:02.000Z",
      status: "done",
    };
    const { root } = await open({
      rows: [...exchange(1), ...exchange(3)],
      records: [comment({ cid: "c0031", status: "sent", body: "送った話" }), question, answer],
      threads: [resolvedThread("c0031"), resolvedThread("c0041")],
    });
    const folds = [...lines(root).querySelectorAll(":scope > .tl-item > .tl-item-fold")];
    expect(folds.map((fold) => fold.textContent).sort()).toEqual([
      "✅ 解決済み: xx て何?",
      "✅ 解決済み: 送った話",
    ]);
    expect(root.querySelector(".tl-btw")).toBeNull();
    expect(root.querySelector(".tl-bubble-comment")).toBeNull();
    // One btw, one folded bubble: its question and answer are one item.
    const btwItem = instanceOf(
      folds.find((fold) => fold.textContent === "✅ 解決済み: xx て何?")?.parentElement,
      HTMLElement,
      "the btw's item",
    );
    await act(() => foldOf(btwItem)?.click());
    expect(btwItem.querySelector(".tl-btw .tl-btw-answer")?.textContent).toContain("答えの文");
  });
});

describe("the filters do not fold (P36)", () => {
  test("the 💬 filter with resolved checked, and the 👤 filter, show the bubbles", async () => {
    for (const filter of ["comment", "prompt"] as const) {
      const { root } = await open({ filter });
      if (filter === "comment") {
        const box = instanceOf(
          [...root.querySelectorAll(".tl-comments-head label")]
            .find((label) => label.textContent === "resolved")
            ?.querySelector("input"),
          HTMLInputElement,
          "resolved",
        );
        await act(() => box.click());
      }
      const asked = itemOf(root, uuidOf("u", 2));
      expect(foldOf(asked)).toBeNull();
      expect(asked.querySelector(".tl-comment-body")?.textContent).toContain("一つ目の");
      expect(root.querySelector(".tl-item-fold")).toBeNull();
      await mounted.unmount();
    }
  });
});

describe("taken off and put on again", () => {
  test("taken off, every item of the thread is its bubble; put on, all fold, the one opened too", async () => {
    const { root, store } = await open();
    const asked = itemOf(root, uuidOf("u", 2));
    const answered = itemOf(root, uuidOf("a", 701));
    // Drawn folded from the start: no motion.
    expect(asked.hasAttribute("data-fold-motion")).toBe(false);
    await act(() => foldOf(asked)?.click());
    await push(store, openThread("c0001"));
    expect(foldOf(asked)).toBeNull();
    expect(foldOf(answered)).toBeNull();
    expect(answered.querySelector(".tl-bubble-comment-reply .md")?.textContent).toContain(
      "二段落目",
    );
    await push(store, resolvedThread("c0001"));
    expect(foldOf(asked)?.textContent).toBe("✅ 解決済み: 一つ目の 話");
    expect(foldOf(answered)).not.toBeNull();
    // Resolved while seen: each shrinks to its line.
    expect(asked.getAttribute("data-fold-motion")).toBe("close");
    expect(answered.getAttribute("data-fold-motion")).toBe("close");
    // Kept drawn, hidden (its state is kept).
    expect(asked.querySelector(".tl-bubble-comment")).not.toBeNull();
  });

  test("a press opens with the motion of opening", async () => {
    const { root } = await open();
    const asked = itemOf(root, uuidOf("u", 2));
    await act(() => foldOf(asked)?.click());
    expect(asked.getAttribute("data-fold-motion")).toBe("open");
  });
});

describe("a position on a folded item (P37)", () => {
  test("landing on it opens it", async () => {
    const { root } = await open({ position: uuidOf("a", 701) });
    await drained();
    await drained();
    const answered = itemOf(root, uuidOf("a", 701));
    expect(foldOf(answered)).toBeNull();
    expect(answered.querySelector(".tl-bubble-comment-reply .md")?.textContent).toContain("返信");
    expect(answered.classList.contains("tl-position-selected")).toBe(true);
    // The landing opens without the motion of a press.
    expect(answered.hasAttribute("data-fold-motion")).toBe(false);
    expect(foldOf(itemOf(root, uuidOf("u", 2)))).not.toBeNull();
  });
});

describe("the 💬 of an item counts no comment of a resolved thread (DR-0062 §12)", () => {
  test("none while resolved, back once taken off", async () => {
    const { root, store } = await open();
    const answer = itemOf(root, uuidOf("a", 1));
    expect(answer.querySelector(":scope > .tl-item-comments")).toBeNull();
    await push(store, openThread("c0001"));
    expect(answer.querySelector(":scope > .tl-item-comments")?.textContent).toBe("💬1");
  });
});
