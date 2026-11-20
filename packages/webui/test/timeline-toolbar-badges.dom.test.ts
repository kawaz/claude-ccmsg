// The 🔔🔐 badges at the left end of the Timeline toolbar (DR-0050 §3):
// - always both, at 0 / 0 too (the way into the filter of every say and
//   request); the counter is the unread count, from 1
// - the badge of the URL's filter is the selected one, and only while the URL
//   names this session
// - the selected badge takes the filter off and keeps the position; the other
//   opens its kind at the tail (§9 U2 / U5)
// - after them the ⭐ of the session's bookmarks (DR-0058 §4): ☆ at 0, ⭐ with
//   the count from 1, one StarMark either way (the box does not change), and
//   the same filter link as the other two
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

/** 🔔🔐 の各バッジを `<emoji><counter>[*]` で (`*` は選択中) と、その href。
 * 後ろの ⭐ (DR-0058) は下の describe で見る。 */
function badges(root: HTMLElement): Array<[string, string | null]> {
  return [...root.querySelectorAll(".notif-badge-say, .notif-badge-permit")].map((badge) => [
    `${badge.textContent ?? ""}${badge.getAttribute("aria-current") === "true" ? "*" : ""}`,
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

  // The link wraps only the emoji's CountBadge: the counter is inside the
  // emoji's box (laid over its bottom right), not beside it in the link.
  test("the counter is inside the emoji's box, which is all the link holds", async () => {
    const { root } = await mount([say(1)], []);
    const [bell, lock] = [...root.querySelectorAll(".notif-badge")];
    expect([...(bell?.children ?? [])].map((child) => child.className)).toEqual(["count-badge"]);
    const box = bell?.querySelector(":scope > .count-badge");
    expect(box?.firstChild?.textContent).toBe("🔔");
    expect(box?.querySelector(":scope > .count-badge-counter")?.textContent).toBe("1");
    expect(lock?.querySelector(".count-badge-counter")).toBeNull();
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

describe("the Timeline toolbar's ⭐", () => {
  function star(root: HTMLElement): HTMLAnchorElement {
    const found = root.querySelector(".notif-badge-bookmark");
    if (!(found instanceof HTMLAnchorElement)) throw new Error("no ⭐ badge");
    return found;
  }

  test("stands after 🔔🔐: ☆ without a counter at 0, ⭐ with the count from 1", async () => {
    const { root, store } = await mount([], []);
    expect([...root.querySelectorAll(".notif-badge")].map((badge) => badge.classList[1])).toEqual([
      "notif-badge-say",
      "notif-badge-permit",
      "notif-badge-bookmark",
    ]);
    const mark = star(root).querySelector(":scope > .count-badge > .star-mark");
    expect(mark?.hasAttribute("data-on")).toBe(false);
    expect(star(root).querySelector(".count-badge-counter")).toBeNull();
    await act(() =>
      store.dispatch({
        type: "bookmarks/loaded",
        sessions: [
          { session_id: SID, uuids: ["u1", "u2"] },
          { session_id: OTHER, uuids: ["u3"] },
        ],
      }),
    );
    // The same StarMark element, switched by its attribute.
    expect(star(root).querySelector(":scope > .count-badge > .star-mark")).toBe(mark);
    expect(mark?.hasAttribute("data-on")).toBe(true);
    expect(star(root).querySelector(".count-badge-counter")?.textContent).toBe("2");
    expect(star(root).getAttribute("aria-label")).toBe(
      "ブックマーク 2 件 — 押すとブックマークだけを表示",
    );
  });

  test("opens the ⭐ filter at the tail, and selected takes it off in place", async () => {
    const { root, store } = await mount([], []);
    expect(star(root).getAttribute("href")).toBe(`/s/${SID}/timeline/head?filter=bookmark`);
    await at(store, SID, "u-7", "bookmark");
    expect(star(root).getAttribute("aria-current")).toBe("true");
    expect(star(root).getAttribute("href")).toBe(`/s/${SID}/timeline/u-7`);
  });
});
