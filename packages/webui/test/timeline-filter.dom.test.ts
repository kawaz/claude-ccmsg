// The Timeline filtered by the 🔔🔐 badges (DR-0050), mounted:
// - the URL's `filter` marks `.tl-lines` with `data-filter`, and the items it
//   keeps name their kind with `data-notif` (say and PushNotification for 🔔,
//   the permission-request bubbles for 🔐). Hiding the rest is CSS (§5)
// - with nothing of the kind loaded, one line says so
// - the 👤 nav is off while filtered (§9 U9)
// - a permission-request bubble is selectable, its record id standing in for
//   a uuid, and selecting keeps the filter (§9 U7, §4)
// - taking the filter off leaves every element in place (no re-render of the
//   transcript), which the scroll restoring relies on (§5, §6)
// - an unread say older than the loaded window makes the 🔔 filter read older
//   until it is in; one not drawn yet but newer does not (§9 U8)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  CCMSG_TOOLS,
  type AgentSay,
  type PermitRequestRecord,
  type UnreadSay,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { permitPosition, type TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
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

function request(id: string): PermitRequestRecord {
  return {
    id,
    sid: SID,
    ts: "2026-10-09T09:00:00.000Z",
    blocked: "x",
    attachments: [],
    intents: ["y"],
    commands: [],
    read: false,
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
  requests?: readonly PermitRequestRecord[];
}): Promise<{ root: HTMLElement; store: Store; ws: FakeTranscriptWs }> {
  const store = timelineStore();
  store.dispatch({ type: "say-unread/loaded", says: [...(options.says ?? [])] });
  store.dispatch({ type: "agent-says/loaded", says: [...(options.agentSays ?? [])] });
  store.dispatch({ type: "permit-requests/loaded", requests: [...(options.requests ?? [])] });
  await filterTo(store, options.filter);
  const ws = new FakeTranscriptWs(store);
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
      rows: [...exchange(1), sayRow(1), ...exchange(2), sayRow(2)],
      filter: "say",
      says: [unreadSay(2)],
      requests: [request("i/1")],
    });
    expect(lines(root).dataset.filter).toBe("say");
    expect(kept(root)).toEqual([
      ["say", uuidOf("a", 101)],
      ["say", uuidOf("a", 102)],
      ["permit", permitPosition("i/1")],
    ]);
    // 種類を名乗らない子 (ユーザ発話・応答) も DOM には残っている (隠すのは CSS)。
    expect(lines(root).querySelector(`[data-timeline-uuid="${uuidOf("u", 1)}"]`)).not.toBeNull();

    await filterTo(store, null);
    expect(lines(root).dataset.filter).toBeUndefined();
  });

  test("says so when nothing of the kind is loaded", async () => {
    const { root, store } = await open({ rows: [...exchange(1)], filter: "say" });
    expect(root.querySelector(".tl-filter-empty")?.textContent).toBe(
      "読み込み済みの範囲に say はありません",
    );
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

  test("a permission-request bubble is selected by its record id, keeping the filter", async () => {
    const { root, store } = await open({
      rows: [...exchange(1)],
      filter: "permit",
      requests: [request("i/1")],
    });
    const item = instanceOf(
      root.querySelector(`[data-timeline-uuid="${permitPosition("i/1")}"]`),
      HTMLElement,
      "permit item",
    );
    const blocked = instanceOf(item.querySelector(".permit-section"), HTMLElement, "section");
    await act(() => blocked.click());
    expect(navigations).toEqual([`/s/${SID}/timeline/permit%3Ai%2F1?filter=permit`]);
    await filterTo(store, "permit", permitPosition("i/1"));
    expect(item.classList.contains("tl-position-selected")).toBe(true);
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

  test("an unread say older than the window makes the 🔔 filter read older until it is in", async () => {
    // 窓は 1:02:03 からで、未読の toolu_1 (1:00:01) はそれより前にある。
    const { ws } = await open({
      rows: [...exchange(1)],
      start: 5000,
      filter: "say",
      says: [unreadSay(1)],
    });
    expect(ws.reads.length).toBe(2);
    expect(ws.lastRead().opts?.before).toBe(5000);
    await ws.lastRead().answer(page([sayRow(1)], 4000));
    // 含まれたので、それ以上は遡らない。
    expect(ws.reads.length).toBe(2);
  });

  test("an unread say newer than the window's start is not looked for in older pages", async () => {
    // toolu_9 (1:00:09) は窓の先頭 (1:00:01) より新しい = live で届く途中。
    const { ws } = await open({
      rows: [sayRow(1)],
      start: 5000,
      filter: "say",
      says: [unreadSay(9)],
    });
    expect(ws.reads.length).toBe(1);
  });

  test("no filter, no reading older for the unread", async () => {
    const { ws } = await open({
      rows: [...exchange(1)],
      start: 5000,
      filter: null,
      says: [unreadSay(1)],
    });
    expect(ws.reads.length).toBe(1);
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
