// The Timeline filtered by the 🔔🔐 badges (DR-0050), mounted:
// - the URL's `filter` marks `.tl-lines` with `data-filter`, and the items it
//   keeps name their kind with `data-notif` (say and PushNotification for 🔔,
//   the permission-request bubbles for 🔐). Hiding the rest is CSS (§5)
// - with nothing of the kind loaded, one line says so
// - below the last bubble, a 「全て既読」 bar marks every unread say (🔔) or
//   request (🔐, not granted) the filter shows read, those outside the window
//   and the workers' says too, and cannot be pressed with none unread; under
//   it, a 「TL に戻る」 bar takes the filter off as the selected badge does (the
//   same URL, replacing the entry). Without a filter both are the same
//   elements, hidden
// - the 👤 nav is off while filtered (§9 U9)
// - a permission-request bubble is the row of its `permit` call, selectable by
//   that row's uuid, and selecting keeps the filter (§9 U7, §4)
// - taking the filter off leaves every element in place (no re-render of the
//   transcript), which the scroll restoring relies on (§5, §6)
// - the 🔔 / 🔐 filter asks the daemon for every say and request of the
//   session (notification_list) and shows the ones of its kind outside the
//   loaded window at their time, each once, without reading older pages; they
//   are the filter's only (§5, §9 U8)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  CCMSG_TOOLS,
  type AgentSay,
  type SessionPermit,
  type SessionSay,
  type UnreadPermit,
  type UnreadSay,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { timelineHref, type TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { permitRows } from "./permit-rows.ts";
import { assistantContentRow, line as jsonl } from "../../protocol/test/transcript-rows.ts";
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
/** 遷移ごとの履歴の扱い (`navigations` と同じ順)。 */
let histories: Array<string | undefined> = [];

beforeEach(() => {
  navigations = [];
  histories = [];
  restores = [
    stubGlobal("navigation", {
      navigate(url: string, options?: { history?: string }) {
        navigations.push(url);
        histories.push(options?.history);
      },
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

/** n 番目の say の行 (assistant が say を呼んだ行)。時刻は 01:00:0n。 */
function sayRow(n: number): string {
  return jsonl(
    assistantContentRow(
      [{ type: "tool_use", id: `toolu_${n}`, name: CCMSG_TOOLS.say, input: { text: `said ${n}` } }],
      { uuid: uuidOf("a", 100 + n), timestamp: `2026-10-09T01:00:0${n}.000Z` },
    ),
  );
}

function unreadSay(n: number): UnreadSay {
  return { session_id: SID, tool_use_id: `toolu_${n}`, ts: `2026-10-09T01:00:0${n}.000Z` };
}

/** The lines of the `n`th request for permission (`toolu_p<n>`), made at
 * 01:00:0n of the say rows' day. */
function requestRows(n: number): string[] {
  return permitRows(
    n,
    `toolu_p${String(n)}`,
    { blocked: `asked ${String(n)}`, intents: ["y"] },
    {
      day: "2026-10-09",
    },
  ).map((row) => row.replace("T00:00:0", "T01:00:0"));
}

/** The `n`th request as notification_list lists it. */
function listedPermit(n: number): SessionPermit {
  return {
    tool_use_id: `toolu_p${String(n)}`,
    ts: `2026-10-09T01:00:0${String(n)}.000Z`,
    cwd: "/w",
    permit: {
      blocked: `asked ${String(n)}`,
      attachments: [],
      intents: ["y"],
      commands: [],
      project_permissions: [],
    },
  };
}

/** sid の Timeline を URL の `filter` 付きで開いた状態にする。 */
async function filterTo(store: Store, filter: TimelineFilter | null, position = "head") {
  await act(() =>
    store.dispatch({
      type: "locator/changed",
      locator: {
        view: "timeline",
        sid: SID,
        position,
        ...(filter !== null ? { filter } : {}),
      },
      sidebar: CLOSED_SIDEBAR,
    }),
  );
}

async function open(options: {
  rows: readonly string[];
  start?: number;
  filter: TimelineFilter | null;
  says?: readonly UnreadSay[];
  agentSays?: readonly AgentSay[];
  /** What notification_list answers of the says. */
  list?: readonly SessionSay[];
  /** What notification_list answers of the requests for permission. */
  permits?: readonly SessionPermit[];
  /** The requests the person has not acted on (ev:"permit_state"). */
  permitUnread?: readonly UnreadPermit[];
}): Promise<{ root: HTMLElement; store: Store; ws: FakeTranscriptWs; acks: Acks }> {
  const store = timelineStore();
  store.dispatch({ type: "say-unread/loaded", says: [...(options.says ?? [])] });
  store.dispatch({ type: "agent-says/loaded", says: [...(options.agentSays ?? [])] });
  store.dispatch({
    type: "permit-state/loaded",
    unread: [...(options.permitUnread ?? [])],
    granted: [],
    applied: [],
  });
  await filterTo(store, options.filter);
  const ws = new FakeTranscriptWs(store);
  ws.says = options.list ?? [];
  ws.permits = options.permits ?? [];
  // The daemon's say_read / permit_read: take the ids out of the unread and
  // push the new whole set, as ev:"say_unread" / ev:"permit_state" do.
  const acks: Acks = { says: [], permits: [] };
  const handle = {
    ...ws.handle,
    sayRead: (ids: readonly string[]) => {
      acks.says.push(ids);
      const targets = new Set(ids);
      store.dispatch({
        type: "say-unread/loaded",
        says: store.getState().unreadSays.filter((say) => !targets.has(say.tool_use_id)),
      });
      return Promise.resolve({ ok: true as const, ids: [...ids] });
    },
    permitRead: (ids: readonly string[], granted?: boolean) => {
      acks.permits.push({ ids, granted });
      const targets = new Set(ids);
      store.dispatch({
        type: "permit-state/loaded",
        unread: store.getState().permitUnread.filter((p) => !targets.has(p.tool_use_id)),
        granted: [],
        applied: [],
      });
      return Promise.resolve({ ok: true as const, ids: [...ids] });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page(options.rows, options.start ?? 0));
  return { root, store, ws, acks };
}

/** The read requests the Timeline sent, in order. */
type Acks = {
  says: Array<readonly string[]>;
  permits: Array<{ ids: readonly string[]; granted: boolean | undefined }>;
};

function unreadPermit(n: number, sid = SID): UnreadPermit {
  return {
    session_id: sid,
    tool_use_id: `toolu_p${String(n)}`,
    ts: `2026-10-09T01:00:0${String(n)}.000Z`,
  };
}

function readAllButton(root: HTMLElement): HTMLButtonElement {
  return instanceOf(root.querySelector(".tl-filter-read-all"), HTMLButtonElement, "全て既読");
}

async function pressReadAll(root: HTMLElement): Promise<void> {
  await act(async () => {
    readAllButton(root).click();
    await Promise.resolve();
  });
}

function backButton(root: HTMLElement): HTMLButtonElement {
  return instanceOf(root.querySelector(".tl-filter-back"), HTMLButtonElement, "TL に戻る");
}

function lines(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-lines"), HTMLElement, ".tl-lines");
}

/** `.tl-lines` の直下の子のうち、種類を名乗るものの (種類, uuid)。 */
function kept(root: HTMLElement): Array<[string, string]> {
  return [...lines(root).children].flatMap(
    (child): Array<[string, string]> =>
      child instanceof HTMLElement && child.dataset.notif !== undefined
        ? [[child.dataset.notif, child.dataset.timelineUuid ?? ""]]
        : [],
  );
}

describe("the Timeline's filter", () => {
  test("marks the lines with the filter and the kept items with their kind", async () => {
    const { root, store } = await open({
      rows: [...exchange(1), sayRow(1), ...exchange(2), sayRow(2), ...requestRows(3)],
      filter: "say",
      says: [unreadSay(2)],
    });
    expect(lines(root).dataset.filter).toBe("say");
    expect(kept(root)).toEqual([
      ["say", uuidOf("a", 101)],
      ["say", uuidOf("a", 102)],
      ["permit", uuidOf("a", 503)],
    ]);
    // 種類を名乗らない子 (ユーザ発話・応答) も DOM には残っている (隠すのは CSS)。
    expect(lines(root).querySelector(`[data-timeline-uuid="${uuidOf("u", 1)}"]`)).not.toBeNull();

    await filterTo(store, null);
    expect(lines(root).dataset.filter).toBeUndefined();
  });

  test("says so when nothing of the kind is loaded", async () => {
    const { root, store } = await open({ rows: [...exchange(1)], filter: "say" });
    expect(root.querySelector(".tl-filter-empty")?.textContent).toBe("say はありません");
    await filterTo(store, "permit");
    expect(root.querySelector(".tl-filter-empty")?.textContent).toBe("許可依頼はありません");
    await filterTo(store, null);
    expect(root.querySelector(".tl-filter-empty")).toBeNull();
  });

  test("「TL に戻る」 below the last bubble takes the filter off as the selected badge does", async () => {
    const { root, store } = await open({
      rows: [...exchange(1), sayRow(1), ...exchange(2)],
      filter: "say",
      says: [unreadSay(1)],
    });
    const back = backButton(root);
    // The look it shares with the top's 「過去分を上に読み込む」「過去分を下に読み込む」.
    expect(back.classList.contains("tl-wide-button")).toBe(true);
    expect(back.hidden).toBe(false);
    expect(back.textContent).toBe("TL に戻る");
    expect(lines(root).lastElementChild).toBe(back);

    await act(() => back.click());
    const badge = instanceOf(
      root.querySelector(".tl-toolbar-badges .notif-badge-say"),
      HTMLAnchorElement,
      "🔔 badge",
    );
    expect(navigations).toEqual([timelineHref(SID, "head")]);
    expect(navigations[0]).toBe(new URL(badge.href).pathname + new URL(badge.href).search);
    expect(histories).toEqual(["replace"]);

    // Taken off, the same element stays, hidden.
    await filterTo(store, null);
    expect(backButton(root)).toBe(back);
    expect(back.hidden).toBe(true);
  });

  test("「TL に戻る」 keeps the selected position, and is there under 「say はありません」 too", async () => {
    const { root, store } = await open({
      rows: [...exchange(1), ...requestRows(1)],
      filter: "permit",
    });
    const uuid = uuidOf("a", 501);
    await filterTo(store, "permit", uuid);
    await act(() => backButton(root).click());
    expect(navigations).toEqual([timelineHref(SID, uuid)]);
    expect(histories).toEqual(["replace"]);

    await filterTo(store, "say");
    const empty = instanceOf(root.querySelector(".tl-filter-empty"), HTMLElement, "empty line");
    expect(empty.textContent).toBe("say はありません");
    const back = backButton(root);
    expect(back.hidden).toBe(false);
    expect(empty.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("turns the 👤 nav off while filtered", async () => {
    const { root, store } = await open({ rows: [...exchange(1), ...exchange(2)], filter: "say" });
    const nav = () => [...root.querySelectorAll<HTMLButtonElement>(".tl-user-nav button")];
    expect(nav().map((button) => button.disabled)).toEqual([true, true, true]);
    await filterTo(store, null);
    expect(nav().map((button) => button.disabled)).toEqual([false, false, false]);
  });

  test("a permission-request bubble is selected by its call row's uuid, keeping the filter", async () => {
    const { root, store } = await open({
      rows: [...exchange(1), ...requestRows(1)],
      filter: "permit",
    });
    const uuid = uuidOf("a", 501);
    const item = instanceOf(
      root.querySelector(`[data-timeline-uuid="${uuid}"]`),
      HTMLElement,
      "permit item",
    );
    expect(item.dataset.notif).toBe("permit");
    const blocked = instanceOf(item.querySelector(".permit-section"), HTMLElement, "section");
    await act(() => blocked.click());
    expect(navigations).toEqual([`/s/${SID}/timeline/${uuid}?filter=permit`]);
    await filterTo(store, "permit", uuid);
    expect(item.classList.contains("tl-position-selected")).toBe(true);
  });

  test("the 🔐 filter shows every request of the session, the ones outside the window at their time", async () => {
    // 窓は requestRows(3) から。toolu_p1 (1:00:01) と toolu_p2 は窓より前、
    // toolu_p3 は窓の中 (一覧にもあるが二重に出さない)。
    const { root, store, ws } = await open({
      rows: [...requestRows(3), ...exchange(1)],
      start: 5000,
      filter: "permit",
      permits: [listedPermit(1), listedPermit(2), listedPermit(3)],
    });
    expect(ws.notificationLists).toEqual([SID]);
    const blocked = () =>
      [...root.querySelectorAll(".tl-bubble-permit")].map(
        (bubble) => bubble.querySelector(".permit-section .md")?.textContent ?? "",
      );
    expect(blocked()).toEqual(["asked 1", "asked 2", "asked 3"]);
    expect(kept(root)).toEqual([
      ["permit", ""],
      ["permit", ""],
      ["permit", uuidOf("a", 503)],
    ]);
    expect(lines(root).querySelectorAll('[data-filter-only="permit"]')).toHaveLength(2);
    expect(ws.reads.length).toBe(1);
    // Taken off, the listed ones go; the window's stays.
    await filterTo(store, null);
    expect(blocked()).toEqual(["asked 3"]);
  });

  test("taking the filter off re-renders nothing: every element is the same one", async () => {
    const { root, store } = await open({
      rows: [...exchange(1), sayRow(1), ...exchange(2)],
      filter: "say",
      says: [unreadSay(1)],
    });
    const before = [...lines(root).querySelectorAll("*")];
    await filterTo(store, null);
    const after = [...lines(root).querySelectorAll("*")];
    expect(after.length).toBe(before.length);
    expect(after.every((el, i) => el === before[i])).toBe(true);
  });

  test("the 🔔 filter shows every say of the session, the ones outside the window at their time", async () => {
    // 窓は sayRow(3) (1:00:03) から。toolu_1 (1:00:01) は窓より前の main の say、
    // toolu_w2 (1:00:02) は push で受けていない worker の say。toolu_3 は窓の中。
    const { root, ws } = await open({
      rows: [sayRow(3), ...exchange(1)],
      start: 5000,
      filter: "say",
      says: [unreadSay(1)],
      list: [
        { tool_use_id: "toolu_1", ts: unreadSay(1).ts, text: "said 1" },
        { tool_use_id: "toolu_w2", ts: "2026-10-09T01:00:02.000Z", text: "w 2", agent_id: "a1" },
        { tool_use_id: "toolu_3", ts: unreadSay(3).ts, text: "said 3" },
      ],
    });
    expect(ws.notificationLists).toEqual([SID]);
    const bubbles = [...root.querySelectorAll(".say")].map((bubble) => [
      bubble.querySelector(".say-body")?.textContent ?? "",
      bubble.querySelector(".say-from")?.textContent ?? "",
      bubble.querySelector(".say-icon")?.textContent ?? "",
    ]);
    expect(bubbles).toEqual([
      ["said 1", "say", "🔔"],
      ["w 2", "say🤖 a1", "🔕"],
      ["said 3", "say", "🔕"],
    ]);
    // 窓の外の 2 つは位置を持たず、フィルタだけのものと名乗る。窓の中の say は
    // transcript の行のまま (位置を持つ)。
    expect(kept(root)).toEqual([
      ["say", ""],
      ["say", ""],
      ["say", uuidOf("a", 103)],
    ]);
    expect(
      [...lines(root).querySelectorAll("[data-filter-only]")].map(
        (el) => el.querySelector(".say-body")?.textContent,
      ),
    ).toEqual(["said 1", "w 2"]);
    // older を読みに行かない (一覧で足りている)。
    expect(ws.reads.length).toBe(1);
  });

  // Each unread say keeps its plain 既読 under the filter too; marking them
  // all is the 「全て既読」 below the last bubble.
  test("an unread say outside the window has its own plain 既読", async () => {
    const { root } = await open({
      rows: [sayRow(3)],
      start: 5000,
      filter: "say",
      says: [unreadSay(1), unreadSay(3)],
      list: [
        { tool_use_id: "toolu_1", ts: unreadSay(1).ts, text: "said 1" },
        { tool_use_id: "toolu_3", ts: unreadSay(3).ts, text: "said 3" },
      ],
    });
    const buttons = [...root.querySelectorAll(".say-read-btn")].map((b) => b.textContent);
    expect(buttons).toEqual(["既読", "既読"]);
  });

  test("a worker's say already merged in is not drawn twice from the list", async () => {
    const worker: AgentSay = {
      session_id: SID,
      agent_id: "a1",
      tool_use_id: "toolu_w2",
      ts: "2026-10-09T01:00:02.000Z",
      text: "w 2",
    };
    const { root } = await open({
      rows: [sayRow(3)],
      filter: "say",
      agentSays: [worker],
      list: [{ tool_use_id: "toolu_w2", ts: worker.ts, text: "w 2", agent_id: "a1" }],
    });
    expect([...root.querySelectorAll(".say-body")].map((b) => b.textContent)).toEqual([
      "w 2",
      "said 3",
    ]);
    expect(lines(root).querySelector("[data-filter-only]")).toBeNull();
  });

  test("taking the 🔔 filter off takes the listed says out, and asks again on the way back", async () => {
    const { root, store, ws } = await open({
      rows: [sayRow(3)],
      filter: "say",
      list: [{ tool_use_id: "toolu_1", ts: unreadSay(1).ts, text: "said 1" }],
    });
    expect(root.querySelectorAll(".say")).toHaveLength(2);
    await filterTo(store, null);
    expect([...root.querySelectorAll(".say-body")].map((b) => b.textContent)).toEqual(["said 3"]);
    await filterTo(store, "say");
    expect(ws.notificationLists).toEqual([SID, SID]);
    expect(root.querySelectorAll(".say")).toHaveLength(2);
  });

  test("no filter, no asking for the list; each filter entered asks", async () => {
    const { ws, store } = await open({ rows: [...exchange(1)], filter: null });
    expect(ws.notificationLists).toEqual([]);
    await filterTo(store, "permit");
    await filterTo(store, "say");
    expect(ws.notificationLists).toEqual([SID, SID]);
  });
});

describe("the filter's 「全て既読」", () => {
  const workerSay: AgentSay = {
    session_id: SID,
    agent_id: "a1",
    tool_use_id: "toolu_w2",
    ts: "2026-10-09T01:00:02.000Z",
    text: "w 2",
  };

  test("sits between the last bubble and 「TL に戻る」, in the wide button's look", async () => {
    const { root } = await open({
      rows: [...exchange(1), sayRow(1), ...exchange(2), sayRow(2)],
      filter: "say",
      says: [unreadSay(2)],
    });
    const readAll = readAllButton(root);
    expect(readAll.textContent).toBe("全て既読");
    // 全幅 (.tl-wide-button) は、押すとそこに TL が現れるボタンだけ。
    expect(readAll.classList.contains("tl-wide-button")).toBe(false);
    expect(readAll.hidden).toBe(false);
    expect(readAll.nextElementSibling).toBe(backButton(root));
    // The last bubble the filter keeps comes before it.
    const keptBubbles = [...lines(root).children].filter(
      (child) => child instanceof HTMLElement && child.dataset.notif !== undefined,
    );
    const lastBubble = keptBubbles.at(-1);
    expect(lastBubble?.querySelector(".say-body")?.textContent).toBe("said 2");
    expect(
      lastBubble !== undefined &&
        lastBubble.compareDocumentPosition(readAll) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("🔔: marks every unread say the filter shows, outside the window and the workers' too", async () => {
    // 窓は sayRow(3) と sayRow(4) から。toolu_1 は窓より前 (一覧から)、toolu_w2 は
    // 合流済みの worker の say。toolu_4 は既読、toolu_9 は別セッションの未読。
    const { root, store, acks } = await open({
      rows: [sayRow(3), sayRow(4)],
      start: 5000,
      filter: "say",
      says: [
        unreadSay(1),
        { ...unreadSay(0), tool_use_id: "toolu_w2", ts: workerSay.ts, agent_id: "a1" },
        unreadSay(3),
        { ...unreadSay(9), session_id: "someone-else" },
      ],
      agentSays: [workerSay],
      list: [
        { tool_use_id: "toolu_1", ts: unreadSay(1).ts, text: "said 1" },
        { tool_use_id: "toolu_w2", ts: workerSay.ts, text: "w 2", agent_id: "a1" },
        { tool_use_id: "toolu_3", ts: unreadSay(3).ts, text: "said 3" },
        { tool_use_id: "toolu_4", ts: unreadSay(4).ts, text: "said 4" },
      ],
    });
    expect(readAllButton(root).disabled).toBe(false);
    await pressReadAll(root);
    expect(acks.says).toHaveLength(1);
    expect([...(acks.says[0] ?? [])].sort()).toEqual(["toolu_1", "toolu_3", "toolu_w2"]);
    expect(acks.permits).toEqual([]);
    expect(store.getState().unreadSays.map((say) => say.tool_use_id)).toEqual(["toolu_9"]);
    expect(
      [...root.querySelectorAll(".say")].map((b) => b.querySelector(".say-icon")?.textContent),
    ).toEqual(["🔕", "🔕", "🔕", "🔕"]);
    expect(root.querySelectorAll(".say-read-btn")).toHaveLength(0);
    // Nothing unread is left to mark: the button is gone (the same element,
    // hidden).
    expect(readAllButton(root).hidden).toBe(true);
    expect(readAllButton(root).disabled).toBe(true);
  });

  test("🔐: marks every unread request the filter shows read, without granting", async () => {
    // 窓は requestRows(3) から。toolu_p1 と toolu_p2 は窓より前 (一覧から)。
    // toolu_p2 は既読、toolu_p9 は別セッションの未読。
    const { root, store, acks } = await open({
      rows: [...requestRows(3), ...exchange(1)],
      start: 5000,
      filter: "permit",
      permits: [listedPermit(1), listedPermit(2), listedPermit(3)],
      permitUnread: [unreadPermit(1), unreadPermit(3), unreadPermit(9, "someone-else")],
    });
    const reads = () =>
      [...root.querySelectorAll<HTMLButtonElement>(".permit-read")].map((b) => b.disabled);
    expect(reads()).toEqual([false, true, false]);
    await pressReadAll(root);
    expect(acks.permits).toHaveLength(1);
    expect([...(acks.permits[0]?.ids ?? [])].sort()).toEqual(["toolu_p1", "toolu_p3"]);
    expect(acks.permits[0]?.granted).toBeUndefined();
    expect(acks.says).toEqual([]);
    expect(store.getState().permitUnread.map((p) => p.tool_use_id)).toEqual(["toolu_p9"]);
    expect(store.getState().permitGranted).toEqual([]);
    expect(reads()).toEqual([true, true, true]);
    expect(readAllButton(root).disabled).toBe(true);
  });

  // Unread of the other kind does not count: each filter marks its own kind.
  test("cannot be pressed with nothing of its kind unread", async () => {
    const { root, store, acks } = await open({
      rows: [...exchange(1), sayRow(1), ...requestRows(2), sayRow(3)],
      filter: "say",
      says: [unreadSay(3)],
      permitUnread: [unreadPermit(2)],
    });
    expect(readAllButton(root).disabled).toBe(false);
    await act(() => {
      store.dispatch({ type: "say-unread/loaded", says: [] });
    });
    expect(readAllButton(root).disabled).toBe(true);
    await filterTo(store, "permit");
    expect(readAllButton(root).disabled).toBe(false);
    await pressReadAll(root);
    expect(acks.permits).toEqual([{ ids: ["toolu_p2"], granted: undefined }]);
    expect(readAllButton(root).disabled).toBe(true);
    await pressReadAll(root);
    expect(acks.permits).toHaveLength(1);
    expect(acks.says).toEqual([]);
  });

  test("is not shown under 「say はありません」 (nothing unread to mark)", async () => {
    const { root, acks } = await open({ rows: [...exchange(1)], filter: "say" });
    const empty = instanceOf(root.querySelector(".tl-filter-empty"), HTMLElement, "empty line");
    const readAll = readAllButton(root);
    expect(readAll.hidden).toBe(true);
    expect(readAll.disabled).toBe(true);
    expect(empty.compareDocumentPosition(readAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await pressReadAll(root);
    expect(acks.says).toEqual([]);
  });

  test("without a filter it is the same element, hidden", async () => {
    // An unread one of each kind: the button shows only while its filter has
    // something to mark.
    const { root, store } = await open({
      rows: [...exchange(1), sayRow(1), ...requestRows(2)],
      filter: "say",
      says: [unreadSay(1)],
      permitUnread: [unreadPermit(2)],
    });
    const readAll = readAllButton(root);
    await filterTo(store, null);
    expect(readAllButton(root)).toBe(readAll);
    expect(readAll.hidden).toBe(true);
    await filterTo(store, "permit");
    expect(readAllButton(root)).toBe(readAll);
    expect(readAll.hidden).toBe(false);
  });

  // The filter's CSS hides every child of the lines that is not of its kind;
  // the 「全て既読」 and 「TL に戻る」 bars are kept.
  test("the filter's CSS keeps it, and hides it without a filter", async () => {
    const style = document.createElement("style");
    // happy-dom drops a rule whose `:not(` list spans lines (as the formatter
    // writes the 🔐 one); a browser reads it as written. Whitespace is
    // insignificant there, so the sheet is fed as one line.
    const css = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    style.textContent = css.replace(/\s+/g, " ");
    document.head.append(style);
    try {
      const { root, store } = await open({
        rows: [...exchange(1), sayRow(1), ...requestRows(2)],
        filter: "say",
        says: [unreadSay(1)],
        permitUnread: [unreadPermit(2)],
      });
      const user = instanceOf(
        lines(root).querySelector(`[data-timeline-uuid="${uuidOf("u", 1)}"]`),
        HTMLElement,
        "user row",
      );
      const display = () => [
        getComputedStyle(user).display,
        getComputedStyle(readAllButton(root)).display,
        getComputedStyle(backButton(root)).display,
      ];
      expect(display()).toEqual(["none", "inline-block", "inline-block"]);
      await filterTo(store, "permit");
      expect(display()).toEqual(["none", "inline-block", "inline-block"]);
      await filterTo(store, null);
      expect(display().slice(1)).toEqual(["none", "none"]);
    } finally {
      style.remove();
    }
  });
});

// The filter lists every say / request from notification_list (§5), so
// reading older pages changes nothing it shows: the top's 「過去分を上に
// 読み込む」「過去分を下に読み込む」 are hidden while filtered, the same element
// coming back when the filter is taken off.
describe("the 過去分を読み込む buttons under the filter", () => {
  function loadOlder(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>(".tl-load-older");
  }

  test("are hidden while filtered and come back, the same element, without a filter", async () => {
    const { root, store } = await open({ rows: [sayRow(3)], start: 5000, filter: "say" });
    const buttons = instanceOf(loadOlder(root), HTMLElement, ".tl-load-older");
    expect(buttons.hidden).toBe(true);
    await filterTo(store, null);
    expect(loadOlder(root)).toBe(buttons);
    expect(buttons.hidden).toBe(false);
    expect([...buttons.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "↑過去分を上に読み込む↑",
      "↓過去分を下に読み込む↓",
    ]);
    await filterTo(store, "permit");
    expect(loadOlder(root)).toBe(buttons);
    expect(buttons.hidden).toBe(true);
  });

  test("are not there either way once the transcript is read from its first byte", async () => {
    const { root, store } = await open({ rows: [...exchange(1), sayRow(1)], filter: "say" });
    expect(loadOlder(root)).toBeNull();
    await filterTo(store, null);
    expect(loadOlder(root)).toBeNull();
    await filterTo(store, "permit");
    expect(loadOlder(root)).toBeNull();
  });

  test("the CSS hides them while filtered", async () => {
    const style = document.createElement("style");
    // The sheet fed as one line, as in the 「全て既読」 CSS test above.
    const css = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    style.textContent = css.replace(/\s+/g, " ");
    document.head.append(style);
    try {
      const { root, store } = await open({ rows: [sayRow(3)], start: 5000, filter: "permit" });
      const buttons = instanceOf(loadOlder(root), HTMLElement, ".tl-load-older");
      expect(getComputedStyle(buttons).display).toBe("none");
      await filterTo(store, null);
      expect(getComputedStyle(buttons).display).toBe("flex");
    } finally {
      style.remove();
    }
  });
});

// DR-0050 §10: a subagent's or teammate's say is the session's to read. The
// daemon hands it (ev:"agent_says", its row being in the agent's own file),
// and the main Timeline draws it at its time, saying who spoke in the label's
// row, under the 🔔 filter too; its 既読 is the say's own.
describe("a worker's say in the main Timeline", () => {
  const workerSay: AgentSay = {
    session_id: SID,
    agent_id: "a1",
    tool_use_id: "toolu_w1",
    ts: "2026-10-09T01:00:02.500Z",
    text: "worker が終わった",
  };

  test("is drawn at its time with its sender, unread, and kept by the 🔔 filter", async () => {
    const { root, store } = await open({
      rows: [sayRow(1), sayRow(3)],
      filter: null,
      says: [
        unreadSay(1),
        { ...unreadSay(0), tool_use_id: "toolu_w1", ts: workerSay.ts, agent_id: "a1" },
      ],
      agentSays: [workerSay],
    });
    const bubbles = [...root.querySelectorAll(".say")].map((bubble) => [
      bubble.querySelector(".say-body")?.textContent ?? "",
      bubble.querySelector(".say-from")?.textContent ?? "",
      bubble.querySelector(".say-icon")?.textContent ?? "",
    ]);
    expect(bubbles).toEqual([
      ["said 1", "say", "🔔"],
      ["worker が終わった", "say🤖 a1", "🔔"],
      ["said 3", "say", "🔕"],
    ]);
    // 未読は main 1 + worker 1。worker の say の「既読」はその say だけを既読にする。
    const button = root.querySelectorAll(".say")[1]?.querySelector(".say-read-btn");
    expect(button?.textContent).toBe("既読");
    await filterTo(store, "say");
    expect(kept(root).map(([kind]) => kind)).toEqual(["say", "say", "say"]);
  });
});
