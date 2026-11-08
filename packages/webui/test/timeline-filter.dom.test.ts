// The Timeline filtered by the 🔔🔐 badges (DR-0050), mounted:
// - the URL's `filter` marks `.tl-lines` with `data-filter`, and the items it
//   keeps name their kind with `data-notif` (say and PushNotification for 🔔,
//   the permission-request bubbles for 🔐). Hiding the rest is CSS (§5)
// - with nothing of the kind loaded, one line says so
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
  type UnreadSay,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { TimelineFilter } from "../src/client/locator.ts";
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

beforeEach(() => {
  navigations = [];
  restores = [
    stubGlobal("navigation", {
      navigate(url: string) {
        navigations.push(url);
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
}): Promise<{ root: HTMLElement; store: Store; ws: FakeTranscriptWs }> {
  const store = timelineStore();
  store.dispatch({ type: "say-unread/loaded", says: [...(options.says ?? [])] });
  store.dispatch({ type: "agent-says/loaded", says: [...(options.agentSays ?? [])] });
  await filterTo(store, options.filter);
  const ws = new FakeTranscriptWs(store);
  ws.says = options.list ?? [];
  ws.permits = options.permits ?? [];
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page(options.rows, options.start ?? 0));
  return { root, store, ws };
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

  test("an unread say outside the window is counted in the newest button's 「すべて既読」", async () => {
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
    expect(buttons).toEqual(["既読", "2 件すべて既読"]);
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
    // 未読は main 1 + worker 1。最新の未読 (worker) のボタンが両方を既読にする。
    const button = root.querySelectorAll(".say")[1]?.querySelector(".say-read-btn");
    expect(button?.textContent).toBe("2 件すべて既読");
    await filterTo(store, "say");
    expect(kept(root).map(([kind]) => kind)).toEqual(["say", "say", "say"]);
  });
});
