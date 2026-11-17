// The day bands, the gaps and the mark at the end of the Timeline (DR-0054),
// mounted in a Timeline: where they go among the items, that they are decided
// over what is shown (a filter's bubbles, a fold group as one item), that the
// band at the top follows the top as older rows come in, that the mark at the
// end shows only while the session's module says no turn is running, and that
// none of them counts as a row of the conversation.
//
// The rows are stamped at noon UTC on days of January and February, when no
// zone changes its clock, so every item falls on the same local date in any
// zone from UTC-12 to UTC+11, and the days between items are the same in all
// of them. What a band says is computed with the browser's own zone, as the
// Timeline does, so the test reads the same wherever it runs. The rule itself
// (calendar days, summer time) is fixed zone by zone in
// timeline-day-marks.test.ts.
import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { CCMSG_TOOLS, type SessionStatusSnapshot } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { TurnIdleMark } from "../src/client/components/timeline/DayMarks.tsx";
import { gapWords, idleWords } from "../src/client/elapsed-words.ts";
import { firstRowScrollAnchor } from "../src/client/components/timeline/scrollAnchor.ts";
import { useApp } from "../src/client/context.ts";
import type { AgentRef, TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { _resetJapanHolidaysForTest, holidaysUrl } from "../src/client/japan-holidays.ts";
import { calendarDayOf, dayLabel, isoDateOf } from "../src/client/timeline-day-marks.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { defined, instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import {
  endOf,
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
  _resetJapanHolidaysForTest();
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
  setSystemTime();
});

/** noon UTC of `date` (`YYYY-MM-DD`), plus `minutes`. */
function noon(date: string, minutes = 0): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + minutes * 60_000).toISOString();
}

/** What the band of the day `ts` falls on says, in the browser's zone. */
function bandOf(ts: string, holiday: string | null = null): string {
  return dayLabel(calendarDayOf()(Date.parse(ts)), holiday);
}

/** The ISO date of the day `ts` falls on, in the browser's zone. */
function localDateOf(ts: string): string {
  return isoDateOf(calendarDayOf()(Date.parse(ts)));
}

/** A user prompt and its answer, both at `ts` (uuid `u<n>` / `a<n>`). */
function exchangeAt(n: number, ts: string): string[] {
  return [
    jsonl(userContentRow(`question ${n}`, { uuid: uuidOf("u", n), timestamp: ts })),
    jsonl(assistantContentRow([textBlock(`answer ${n}`)], { uuid: uuidOf("a", n), timestamp: ts })),
  ];
}

/** A say the assistant made at `ts` (`toolu_<n>`, uuid `a<100+n>`). */
function sayAt(n: number, ts: string): string {
  return jsonl(
    assistantContentRow(
      [{ type: "tool_use", id: `toolu_${n}`, name: CCMSG_TOOLS.say, input: { text: `said ${n}` } }],
      { uuid: uuidOf("a", 100 + n), timestamp: ts },
    ),
  );
}

/** A tool call and its result, at `callTs` and `resultTs`: rows that go into
 * a fold group. */
function toolAt(id: string, callTs: string, resultTs: string): string[] {
  return [
    jsonl(
      assistantContentRow([toolUseBlock("Read", { file_path: "src/a.ts" }, id)], {
        timestamp: callTs,
      }),
    ),
    jsonl(
      userContentRow([toolResultBlock("1\talpha", { tool_use_id: id })], { timestamp: resultTs }),
    ),
  ];
}

const BASE_STATUS: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };

function TimelineOf({
  status,
  agent,
}: {
  status: SessionStatusSnapshot | undefined;
  agent: AgentRef | null;
}) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: status,
    agent,
    active: true,
    visible: true,
  });
}

interface View {
  root: HTMLElement;
  store: Store;
  ws: FakeTranscriptWs;
  setStatus(status: SessionStatusSnapshot | undefined): Promise<void>;
}

async function filterTo(store: Store, filter: TimelineFilter | null): Promise<void> {
  await act(() =>
    store.dispatch({
      type: "locator/changed",
      locator: {
        view: "timeline",
        sid: SID,
        position: "head",
        ...(filter !== null ? { filter } : {}),
      },
      sidebar: CLOSED_SIDEBAR,
    }),
  );
}

