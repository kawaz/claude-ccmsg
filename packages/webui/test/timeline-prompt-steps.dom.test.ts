// The 「↑前 | 次↓」 of a user's prompt in the session's Timeline (DR-0058 §3),
// mounted:
// - only the bubbles of the person's prompts carry it, left of the jsonl
//   toggle; an agent's Timeline has none
// - ↑前 / 次↓ move to the prompt one before / after, as a filter item's click
//   moves (the position with `seek=true`, replacing the entry)
// - the order is the session's whole: ↑前 is disabled on the oldest prompt and
//   次↓ on the newest; with older rows unread, prompt_rows say the prompts
//   before the window, and ↑前 of the window's first moves to the one before it,
//   which the landing reads older pages for
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { BookmarkRow } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { timelineHref, type AgentRef } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
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

const u = (n: number): string => uuidOf("u", n);

async function open(options: {
  rows: readonly string[];
  start?: number;
  agent?: AgentRef;
  promptRows?: readonly BookmarkRow[];
}): Promise<{ root: HTMLElement; store: Store; ws: FakeTranscriptWs }> {
  const store = timelineStore(options.agent !== undefined ? { agent: options.agent } : {});
  const ws = new FakeTranscriptWs(store);
  ws.promptRows = options.promptRows ?? [];
  const root = await mounted.mount(
    store,
    ws.handle,
    h(TimelineOf, { agent: options.agent ?? null }),
  );
  await ws.lastRead().answer(page(options.rows, options.start ?? 0));
  await drained();
  return { root, store, ws };
}

/** Let the replies and their renders settle. */
const drained = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    root.querySelector(`.tl-lines > [data-timeline-uuid="${uuid}"]`),
    HTMLElement,
    `the item ${uuid}`,
  );
}

function stepOf(root: HTMLElement, uuid: string, step: "prev" | "next"): HTMLButtonElement {
  return instanceOf(
    itemOf(root, uuid).querySelector(`.tl-item-prompt-steps > [data-step="${step}"]`),
    HTMLButtonElement,
    `${step} of ${uuid}`,
  );
}

const rowOf = (text: string): BookmarkRow => ({
  uuid: /"uuid":"([^"]+)"/.exec(text)?.[1] ?? "",
  lines: [text],
});

describe("「↑前 | 次↓」 of a user's prompt", () => {
  test("the prompts carry it left of the jsonl toggle, as two buttons in one group; answers do not", async () => {
    const { root } = await open({ rows: [...exchange(1), ...exchange(2)] });
    const prompt = itemOf(root, u(1));
    const group = instanceOf(
      prompt.querySelector(":scope > .tl-item-prompt-steps"),
      HTMLElement,
      "group",
    );
    expect(group.nextElementSibling?.classList.contains("tl-item-raw-toggle")).toBe(true);
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["↑前", "次↓"]);
    expect(itemOf(root, uuidOf("a", 1)).querySelector(".tl-item-prompt-steps")).toBeNull();
  });

  test("↑前 is disabled on the oldest prompt, 次↓ on the newest", async () => {
    const { root, ws } = await open({ rows: [...exchange(1), ...exchange(2), ...exchange(3)] });
    expect(stepOf(root, u(1), "prev").disabled).toBe(true);
    expect(stepOf(root, u(1), "next").disabled).toBe(false);
    expect(stepOf(root, u(2), "prev").disabled).toBe(false);
    expect(stepOf(root, u(2), "next").disabled).toBe(false);
    expect(stepOf(root, u(3), "prev").disabled).toBe(false);
    expect(stepOf(root, u(3), "next").disabled).toBe(true);
    // Read from the start: the window has every prompt, nothing is asked.
    expect(ws.promptRowsAsked).toEqual([]);
  });

  test("↑前 / 次↓ move to the prompt one before / after, replacing the entry", async () => {
    const { root } = await open({ rows: [...exchange(1), ...exchange(2), ...exchange(3)] });
    await act(() => stepOf(root, u(2), "prev").click());
    await act(() => stepOf(root, u(2), "next").click());
    expect(navigations).toEqual([
      timelineHref(SID, u(1), null, true),
      timelineHref(SID, u(3), null, true),
    ]);
    expect(histories).toEqual(["replace", "replace"]);
  });

  test("with older rows unread, ↑前 of the window's first prompt moves to the one before it, read in by the landing", async () => {
    const older = [...exchange(21, "an old prompt"), ...exchange(22, "a later old prompt")];
    const windowStart = endOf(older, 0);
    const windowRows = [...exchange(1), ...exchange(2)];
    const { root, store, ws } = await open({
      rows: windowRows,
      start: windowStart,
      promptRows: [rowOf(older[0] ?? ""), rowOf(older[2] ?? ""), rowOf(windowRows[0] ?? "")],
    });
    expect(ws.promptRowsAsked).toEqual([SID]);
    expect(stepOf(root, u(1), "prev").disabled).toBe(false);
    await act(() => stepOf(root, u(1), "prev").click());
    expect(navigations).toEqual([timelineHref(SID, u(22), null, true)]);
    // The URL's position with seek, as the navigation makes it: the landing
    // reads the older page before the window.
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, position: u(22), seek: true },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    expect(ws.reads.map((read) => read.opts)).toEqual([undefined, { before: windowStart }]);
  });

  test("with the oldest prompt before the window, ↑前 is disabled on it only", async () => {
    const older = [...exchange(21, "an old prompt")];
    const { root } = await open({
      rows: [...exchange(1)],
      start: endOf(older, 0),
      promptRows: [rowOf(older[0] ?? "")],
    });
    // u(1)'s previous is u(21), outside the window; u(1) is the newest.
    expect(stepOf(root, u(1), "prev").disabled).toBe(false);
    expect(stepOf(root, u(1), "next").disabled).toBe(true);
  });

  test("an agent's Timeline has none, and asks nothing", async () => {
    const { root, ws } = await open({
      rows: [...exchange(1), ...exchange(2)],
      start: 100,
      agent: { agentId: "a0123456789abcdef" },
    });
    expect(root.querySelector(".tl-item-prompt-steps")).toBeNull();
    expect(ws.promptRowsAsked).toEqual([]);
  });
});
