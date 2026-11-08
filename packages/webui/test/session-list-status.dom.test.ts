// The sidebar's Sessions list, mounted: which section a session lands in and
// what its live dot says come from the agents rows the daemon pushes, whose
// `turn` is the session's hooks module's word (DR-0035 §3). A session no
// module speaks for is shown as such, not as running or idle.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo, UnreadPermit, UnreadSay } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { renameNoteOf, SessionList } from "../src/client/components/SessionList.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

const RESPONDING = "aaaaaaaa-0000-4000-8000-000000000001";
const IDLE = "bbbbbbbb-0000-4000-8000-000000000002";
const BARE = "cccccccc-0000-4000-8000-000000000003";
const WAITING = "dddddddd-0000-4000-8000-000000000004";
const SINCE = "2026-10-18T01:00:00.000Z";

function peer(sid: string): PeerInfo {
  return {
    sid,
    repo: "repo",
    ws: sid.slice(0, 4),
    cwd: `/w/${sid}`,
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

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

async function mount(
  peers: PeerInfo[],
  agents: AgentInfo[],
  unreadPermits: UnreadPermit[] = [],
  unreadSays: UnreadSay[] = [],
): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({ type: "agents/loaded", agents });
  store.dispatch({ type: "permit-state/loaded", unread: unreadPermits, applied: [] });
  store.dispatch({ type: "say-unread/loaded", says: unreadSays });
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

/** Each section's heading, and the sid of each of its rows. */
function sections(root: HTMLElement): { summary: string; sids: string[] }[] {
  return [...root.querySelectorAll("details.session-section")].map((fold) => ({
    summary: fold.querySelector("summary")?.textContent ?? "",
    sids: [...fold.querySelectorAll("li.session-row")].map(
      (row) => row.querySelector(".session-line3")?.textContent ?? "",
    ),
  }));
}

function rowOf(root: HTMLElement, sid: string): HTMLElement {
  const row = [...root.querySelectorAll("li.session-row")].find((li) =>
    li.querySelector(".session-line3")?.textContent?.includes(sid),
  );
  return instanceOf(row, HTMLElement, `the row of ${sid}`);
}

describe("SessionList status from the module's turn", () => {
  test("responding / idle sessions are Active, a session no module speaks for is No module", async () => {
    const root = await mount(
      [peer(RESPONDING), peer(IDLE), peer(BARE), peer(WAITING)],
      [
        agent(RESPONDING, { status: "idle", turn: { state: "responding", since: SINCE } }),
        // Claude Code says busy (a background shell runs); the module says idle.
        agent(IDLE, { status: "busy", turn: { state: "idle", since: SINCE } }),
        agent(BARE, { status: "busy" }),
        agent(WAITING, { status: "waiting", waitingFor: "dialog open" }),
      ],
    );
    expect(
      sections(root).map(({ summary, sids }) => ({
        summary,
        sids: sids.map((s) => s.slice(0, 8)),
      })),
    ).toEqual([
      { summary: "Waiting (1)", sids: [WAITING.slice(0, 8)] },
      { summary: "Active (2)", sids: [RESPONDING.slice(0, 8), IDLE.slice(0, 8)] },
      { summary: "No module (1)", sids: [BARE.slice(0, 8)] },
    ]);

    const dot = (sid: string) => rowOf(root, sid).querySelector(".session-live-dot");
    expect(dot(RESPONDING)?.className).toBe("session-live-dot session-live-dot-running");
    expect(dot(RESPONDING)?.getAttribute("aria-label")).toBe("responding");
    expect(dot(IDLE)?.className).toBe("session-live-dot");
    expect(dot(IDLE)?.getAttribute("aria-label")).toBe("idle");
    expect(dot(WAITING)?.className).toBe("session-live-dot session-live-dot-waiting");
    expect(dot(WAITING)?.getAttribute("aria-label")).toBe("waiting (dialog open)");
    expect(dot(BARE)).toBeNull();
    expect(rowOf(root, BARE).title).toContain("hooks module 無し");
  });
});

// DR-0047: the session's hooks module runs `/rename`, so the title editor
// (✎) is offered where a module speaks for the session, and the note after a
// rename says whether the name changes now or after the turn.
describe("renaming from the Sessions list", () => {
  test("✎ is on the rows a module speaks for, not on the others", async () => {
    const root = await mount(
      [peer(RESPONDING), peer(IDLE), peer(BARE)],
      [
        agent(RESPONDING, { turn: { state: "responding", since: SINCE } }),
        agent(IDLE, { turn: { state: "idle", since: SINCE } }),
        agent(BARE, { status: "busy", hyoui_session_id: "hy-1" }),
      ],
    );
    const pencil = (sid: string) =>
      rowOf(root, sid).querySelector('button[aria-label="タイトルを変更"]');
    expect(pencil(RESPONDING)).not.toBeNull();
    expect(pencil(IDLE)).not.toBeNull();
    expect(pencil(BARE)).toBeNull();
  });

  test("the note says now or after the turn", () => {
    expect(renameNoteOf({ ok: true, title: "新しい名前", outcome: "renamed" })).toBe(
      "名前を変更: 新しい名前",
    );
    expect(renameNoteOf({ ok: true, title: "新しい名前", outcome: "queued" })).toBe(
      "応答の後に名前を変更: 新しい名前",
    );
  });
});

// A session waiting for the person's permission (DR-0040) or that spoke to
// them (say, DR-0045 §7) carries the 🔔🔐 badges by the TL header's rule
// (DR-0050 §7): both when either kind has something unread, the count as a
// counter over the emoji from 1, none at 0 / 0. Each badge opens the
// session's Timeline filtered to its kind, apart from the row's own link.
describe("the Sessions list's 🔔🔐 badges", () => {
  const request = (id: string, sid: string): UnreadPermit => ({
    session_id: sid,
    tool_use_id: id,
    ts: SINCE,
  });
  const say = (id: string, sid: string): UnreadSay => ({
    session_id: sid,
    tool_use_id: id,
    ts: SINCE,
  });

  /** Each badge of the row as `<emoji><counter>` (no counter at 0). */
  function badges(root: HTMLElement, sid: string): string[] {
    return [...rowOf(root, sid).querySelectorAll(".notif-badge")].map(
      (badge) =>
        `${badge.querySelector(".notif-badge-icon")?.textContent ?? ""}${badge.querySelector(".notif-badge-counter")?.textContent ?? ""}`,
    );
  }

  test("show both kinds when either is unread, counting from one", async () => {
    const root = await mount(
      [peer(RESPONDING), peer(IDLE), peer(BARE)],
      [
        agent(RESPONDING, { status: "idle", turn: { state: "idle", since: SINCE } }),
        agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } }),
        agent(BARE, { status: "idle", turn: { state: "idle", since: SINCE } }),
      ],
      [request("toolu_p1", RESPONDING), request("toolu_p2", IDLE), request("toolu_p3", IDLE)],
      [say("toolu_2", IDLE)],
    );
    expect(badges(root, RESPONDING)).toEqual(["🔔", "🔐1"]);
    expect(badges(root, IDLE)).toEqual(["🔔1", "🔐2"]);
    expect(badges(root, BARE)).toEqual([]);
    const permit = rowOf(root, IDLE).querySelector(".notif-badge-permit");
    expect(permit?.getAttribute("aria-label")).toBe(
      "未確認の許可依頼 2 件 — 押すと許可依頼だけを表示",
    );
  });

  test("each badge opens the session's Timeline filtered to its kind, outside the row's link", async () => {
    const root = await mount(
      [peer(IDLE)],
      [agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } })],
      [],
      [say("toolu_1", IDLE)],
    );
    const hrefs = [...rowOf(root, IDLE).querySelectorAll(".notif-badge")].map((badge) =>
      badge.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      `/s/${IDLE}/timeline/head?filter=say`,
      `/s/${IDLE}/timeline/head?filter=permit`,
    ]);
    const mainLink = rowOf(root, IDLE).querySelector(".session-main-link");
    expect(mainLink?.getAttribute("href")).toBe(`/s/${IDLE}`);
    expect(mainLink?.querySelector(".notif-badge")).toBeNull();
  });
});
