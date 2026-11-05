// Showing a kept session view again must not move any kept view's element:
// a moved element loses the scroll position of every scroller inside it
// (Chromium and WebKit alike), while one that stays in place and is only
// hidden and shown keeps them (docs/findings/2026-11-05-older-tab-freeze-fix.md).
// This renders the cache the way App does (keyed by sid, in
// sessionViewMountOrder) through a run of session switches and watches the
// container for elements taken out.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import {
  sessionViewMountOrder,
  touchSessionViewCache,
  type CachedSessionView,
} from "../src/client/session-view-cache.ts";
import { withDom } from "./dom.ts";

withDom();

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

function views(cache: readonly CachedSessionView[], shown: string) {
  return h(
    "div",
    null,
    sessionViewMountOrder(cache).map((view) =>
      h("main", { key: view.sid, "data-sid": view.sid, hidden: view.sid !== shown }),
    ),
  );
}

describe("kept session views", () => {
  test("stay in place in the DOM while other sessions are shown and evicted", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    container = root;
    let cache: readonly CachedSessionView[] = [];
    const show = async (sid: string) => {
      cache = touchSessionViewCache(cache, { sid, tab: "timeline", agent: null }, 3);
      await act(() => render(views(cache, sid), root));
    };
    await show("s3");
    await show("s1");
    const list = root.firstElementChild;
    if (list === null) throw new Error("nothing rendered");
    const removed: string[] = [];
    const collect = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          removed.push(node instanceof HTMLElement ? (node.dataset.sid ?? "?") : "?");
        }
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(list, { childList: true });

    await show("s2");
    await show("s3");
    await show("s1");
    await show("s2");
    await show("s4");
    collect(observer.takeRecords());
    observer.disconnect();

    // Only the view the LRU dropped (s3, least recently shown when s4 came)
    // left the DOM, and only once.
    expect(removed).toEqual(["s3"]);
    expect([...list.children].map((child) => child.getAttribute("data-sid"))).toEqual([
      "s1",
      "s2",
      "s4",
    ]);
  });

  // The case where a position used to be lost: a scroller in A's Timeline,
  // then A's Status, another session, and back to A's Status before its
  // Timeline. A's view must be the same element, never taken out.
  test("keep a session's view in place across its tabs and another session", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    container = root;
    let cache: readonly CachedSessionView[] = [];
    const show = async (sid: string, tab: CachedSessionView["tab"]) => {
      cache = touchSessionViewCache(cache, { sid, tab, agent: null }, 3);
      await act(() => render(views(cache, sid), root));
    };
    await show("sB", "timeline");
    await show("sA", "timeline");
    const viewA = root.querySelector('[data-sid="sA"]');
    await show("sA", "status");
    await show("sB", "timeline");
    await show("sA", "status");
    await show("sA", "timeline");
    expect(root.querySelector('[data-sid="sA"]')).toBe(viewA);
    expect(viewA?.isConnected).toBe(true);
    expect(
      [...(root.firstElementChild?.children ?? [])].map((c) => c.getAttribute("data-sid")),
    ).toEqual(["sA", "sB"]);
  });
});
