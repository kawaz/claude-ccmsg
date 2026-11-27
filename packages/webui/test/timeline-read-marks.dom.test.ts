// The read marks of a session's Timeline, mounted (DR-0068 §2, §3, §5, §6):
// the 既読 of an agent's response, and the items folded while read.
// 何を保証するか:
//   - メインの会話の応答の吹き出しは、本文の一番下の「返信」のすぐ左に既読のボタンを 1 つ
//     持つ (既読でない時は「既読にする」、既読の時は「既読を外す」、押されているかは
//     aria-pressed)。say と許可依頼の吹き出しには 2 つ目の「既読」を足さない。agent の TL の
//     応答には出さない
//   - 押すと read_mark_set を 1 つ送り、確認を挟まない。daemon の push (ev:"read_mark") が
//     来るまで見え方を変えない (非楽観)。断られた理由はボタンの下の段に出す
//   - 既読の応答・未読でない say (メインの会話のものと合流した worker のもの)・未読でない
//     許可依頼は、フィルタの無い TL で中身が 1 行だけの吹き出し (「✅ 既読: <冒頭>」の名前の
//     ボタン) になり、元の吹き出しは描かない。未読の say と許可依頼、既読でない応答、
//     PushNotification、agent の TL の項目は畳まない
//   - どのフィルタの中でも元の吹き出しで出す
//   - 畳んだ吹き出しを押すと元の吹き出しに戻り、op を 1 つも送らない。見ている間に既読に
//     なった応答は縮む動きの印を持つ。既読を外すと元の吹き出しに戻り、付け直すと開いていた
//     ことを忘れて畳んだ形から始まる
//   - 既読の付け外しの前後で、TL の項目の数・位置 (data-timeline-uuid)・fold の切れ目は
//     変わらない
//   - 畳んだ応答の位置へ来る (URL の位置) と、開いて着地する
// 該当なし: 縦に伸び縮みする動きそのものは happy-dom に描画が無いので測れない (e2e の
// read-fold で実物で測る)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  CCMSG_TOOLS,
  type AgentSay,
  type ReplyOf,
  type UnreadPermit,
  type UnreadSay,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef, TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { assistantContentRow, line as jsonl } from "../../protocol/test/transcript-rows.ts";
import { instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { permitRows } from "./permit-rows.ts";
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

function TimelineOf({ agent }: { agent: AgentRef | null }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent,
    active: true,
    visible: true,
  });
}

const drained = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** The row of a `say` call `n` (`toolu_s<n>`). */
function sayRow(n: number): string {
  return jsonl(
    assistantContentRow(
      [
        {
          type: "tool_use",
          id: `toolu_s${String(n)}`,
          name: CCMSG_TOOLS.say,
          input: { text: `said ${String(n)}` },
        },
      ],
      { uuid: uuidOf("a", 300 + n), timestamp: `2030-01-01T00:00:0${String(n)}.000Z` },
    ),
  );
}

function unreadSay(n: number): UnreadSay {
  return {
    session_id: SID,
    tool_use_id: `toolu_s${String(n)}`,
    ts: `2030-01-01T00:00:0${String(n)}.000Z`,
  };
}

/** The row of a PushNotification call. */
const PUSH_ROW = jsonl(
  assistantContentRow(
    [{ type: "tool_use", id: "toolu_push", name: "PushNotification", input: { message: "通知" } }],
    { uuid: uuidOf("a", 400), timestamp: "2030-01-01T00:00:08.000Z" },
  ),
);

function unreadPermit(id: string): UnreadPermit {
  return { session_id: SID, tool_use_id: id, ts: "2030-01-01T00:00:00.000Z" };
}

/** Two exchanges, a say, a request for permission, a PushNotification. */
const ROWS = [
  ...exchange(1),
  sayRow(1),
  ...permitRows(1, "toolu_p1", { blocked: "止められた行動の文", intents: ["y"] }),
  PUSH_ROW,
  ...exchange(2),
];

interface Opened {
  root: HTMLElement;
  store: Store;
  /** Every read_mark_set asked, as `<uuid> <read>`, and any other op. */
  ops: string[];
}

