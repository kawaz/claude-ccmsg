// The SESSIONS list's Bookmarks section (DR-0043 §11): a fold, closed until
// the reader opens it, its state stored like the tree's folds; shown with no
// bookmark too (the heading alone, `(0)`); while the quick
// filter narrows, shown open with a match and not at all without one, the
// stored state left as it was.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import type { SessionBookmark } from "../src/client/session-bookmarks.ts";
import { BOOKMARKS_FOLD_KEY, SESSION_FOLDS_STORAGE_KEY } from "../src/client/session-tree.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, peerLocation } from "./helpers.ts";

withDom();

const SINCE = "2026-11-21T01:00:00.000Z";
const LIVE = "aaaaaaaa-0000-4000-8000-000000000001";
const SAVED = "bbbbbbbb-0000-4000-8000-000000000002";

const saved: SessionBookmark = {
  sid: SAVED,
  cwd: "/w/issue-42",
  repo: "kawaz/hyoui",
  ws: "issue-42",
  title: "issue 42 の調査",
  file: "",
  updated_at: SINCE,
};

const live: PeerInfo = {
  sid: LIVE,
  ...peerLocation("kawaz/claude-ccmsg", "main"),
  cwd: "/w/main",
  connected_at: SINCE,
  transcript_path: `/p/${LIVE}.jsonl`,
};

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  localStorage.clear();
});

async function mount(bookmarks: SessionBookmark[]): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({ type: "session-bookmarks/hydrated", bookmarks });
  const ws = createWsClient((action) => store.dispatch(action));
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(SessionList, { peers: [live], currentSid: null }),
      ),
      root,
    ),
  );
  return root;
}

function bookmarks(root: HTMLElement): HTMLDetailsElement | null {
  const found = root.querySelector(".session-bookmarks-section");
  return found === null ? null : instanceOf(found, HTMLDetailsElement, "the Bookmarks section");
}

function heading(details: HTMLDetailsElement): string {
  return details.querySelector(":scope > summary > .session-tree-name")?.textContent ?? "";
}

async function click(details: HTMLDetailsElement): Promise<void> {
  const summary = instanceOf(details.querySelector(":scope > summary"), HTMLElement, "summary");
  await act(() => {
    summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function type(root: HTMLElement, value: string): Promise<void> {
  const input = instanceOf(root.querySelector(".session-filter-input"), HTMLInputElement, "filter");
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the Bookmarks section", () => {
  test("is shown with no bookmark, the heading alone", async () => {
    const root = await mount([]);
    const section = instanceOf(bookmarks(root), HTMLDetailsElement, "Bookmarks");
    expect(heading(section)).toBe("Bookmarks (0)");
    expect([...section.children].filter((child) => child.tagName !== "SUMMARY")).toEqual([]);
    expect(section.querySelectorAll("li.session-row").length).toBe(0);
  });

  test("starts closed, and the reader's opening is stored and kept after a remount", async () => {
    let root = await mount([saved]);
    let section = instanceOf(bookmarks(root), HTMLDetailsElement, "Bookmarks");
    expect(heading(section)).toBe("Bookmarks (1)");
    expect(section.open).toBe(false);
    await click(section);
    expect(section.open).toBe(true);
    expect(JSON.parse(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY) ?? "{}")).toEqual({
      [BOOKMARKS_FOLD_KEY]: true,
    });

    root = await mount([saved]);
    section = instanceOf(bookmarks(root), HTMLDetailsElement, "Bookmarks");
    expect(section.open).toBe(true);
  });

  // The rows keep their flat shape with the owner: `owner/repo@ws`.
  test("lists its rows flat, with the owner", async () => {
    const root = await mount([saved]);
    const section = instanceOf(bookmarks(root), HTMLDetailsElement, "Bookmarks");
    expect(section.querySelector(".session-tree-fold")).toBeNull();
    expect(section.querySelector("li.session-row .session-main-link")?.textContent).toBe(
      "kawaz/hyoui@issue-42",
    );
  });

  test("under the quick filter: open with a match, gone without one, the stored state untouched", async () => {
    const root = await mount([saved]);
    await type(root, "issue-42");
    const section = instanceOf(bookmarks(root), HTMLDetailsElement, "Bookmarks");
    expect(section.open).toBe(true);
    expect(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)).toBeNull();

    await type(root, "claude-ccmsg");
    expect(bookmarks(root)).toBeNull();

    await type(root, "");
    expect(instanceOf(bookmarks(root), HTMLDetailsElement, "Bookmarks").open).toBe(false);
    expect(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)).toBeNull();
  });
});
