// The Timeline's bookmarks (DR-0058), mounted:
// - every item carries a ☆ / ⭐ after its content (StarMark: both glyphs, the
//   box's data-shown picks one); an item with a uuid (a position) toggles its
//   bookmark through the daemon, and its wrapper says it is bookmarked; an
//   item without one (a fold's rows, a worker's say) shows ☆ disabled; an
//   agent's Timeline bookmarks nothing
// - the ⭐ filter keeps the bookmarked items (CSS on `data-bookmarked`), asks
//   the daemon for the rows of the session's bookmarks (bookmark_rows) and
//   shows the ones outside the window at their time, drawn as the window
//   draws them; with none, one line says so
// - under the ⭐ filter a click on an item moves to it in the Timeline, reading
//   older pages for one outside the window
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { CCMSG_TOOLS, PERMIT_REQUESTED_TEXT } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { timelineHref, type AgentRef, type TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { timelineAutoOpenStorageKey } from "../src/client/timeline-auto-open.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  endOf,
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
  localStorage.clear();
  localStorage.setItem(
    timelineAutoOpenStorageKey(SID, undefined),
    JSON.stringify({ thinking: true, ccmsg: true, agent: true, edit: true, items: true }),
  );
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

async function filterTo(store: Store, filter: TimelineFilter | null, position = "head") {
  await act(() =>
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid: SID, position, ...(filter !== null ? { filter } : {}) },
      sidebar: CLOSED_SIDEBAR,
    }),
  );
}

async function open(options: {
  rows: readonly string[];
  start?: number;
  filter?: TimelineFilter | null;
  marked?: readonly string[];
  agent?: AgentRef;
  /** What bookmark_rows answers. */
  listed?: ReadonlyArray<{ uuid: string; lines: string[] }>;
}): Promise<{ root: HTMLElement; store: Store; ws: FakeTranscriptWs }> {
  const store = timelineStore();
  store.dispatch({
    type: "bookmarks/loaded",
    sessions: options.marked === undefined ? [] : [{ session_id: SID, uuids: [...options.marked] }],
  });
  await filterTo(store, options.filter ?? null);
  const ws = new FakeTranscriptWs(store);
  ws.bookmarkRows = options.listed ?? [];
  const root = await mounted.mount(
    store,
    ws.handle,
    h(TimelineOf, { agent: options.agent ?? null }),
  );
  await ws.lastRead().answer(page(options.rows, options.start ?? 0));
  return { root, store, ws };
}

function lines(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-lines"), HTMLElement, ".tl-lines");
}

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    lines(root).querySelector(`[data-timeline-uuid="${uuid}"]`),
    HTMLElement,
    `item ${uuid}`,
  );
}

function starOf(item: HTMLElement): HTMLButtonElement {
  return instanceOf(item.querySelector(":scope > .tl-item-star"), HTMLButtonElement, "star");
}

/** A Bash call and its result: rows that fold, with no position. */
function toolRows(): string[] {
  return [
    jsonl(assistantContentRow([toolUseBlock("Bash", { command: "ls" }, "toolu_ls")])),
    jsonl(userContentRow([toolResultBlock("a.txt", { tool_use_id: "toolu_ls" })])),
  ];
}

