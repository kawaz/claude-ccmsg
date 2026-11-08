// The 🔔🔐 badges at the left end of the Timeline toolbar (DR-0050 §3):
// - none when the session has neither a say nor a request; both while it has
//   either, read or not; the counter is the unread count, from 1
// - the badge of the URL's filter is the selected one, and only while the URL
//   names this session; it stays shown when there is neither (§9 U4)
// - the selected badge takes the filter off and keeps the position; the other
//   opens its kind at the tail (§9 U2 / U5)
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { PermitRequestRecord, SessionSayTotal, UnreadSay } from "@ccmsg/protocol";
import { TimelineToolbarBadges } from "../src/client/components/timeline/TimelineToolbarBadges.tsx";
import { AppContext } from "../src/client/context.ts";
import type { TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { sayTotalsOf } from "./say-fixture.ts";

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

function request(id: string, read = false): PermitRequestRecord {
  return {
    id,
    sid: SID,
    ts: "2026-11-08T00:00:00.000Z",
    blocked: "x",
    attachments: [],
    intents: [],
    commands: [],
    read,
  };
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

async function mount(
  says: UnreadSay[],
  requests: PermitRequestRecord[],
  totals: SessionSayTotal[] = sayTotalsOf(says),
) {
  const store = createStore(initialState());
  store.dispatch({ type: "say-unread/loaded", says, totals });
  store.dispatch({ type: "permit-requests/loaded", requests });
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
  test("none when there is neither, both while either is there, read or not", async () => {
    const { root, store } = await mount([], []);
    expect(badges(root)).toEqual([]);
    // A read request alone: both emoji, no counter.
    await act(() =>
      store.dispatch({ type: "permit-requests/loaded", requests: [request("i/1", true)] }),
    );
    expect(badges(root).map(([text]) => text)).toEqual(["🔔", "🔐"]);
    const says = [say(1), say(2, OTHER)];
    await act(() => store.dispatch({ type: "say-unread/loaded", says, totals: sayTotalsOf(says) }));
    expect(badges(root).map(([text]) => text)).toEqual(["🔔1", "🔐"]);
    // The say read: it is still there, so its emoji stays without a counter.
    await act(() =>
      store.dispatch({
        type: "say-unread/loaded",
        says: [say(2, OTHER)],
        totals: sayTotalsOf(says),
      }),
    );
    expect(badges(root).map(([text]) => text)).toEqual(["🔔", "🔐"]);
  });

  test("a read say alone shows both emoji, the unread request counted", async () => {
    const { root } = await mount([], [request("i/1")], [{ session_id: SID, count: 1 }]);
    expect(badges(root).map(([text]) => text)).toEqual(["🔔", "🔐1"]);
  });

  test("the counter is a child of the badge beside the icon, not inside it", async () => {
    const { root } = await mount([say(1)], [request("i/1", true)]);
    const [bell, lock] = [...root.querySelectorAll(".notif-badge")];
    expect(bell?.querySelector(".notif-badge-icon")?.textContent).toBe("🔔");
    expect(bell?.querySelector(":scope > .notif-badge-counter")?.textContent).toBe("1");
    expect(bell?.querySelector(".notif-badge-icon .notif-badge-counter")).toBeNull();
    expect(lock?.querySelector(".notif-badge-counter")).toBeNull();
  });

  test("the URL's filter selects its badge, which takes the filter off in place", async () => {
    const { root, store } = await mount([say(1)], [request("i/1")]);
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

  test("the selected badge stays with neither there so the filter can be taken off", async () => {
    const { root, store } = await mount([say(1)], []);
    await at(store, SID, "head", "say");
    await act(() => store.dispatch({ type: "say-unread/loaded", says: [], totals: [] }));
    expect(badges(root).map(([text]) => text)).toEqual(["🔔*", "🔐"]);
    await at(store, SID, "head", null);
    expect(badges(root)).toEqual([]);
  });

  test("another session's filter selects nothing here", async () => {
    const { root, store } = await mount([say(1)], []);
    await at(store, OTHER, "head", "say");
    expect(badges(root).map(([text]) => text)).toEqual(["🔔1", "🔐"]);
  });
});
