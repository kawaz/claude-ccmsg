// The SESSIONS list's one owner → group tree, mounted (DR-0043 §10): the owner's heading counts its sessions, a repo's heading is
// its name alone, sessions with no repository gather under one group, Bookmarks
// stays flat, a fold the reader closes stays closed across a remount, and
// while the quick filter narrows every fold left is shown open without the
// stored state changing.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo, UnreadPermit, UnreadSay } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import { SESSION_FOLDS_STORAGE_KEY } from "../src/client/session-tree.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, peerLocation } from "./helpers.ts";

withDom();

const APP_MAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const APP_FIX = "aaaaaaaa-0000-4000-8000-000000000002";
const LIB = "bbbbbbbb-0000-4000-8000-000000000003";
const TOOL = "cccccccc-0000-4000-8000-000000000004";
const BARE = "dddddddd-0000-4000-8000-000000000005";
const PINNED = "eeeeeeee-0000-4000-8000-000000000006";
const SINCE = "2026-11-21T01:00:00.000Z";

function peer(sid: string, repo: string, ws: string): PeerInfo {
  return {
    sid,
    ...peerLocation(repo, ws),
    cwd: `/w/${sid}`,
    connected_at: SINCE,
    transcript_path: `/p/${sid}.jsonl`,
  };
}

function idle(sid: string): AgentInfo {
  return {
    pid: 1,
    cwd: `/w/${sid}`,
    kind: "interactive",
    startedAt: 1,
    sessionId: sid,
    config_dir: "/c",
    status: "idle",
    turn: { state: "idle", since: SINCE },
  };
}

const PEERS = [
  peer(APP_MAIN, "alice/app", "main"),
  peer(APP_FIX, "alice/app", "fix"),
  peer(LIB, "alice/lib", "main"),
  peer(TOOL, "bob/tool", "main"),
  peer(BARE, "", ""),
];

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  localStorage.clear();
});

async function mount(
  unread: { says?: UnreadSay[]; permits?: UnreadPermit[] } = {},
  peers: readonly PeerInfo[] = PEERS,
): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({
    type: "permit-state/loaded",
    unread: unread.permits ?? [],
    granted: [],
    marks: [],
    rules: [],
  });
  store.dispatch({ type: "say-unread/loaded", says: unread.says ?? [] });
  store.dispatch({ type: "agents/loaded", agents: peers.map((p) => idle(p.sid)) });
  store.dispatch({
    type: "session-bookmarks/hydrated",
    bookmarks: [
      {
        sid: PINNED,
        cwd: "/bookmarked/x",
        repo: "alice/app",
        ws: "bookmarked",
        title: null,
        file: "",
        updated_at: SINCE,
      },
    ],
  });
  const ws = createWsClient((action) => store.dispatch(action));
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(
      h(AppContext.Provider, { value: { store, ws } }, h(SessionList, { peers, currentSid: null })),
      root,
    ),
  );
  return root;
}

/** A section's tree as text: each fold's heading indented by its depth
 * (`[x]` when closed), each row's short sid. */
function outline(section: Element): string[] {
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    for (const child of el.children) {
      if (child.matches("details.session-section")) continue;
      if (child instanceof HTMLDetailsElement && child.classList.contains("session-tree-fold")) {
        const heading =
          child.querySelector(":scope > summary > .session-tree-name")?.textContent ?? "";
        lines.push(`${"  ".repeat(depth)}${child.open ? "" : "[x] "}${heading}`);
        walk(child, depth + 1);
      } else if (child.matches("li.session-row")) {
        lines.push(
          `${"  ".repeat(depth)}${child.querySelector(".session-sid")?.textContent ?? ""}`,
        );
      } else {
        walk(child, depth);
      }
    }
  };
  walk(section, 0);
  return lines;
}

/** The list: the tree's folds sit right in it, below the sections. */
function tree(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector("#session-list"), HTMLElement, "the list");
}

/** The tree's rows, in order (not the sections' above it). */
function treeRows(root: HTMLElement): Element[] {
  return [...root.querySelectorAll("#session-list > details.session-tree-fold li.session-row")];
}

function fold(root: HTMLElement, heading: string): HTMLDetailsElement {
  const found = [...root.querySelectorAll("details.session-tree-fold")].find(
    (d) => d.querySelector(":scope > summary > .session-tree-name")?.textContent === heading,
  );
  return instanceOf(found, HTMLDetailsElement, `the ${heading} fold`);
}

/** Clicks a fold's heading, as the reader does, until it is `open` (the
 * click on a summary flips its details here as in a browser). */