async function open(
  options: {
    rows?: readonly string[];
    /** The responses read as the Timeline is looked at (ev:"comments"). */
    read?: readonly string[];
    says?: readonly UnreadSay[];
    agentSays?: readonly AgentSay[];
    permits?: readonly UnreadPermit[];
    filter?: TimelineFilter | null;
    position?: string;
    agent?: AgentRef;
    /** What the daemon answers read_mark_set with; ok (and no push) unless told. */
    answer?: () => Promise<ReplyOf<"read_mark_set">>;
  } = {},
): Promise<Opened> {
  const store = timelineStore(options.agent !== undefined ? { agent: options.agent } : {});
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
    sid: SID,
    comments: [],
    threads: [],
    drafts: [],
    readMarks: (options.read ?? []).map((uuid) => ({
      kind: "read",
      session_id: SID,
      uuid,
      read: true,
    })),
  });
  store.dispatch({ type: "say-unread/loaded", says: [...(options.says ?? [])] });
  store.dispatch({ type: "agent-says/loaded", says: [...(options.agentSays ?? [])] });
  store.dispatch({
    type: "permit-state/loaded",
    unread: [...(options.permits ?? [])],
    granted: [],
    marks: [],
    rules: [],
  });
  const ws = new FakeTranscriptWs(store);
  const ops: string[] = [];
  const handle = {
    ...ws.handle,
    readMarkSet: (_sid: string, uuid: string, read: boolean) => {
      ops.push(`${uuid} ${String(read)}`);
      return options.answer?.() ?? Promise.resolve({ ok: true as const });
    },
    sayRead: (ids: readonly string[]) => {
      ops.push(`say_read ${ids.join(",")}`);
      return Promise.resolve({ ok: true as const, ids: [...ids] });
    },
    commentResolve: (_sid: string, cid: string) => {
      ops.push(`comment_resolve ${cid}`);
      return Promise.reject(new Error("not asked here"));
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, { agent: options.agent ?? null }));
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