async function open(options: {
  rows: readonly string[];
  start?: number;
  filter?: TimelineFilter | null;
  status?: SessionStatusSnapshot;
  agent?: AgentRef;
}): Promise<View> {
  const store = timelineStore(options.agent !== undefined ? { agent: options.agent } : {});
  if (options.filter !== undefined && options.filter !== null)
    await filterTo(store, options.filter);
  const ws = new FakeTranscriptWs(store);
  const agent = options.agent ?? null;
  const root = await mounted.mount(
    store,
    ws.handle,
    h(TimelineOf, { status: options.status, agent }),
  );
  await ws.lastRead().answer(page(options.rows, options.start ?? 0));
  return {
    root,
    store,
    ws,
    setStatus: (status) => mounted.rerender(store, ws.handle, h(TimelineOf, { status, agent })),
  };
}

function lines(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-lines"), HTMLElement, ".tl-lines");
}

/** What assistive technology reads of a mark: the band's date (its
 * separator), or the elapsed mark's sentence. */
function markName(mark: HTMLElement): string {
  const named = mark.dataset.tlMarker === "day" ? mark.querySelector(".tl-day-label") : mark;
  return named?.getAttribute("aria-label") ?? "";
}

/** The `spoken` sentence of the gap of `days` calendar days between `from`
 * and `to`. */
function gapName(days: number, from: string, to: string): string {
  return gapWords(days, Date.parse(to) - Date.parse(from)).spoken;
}

/** The children of `.tl-lines` as words: a mark of the view on show (all of
 * the Timeline, or the filter's) as `<kind>: <its name>`, an item with a
 * position as its uuid, a fold group as `fold`. The rest (the marks of the
 * other views, the buttons at the end) are left out. */
function sequence(root: HTMLElement): string[] {
  const view = lines(root).dataset.filter ?? "all";
  return [...lines(root).children].flatMap((child): string[] => {
    if (!(child instanceof HTMLElement)) return [];
    const marker = child.dataset.tlMarker;
    const views = child.dataset.tlViews?.split(" ");
    if (views !== undefined && !views.includes(view)) return [];
    if (marker !== undefined) return [`${marker}: ${markName(child)}`];
    const uuid = child.dataset.timelineUuid;
    if (uuid !== undefined) return [uuid];
    if (child.matches(".tl-fold-group, .tl-guided-content")) return ["fold"];
    return [];
  });
}

const DAY_A = noon("2027-01-12");
const DAY_A_LATER = noon("2027-01-12", 10);
const DAY_B = noon("2027-01-13");
const DAY_E = noon("2027-01-16");
const DAY_WEEKS = noon("2027-02-06");