async function setOpen(details: HTMLDetailsElement, open: boolean): Promise<void> {
  const summary = instanceOf(details.querySelector(":scope > summary"), HTMLElement, "summary");
  if (details.open === open) return;
  await act(() => {
    summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(details.open).toBe(open);
}

async function type(root: HTMLElement, value: string): Promise<void> {
  const input = instanceOf(
    root.querySelector(".session-filter-input"),
    HTMLInputElement,
    "the filter box",
  );
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const short = (sid: string) => sid.slice(0, 8);
const line1 = (el: Element | null) => el?.querySelector(".session-main-link")?.textContent ?? "";

describe("the SESSIONS owner → repo tree", () => {
  test("owners count their sessions, repos show their name alone, sessions with no repository gather in others, last", async () => {
    const root = await mount();
    // One tree: no status section around it, only Bookmarks above.
    expect(
      [...root.querySelectorAll("details.session-section")].map(
        (d) => d.querySelector(":scope > summary")?.textContent,
      ),
    ).toEqual(["Bookmarks (1)"]);
    expect(outline(tree(root))).toEqual([
      "alice (3)",
      "  app",
      `    ${short(APP_MAIN)}`,
      `    ${short(APP_FIX)}`,
      "  lib",
      `    ${short(LIB)}`,
      "bob (1)",
      "  tool",
      `    ${short(TOOL)}`,
      "others (1)",
      `  ${short(BARE)}`,
    ]);
  });

  // Under its owner's fold a row does not repeat the owner, and under a repo
  // group not the repository either (the heading says it): its first line is
  // the ws alone, without `@`. Bookmarks rows are flat and keep
  // `owner/name@ws`. The quick filter still matches the owner's word.
  test("a row in a repo group drops the owner and the repo, a Bookmarks row keeps both, the filter still knows them", async () => {
    const root = await mount();
    expect(treeRows(root).map((row) => line1(row))).toEqual(["main", "fix", "main", "main", BARE]);
    expect(treeRows(root).some((row) => row.querySelector(".session-line1-repo"))).toBe(false);
    expect(line1(root.querySelector(".session-bookmarks-section li.session-row"))).toBe(
      "alice/app@bookmarked",
    );
    await type(root, "alice");
    expect(outline(tree(root))).toEqual([
      "alice (3)",
      "  app",
      `    ${short(APP_MAIN)}`,
      `    ${short(APP_FIX)}`,
      "  lib",
      `    ${short(LIB)}`,
    ]);
    await type(root, "alice/app");
    expect(outline(tree(root))).toEqual([
      "alice (2)",
      "  app",
      `    ${short(APP_MAIN)}`,
      `    ${short(APP_FIX)}`,
    ]);
  });

  // A prefix group's heading does not say which repository a row is of, so
  // its rows keep `name@ws`.
  test("a row in a prefix group keeps the repo", async () => {
    const root = await mount({}, [
      peer(APP_MAIN, "alice/claude-ccmsg", "main"),
      peer(LIB, "alice/claude-rules", "main"),
    ]);
    expect(outline(tree(root))).toEqual([
      "alice (2)",
      "  claude",
      `    ${short(APP_MAIN)}`,
      `    ${short(LIB)}`,
    ]);
    expect(treeRows(root).map((row) => line1(row))).toEqual([
      "claude-ccmsg@main",
      "claude-rules@main",
    ]);
  });

  // A row of a repo group with no ws has nothing left for its first line, so
  // the title goes up there, as on a row with neither repo nor ws. The
  // heading says where it is, so no path line is added.
  test("a row in a repo group without a ws puts its title on the first line", async () => {
    const root = await mount({}, [peer(TOOL, "bob/tool", "")]);
    const row = instanceOf(treeRows(root)[0], HTMLElement, "the tool row");
    expect(row.querySelector(".session-line1 .session-title")).not.toBeNull();
    expect(row.querySelector(".session-line2")).toBeNull();
    expect(row.querySelector(".session-line4")).toBeNull();
  });

  test("Bookmarks stays flat", async () => {
    const root = await mount();
    const bookmarked = instanceOf(
      root.querySelector(".session-bookmarks-section"),
      HTMLElement,
      "Bookmarks",
    );
    expect(bookmarked.querySelector(".session-tree-fold")).toBeNull();
    expect(bookmarked.querySelectorAll("li.session-row").length).toBe(1);
  });

  test("a closed fold is stored and stays closed after a remount", async () => {
    let root = await mount();
    await setOpen(fold(root, "alice (3)"), false);
    await setOpen(fold(root, "tool"), false);
    expect(JSON.parse(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY) ?? "{}")).toEqual({
      "owner:alice": false,
      "repo:bob/tool": false,
    });

    await act(() => render(null, roots[0] ?? document.body));
    root = await mount();
    expect(fold(root, "alice (3)").open).toBe(false);
    expect(fold(root, "tool").open).toBe(false);
    expect(fold(root, "bob (1)").open).toBe(true);

    await setOpen(fold(root, "alice (3)"), true);
    expect(JSON.parse(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY) ?? "{}")).toEqual({
      "owner:alice": true,
      "repo:bob/tool": false,
    });
  });

  // The keys carry no section; a stored key of another shape (one with a
  // section in it) names no fold and is left alone.
  test("a stored key that names no fold is ignored", async () => {
    const stored = JSON.stringify({ "owner:busy:alice": false, "repo:busy:bob/tool": false });
    localStorage.setItem(SESSION_FOLDS_STORAGE_KEY, stored);
    const root = await mount();
    expect(fold(root, "alice (3)").open).toBe(true);
    expect(fold(root, "tool").open).toBe(true);
    expect(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)).toBe(stored);
  });

  test("the quick filter shows what is left open, and the stored state comes back after", async () => {
    const root = await mount();
    await setOpen(fold(root, "alice (3)"), false);
    await setOpen(fold(root, "app"), false);
    const stored = localStorage.getItem(SESSION_FOLDS_STORAGE_KEY);

    await type(root, "app");
    expect(outline(tree(root))).toEqual([
      "alice (2)",
      "  app",
      `    ${short(APP_MAIN)}`,
      `    ${short(APP_FIX)}`,
    ]);
    // A toggle while the filter holds the fold open is not stored.
    await setOpen(fold(root, "alice (2)"), false);
    expect(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)).toBe(stored);

    await type(root, "");
    expect(fold(root, "alice (3)").open).toBe(false);
    expect(fold(root, "app").open).toBe(false);
    expect(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)).toBe(stored);
  });

  test("a fold closed while the filter held it open is open again after, as stored", async () => {
    const root = await mount();
    await type(root, "app");
    await setOpen(fold(root, "alice (2)"), false);
    await type(root, "");
    expect(fold(root, "alice (3)").open).toBe(true);
    expect(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)).toBeNull();
  });
});

