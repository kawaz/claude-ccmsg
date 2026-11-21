// The owner → repo tree inside each SESSIONS status section, mounted
// (DR-0043 §10): the owner's heading counts its sessions, a repo's heading is
// its name alone, sessions with no repository gather under one group, Pinned
// stays flat, a fold the reader closes stays closed across a remount, and
// while the quick filter narrows every fold left is shown open without the
// stored state changing.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo, UnreadPermit, UnreadSay } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import { SESSION_TREE_CLOSED_STORAGE_KEY } from "../src/client/session-tree.ts";
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
  store.dispatch({ type: "agents/loaded", agents: PEERS.map((p) => idle(p.sid)) });
  store.dispatch({
    type: "pinned/hydrated",
    pins: [
      {
        sid: PINNED,
        cwd: "/pinned/x",
        repo: "alice/app",
        ws: "pinned",
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
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(SessionList, { peers: PEERS, currentSid: null }),
      ),
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

function section(root: HTMLElement, label: string): HTMLDetailsElement {
  const found = [...root.querySelectorAll("details.session-section")].find((d) =>
    d.querySelector(":scope > summary")?.textContent?.startsWith(label),
  );
  return instanceOf(found, HTMLDetailsElement, `the ${label} section`);
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

describe("the SESSIONS owner → repo tree", () => {
  test("owners count their sessions, repos show their name alone, no-repo sessions gather", async () => {
    const root = await mount();
    expect(section(root, "Active").querySelector(":scope > summary")?.textContent).toBe(
      "Active (5)",
    );
    expect(outline(section(root, "Active"))).toEqual([
      "alice (3)",
      "  app",
      `    ${short(APP_MAIN)}`,
      `    ${short(APP_FIX)}`,
      "  lib",
      `    ${short(LIB)}`,
      "bob (1)",
      "  tool",
      `    ${short(TOOL)}`,
      "(repo なし) (1)",
      `  ${short(BARE)}`,
    ]);
  });

  test("Pinned stays flat", async () => {
    const root = await mount();
    const pinned = instanceOf(root.querySelector(".pinned-section"), HTMLElement, "Pinned");
    expect(pinned.querySelector(".session-tree-fold")).toBeNull();
    expect(pinned.querySelectorAll("li.session-row").length).toBe(1);
  });

  test("a closed fold is stored and stays closed after a remount", async () => {
    let root = await mount();
    await setOpen(fold(root, "alice (3)"), false);
    await setOpen(fold(root, "tool"), false);
    expect(JSON.parse(localStorage.getItem(SESSION_TREE_CLOSED_STORAGE_KEY) ?? "[]")).toEqual([
      "owner:busy:alice",
      "repo:busy:bob/tool",
    ]);

    await act(() => render(null, roots[0] ?? document.body));
    root = await mount();
    expect(fold(root, "alice (3)").open).toBe(false);
    expect(fold(root, "tool").open).toBe(false);
    expect(fold(root, "bob (1)").open).toBe(true);

    await setOpen(fold(root, "alice (3)"), true);
    expect(JSON.parse(localStorage.getItem(SESSION_TREE_CLOSED_STORAGE_KEY) ?? "[]")).toEqual([
      "repo:busy:bob/tool",
    ]);
  });

  test("the quick filter shows what is left open, and the stored state comes back after", async () => {
    const root = await mount();
    await setOpen(fold(root, "alice (3)"), false);
    await setOpen(fold(root, "app"), false);
    const stored = localStorage.getItem(SESSION_TREE_CLOSED_STORAGE_KEY);

    await type(root, "app");
    expect(outline(section(root, "Active"))).toEqual([
      "alice (2)",
      "  app",
      `    ${short(APP_MAIN)}`,
      `    ${short(APP_FIX)}`,
    ]);
    // A toggle while the filter holds the fold open is not stored.
    await setOpen(fold(root, "alice (2)"), false);
    expect(localStorage.getItem(SESSION_TREE_CLOSED_STORAGE_KEY)).toBe(stored);

    await type(root, "");
    expect(fold(root, "alice (3)").open).toBe(false);
    expect(fold(root, "app").open).toBe(false);
    expect(localStorage.getItem(SESSION_TREE_CLOSED_STORAGE_KEY)).toBe(stored);
  });
});

// A closed fold's heading carries the 🔔🔐 unread counts of the sessions it
// folds, summed, as the rows' badges do (the kinds with something unread
// only); an open one carries none, its rows show their own. Under the quick
// filter the sum is of the matching rows only. The heading's badges are not
// links: the heading is the fold's toggle.
describe("a folded heading's 🔔🔐 sum", () => {
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

  /** The heading's badges as `<emoji><counter>`. */
  function headingBadges(details: HTMLDetailsElement): string[] {
    return [...details.querySelectorAll(":scope > summary .notif-badge")].map(
      (badge) => badge.textContent ?? "",
    );
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