describe("the day bands and the gaps", () => {
  // kawaz (2026-11-17): a band over the first item of each day, the band only
  // when the day before had items, and a gap mark above the band when two or
  // more days lie between. The window's first item gets the band of its day.
  test("go right above the first item of each day, with the gap above the band", async () => {
    const view = await open({
      rows: [
        ...exchangeAt(1, DAY_A),
        ...exchangeAt(2, DAY_A_LATER),
        ...exchangeAt(3, DAY_B),
        ...exchangeAt(4, DAY_E),
        ...exchangeAt(5, DAY_WEEKS),
      ],
    });
    expect(sequence(view.root)).toEqual([
      `day: ${bandOf(DAY_A)}`,
      uuidOf("u", 1),
      uuidOf("a", 1),
      uuidOf("u", 2),
      uuidOf("a", 2),
      `day: ${bandOf(DAY_B)}`,
      uuidOf("u", 3),
      uuidOf("a", 3),
      `gap: ${gapName(3, DAY_B, DAY_E)}`,
      `day: ${bandOf(DAY_E)}`,
      uuidOf("u", 4),
      uuidOf("a", 4),
      `gap: ${gapName(21, DAY_E, DAY_WEEKS)}`,
      `day: ${bandOf(DAY_WEEKS)}`,
      uuidOf("u", 5),
      uuidOf("a", 5),
    ]);
  });

  // A fold group is one item, dated from its first row: the rows folded in it
  // put no band inside it. Its last row is where the gap to the next item is
  // measured from, so a run of tools that went on into the next day leaves no
  // gap, while the next item still starts the new day's band.
  test("a fold group is one item, from its first row to its last", async () => {
    const view = await open({
      rows: [
        jsonl(userContentRow("question 1", { uuid: uuidOf("u", 1), timestamp: DAY_A })),
        ...toolAt("tu_1", noon("2027-01-12", 1), noon("2027-01-14")),
        jsonl(
          assistantContentRow([textBlock("answer 1")], {
            uuid: uuidOf("a", 1),
            timestamp: noon("2027-01-14", 5),
          }),
        ),
      ],
    });
    expect(sequence(view.root)).toEqual([
      `day: ${bandOf(DAY_A)}`,
      uuidOf("u", 1),
      "fold",
      `day: ${bandOf(noon("2027-01-14"))}`,
      uuidOf("a", 1),
    ]);
  });

  // Under the 🔔 filter only the says are shown, and the bands are decided
  // over them: the top band is the first say's day, not the first row's, and
  // the days of the hidden rows put no band between the says.
  test("are decided over what the filter shows", async () => {
    const view = await open({
      rows: [
        ...exchangeAt(1, DAY_A),
        sayAt(1, DAY_B),
        ...exchangeAt(2, noon("2027-01-14")),
        sayAt(2, noon("2027-01-15")),
      ],
      filter: "say",
    });
    const marks = (words: string[]) =>
      words.filter((word) => word.startsWith("day:") || word.startsWith("gap:"));
    expect(marks(sequence(view.root))).toEqual([
      `day: ${bandOf(DAY_B)}`,
      `gap: ${gapName(2, DAY_B, noon("2027-01-15"))}`,
      `day: ${bandOf(noon("2027-01-15"))}`,
    ]);
    // Each band sits right above its say.
    const words = sequence(view.root);
    expect(words[words.indexOf(`day: ${bandOf(DAY_B)}`) + 1]).toBe(uuidOf("a", 101));
    expect(words[words.indexOf(`day: ${bandOf(noon("2027-01-15"))}`) + 1]).toBe(uuidOf("a", 102));

    // Off the filter, every row is shown and the bands are the rows' days.
    await filterTo(view.store, null);
    expect(marks(sequence(view.root))).toEqual([
      `day: ${bandOf(DAY_A)}`,
      `day: ${bandOf(DAY_B)}`,
      `day: ${bandOf(noon("2027-01-14"))}`,
      `day: ${bandOf(noon("2027-01-15"))}`,
    ]);
  });

  // Every view's marks are drawn, and app.css shows the view's own: switching
  // the filter hides and shows, and draws nothing anew (DR-0050 §5).
  test("app.css shows the marks of the view on show and hides the rest", async () => {
    const style = document.createElement("style");
    const css = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    style.textContent = css.replace(/\s+/g, " ");
    document.head.append(style);
    try {
      const view = await open({
        rows: [...exchangeAt(1, DAY_A), sayAt(1, DAY_B), ...exchangeAt(2, noon("2027-01-14"))],
      });
      const shownBands = () =>
        [...lines(view.root).querySelectorAll<HTMLElement>("[data-tl-marker='day']")]
          .filter((band) => getComputedStyle(band).display !== "none")
          .map(markName);
      const drawn = [...lines(view.root).querySelectorAll("[data-tl-marker]")];
      expect(shownBands()).toEqual([bandOf(DAY_A), bandOf(DAY_B), bandOf(noon("2027-01-14"))]);
      await filterTo(view.store, "say");
      expect(shownBands()).toEqual([bandOf(DAY_B)]);
      await filterTo(view.store, "permit");
      expect(shownBands()).toEqual([]);
      await filterTo(view.store, null);
      expect(shownBands()).toEqual([bandOf(DAY_A), bandOf(DAY_B), bandOf(noon("2027-01-14"))]);
      const after = [...lines(view.root).querySelectorAll("[data-tl-marker]")];
      expect(after.length).toBe(drawn.length);
      expect(after.every((mark, i) => mark === drawn[i])).toBe(true);
    } finally {
      style.remove();
    }
  });

  // The top band says what day the top of the loaded window is on: when older
  // rows come in above, it moves to the new top, and the old top's day gets an
  // ordinary band (it starts a day the rows above did not).
  test("the top band follows the top of the window when older rows come in", async () => {
    const older = exchangeAt(1, DAY_A);
    const newer = exchangeAt(2, DAY_B);
    const view = await open({ rows: newer, start: endOf(older, 0) });
    expect(sequence(view.root)).toEqual([`day: ${bandOf(DAY_B)}`, uuidOf("u", 2), uuidOf("a", 2)]);

    const button = instanceOf(
      view.root.querySelector('.tl-load-older button[data-placement="above"]'),
      HTMLButtonElement,
      "過去分を上に読み込む",
    );
    await act(() => button.click());
    await view.ws.lastRead().answer(page(older, 0));
    expect(sequence(view.root)).toEqual([
      `day: ${bandOf(DAY_A)}`,
      uuidOf("u", 1),
      uuidOf("a", 1),
      `day: ${bandOf(DAY_B)}`,
      uuidOf("u", 2),
      uuidOf("a", 2),
    ]);
  });

  // The band is drawn at once with the date and the weekday, and the name of
  // a Japanese holiday joins them when the year's list arrives. The day is
  // looked up as the browser's calendar has it.
  test("a holiday's name joins the band when the year's list arrives", async () => {
    const holiday = noon("2027-01-11");
    const date = localDateOf(holiday);
    let release = (): void => {};
    restores.push(
      stubGlobal(
        "fetch",
        (input: string) =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve(
                input === holidaysUrl(Number(date.slice(0, 4)))
                  ? Response.json({ [date]: "成人の日" })
                  : new Response("", { status: 404 }),
              );
          }),
      ),
    );
    const view = await open({ rows: exchangeAt(1, holiday) });
    expect(sequence(view.root)[0]).toBe(`day: ${bandOf(holiday)}`);
    await act(async () => {
      release();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(sequence(view.root)[0]).toBe(`day: ${bandOf(holiday, "成人の日")}`);
    expect(lines(view.root).querySelector(".tl-day-label")?.getAttribute("data-label")).toBe(
      bandOf(holiday, "成人の日"),
    );
  });
});

