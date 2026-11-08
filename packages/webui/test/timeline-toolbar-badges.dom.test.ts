// The 🔔🔐 badges at the left end of the Timeline toolbar (DR-0050 §3):
// - always both, at 0 / 0 too (the way into the filter of every say and
//   request); the counter is the unread count, from 1
// - the badge of the URL's filter is the selected one, and only while the URL
//   names this session
// - the selected badge takes the filter off and keeps the position; the other
//   opens its kind at the tail (§9 U2 / U5)
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { UnreadPermit, UnreadSay } from "@ccmsg/protocol";
import { TimelineToolbarBadges } from "../src/client/components/timeline/TimelineToolbarBadges.tsx";
import { AppContext } from "../src/client/context.ts";
import type { TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";

withDom();

const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

function say(n: number, sid = SID): UnreadSay {
  return { session_id: sid, tool_use_id: `toolu_${n}`, ts: "2026-11-08T00:00:00.000Z" };
}

function request(id: string): UnreadPermit {
  return { session_id: SID, tool_use_id: id, ts: "2026-11-08T00:00:00.000Z" };
}

async function at(store: Store, sid: string, position: string, filter: TimelineFilter | null) {
  await act(() =>
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid, position, ...(filter !== null ? { filter } : {}) },
      sidebar: CLOSED_SIDEBAR,
    }),
  );
}

async function mount(says: UnreadSay[], requests: UnreadPermit[]) {
  const store = createStore(initialState());
  store.dispatch({ type: "say-unread/loaded", says });
  store.dispatch({ type: "permit-state/loaded", unread: requests, granted: [], applied: [] });
  const ws = createWsClient((action) => store.dispatch(action));
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(
      h(AppContext.Provider, { value: { store, ws } }, h(TimelineToolbarBadges, { sid: SID })),
      root,
    ),
  );
  return { root, store };
}

/** 各バッジを `<emoji><counter>[*]` で (`*` は選択中) と、その href。 */
function badges(root: HTMLElement): Array<[string, string | null]> {
  return [...root.querySelectorAll(".notif-badge")].map((badge) => [
    `${badge.querySelector(".notif-badge-icon")?.textContent ?? ""}${badge.querySelector(".notif-badge-counter")?.textContent ?? ""}${badge.getAttribute("aria-current") === "true" ? "*" : ""}`,
    badge.getAttribute("href"),
  ]);
}

describe("the Timeline toolbar's badges", () => {
  test("both at 0 / 0 without counters, the counter once either is unread", async () => {
    const { root, store } = await mount([], []);
    expect(badges(root).map(([text]) => text)).toEqual(["🔔", "🔐"]);
    await act(() => store.dispatch({ type: "say-unread/loaded", says: [say(1), say(2, OTHER)] }));
    expect(badges(root).map(([text]) => text)).toEqual(["🔔1", "🔐"]);
  });

  test("the counter is a child of the badge beside the icon, not inside it", async () => {
    const { root } = await mount([say(1)], []);
    const [bell, lock] = [...root.querySelectorAll(".notif-badge")];
    expect(bell?.querySelector(".notif-badge-icon")?.textContent).toBe("🔔");
    expect(bell?.querySelector(":scope > .notif-badge-counter")?.textContent).toBe("1");
    expect(bell?.querySelector(".notif-badge-icon .notif-badge-counter")).toBeNull();
    expect(lock?.querySelector(".notif-badge-counter")).toBeNull();
  });

  test("the URL's filter selects its badge, which takes the filter off in place", async () => {
    const { root, store } = await mount([say(1)], [request("toolu_p1")]);
    await at(store, SID, "u-7", "say");
    expect(badges(root)).toEqual([
      ["🔔1*", `/s/${SID}/timeline/u-7`],
      ["🔐1", `/s/${SID}/timeline/head?filter=permit`],
    ]);
    await at(store, SID, "u-7", null);
    expect(badges(root)).toEqual([
      ["🔔1", `/s/${SID}/timeline/head?filter=say`],
      ["🔐1", `/s/${SID}/timeline/head?filter=permit`],
    ]);
  });

  test("the selected badge stays at 0 / 0 so the filter can be taken off", async () => {
    const { root, store } = await mount([say(1)], []);
    await at(store, SID, "head", "say");
    await act(() => store.dispatch({ type: "say-unread/loaded", says: [] }));
    expect(badges(root).map(([text]) => text)).toEqual(["🔔*", "🔐"]);
    await at(store, SID, "head", null);
    expect(badges(root).map(([text]) => text)).toEqual(["🔔", "🔐"]);
  });

  test("another session's filter selects nothing here", async () => {
    const { root, store } = await mount([say(1)], []);
    await at(store, OTHER, "head", "say");
    expect(badges(root).map(([text]) => text)).toEqual(["🔔1", "🔐"]);
  });
});
