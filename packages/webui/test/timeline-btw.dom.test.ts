// A session's btws in its Timeline (DR-0060 §7), mounted: drawn right after
// the item of their anchor whatever their time, as the question and the
// fork's answer framed together; a running one says so with 取り消し, which
// sends btw_cancel; a failed one shows why; of the filters, only the 💬 one
// shows them (DR-0062 §13).
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { BtwRecord } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { instanceOf } from "./helpers.ts";
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

afterEach(async () => {
  await mounted.unmount();
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

function btw(fields: Partial<BtwRecord> & Pick<BtwRecord, "id">): BtwRecord {
  return {
    session_id: SID,
    ts: "2030-01-01T00:00:00.000Z",
    prompt: "横道の質問",
    response: "",
    status: "done",
    ...fields,
  };
}

async function open(
  btws: readonly BtwRecord[],
): Promise<{ root: HTMLElement; store: Store; cancels: string[] }> {
  const store = timelineStore();
  store.dispatch({ type: "btws/loaded", sid: SID, btws: [...btws] });
  const ws = new FakeTranscriptWs(store);
  const cancels: string[] = [];
  const handle = {
    ...ws.handle,
    btwCancel: (id: string) => {
      cancels.push(id);
      return Promise.resolve({ ok: true as const });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...exchange(1), ...exchange(2)]));
  return { root, store, cancels };
}

/** The Timeline's items, top to bottom, as the btw's id or the item's text. */
function order(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".tl-lines > .tl-item, .tl-lines > [data-btw-id]")].flatMap(
    (item) => {
      const btwId = item.querySelector("[data-btw-id]")?.getAttribute("data-btw-id");
      if (btwId) return [`btw:${btwId}`];
      const text = item.textContent ?? "";
      const said = /(question|answer) \d/.exec(text);
      return said ? [said[0]] : [];
    },
  );
}

describe("a session's btws in its Timeline", () => {
  test("right after the item of its anchor, though it was asked long after", async () => {
    const { root } = await open([btw({ id: "b1", after_uuid: uuidOf("a", 1), response: "答え" })]);
    expect(order(root)).toEqual(["question 1", "answer 1", "btw:b1", "question 2", "answer 2"]);
    const item = instanceOf(root.querySelector(".tl-btw"), HTMLElement, "the btw");
    expect(item.querySelector(".tl-bubble-right")?.textContent).toContain("横道の質問");
    expect(item.querySelector(".tl-btw-answer")?.textContent).toContain("答え");
  });

  test("a running one shows its running line, and 取り消し sends btw_cancel", async () => {
    const { root, cancels } = await open([
      btw({ id: "run", after_uuid: uuidOf("a", 2), status: "running", tool: "Read" }),
    ]);
    const running = instanceOf(root.querySelector(".tl-btw-running"), HTMLElement, "running");
    expect(running.textContent).toContain("btw 応答中");
    expect(running.textContent).toContain("(Read)");
    const cancel = instanceOf(running.querySelector("button"), HTMLButtonElement, "取り消し");
    await act(async () => {
      cancel.click();
      await Promise.resolve();
    });
    expect(cancels).toEqual(["run"]);
    expect(cancel.disabled).toBe(true);
  });

  test("a failed one shows why", async () => {
    const { root } = await open([
      btw({ id: "f", after_uuid: uuidOf("u", 1), status: "failed", error: "Prompt is too long" }),
    ]);
    expect(root.querySelector(".tl-btw-error")?.textContent).toBe("Prompt is too long");
    expect(root.querySelector(".tl-btw-running")).toBeNull();
  });

  test("a btw pushed later appears in its place, and its change replaces it", async () => {
    const { root, store } = await open([]);
    expect(root.querySelector(".tl-btw")).toBeNull();
    await act(() => {
      store.dispatch({
        type: "btw/changed",
        btw: btw({ id: "late", after_uuid: uuidOf("u", 2), status: "running" }),
      });
    });
    expect(order(root)).toEqual(["question 1", "answer 1", "question 2", "btw:late", "answer 2"]);
    await act(() => {
      store.dispatch({
        type: "btw/changed",
        btw: btw({ id: "late", after_uuid: uuidOf("u", 2), response: "出た" }),
      });
    });
    expect(root.querySelectorAll(".tl-btw")).toHaveLength(1);
    expect(root.querySelector(".tl-btw-answer")?.textContent).toContain("出た");
  });

  test("under a filter but the 💬 filter the btws are hidden", async () => {
    const { root, store } = await open([btw({ id: "b1", after_uuid: uuidOf("a", 1) })]);
    await act(() => {
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, filter: "say" },
        sidebar: CLOSED_SIDEBAR,
      });
    });
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, "the lines");
    expect(lines.getAttribute("data-filter")).toBe("say");
    const item = instanceOf(root.querySelector(".tl-btw"), HTMLElement, "the btw").parentElement;
    // The CSS hides a child of the lines the filter does not keep: the 💬
    // filter keeps a btw (DR-0062 §13), no other filter does. It is no
    // filter's only: the Timeline shows it without one.
    expect(item?.getAttribute("data-notif")).toBe("comment");
    expect(item?.hasAttribute("data-filter-only")).toBe(false);
    expect(item?.querySelector("[data-comment-kind]")?.getAttribute("data-comment-kind")).toBe(
      "btw",
    );
  });
});