describe("the mark at the end", () => {
  const LAST = noon("2027-01-12", 30);
  const rows = [...exchangeAt(1, DAY_A), ...exchangeAt(2, LAST)];

  // While the module says the main thread answers no turn, the end of the
  // Timeline says how long ago the last row was written (a turn's rows land as
  // it ends). While a turn runs, 応答中 stands there instead; without the
  // module's word, nothing is guessed.
  test("shows while no turn runs, and not while one does or when no module said", async () => {
    setSystemTime(Date.parse(LAST) + 3 * 60_000 + 12_000);
    const idle = { ...BASE_STATUS, turn: { state: "idle" as const, since: DAY_A } };
    const view = await open({ rows, status: idle });
    expect(sequence(view.root).at(-1)).toBe(`idle: ${idleWords(3 * 60_000 + 12_000).spoken}`);
    expect(view.root.querySelector(".tl-turn-responding")).toBeNull();

    await view.setStatus({ ...BASE_STATUS, turn: { state: "responding", since: LAST } });
    expect(view.root.querySelector("[data-tl-marker='idle']")).toBeNull();
    expect(view.root.querySelector(".tl-turn-responding")).not.toBeNull();

    await view.setStatus(BASE_STATUS);
    expect(view.root.querySelector("[data-tl-marker='idle']")).toBeNull();
    await view.setStatus(undefined);
    expect(view.root.querySelector("[data-tl-marker='idle']")).toBeNull();
  });

  // An agent's Timeline is not the main thread's: no mark there.
  test("is not on an agent's Timeline", async () => {
    const idle = { ...BASE_STATUS, turn: { state: "idle" as const, since: DAY_A } };
    const view = await open({ rows, status: idle, agent: { agentId: "a1b2c3" } });
    expect(view.root.querySelector("[data-tl-marker='idle']")).toBeNull();
  });
});

describe("TurnIdleMark", () => {
  let container: HTMLElement | null = null;
  afterEach(async () => {
    jest.useRealTimers();
    const root = container;
    container = null;
    if (root === null) return;
    await act(() => render(null, root));
    root.remove();
  });

  // The time counts on while it is shown, by the second, as 応答中 does.
  test("counts on by the second", async () => {
    jest.useFakeTimers();
    const ended = Date.parse("2027-01-12T12:00:00Z");
    setSystemTime(ended + 59_000);
    const root = document.createElement("div");
    document.body.append(root);
    container = root;
    await act(() => render(h(TurnIdleMark, { endedAt: ended }), root));
    const label = root.querySelector("[data-label]");
    const shown = () => [label?.getAttribute("data-label"), label?.getAttribute("data-detail")];
    expect(shown()).toEqual(["59秒", null]);
    await act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(shown()).toEqual(["1分", "1m1s"]);
  });
});

