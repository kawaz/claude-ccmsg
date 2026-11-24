// The FAB's drafts in the 💬 filter (DR-0062 §13, §15), mounted in a
// Timeline: each draft drawn as the person's prompt it goes as (its
// attachments put in), among the comments where it was written, a queued one
// marked unsent; the buttons of each (消す / 直す / 送る for a queued one,
// 下書きに戻す / 送った扱いにする for an unconfirmed one, and no words of its
// state); and 全部送信 sending the unsent comments and the queued drafts in
// the order written, whatever the boxes hide.
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type {
  PromptDraftRecord,
  QueueSendItem,
  UnconfirmedSettleRequest,
  UserComment,
} from "@ccmsg/protocol";
import { EditDraftContext } from "../src/client/components/SessionInputComposer.tsx";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState } from "../src/client/useStore.ts";
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
});

const edited: PromptDraftRecord[] = [];

function TimelineOf() {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(
    EditDraftContext.Provider,
    { value: (draft: PromptDraftRecord) => edited.push(draft) },
    h(Timeline, {
      key: SID,
      sid: SID,
      timeline: tree.timeline,
      search: tree.timelineSearch,
      sessionStatus: undefined,
      agent: null,
      active: true,
      visible: true,
    }),
  );
}

function comment(cid: string): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid,
    session_id: SID,
    anchor: { kind: "message", uuid: uuidOf("a", 1), msg_start_with: "answer 1" },
    body: "ここは?",
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: uuidOf("a", 1) },
    updated_at: `v-${cid}`,
    btw: false,
    status: "draft",
  };
}

function draft(
  id: string,
  status: PromptDraftRecord["status"],
  patch: Partial<PromptDraftRecord> = {},
): PromptDraftRecord {
  return {
    kind: "draft",
    id,
    session_id: SID,
    written: { at: "2030-01-01T00:00:00.000Z" },
    updated_at: `v-${id}`,
    text: `下書き ${id}`,
    attachments: [],
    status,
    ...patch,
  };
}

interface Opened {
  root: HTMLElement;
  sends: QueueSendItem[][];
  deletes: Array<{ id: string; seen: string }>;
  settles: Array<{ item: UnconfirmedSettleRequest["item"]; action: string; seen: string }>;
}

/** The Timeline of one exchange under ?filter=comment, holding `comments`
 * and `drafts`. */
async function open(comments: UserComment[], drafts: PromptDraftRecord[]): Promise<Opened> {
  restores.push(stubGlobal("localStorage", new MemStorage()));
  edited.splice(0);
  const store = timelineStore();
  store.dispatch({
    type: "locator/changed",
    locator: { view: "timeline", sid: SID, filter: "comment" },
    sidebar: CLOSED_SIDEBAR,
  });
  store.dispatch({ type: "comments/loaded", sid: SID, comments, threads: [], drafts });
  const ws = new FakeTranscriptWs(store);
  const sends: Opened["sends"] = [];
  const deletes: Opened["deletes"] = [];
  const settles: Opened["settles"] = [];
  const handle = {
    ...ws.handle,
    queueSend: (_sid: string, items: readonly QueueSendItem[]) => {
      sends.push([...items]);
      return Promise.resolve({
        ok: true as const,
        results: items.map((item) =>
          item.kind === "comment"
            ? { kind: "comment" as const, id: item.cid, outcome: "sent" as const }
            : { kind: "draft" as const, id: item.id, outcome: "sent" as const },
        ),
      });
    },
    promptQueueDelete: (_sid: string, id: string, seen: string) => {
      deletes.push({ id, seen });
      return Promise.resolve({ ok: true as const });
    },
    unconfirmedSettle: (
      _sid: string,
      item: UnconfirmedSettleRequest["item"],
      action: "back_to_draft" | "mark_sent",
      seen: string,
    ) => {
      settles.push({ item, action, seen });
      return Promise.resolve({ ok: true as const });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...exchange(1)]));
  return { root, sends, deletes, settles };
}

function drafts(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll(".tl-bubble-draft")].map((el) =>
    instanceOf(el, HTMLElement, "a draft"),
  );
}

function button(at: Element, label: string): HTMLButtonElement {
  return instanceOf(
    [...at.querySelectorAll(".tl-comment-actions button")].find((b) => b.textContent === label),
    HTMLButtonElement,
    label,
  );
}

const drained = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function press(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await drained();
  });
}