const drained = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("an item's ☆ / ⭐", () => {
  test("stands after the item's content and toggles the bookmark of the item's row", async () => {
    const { root, ws } = await open({ rows: [...exchange(1)] });
    const item = itemOf(root, uuidOf("u", 1));
    const star = starOf(item);
    expect(item.lastElementChild).toBe(star);
    expect(star.disabled).toBe(false);
    expect(star.getAttribute("aria-pressed")).toBe("false");
    const mark = instanceOf(star.querySelector(".star-mark"), HTMLElement, "mark");
    expect([...mark.children].map((child) => child.textContent)).toEqual(["☆", "⭐"]);
    expect(mark.getAttribute("data-shown")).toBe("0");
    expect(item.hasAttribute("data-bookmarked")).toBe(false);

    await act(() => star.click());
    expect(ws.bookmarkSets).toEqual([{ sid: SID, uuid: uuidOf("u", 1), on: true }]);
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(mark.getAttribute("data-shown")).toBe("1");
    expect(item.hasAttribute("data-bookmarked")).toBe(true);
    // A press of the star is the star's: it does not select the item.
    expect(navigations).toEqual([]);

    await act(() => star.click());
    expect(ws.bookmarkSets.at(-1)).toEqual({ sid: SID, uuid: uuidOf("u", 1), on: false });
    expect(item.hasAttribute("data-bookmarked")).toBe(false);
  });

  test("stands right of the jsonl toggle on every item, above the bubble on a user's prompt", async () => {
    const { root } = await open({ rows: [...exchange(1)] });
    for (const uuid of [uuidOf("u", 1), uuidOf("a", 1)]) {
      const item = itemOf(root, uuid);
      const toggle = instanceOf(
        item.querySelector(":scope > .tl-item-raw-toggle"),
        HTMLElement,
        "jsonl",
      );
      expect(
        toggle.compareDocumentPosition(starOf(item)) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(itemOf(root, uuidOf("u", 1)).classList.contains("tl-item-controls-above")).toBe(true);
    expect(itemOf(root, uuidOf("a", 1)).classList.contains("tl-item-controls-above")).toBe(false);
  });

  test("an item without a position (a fold's rows) shows ☆ that does nothing", async () => {
    const { root, ws } = await open({ rows: [...exchange(1), ...toolRows(), ...exchange(2)] });
    const card = [...lines(root).querySelectorAll<HTMLElement>(".tl-item")].find(
      (el) => el.dataset.timelineUuid === undefined && el.textContent?.includes("ls"),
    );
    const star = starOf(instanceOf(card, HTMLElement, "the Bash card"));
    expect(star.disabled).toBe(true);
    expect(star.hasAttribute("aria-pressed")).toBe(false);
    await act(() => star.click());
    expect(ws.bookmarkSets).toEqual([]);
  });

  // The star and the jsonl toggle take no room in the item (they are laid over
  // the item's corner, or above a user's prompt), so placing them changes
  // neither the item's height nor the gaps between the items (kawaz
  // 2026-11-20). The star's box is the jsonl toggle's height on every item.
  test("takes no room in the item, and is the jsonl toggle's size on every item", async () => {
    const style = document.createElement("style");
    const css = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    style.textContent = css.replace(/\s+/g, " ");
    document.head.append(style);
    try {
      const { root } = await open({ rows: [...exchange(1), ...toolRows(), ...exchange(2)] });
      const items = [...lines(root).querySelectorAll<HTMLElement>(".tl-item")];
      expect(items.length).toBeGreaterThan(2);
      for (const item of items) {
        expect(getComputedStyle(starOf(item)).position).toBe("absolute");
        const toggle = item.querySelector(":scope > .tl-item-raw-toggle");
        expect(toggle === null ? "absolute" : getComputedStyle(toggle).position).toBe("absolute");
        // The jsonl toggle's box: its type, its padding and its border.
        expect(getComputedStyle(item).getPropertyValue("--tl-star-size").trim()).toBe(
          "calc(0.6rem + 2 * 0.1rem + 2px)",
        );
        expect(getComputedStyle(starOf(item)).fontSize).toBe("11.2px");
      }
      // Above a user's prompt: the pair's bottom on the item's top.
      const user = itemOf(root, uuidOf("u", 1));
      for (const control of [user.querySelector(":scope > .tl-item-raw-toggle"), starOf(user)]) {
        const computed = getComputedStyle(instanceOf(control, HTMLElement, "control"));
        expect([computed.top, computed.bottom]).toEqual(["auto", "100%"]);
      }
    } finally {
      style.remove();
    }
  });

  test("an agent's Timeline bookmarks nothing: every star is disabled", async () => {
    const { root } = await open({ rows: [...exchange(1)], agent: { agentId: "a1234567" } });
    const stars = [...root.querySelectorAll<HTMLButtonElement>(".tl-item-star")];
    expect(stars.length).toBeGreaterThan(0);
    expect(stars.every((star) => star.disabled)).toBe(true);
  });
});

describe("the ⭐ filter", () => {
  test("keeps the bookmarked items, and asks for the rows of the bookmarks", async () => {
    const { root, ws } = await open({
      rows: [...exchange(1), ...exchange(2)],
      filter: "bookmark",
      marked: [uuidOf("a", 1), uuidOf("u", 2)],
    });
    expect(lines(root).dataset.filter).toBe("bookmark");
    expect(ws.bookmarkRowsAsked).toEqual([SID]);
    const kept = [...lines(root).children].flatMap((child) =>
      child instanceof HTMLElement && child.hasAttribute("data-bookmarked")
        ? [child.dataset.timelineUuid]
        : [],
    );
    expect(kept).toEqual([uuidOf("a", 1), uuidOf("u", 2)]);
    expect(root.querySelector(".tl-filter-empty")).toBeNull();
  });

  test("says so with no bookmark, once the rows are answered", async () => {
    const { root } = await open({ rows: [...exchange(1)], filter: "bookmark" });
    expect(root.querySelector(".tl-filter-empty")?.textContent).toBe("ブックマークはありません");
  });

  test("the filter's CSS hides what is not bookmarked", async () => {
    const style = document.createElement("style");
    const css = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    style.textContent = css.replace(/\s+/g, " ");
    document.head.append(style);
    try {
      const { root } = await open({
        rows: [...exchange(1)],
        filter: "bookmark",
        marked: [uuidOf("a", 1)],
      });
      expect(getComputedStyle(itemOf(root, uuidOf("u", 1))).display).toBe("none");
      expect(getComputedStyle(itemOf(root, uuidOf("a", 1))).display).not.toBe("none");
    } finally {
      style.remove();
    }
  });

  test("shows a bookmark outside the window at its time, drawn as the window draws its row", async () => {
    // The request for permission of the bookmarked row is one only with its
    // result, which comes with it from the daemon.
    const call = jsonl(
      assistantContentRow(
        [
          {
            type: "tool_use",
            id: "toolu_p9",
            name: CCMSG_TOOLS.permit,
            input: { blocked: "old block", intents: ["y"] },
          },
        ],
        { uuid: uuidOf("a", 900), timestamp: "2026-10-09T00:00:00.000Z" },
      ),
    );
    const result = jsonl(
      userContentRow([toolResultBlock(PERMIT_REQUESTED_TEXT, { tool_use_id: "toolu_p9" })], {
        uuid: uuidOf("u", 900),
        timestamp: "2026-10-09T00:00:00.000Z",
      }),
    );
    const said = jsonl(
      assistantContentRow([textBlock("an old answer")], {
        uuid: uuidOf("a", 901),
        timestamp: "2026-10-09T00:00:01.000Z",
      }),
    );
    const { root } = await open({
      rows: [...exchange(1)],
      start: 9000,
      filter: "bookmark",
      marked: [uuidOf("a", 900), uuidOf("a", 901), uuidOf("a", 1)],
      listed: [
        { uuid: uuidOf("a", 900), lines: [call, result] },
        { uuid: uuidOf("a", 901), lines: [said] },
      ],
    });
    const listed = [...lines(root).querySelectorAll<HTMLElement>('[data-filter-only="bookmark"]')];
    expect(listed.map((item) => item.querySelector(".tl-bubble")?.className)).toEqual([
      "tl-bubble tl-bubble-left tl-bubble-permit",
      "tl-bubble tl-bubble-left tl-bubble-assistant",
    ]);
    expect(listed.every((item) => item.hasAttribute("data-bookmarked"))).toBe(true);
    expect(listed.every((item) => item.dataset.timelineUuid === undefined)).toBe(true);
    // Its star takes the bookmark off.
    expect(starOf(listed[0] ?? root).getAttribute("aria-pressed")).toBe("true");
    // Older than the window's rows: above them.
    const window = itemOf(root, uuidOf("a", 1));
    for (const item of listed) {
      expect(item.compareDocumentPosition(window) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  test("a click on a bookmark outside the window reads older pages until its row is in, then moves to it", async () => {
    const oldest = [...exchange(9)];
    const windowStart = endOf(oldest, 0);
    const { root, ws } = await open({
      rows: [...exchange(1)],
      start: windowStart,
      filter: "bookmark",
      marked: [uuidOf("u", 9)],
      listed: [{ uuid: uuidOf("u", 9), lines: [oldest[0] ?? ""] }],
    });
    const listed = instanceOf(
      lines(root).querySelector('[data-filter-only="bookmark"]'),
      HTMLElement,
      "the listed bookmark",
    );
    await act(() =>
      instanceOf(listed.querySelector(".tl-bubble-body"), HTMLElement, "body").click(),
    );
    expect(ws.reads.map((read) => read.opts)).toEqual([undefined, { before: windowStart }]);
    await ws.lastRead().answer(page(oldest, 0));
    await drained();
    expect(navigations).toEqual([timelineHref(SID, uuidOf("u", 9))]);
  });

  test("a click on a bookmarked item in the window moves to it at once", async () => {
    const { root, ws } = await open({
      rows: [...exchange(1), ...exchange(2)],
      filter: "bookmark",
      marked: [uuidOf("a", 1)],
    });
    const body = itemOf(root, uuidOf("a", 1)).querySelector(".tl-bubble-body");
    await act(() => instanceOf(body, HTMLElement, "body").click());
    expect(navigations).toEqual([timelineHref(SID, uuidOf("a", 1))]);
    expect(ws.reads).toHaveLength(1);
  });
});
