// The in-view search as the 🔍 filter of the session's own Timeline
// (DR-0022 §2, §3), mounted:
// - the toolbar has the 🔍 badge alone (no search bar); the form is the
//   filter's, above the rows, the same element hidden without the filter
// - under `?filter=search` the window's items whose rows the query matches
//   stay (`data-search-hit`), and a fold's matched row is drawn apart
//   (`data-filter-only="search"`) at its time
// - the form edits the session's query (the store's timelineSearch), shows its
//   words and the number of matched items
// - a click on a matched item moves to its row in the Timeline (DR-0058 §6)
// - the 過去分を読む button reads an older page into the same window, whose
//   matches join the list and whose rows stay when the filter is taken off
// - with no query, and with none matched, one line says so
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { timelineHref, type TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  thinkingBlock,
  toolUseBlock,
} from "../../protocol/test/transcript-rows.ts";
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

async function filterTo(store: Store, filter: TimelineFilter | null) {
  await act(() =>
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid: SID, position: "head", ...(filter ? { filter } : {}) },
      sidebar: CLOSED_SIDEBAR,
    }),
  );
}

async function searchFor(store: Store, queryText: string) {
  await act(() =>
    store.dispatch({
      type: "timeline/search-changed",
      sid: SID,
      search: { queryText, caseSensitive: false, regex: false },
    }),
  );
}

async function open(rows: readonly string[], start = 0) {
  const store = timelineStore();
  await filterTo(store, "search");
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page(rows, start));
  return { root, store, ws };
}

function el(root: HTMLElement, selector: string): HTMLElement {
  return instanceOf(root.querySelector(selector), HTMLElement, selector);
}

function hits(root: HTMLElement): string[] {
  return [...el(root, ".tl-lines").children].flatMap((child) =>
    child instanceof HTMLElement && child.hasAttribute("data-search-hit")
      ? [child.dataset.timelineUuid ?? ""]
      : [],
  );
}

/** An assistant row in a fold (thinking and a tool call, no text), then the
 * tool's result and the turn's answer. */
function foldedThinking(n: number, thought: string): string[] {
  return [
    jsonl(
      assistantContentRow(
        [thinkingBlock(thought), toolUseBlock("Bash", { command: "ls" }, `toolu_${n}`)],
        {
          uuid: uuidOf("a", 100 + n),
        },
      ),
    ),
    jsonl(assistantContentRow([textBlock(`final ${n}`)], { uuid: uuidOf("a", 200 + n) })),
  ];
}

describe("the 🔍 filter", () => {
  test("the toolbar has the 🔍 badge and no search bar; the form is the filter's", async () => {
    const { root, store } = await open([...exchange(1)]);
    const toolbar = el(root, ".tl-toolbar");
    expect(toolbar.querySelector(".search-bar")).toBeNull();
    expect(toolbar.querySelector(".notif-badge-search")?.getAttribute("aria-current")).toBe("true");
    const form = el(root, ".tl-search-form");
    expect(form.hidden).toBe(false);
    await filterTo(store, null);
    expect(el(root, ".tl-search-form")).toBe(form);
    expect(form.hidden).toBe(true);
  });

  test("keeps the window's items the query matches, and shows the words and the count", async () => {
    const { root, store } = await open([...exchange(1), ...exchange(2), ...exchange(3)]);
    await searchFor(store, "question 2\nanswer 3");
    expect(el(root, ".tl-lines").dataset.filter).toBe("search");
    expect(hits(root)).toEqual([uuidOf("u", 2), uuidOf("a", 3)]);
    expect(
      [...root.querySelectorAll(".tl-search-form-chips .search-bar-chip")].map(
        (c) => c.textContent,
      ),
    ).toEqual(["question", "2", "answer", "3"]);
    expect(el(root, ".tl-search-form-count").textContent).toBe("一致 2 項目 (読み込み済みの範囲)");
  });

  test("the form's field edits the session's query", async () => {
    const { root, store } = await open([...exchange(1), ...exchange(2)]);
    const field = instanceOf(
      root.querySelector(".tl-search-form-query"),
      HTMLTextAreaElement,
      "field",
    );
    await act(() => {
      field.value = "answer 1";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(store.getState().sessionTrees.get(SID)?.timelineSearch.queryText).toBe("answer 1");
    expect(hits(root)).toEqual([uuidOf("a", 1)]);
  });

  test("a fold's matched row is drawn apart, and a click on it moves to its row", async () => {
    const { root, store } = await open([...exchange(1), ...foldedThinking(1, "deep thought")]);
    await searchFor(store, "deep");
    expect(hits(root)).toEqual([]);
    const copy = el(root, '[data-filter-only="search"]');
    expect(copy.textContent).toContain("deep thought");
    await act(() => copy.click());
    expect(navigations).toEqual([timelineHref(SID, uuidOf("a", 101), null, true)]);
    expect(histories).toEqual(["replace"]);
  });

  test("a click on a matched item of the window moves to its row", async () => {
    const { root, store } = await open([...exchange(1), ...exchange(2)]);
    await searchFor(store, "question 1");
    const item = el(root, `[data-timeline-uuid="${uuidOf("u", 1)}"]`);
    await act(() => el(item, ".tl-bubble-body").click());
    expect(navigations).toEqual([timelineHref(SID, uuidOf("u", 1), null, true)]);
  });

  test("says so with no query, and with nothing matched", async () => {
    const { root, store } = await open([...exchange(1)]);
    await searchFor(store, "");
    expect(el(root, ".tl-filter-empty").textContent).toBe(
      "検索語を入れると、一致した項目だけが並びます",
    );
    await searchFor(store, "nowhere");
    expect(el(root, ".tl-filter-empty").textContent).toBe("読み込み済みの範囲に一致はありません");
  });

  test("過去分を読む reads the older page into the window, and its matches join", async () => {
    const older = exchange(1, "an older question");
    const start = endOf(older, 0);
    const { root, store, ws } = await open([...exchange(2)], start);
    await searchFor(store, "older");
    expect(hits(root)).toEqual([]);
    // The Timeline's own buttons stay hidden; the form has its own.
    expect(el(root, ".tl-load-older").hidden).toBe(true);
    const button = el(root, ".tl-search-older");
    expect(button.textContent).toBe("過去分を読む");
    await act(() => button.click());
    expect(ws.reads.at(-1)?.opts).toEqual({ before: start });
    await ws.lastRead().answer(page(older, 0));
    expect(hits(root)).toEqual([uuidOf("u", 1)]);
    // At the transcript's start there is nothing older to read.
    expect(root.querySelector(".tl-search-older")).toBeNull();
    // The rows read are the window's: they stay with the filter taken off.
    await filterTo(store, null);
    expect(root.querySelector(`[data-timeline-uuid="${uuidOf("u", 1)}"]`)).not.toBeNull();
  });
});
