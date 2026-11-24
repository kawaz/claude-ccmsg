// The SESSIONS quick filter, mounted (DR-0043 §9): the box at the top of the
// list narrows every fold — Bookmarks and the owner tree — to the rows whose
// shown text matches, each heading counts what is left, a fold left with
// nothing is dropped, "該当なし" says when nothing is left
// anywhere, and Esc empties the box.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import type { SessionBookmark } from "../src/client/session-bookmarks.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, peerLocation } from "./helpers.ts";

withDom();

const ALPHA = "aaaaaaaa-0000-4000-8000-000000000001";
const BETA = "bbbbbbbb-0000-4000-8000-000000000002";
const GAMMA = "cccccccc-0000-4000-8000-000000000003";
const PINNED = "dddddddd-0000-4000-8000-000000000004";
const SINCE = "2026-11-21T01:00:00.000Z";

function peer(sid: string, repo: string, ws: string): PeerInfo {
  return {
    sid,
    ...peerLocation(repo, ws),
    cwd: `/w/${ws}`,
    connected_at: SINCE,
    transcript_path: `/p/${sid}.jsonl`,
  };
}

function agent(sid: string, overrides: Partial<AgentInfo>): AgentInfo {
  return {
    pid: 1,
    cwd: `/w/${sid}`,
    kind: "interactive",
    startedAt: 1,
    sessionId: sid,
    config_dir: "/c",
    ...overrides,
  };
}

const idle = { status: "idle" as const, turn: { state: "idle" as const, since: SINCE } };

const bookmark: SessionBookmark = {
  sid: PINNED,
  cwd: "/bookmarked/notes",
  repo: "owner/notes",
  ws: "main",
  title: null,
  file: "",
  updated_at: SINCE,
};

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

async function mount(): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({
    type: "agents/loaded",
    agents: [
      agent(ALPHA, { ...idle, name: "fix the parser" }),
      agent(BETA, idle),
      agent(GAMMA, { status: "busy" }),
    ],
  });
  store.dispatch({ type: "session-bookmarks/hydrated", bookmarks: [bookmark] });
  const ws = createWsClient((action) => store.dispatch(action));
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const peers = [
    peer(ALPHA, "kawaz/claude-ccmsg", "parser-fix"),
    peer(BETA, "kawaz/claude-ccmsg", "main"),
    peer(GAMMA, "kawaz/dotfiles", "main"),
  ];
  await act(() =>
    render(
      h(AppContext.Provider, { value: { store, ws } }, h(SessionList, { peers, currentSid: null })),
      root,
    ),
  );
  return root;
}

function box(root: HTMLElement): HTMLInputElement {
  return instanceOf(
    root.querySelector(".session-filter-input"),
    HTMLInputElement,
    "the filter box",
  );
}

async function type(root: HTMLElement, value: string): Promise<void> {
  const input = box(root);
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Each top-level fold of the list (the sections, the tree's owners): its
 * heading and the short sids of its rows. */
function sections(root: HTMLElement): { summary: string; sids: string[] }[] {
  return [...root.querySelectorAll("#session-list > details")].map((fold) => ({
    summary: fold.querySelector("summary")?.textContent ?? "",
    sids: [...fold.querySelectorAll("li.session-row .session-sid")].map(
      (el) => el.textContent ?? "",
    ),
  }));
}

const short = (sid: string) => sid.slice(0, 8);

describe("the SESSIONS quick filter", () => {
  test("sits above the sections, outside the list's own scroller, and names what it filters by", async () => {
    const root = await mount();
    const input = box(root);
    expect(input.type).toBe("search");
    expect(input.placeholder).toBe("Filter sessions by name");
    // A sibling before #session-list, not inside it: the list scrolls
    // sideways with its rows and the box must not.
    expect(input.closest("#session-list")).toBeNull();
    // The box's place (DR-0043 §9) is `.session-filter`; the input sits in
    // the box's frame (FilterField) inside it.
    expect(input.closest(".session-filter")?.nextElementSibling?.id).toBe("session-list");
  });

  test("an empty box shows every section as is", async () => {
    const root = await mount();
    expect(sections(root)).toEqual([
      { summary: "Bookmarks (1)", sids: [short(PINNED)] },
      { summary: "kawaz (3)", sids: [short(ALPHA), short(BETA), short(GAMMA)] },
    ]);
    expect(root.querySelector(".session-filter-empty")).toBeNull();
  });

  test("narrows every section to its matching rows and counts what is left", async () => {
    const root = await mount();
    await type(root, "ccmsg");
    expect(sections(root)).toEqual([{ summary: "kawaz (2)", sids: [short(ALPHA), short(BETA)] }]);

    // repo and ws are separate fields; two words may hit both.
    await type(root, "ccmsg main");
    expect(sections(root)).toEqual([{ summary: "kawaz (1)", sids: [short(BETA)] }]);

    // The session title (agent name), case-insensitively.
    await type(root, "PARSER");
    expect(sections(root)).toEqual([{ summary: "kawaz (1)", sids: [short(ALPHA)] }]);

    // The short sid.
    await type(root, short(GAMMA));
    expect(sections(root)).toEqual([{ summary: "kawaz (1)", sids: [short(GAMMA)] }]);
  });

  test("Bookmarks rows are filtered too", async () => {
    const root = await mount();
    await type(root, "notes");
    expect(sections(root)).toEqual([{ summary: "Bookmarks (1)", sids: [short(PINNED)] }]);
    await type(root, "main");
    expect(sections(root)).toEqual([
      { summary: "Bookmarks (1)", sids: [short(PINNED)] },
      { summary: "kawaz (2)", sids: [short(BETA), short(GAMMA)] },
    ]);
  });

  test("an exclude-only query keeps the rows without the word", async () => {
    const root = await mount();
    await type(root, "-ccmsg");
    expect(sections(root)).toEqual([
      { summary: "Bookmarks (1)", sids: [short(PINNED)] },
      { summary: "kawaz (1)", sids: [short(GAMMA)] },
    ]);
  });

  test("says 該当なし when nothing is left anywhere", async () => {
    const root = await mount();
    await type(root, "nowhere");
    expect(sections(root)).toEqual([]);
    expect(root.querySelector(".session-filter-empty")?.textContent).toBe("該当なし");
  });

  test("Esc empties the box and brings every row back", async () => {
    const root = await mount();
    await type(root, "nowhere");
    const input = box(root);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(() => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    expect(sections(root).map((s) => s.summary)).toEqual(["Bookmarks (1)", "kawaz (3)"]);
  });
});