describe("the FAB's drafts in the 💬 filter", () => {
  // 下書きはユーザの発言と同じ吹き出しで、添付を [FILE<n>:<name>](<path>) に置き換えた文
  // (届く形) で 1 件ずつ出る。queued のものだけが未送信の印を持つ (§13)。
  test("each draft is the person's prompt it goes as, a queued one marked unsent", async () => {
    const { root } = await open(
      [comment("c0001")],
      [
        draft("d1", "queued", {
          text: "[FILE2] を見て",
          attachments: [{ n: 2, name: "a.png", path: "/s/x.att-1.png" }],
        }),
        draft("d2", "unconfirmed"),
      ],
    );
    const [queued, unconfirmed] = drafts(root);
    if (queued === undefined || unconfirmed === undefined) throw new Error("no drafts");
    // The attachment as it goes ([FILE2:a.png](/s/x.att-1.png)), drawn as the
    // person's prompt draws it: the label of the link.
    expect(queued.querySelector(".md")?.textContent).toBe("FILE2:a.png を見て");
    expect(unconfirmed.querySelector(".md")?.textContent).toBe("下書き d2");
    for (const bubble of [queued, unconfirmed]) {
      expect(bubble.classList.contains("tl-bubble-right")).toBe(true);
      expect(bubble.getAttribute("data-comment-kind")).toBe("draft");
    }
    expect(queued.hasAttribute("data-unsent")).toBe(true);
    expect(unconfirmed.hasAttribute("data-unsent")).toBe(false);
    // Each draft its own item of the filter's.
    expect(queued.closest(".tl-item")?.getAttribute("data-filter-only")).toBe("comment");
  });

  // queued の下書きには 消す・直す・送る、unconfirmed の下書きには 下書きに戻す・送った扱いに
  // する を付ける。状態を言う字は出さない (§13、§15)。
  test("a queued draft has 消す / 直す / 送る, an unconfirmed one 下書きに戻す / 送った扱いにする", async () => {
    const { root } = await open([], [draft("d1", "queued"), draft("d2", "unconfirmed")]);
    const [queued, unconfirmed] = drafts(root);
    if (queued === undefined || unconfirmed === undefined) throw new Error("no drafts");
    const words = (item: Element) =>
      [...item.querySelectorAll(".tl-comment-actions button")].map((b) => b.textContent);
    expect(words(queued)).toEqual(["消す", "直す", "送る"]);
    expect(words(unconfirmed)).toEqual(["下書きに戻す", "送った扱いにする"]);
    expect(unconfirmed.textContent).not.toContain("届いたか分からない");
  });

  // 1 件ずつの送信・直す・消す・未確認の扱いは、その下書き 1 つを見ていた版で渡す。
  test("each draft's buttons act on that draft at the version shown", async () => {
    const { root, sends, deletes, settles } = await open(
      [],
      [draft("d1", "queued"), draft("d2", "unconfirmed"), draft("d3", "queued")],
    );
    const [first, second] = drafts(root);
    if (first === undefined || second === undefined) throw new Error("no drafts");
    await press(button(first, "送る"));
    expect(sends).toEqual([[{ kind: "draft", id: "d1", seen_updated_at: "v-d1" }]]);
    await press(button(first, "直す"));
    expect(edited.map((d) => d.id)).toEqual(["d1"]);
    await press(button(first, "消す"));
    expect(deletes).toEqual([{ id: "d1", seen: "v-d1" }]);
    await press(button(second, "下書きに戻す"));
    await press(button(second, "送った扱いにする"));
    expect(settles).toEqual([
      { item: { kind: "draft", id: "d2" }, action: "back_to_draft", seen: "v-d2" },
      { item: { kind: "draft", id: "d2" }, action: "mark_sent", seen: "v-d2" },
    ]);
  });

  // 全部送信は未送信のコメントと FAB の下書き (queued だけ) を書いた時刻の順に 1 つの
  // queue_send で渡す (daemon はこの順で、並んだコメントを 1 つのプロンプト、下書きを 1 件
  // ずつ送る)。同じ時刻ならコメントが先。
  test("全部送信 sends the unsent comments and the queued drafts in the order written", async () => {
    const { root, sends } = await open(
      [comment("c0001")],
      [draft("d1", "queued"), draft("d2", "unconfirmed"), draft("d3", "queued")],
    );
    const sendAll = instanceOf(
      root.querySelector(".tl-comments-send-all"),
      HTMLButtonElement,
      "全部送信",
    );
    expect(sendAll.textContent).toBe("全部送信 (3)");
    await press(sendAll);
    expect(sends).toEqual([
      [
        { kind: "comment", cid: "c0001", seen_updated_at: "v-c0001" },
        { kind: "draft", id: "d1", seen_updated_at: "v-d1" },
        { kind: "draft", id: "d3", seen_updated_at: "v-d3" },
      ],
    ]);
  });

  // 全部送信はチェックボックスで絞らない (kawaz 2026-11-24): comment / btw / sent を外して
  // 未送信のコメントが隠れても、それと queued の下書きを送る。届いたか分からない下書きは
  // 送らない。
  test("全部送信 sends the hidden ones too, with comment, btw and sent all off", async () => {
    const { root, sends } = await open(
      [comment("c0001")],
      [draft("d1", "queued"), draft("d2", "unconfirmed")],
    );
    for (const label of ["sent", "comment", "btw"]) {
      const box = instanceOf(
        [...root.querySelectorAll(".tl-comments-head label")]
          .find((l) => l.textContent === label)
          ?.querySelector("input"),
        HTMLInputElement,
        label,
      );
      await act(() => box.click());
    }
    await press(
      instanceOf(root.querySelector(".tl-comments-send-all"), HTMLButtonElement, "全部送信"),
    );
    expect(sends).toEqual([
      [
        { kind: "comment", cid: "c0001", seen_updated_at: "v-c0001" },
        { kind: "draft", id: "d1", seen_updated_at: "v-d1" },
      ],
    ]);
  });
});
