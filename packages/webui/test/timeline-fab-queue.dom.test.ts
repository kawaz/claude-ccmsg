// The 💬 filter's preview area with the FAB's drafts (DR-0062 §13, §15),
// mounted in a Timeline: the comments' section above the drafts' (P11: the
// order they are sent in), each draft shown as the prompt it goes as (its
// attachments put in), the buttons of each (送る / 直す / 消す for a queued
// one, 下書きに戻す / 送った扱いにする for an unconfirmed one), the drafts'
// section's send, and 全部送る sending the comments first, then the drafts.
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

function area(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-comments-preview"), HTMLElement, "the preview area");
}

function button(at: Element, selector: string): HTMLButtonElement {
  return instanceOf(at.querySelector(selector), HTMLButtonElement, selector);
}

const drained = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function press(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await drained();
  });
}

describe("the FAB's drafts in the preview area", () => {
  // コメントのセクションが上、FAB の下書きのセクションが下 (P11: 上から読んだ順が届く順)。
  // 下書きは 1 件ずつ、添付を [FILE<n>:<name>](<path>) に置き換えた文で分けて見せ、続けて
  // 送ったものは連結されないが同じ turn に並んで届くことを添える (§13)。
  test("the drafts' section is under the comments', each draft as the prompt it goes as", async () => {
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
    const titles = [...area(root).querySelectorAll(".tl-comments-preview-title")].map(
      (t) => t.textContent,
    );
    expect(titles).toEqual(["コメント (1)", "FAB の下書き (2)"]);
    const texts = [...area(root).querySelectorAll(".tl-draft-text")].map((t) => t.textContent);
    expect(texts).toEqual(["[FILE2:a.png](/s/x.att-1.png) を見て", "下書き d2"]);
    expect(area(root).querySelector(".tl-drafts-note")?.textContent).toContain("同じ turn");
  });

  // queued の下書きには 送る・直す・消す、unconfirmed の下書きには 下書きに戻す・送った扱いに
  // する を付ける (§13、§15)。
  test("a queued draft has 送る / 直す / 消す, an unconfirmed one 下書きに戻す / 送った扱いにする", async () => {
    const { root } = await open([], [draft("d1", "queued"), draft("d2", "unconfirmed")]);
    const [queued, unconfirmed] = [...area(root).querySelectorAll(".tl-draft-item")];
    if (queued === undefined || unconfirmed === undefined) throw new Error("no drafts");
    const words = (item: Element) =>
      [...item.querySelectorAll(".tl-draft-actions button")].map((b) => b.textContent);
    expect(words(queued)).toEqual(["送る", "直す", "消す"]);
    expect(words(unconfirmed)).toEqual(["下書きに戻す", "送った扱いにする"]);
    expect(unconfirmed.querySelector(".tl-draft-status")?.textContent).toBe("届いたか分からない");
  });

  // 1 件ずつの送信・直す・消す・未確認の扱いは、その下書き 1 つを見ていた版で渡す。
  test("each draft's buttons act on that draft at the version shown", async () => {
    const { root, sends, deletes, settles } = await open(
      [],
      [draft("d1", "queued"), draft("d2", "unconfirmed"), draft("d3", "queued")],
    );
    const [first, second] = [...area(root).querySelectorAll(".tl-draft-item")];
    if (first === undefined || second === undefined) throw new Error("no drafts");
    await press(button(first, ".tl-draft-send"));
    expect(sends).toEqual([[{ kind: "draft", id: "d1", seen_updated_at: "v-d1" }]]);
    await press(button(first, ".tl-draft-edit"));
    expect(edited.map((d) => d.id)).toEqual(["d1"]);
    await press(button(first, ".tl-draft-delete"));
    expect(deletes).toEqual([{ id: "d1", seen: "v-d1" }]);
    await press(button(second, ".tl-draft-back"));
    await press(button(second, ".tl-draft-mark-sent"));
    expect(settles).toEqual([
      { item: { kind: "draft", id: "d2" }, action: "back_to_draft", seen: "v-d2" },
      { item: { kind: "draft", id: "d2" }, action: "mark_sent", seen: "v-d2" },
    ]);
  });

  // セクションごとの送信は、そのセクションの送れるもの (下書きは queued だけ) を送る。
  // 全部送るはコメントを先、FAB の下書きを後に 1 つの queue_send で渡す (daemon はこの順で、
  // コメントを 1 つのプロンプト、下書きを 1 件ずつ送る)。
  test("the drafts' section sends its queued drafts; 全部送る sends the comments first", async () => {
    const { root, sends } = await open(
      [comment("c0001")],
      [draft("d1", "queued"), draft("d2", "unconfirmed"), draft("d3", "queued")],
    );
    await press(button(area(root), ".tl-drafts-send-section"));
    await press(button(area(root), ".tl-comments-send-all"));
    expect(sends).toEqual([
      [
        { kind: "draft", id: "d1", seen_updated_at: "v-d1" },
        { kind: "draft", id: "d3", seen_updated_at: "v-d3" },
      ],
      [
        { kind: "comment", cid: "c0001", seen_updated_at: "v-c0001" },
        { kind: "draft", id: "d1", seen_updated_at: "v-d1" },
        { kind: "draft", id: "d3", seen_updated_at: "v-d3" },
      ],
    ]);
  });

  // 下書きが無ければセクションは「無い」と言い、送るボタンを出さない。
  test("with no drafts, the section says so and offers no send", async () => {
    const { root } = await open([], []);
    expect(area(root).querySelector(".tl-drafts-preview")?.textContent).toContain(
      "キューに FAB の下書きはありません",
    );
    expect(area(root).querySelector(".tl-drafts-send-section")).toBeNull();
    expect(area(root).querySelector(".tl-comments-send-all")).toBeNull();
  });
});