describe("the marks are not rows of the conversation", () => {
  const rows = [...exchangeAt(1, DAY_A), ...exchangeAt(2, DAY_E)];

  // A mark has no position, no kind, no jsonl toggle and no menu: it is not
  // an item (ItemRawToggle). Assistive technology reads its words as a
  // separator: the elapsed mark is one, and the band's date is (beside the
  // band's two buttons, which a separator would hide, its children being
  // presentational). No word of a mark, and no arrow's sign, is text in the
  // DOM: they are drawn from data-label as generated content, which a
  // selection across the mark cannot take in.
  test("carry no position, kind, toggle or menu, read as separators, and hold no text", async () => {
    const idle = { ...BASE_STATUS, turn: { state: "idle" as const, since: DAY_A } };
    const view = await open({ rows, status: idle });
    const marks = [...lines(view.root).querySelectorAll<HTMLElement>("[data-tl-marker]")];
    expect(marks.map((mark) => mark.dataset.tlMarker)).toEqual(["day", "gap", "day", "idle"]);
    for (const mark of marks) {
      const separator =
        mark.dataset.tlMarker === "day" ? mark.querySelector(".tl-day-label") : mark;
      expect(separator?.getAttribute("role")).toBe("separator");
      expect(separator?.querySelector("button")).toBeNull();
      expect(mark.textContent).toBe("");
      expect(mark.dataset.timelineUuid).toBeUndefined();
      expect(mark.dataset.notif).toBeUndefined();
      expect(mark.classList.contains("tl-item")).toBe(false);
    }
    const band = defined(marks[0], "the top band");
    expect(band.querySelector(".tl-day-label")?.getAttribute("data-label")).toBe(bandOf(DAY_A));
    expect(
      [...band.querySelectorAll("button")].map((button) => [
        button.type,
        button.getAttribute("aria-label"),
        button.dataset.label,
      ]),
    ).toEqual([
      ["button", "前の日付へ", "↑"],
      ["button", "次の日付へ", "↓"],
    ]);
    expect(marks[1]?.querySelector("[data-label]")?.getAttribute("data-label")).toBe("4日");
    const elapsed = marks.filter((mark) => mark.dataset.tlMarker !== "day");
    expect(elapsed.every((mark) => mark.querySelector("button") === null)).toBe(true);
  });

  // A press on the band's date selects nothing and moves nothing: the
  // position (URL) is not touched. Only its arrows act.
  test("a press on the band's date does nothing", async () => {
    const view = await open({ rows });
    await act(() =>
      instanceOf(lines(view.root).querySelector(".tl-day-label"), HTMLElement, "date").click(),
    );
    expect(navigations).toEqual([]);
  });

  // The in-view search does not find the marks' words: only the
  // conversation's units are searched.
  test("the in-view search does not find their words", async () => {
    const view = await open({ rows });
    const count = async (queryText: string) => {
      await act(() =>
        view.store.dispatch({
          type: "timeline/search-changed",
          sid: SID,
          search: { queryText, caseSensitive: false, regex: false },
        }),
      );
      return view.root.querySelector(".search-bar-count")?.textContent ?? "";
    };
    const none = await count("zzzz-no-such-word");
    expect(await count("4日")).toBe(none);
    expect(await count("2027年")).toBe(none);
    expect(await count("question")).not.toBe(none);
  });

  // When older rows are read in above, what is held in place is a row: the
  // top band moves to the new top, so it is never what is held, even when no
  // row with a position is drawn (a window of fold groups).
  test("the row held while older rows come in is never a mark", () => {
    const scroller = document.createElement("div");
    const tl = document.createElement("div");
    const band = document.createElement("div");
    band.dataset.tlMarker = "day";
    const fold = document.createElement("div");
    tl.append(band, fold);
    scroller.append(tl);
    document.body.append(scroller);
    // happy-dom lays nothing out: both are drawn, one box each.
    const drawn = { value: () => [new DOMRect(0, 0, 10, 10)] };
    restores.push(
      () => scroller.remove(),
      stubProperty(band, "getClientRects", drawn),
      stubProperty(fold, "getClientRects", drawn),
    );
    const anchor = firstRowScrollAnchor(scroller, tl);
    expect(anchor?.kind === "element" ? anchor.element : null).toBe(fold);
  });
});