// A closed fold's heading carries the 🔔🔐 unread counts of the sessions it
// folds, summed, as the rows' badges do (the kinds with something unread
// only); an open one shows none, its rows show their own. Under the quick
// filter the sum is of the matching rows only. The heading's badges are not
// links: the heading is the fold's toggle. The sum is always in the heading
// and app.css hides it while the fold is open, so what is read here is what
// app.css leaves shown.
describe("a folded heading's 🔔🔐 sum", () => {
  let sheet: HTMLStyleElement | null = null;
  beforeAll(async () => {
    sheet = document.createElement("style");
    sheet.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    document.head.append(sheet);
  });
  afterAll(() => {
    sheet?.remove();
    sheet = null;
  });

  const say = (id: string, sid: string): UnreadSay => ({
    session_id: sid,
    tool_use_id: id,
    ts: SINCE,
  });
  const permit = (id: string, sid: string): UnreadPermit => ({
    session_id: sid,
    tool_use_id: id,
    ts: SINCE,
  });
  const UNREAD = {
    says: [say("s1", APP_MAIN), say("s2", APP_FIX), say("s3", LIB)],
    permits: [permit("p1", APP_FIX)],
  };

  /** The heading's badges as `<emoji><counter>`, those shown only. */
  function headingBadges(details: HTMLDetailsElement): string[] {
    const sum = details.querySelector(":scope > summary > .session-tree-badges");
    if (sum === null || getComputedStyle(sum).display === "none") return [];
    return [...sum.querySelectorAll(".notif-badge")].map((badge) => badge.textContent ?? "");
  }

  test("a closed fold shows the sum of what it folds, an open one none", async () => {
    const root = await mount(UNREAD);
    expect(headingBadges(fold(root, "alice (3)"))).toEqual([]);
    await setOpen(fold(root, "app"), false);
    expect(headingBadges(fold(root, "app"))).toEqual(["🔔2", "🔐1"]);
    await setOpen(fold(root, "alice (3)"), false);
    expect(headingBadges(fold(root, "alice (3)"))).toEqual(["🔔3", "🔐1"]);
    // A kind with nothing unread is not shown.
    await setOpen(fold(root, "lib"), false);
    expect(headingBadges(fold(root, "lib"))).toEqual(["🔔1"]);
    await setOpen(fold(root, "bob (1)"), false);
    expect(headingBadges(fold(root, "bob (1)"))).toEqual([]);

    const badge = instanceOf(
      fold(root, "app").querySelector(":scope > summary .notif-badge-say"),
      HTMLElement,
      "the heading's say badge",
    );
    expect(badge.tagName).toBe("SPAN");
    expect(badge.closest("a")).toBeNull();
    expect(badge.getAttribute("aria-label")).toBe("未読の say 2 件");

    await setOpen(fold(root, "alice (3)"), true);
    expect(headingBadges(fold(root, "alice (3)"))).toEqual([]);
  });

  test("under the quick filter, the sum is of the matching rows", async () => {
    const root = await mount(UNREAD);
    await type(root, "main");
    // Held open by the filter: no sum. Closed by a click: the matching rows'.
    expect(headingBadges(fold(root, "alice (2)"))).toEqual([]);
    await setOpen(fold(root, "alice (2)"), false);
    expect(headingBadges(fold(root, "alice (2)"))).toEqual(["🔔2"]);
  });
});