/** A response's 既読: its name and whether it is pressed. */
function readMarkOf(item: Element): HTMLButtonElement {
  return instanceOf(item.querySelector(".tl-read-mark"), HTMLButtonElement, "既読");
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

async function pushMark(store: Store, uuid: string, read: boolean) {
  await act(() =>
    store.dispatch({
      type: "read-mark/changed",
      mark: { kind: "read", session_id: SID, uuid, read },
    }),
  );
}

const ANSWER_1 = uuidOf("a", 1);
const SAY_1 = uuidOf("a", 301);
const PERMIT_1 = uuidOf("a", 501);
const PUSH = uuidOf("a", 400);

describe("a response's 既読 (DR-0068 §6)", () => {
  test("one button, just left of 返信, on the response; none added to a say's or a request's", async () => {
    const { root } = await open({ says: [unreadSay(1)], permits: [unreadPermit("toolu_p1")] });
    const answer = itemOf(root, ANSWER_1);
    const row = instanceOf(
      answer.querySelector(".tl-bubble-assistant .tl-comment-reply-row"),
      HTMLElement,
      "返信's row",
    );
    const buttons = [...row.querySelectorAll(".tl-comment-reply-end > button")];
    expect(buttons.map((button) => button.className)).toEqual(["tl-read-mark", "tl-comment-reply"]);
    expect(readMarkOf(answer).getAttribute("aria-label")).toBe("既読にする");
    expect(readMarkOf(answer).getAttribute("aria-pressed")).toBe("false");
    // Its words are CSS's: none in the bubble's text.
    expect(readMarkOf(answer).textContent).toBe("");
    for (const uuid of [SAY_1, PERMIT_1]) {
      expect(itemOf(root, uuid).querySelector(".tl-read-mark")).toBeNull();
    }
    // The say's and the request's own 既読 stay one each.
    expect(itemOf(root, SAY_1).querySelectorAll(".say-read-btn").length).toBe(1);
    expect(itemOf(root, PERMIT_1).querySelectorAll("button.permit-read").length).toBe(1);
  });

  test("pressed, it asks the daemon once and changes nothing until the push", async () => {
    const { root, store, ops } = await open();
    const answer = itemOf(root, ANSWER_1);
    await act(() => readMarkOf(answer).click());
    expect(ops).toEqual([`${ANSWER_1} true`]);
    expect(foldOf(answer)).toBeNull();
    expect(readMarkOf(answer).getAttribute("aria-pressed")).toBe("false");
    await pushMark(store, ANSWER_1, true);
    expect(foldOf(answer)?.textContent).toBe("✅ 既読: answer 1");
    // Read while seen: it shrinks to its line.
    expect(answer.getAttribute("data-fold-motion")).toBe("close");
  });

  test("a refusal says why below the button, and the look stays", async () => {
    const { root } = await open({
      answer: () =>
        Promise.resolve({
          ok: false as const,
          error: { code: "state_not_writable", msg: "the comments were not written" },
        }),
    });
    const answer = itemOf(root, ANSWER_1);
    await act(() => readMarkOf(answer).click());
    await drained();
    expect(answer.querySelector(".tl-comment-reply-end > .tl-comment-failure")?.textContent).toBe(
      "the comments were not written",
    );
    expect(foldOf(answer)).toBeNull();
  });

  test("not on an agent's Timeline, whose items do not fold", async () => {
    const { root } = await open({ agent: { agentId: "a1" }, read: [ANSWER_1] });
    expect(root.querySelector(".tl-read-mark")).toBeNull();
    expect(root.querySelector(".tl-item-fold")).toBeNull();
  });
});

describe("what folds on the Timeline without a filter (DR-0068 §3, §5)", () => {
  test("a response read, a say and a request not unread: 「✅ 既読: <start>」, not their bubbles", async () => {
    const { root } = await open({ read: [ANSWER_1] });
    for (const [uuid, line, side] of [
      [ANSWER_1, "✅ 既読: answer 1", "response"],
      [SAY_1, "✅ 既読: said 1", "say"],
      [PERMIT_1, "✅ 既読: 止められた行動の文", "permit"],
    ] as const) {
      const fold = foldOf(itemOf(root, uuid));
      expect(fold?.getAttribute("aria-expanded")).toBe("false");
      expect(fold?.textContent).toBe(line);
      expect(fold?.dataset.frame).toBe(side);
      expect(fold?.classList.contains("tl-bubble-left")).toBe(true);
    }
    expect(itemOf(root, ANSWER_1).querySelector(".tl-bubble-assistant")).toBeNull();
    expect(itemOf(root, SAY_1).querySelector(".say")).toBeNull();
    expect(itemOf(root, PERMIT_1).querySelector(".tl-bubble-permit")).toBeNull();
    // Read from the start: no motion.
    expect(itemOf(root, ANSWER_1).hasAttribute("data-fold-motion")).toBe(false);
    // A PushNotification has no read: as it is.
    expect(foldOf(itemOf(root, PUSH))).toBeNull();
    expect(itemOf(root, PUSH).querySelector(".say")).not.toBeNull();
    // A response not read: as it is.
    expect(foldOf(itemOf(root, uuidOf("a", 2)))).toBeNull();
  });

  test("an unread say and an unread request are their bubbles", async () => {
    const { root } = await open({ says: [unreadSay(1)], permits: [unreadPermit("toolu_p1")] });
    expect(foldOf(itemOf(root, SAY_1))).toBeNull();
    expect(foldOf(itemOf(root, PERMIT_1))).toBeNull();
    expect(root.querySelector(".tl-item-fold")).toBeNull();
  });

  // DR-0068 §3: a request out of the unread without its 既読 (granted, or its
  // items all done; the daemon's ev:"permit_state") folds as well, shrinking
  // where it was seen.
  test("a request seen going out of the unread shrinks to its line, its bubble kept drawn", async () => {
    const { root, store } = await open({ permits: [unreadPermit("toolu_p1")] });
    const request = itemOf(root, PERMIT_1);
    expect(foldOf(request)).toBeNull();
    await act(() =>
      store.dispatch({
        type: "permit-state/loaded",
        unread: [],
        granted: ["toolu_p1"],
        marks: [],
        rules: [],
      }),
    );
    expect(foldOf(request)?.textContent).toBe("✅ 既読: 止められた行動の文");
    expect(request.getAttribute("data-fold-motion")).toBe("close");
    expect(request.querySelector(".tl-bubble-permit")).not.toBeNull();
  });

  test("a worker's say merged in folds once not unread", async () => {
    const worker: AgentSay = {
      session_id: SID,
      agent_id: "a1",
      tool_use_id: "toolu_w1",
      ts: "2030-01-01T00:00:09.500Z",
      text: "worker が終わった",
    };
    const { root, store } = await open({
      rows: [...exchange(1)],
      agentSays: [worker],
      says: [{ session_id: SID, tool_use_id: "toolu_w1", ts: worker.ts, agent_id: "a1" }],
    });
    const merged = () =>
      instanceOf(
        lines(root).querySelector(':scope > [data-notif="say"]'),
        HTMLElement,
        "the worker's say",
      );
    expect(foldOf(merged())).toBeNull();
    await act(() => store.dispatch({ type: "say-unread/loaded", says: [] }));
    expect(foldOf(merged())?.textContent).toBe("✅ 既読: worker が終わった");
  });

  test("marking read and taking it off leaves the items, their positions and folds as they are", async () => {
    const { root, store } = await open({ read: [] });
    const before = shape(root);
    await pushMark(store, ANSWER_1, true);
    expect(shape(root)).toEqual(before);
    await pushMark(store, ANSWER_1, false);
    expect(shape(root)).toEqual(before);
  });
});

describe("opened, and the mark taken off and put on again", () => {
  test("pressed, the folded response opens to its bubble, still read, and nothing is asked", async () => {
    const { root, ops } = await open({ read: [ANSWER_1] });
    const answer = itemOf(root, ANSWER_1);
    await act(() => foldOf(answer)?.click());
    expect(foldOf(answer)).toBeNull();
    expect(answer.querySelector(".tl-bubble-assistant .md")?.textContent).toContain("answer 1");
    expect(readMarkOf(answer).getAttribute("aria-pressed")).toBe("true");
    expect(readMarkOf(answer).getAttribute("aria-label")).toBe("既読を外す");
    expect(answer.getAttribute("data-fold-motion")).toBe("open");
    expect(document.activeElement).toBe(answer);
    expect(ops).toEqual([]);
    expect(navigations).toEqual([]);
  });

  test("a say and a request opened are their bubbles, with no 既読 to take off", async () => {
    const { root, ops } = await open();
    for (const uuid of [SAY_1, PERMIT_1]) {
      const item = itemOf(root, uuid);
      await act(() => foldOf(item)?.click());
      expect(foldOf(item)).toBeNull();
    }
    expect(itemOf(root, SAY_1).querySelector(".say-icon")?.textContent).toBe("🔕");
    expect(itemOf(root, SAY_1).querySelector(".say-read-done")?.textContent).toBe("既読");
    expect(itemOf(root, PERMIT_1).querySelector(".tl-bubble-from")?.textContent).toBe("🔓許可依頼");
    expect(root.querySelector(".tl-read-mark[aria-pressed='true']")).toBeNull();
    expect(ops).toEqual([]);
  });

  test("its ✅既読 takes the mark off: back to its bubble; put on again, it starts folded", async () => {
    const { root, store, ops } = await open({ read: [ANSWER_1] });
    const answer = itemOf(root, ANSWER_1);
    await act(() => foldOf(answer)?.click());
    await act(() => readMarkOf(answer).click());
    expect(ops).toEqual([`${ANSWER_1} false`]);
    await pushMark(store, ANSWER_1, false);
    expect(foldOf(answer)).toBeNull();
    expect(readMarkOf(answer).getAttribute("aria-pressed")).toBe("false");
    await pushMark(store, ANSWER_1, true);
    expect(foldOf(answer)?.textContent).toBe("✅ 既読: answer 1");
  });
});

describe("the filters do not fold (DR-0062 P36)", () => {
  test("under 🔔 and 🔐 the say and the request are their bubbles; under ⭐ the response is", async () => {
    for (const filter of ["say", "permit"] as const) {
      const { root } = await open({ filter, read: [ANSWER_1] });
      expect(root.querySelector(".tl-item-fold")).toBeNull();
      const uuid = filter === "say" ? SAY_1 : PERMIT_1;
      expect(
        itemOf(root, uuid).querySelector(filter === "say" ? ".say" : ".tl-bubble-permit"),
      ).not.toBeNull();
      await mounted.unmount();
    }
    const { root, store } = await open({ filter: "bookmark", read: [ANSWER_1] });
    await act(() =>
      store.dispatch({
        type: "bookmarks/loaded",
        sessions: [{ session_id: SID, uuids: [ANSWER_1] }],
      }),
    );
    expect(foldOf(itemOf(root, ANSWER_1))).toBeNull();
    expect(itemOf(root, ANSWER_1).querySelector(".tl-bubble-assistant")).not.toBeNull();
  });
});

describe("a position on a folded response", () => {
  test("landing on it opens it", async () => {
    const { root } = await open({ read: [ANSWER_1], position: ANSWER_1 });
    await drained();
    await drained();
    const answer = itemOf(root, ANSWER_1);
    expect(foldOf(answer)).toBeNull();
    expect(answer.querySelector(".tl-bubble-assistant")).not.toBeNull();
    expect(answer.classList.contains("tl-position-selected")).toBe(true);
    expect(answer.hasAttribute("data-fold-motion")).toBe(false);
  });
});