describe("↑ / ↓ on a day band", () => {
  // happy-dom lays nothing out: put each day band 100px below the one before
  // (the first at 1000px), the toolbar's bottom at 50px and everything else at
  // 0, and record where the scroller is sent. Landing on a band puts it right
  // below the toolbar: scrollTop = its top - 50 (toolbar-offset.ts).
  let scrolledTo: number[] = [];
  const BAND_TOP = 1000;
  const TOOLBAR_BOTTOM = 50;
  beforeEach(() => {
    scrolledTo = [];
    const proto = HTMLElement.prototype;
    restores.push(
      stubProperty(proto, "getBoundingClientRect", {
        configurable: true,
        value(this: HTMLElement) {
          if (this.classList.contains("tl-toolbar")) return new DOMRect(0, 0, 100, TOOLBAR_BOTTOM);
          const bands = [...document.querySelectorAll(".tl-lines > [data-tl-marker='day']")];
          const index = bands.indexOf(this);
          return new DOMRect(0, index < 0 ? 0 : BAND_TOP + index * 100, 100, 40);
        },
      }),
      stubProperty(proto, "scrollTo", {
        configurable: true,
        value(this: HTMLElement, options: ScrollToOptions) {
          if (this.classList.contains("timeline-view")) scrolledTo.push(options.top ?? 0);
        },
      }),
    );
  });

  /** The band of the day `ts` falls on (in the view on show). */
  function bandOn(root: HTMLElement, ts: string): HTMLElement {
    const view = lines(root).dataset.filter ?? "all";
    const band = [...lines(root).querySelectorAll<HTMLElement>("[data-tl-marker='day']")].find(
      (el) => el.dataset.tlDay === localDateOf(ts) && el.dataset.tlViews?.split(" ").includes(view),
    );
    return instanceOf(band ?? null, HTMLElement, `band of ${ts}`);
  }

  function arrow(band: HTMLElement, step: "up" | "down"): HTMLButtonElement {
    return instanceOf(
      band.querySelector(`.tl-day-step[data-step="${step}"]`),
      HTMLButtonElement,
      `${step} arrow`,
    );
  }

  /** Where landing on `band` sends the scroller. */
  function landingOf(root: HTMLElement, band: HTMLElement): number {
    const view = lines(root).dataset.filter ?? "all";
    const all = [...lines(root).querySelectorAll(".tl-lines > [data-tl-marker='day']")];
    expect(band.dataset.tlViews?.split(" ")).toContain(view);
    return BAND_TOP + all.indexOf(band) * 100 - TOOLBAR_BOTTOM;
  }

  /** Let `n` frames go by (a search goes on a frame after its page lands). */
  async function frames(n: number): Promise<void> {
    await act(async () => {
      for (let i = 0; i < n; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
  }

  async function press(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }

  const rows = [...exchangeAt(1, DAY_A), ...exchangeAt(2, DAY_B), ...exchangeAt(3, DAY_E)];

  // ↑ / ↓ go to the band right above / below, put it below the toolbar, and
  // move the focus to the same arrow of that band, so pressing on walks the
  // days.
  test("step to the band above or below, and the focus follows", async () => {
    const view = await open({ rows });
    await press(arrow(bandOn(view.root, DAY_B), "down"));
    const e = bandOn(view.root, DAY_E);
    expect(scrolledTo.at(-1)).toBe(landingOf(view.root, e));
    expect(document.activeElement).toBe(arrow(e, "down"));

    await press(arrow(e, "up"));
    const b = bandOn(view.root, DAY_B);
    expect(scrolledTo.at(-1)).toBe(landingOf(view.root, b));
    expect(document.activeElement).toBe(arrow(b, "up"));
  });

  // Past the last band, ↓ goes to the end of the Timeline as ⤓ does.
  test("↓ on the last band goes to the end", async () => {
    const view = await open({ rows });
    const scroller = instanceOf(view.root.querySelector(".timeline-view"), HTMLElement, "scroller");
    restores.push(stubProperty(scroller, "scrollHeight", { configurable: true, value: 5000 }));
    scroller.scrollTop = 0;
    await press(arrow(bandOn(view.root, DAY_E), "down"));
    expect(scroller.scrollTop).toBe(5000);
  });

  // ↑ on the first band of a window that does not start at the start of the
  // transcript reads the older page in (as 「過去分を上に読み込む」) and steps
  // to the band that came in above.
  test("↑ on the top band reads older rows in until a band shows up above", async () => {
    const older = exchangeAt(1, DAY_A);
    const newer = [...exchangeAt(2, DAY_B), ...exchangeAt(3, DAY_E)];
    const view = await open({ rows: newer, start: endOf(older, 0) });
    await press(arrow(bandOn(view.root, DAY_B), "up"));
    expect(view.ws.lastRead().opts).toEqual({ before: endOf(older, 0) });
    await view.ws.lastRead().answer(page(older, 0));
    await frames(3);
    const a = bandOn(view.root, DAY_A);
    expect(scrolledTo.at(-1)).toBe(landingOf(view.root, a));
    expect(document.activeElement).toBe(arrow(a, "up"));
  });

  // Read to the start of the transcript with no band above: the first day,
  // so ↑ goes to the top as ⤒ does.
  test("↑ on the first day of the transcript goes to the top", async () => {
    const view = await open({ rows });
    const reads = view.ws.reads.length;
    await press(arrow(bandOn(view.root, DAY_A), "up"));
    expect(view.ws.reads).toHaveLength(reads);
    expect(scrolledTo.at(-1)).toBe(0);
  });

  // A search that is reading older rows lets go when anything else happens:
  // here another arrow is pressed while the page is on its way. When the page
  // lands, the old search moves nothing; the newer press stands.
  test("a search let go of moves nothing when its page lands", async () => {
    const older = exchangeAt(1, DAY_A);
    const newer = [...exchangeAt(2, DAY_B), ...exchangeAt(3, DAY_E)];
    const view = await open({ rows: newer, start: endOf(older, 0) });
    await press(arrow(bandOn(view.root, DAY_B), "up"));
    const pending = view.ws.lastRead();
    await press(arrow(bandOn(view.root, DAY_B), "down"));
    const e = bandOn(view.root, DAY_E);
    expect(document.activeElement).toBe(arrow(e, "down"));
    await pending.answer(page(older, 0));
    await frames(3);
    // The band of DAY_A came in above; the scroller is still held on DAY_E's
    // band (its hold puts it there again as the rows above grew), and the
    // focus stays on it.
    expect(lines(view.root).querySelector(`[data-tl-day="${localDateOf(DAY_A)}"]`)).not.toBeNull();
    expect(scrolledTo.at(-1)).toBe(landingOf(view.root, e));
    expect(document.activeElement).toBe(arrow(e, "down"));
  });

  // The reader's own scrolling lets go of the search too.
  test("the reader's own scrolling lets go of the search", async () => {
    const older = exchangeAt(1, DAY_A);
    const newer = [...exchangeAt(2, DAY_B), ...exchangeAt(3, DAY_E)];
    const view = await open({ rows: newer, start: endOf(older, 0) });
    const top = bandOn(view.root, DAY_B);
    await press(arrow(top, "up"));
    const landed = scrolledTo.length;
    const scroller = instanceOf(view.root.querySelector(".timeline-view"), HTMLElement, "scroller");
    await act(() => {
      scroller.dispatchEvent(new Event("wheel"));
    });
    await view.ws.lastRead().answer(page(older, 0));
    await frames(3);
    expect(scrolledTo.length).toBe(landed);
  });

  // Under a filter the arrows step between the bands of that view, and ↑ on
  // its first band goes to the top without reading anything (the filter
  // already shows every say).
  test("under a filter, steps between the filter's bands", async () => {
    const view = await open({
      rows: [
        ...exchangeAt(1, DAY_A),
        sayAt(1, DAY_B),
        ...exchangeAt(2, DAY_E),
        sayAt(2, DAY_WEEKS),
      ],
      start: 10,
      filter: "say",
    });
    const reads = view.ws.reads.length;
    await press(arrow(bandOn(view.root, DAY_B), "down"));
    const weeks = bandOn(view.root, DAY_WEEKS);
    expect(scrolledTo.at(-1)).toBe(landingOf(view.root, weeks));
    await press(arrow(weeks, "up"));
    await press(arrow(bandOn(view.root, DAY_B), "up"));
    expect(view.ws.reads).toHaveLength(reads);
    expect(scrolledTo.at(-1)).toBe(0);
  });
});
