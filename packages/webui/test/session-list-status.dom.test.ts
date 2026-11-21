// The sidebar's Sessions list, mounted: which section a session lands in and
// what its live dot says come from the agents rows the daemon pushes, whose
// `turn` is the session's hooks module's word (DR-0035 §3). A session no
// module speaks for is shown as such, not as running or idle.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo, UnreadPermit, UnreadSay } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import type { Pin } from "../src/client/pinned-sessions.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, peerLocation } from "./helpers.ts";

withDom();

const RESPONDING = "aaaaaaaa-0000-4000-8000-000000000001";
const IDLE = "bbbbbbbb-0000-4000-8000-000000000002";
const BARE = "cccccccc-0000-4000-8000-000000000003";
const WAITING = "dddddddd-0000-4000-8000-000000000004";
const SINCE = "2026-10-18T01:00:00.000Z";

function peer(sid: string): PeerInfo {
  return {
    sid,
    ...peerLocation("owner/repo", sid.slice(0, 4)),
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
  return (await mountWithStore(peers, agents, unreadPermits, unreadSays)).root;
}

/** mount, with the store, for a test that changes what is unread after. */
async function mountWithStore(
  peers: PeerInfo[],
  agents: AgentInfo[],
  unreadPermits: UnreadPermit[] = [],
  unreadSays: UnreadSay[] = [],
): Promise<{ root: HTMLElement; store: Store }> {
  const store = createStore(initialState());
  store.dispatch({ type: "agents/loaded", agents });
  store.dispatch({
    type: "permit-state/loaded",
    unread: unreadPermits,
    granted: [],
    applied: [],
    skipped: [],
  });
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
  return { root, store };
}

/** The sid a row links to: the row's main link is `sessionHref(sid)`. */
function sidOfRow(row: Element): string {
  const href = row.querySelector("a.session-main-link")?.getAttribute("href") ?? "";
  return decodeURIComponent(href.slice(href.lastIndexOf("/") + 1));
}

/** Each section's heading, and the sid of each of its rows. */
function sections(root: HTMLElement): { summary: string; sids: string[] }[] {
  return [...root.querySelectorAll("details.session-section")].map((fold) => ({
    summary: fold.querySelector("summary")?.textContent ?? "",
    sids: [...fold.querySelectorAll("li.session-row")].map(sidOfRow),
  }));
}

/** A status snapshot whose context says the session answered as `model` at `effort` — what the session_status subscription of an open session gives the row. */
function statusWith(sid: string, model: string, effort?: string) {
  return {
    type: "session-status/loaded" as const,
    sid,
    snapshot: {
      todos: [],
      workflows: [],
      background: [],
      context: { model, ...(effort ? { effort } : {}), timestamp: SINCE },
    },
  };
}

function rowOf(root: HTMLElement, sid: string): HTMLElement {
  const row = [...root.querySelectorAll("li.session-row")].find((li) => sidOfRow(li) === sid);
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
  });
});

// A session waiting for the person's permission (DR-0040) or that spoke to
// them (say, DR-0045 §7) carries a badge for each kind it has something
// unread of (DR-0050 §7): 🔔 for says, 🔐 for requests, both when both, none
// at 0 / 0 (the TL header carries both always, §3), the count as a counter
// over the emoji from 1. Marking a kind read takes its badge away. Each badge
// opens the session's Timeline filtered to its kind, apart from the row's own
// link.
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
      (badge) => badge.textContent ?? "",
    );
  }

  test("show the kinds with something unread only, counting from one", async () => {
    const root = await mount(
      [peer(RESPONDING), peer(IDLE), peer(BARE), peer(WAITING)],
      [
        agent(RESPONDING, { status: "idle", turn: { state: "idle", since: SINCE } }),
        agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } }),
        agent(BARE, { status: "idle", turn: { state: "idle", since: SINCE } }),
        agent(WAITING, { status: "idle", turn: { state: "idle", since: SINCE } }),
      ],
      [request("toolu_p1", RESPONDING), request("toolu_p2", IDLE), request("toolu_p3", IDLE)],
      [say("toolu_2", IDLE), say("toolu_4", WAITING)],
    );
    // 許可依頼だけ / 両方 / 0 / 0 / say だけ。
    expect(badges(root, RESPONDING)).toEqual(["🔐1"]);
    expect(badges(root, IDLE)).toEqual(["🔔1", "🔐2"]);
    expect(badges(root, BARE)).toEqual([]);
    expect(badges(root, WAITING)).toEqual(["🔔1"]);
    const permit = rowOf(root, IDLE).querySelector(".notif-badge-permit");
    expect(permit?.getAttribute("aria-label")).toBe(
      "未確認の許可依頼 2 件 — 押すと許可依頼だけを表示",
    );
  });

  test("marking a kind read takes its badge away, the other's stays", async () => {
    const { root, store } = await mountWithStore(
      [peer(IDLE)],
      [agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } })],
      [request("toolu_p1", IDLE)],
      [say("toolu_1", IDLE)],
    );
    expect(badges(root, IDLE)).toEqual(["🔔1", "🔐1"]);
    await act(() => store.dispatch({ type: "say-unread/loaded", says: [] }));
    expect(badges(root, IDLE)).toEqual(["🔐1"]);
    await act(() =>
      store.dispatch({
        type: "permit-state/loaded",
        unread: [],
        granted: [],
        applied: [],
        skipped: [],
      }),
    );
    expect(badges(root, IDLE)).toEqual([]);
  });

  test("each badge opens the session's Timeline filtered to its kind, outside the row's link", async () => {
    const root = await mount(
      [peer(IDLE)],
      [agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } })],
      [request("toolu_p1", IDLE)],
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

// The row's sid line carries, left to right: the live dot and the time since
// the last activity (one group: what state, and since when), the model the
// session runs on and its effort as `model/effort`, and the short sid. The dot
// and the time live only here, not on the repo@ws line above (kawaz
// 2026-11-16: `(dot)41m50s fable/low d2c0e3e2`). A pinned row has neither a
// dot nor a time (a pin is not an agents row), so it is `model/effort`, sid.
describe("SessionList sid line", () => {
  /** The sid line's parts, by class, in the order they are drawn. */
  function sidLineOrder(row: Element): string[] {
    const line = row.querySelector(".session-line3");
    return [
      ...(line?.querySelectorAll(
        ".session-live-dot, .session-idle, .session-model, .session-sid",
      ) ?? []),
    ].map((el) => el.classList[0] ?? "");
  }

  test("a live row reads dot, time, model/effort, sid — and the repo@ws line has no dot or time", async () => {
    const { root, store } = await mountWithStore(
      [{ ...peer(IDLE), last_activity_at: SINCE }],
      [agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } })],
    );
    await act(() => store.dispatch(statusWith(IDLE, "claude-fable-5-2", "low")));
    const row = rowOf(root, IDLE);
    expect(sidLineOrder(row)).toEqual([
      "session-live-dot",
      "session-idle",
      "session-model",
      "session-sid",
    ]);
    const line1 = row.querySelector(".session-line1");
    expect(line1?.querySelector(".session-live-dot")).toBeNull();
    expect(line1?.querySelector(".session-idle")).toBeNull();
    // The time is a duration since SINCE (weeks before now), not a timestamp.
    expect(row.querySelector(".session-line3 .session-idle")?.textContent).toMatch(/^\d+[smhd]/);
    // The model loses its version: the row says which family.
    const model = row.querySelector(".session-model");
    expect(model?.textContent).toBe("fable/low");
  });

  // A session no module speaks for has no dot, and one with no activity yet
  // has no time; with neither, the sid line starts at what it does have, with
  // no empty slot left for them.
  test("a row with neither dot nor time starts its sid line at the model", async () => {
    const { root, store } = await mountWithStore([peer(BARE)], [agent(BARE, { status: "busy" })]);
    await act(() => store.dispatch(statusWith(BARE, "claude-fable-5-2", "low")));
    const row = rowOf(root, BARE);
    expect(sidLineOrder(row)).toEqual(["session-model", "session-sid"]);
    expect(row.querySelector(".session-line3")?.firstElementChild?.className).toBe("session-model");
  });

  // An effort the session never reported (older Claude Code rows, or the
  // gateway's request, which carries the model only) is left out together
  // with its `/`: a trailing `opus/` would read as "effort: empty".
  test("a model with no effort is shown alone, with no slash", async () => {
    const { root, store } = await mountWithStore(
      [peer(IDLE)],
      [agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } })],
    );
    await act(() => store.dispatch(statusWith(IDLE, "claude-opus-5-5")));
    const model = rowOf(root, IDLE).querySelector(".session-model");
    expect(model?.textContent).toBe("opus");
  });

  test("a pinned row reads model/effort, sid", async () => {
    const { root, store } = await mountWithStore([], []);
    await act(() =>
      store.dispatch({
        type: "pinned/hydrated",
        pins: [
          {
            sid: IDLE,
            cwd: `/pinned/${IDLE}`,
            repo: "repo",
            ws: "main",
            title: null,
            file: "",
            updated_at: SINCE,
          },
        ],
      }),
    );
    await act(() => store.dispatch(statusWith(IDLE, "claude-fable-5-2[1m]", "high")));
    const row = instanceOf(
      root.querySelector(".pinned-section li.session-row"),
      HTMLElement,
      "the pinned row",
    );
    expect(sidLineOrder(row)).toEqual(["session-model", "session-sid"]);
    expect(row.querySelector(".session-model")?.textContent).toBe("fable/high");
  });
});

// Where a row's model/effort comes from (DR-0053 §4). The candidates are read in order and the first that names a model gives both values:
//   1. the session_status subscription's context — only the session open now (SessionView subscribes while its tab is shown) has one;
//   2. the peers row's model/effort — the daemon puts it on every session's row (the hooks module's facts, else what it read off the transcript when it first knew the session), so a row never opened, and a row the person opened and left, shows one;
//   3. the gateway's latest request — the model only, and only while the prompt cache window is open;
//   4. a pinned row's frozen value (the search hit it was pinned from). The subscription comes first because it is what the open session's Timeline is drawn from right now; the peers row comes before the gateway because it carries the effort the gateway's request does not.
describe("SessionList model/effort sources", () => {
  const OPEN = "eeeeeeee-0000-4000-8000-000000000005";
  const idle = (sid: string): AgentInfo =>
    agent(sid, { status: "idle", turn: { state: "idle", since: SINCE } });
  const modelOf = (root: HTMLElement, sid: string): string | null =>
    rowOf(root, sid).querySelector(".session-model")?.textContent ?? null;

  // The row of a session nobody opened reads the peers row: before this field the row had nothing unless the session was open or its prompt cache window was.
  test("a row never opened shows the peers row's model/effort", async () => {
    const root = await mount(
      [{ ...peer(IDLE), model: "claude-fable-5-2", effort: "low" }],
      [idle(IDLE)],
    );
    expect(modelOf(root, IDLE)).toBe("fable/low");
  });

  // A peers row without an effort (a transcript from before Claude Code recorded one) gives the model alone; the gateway's request, though later in the order, is not mixed in for the effort (it has none anyway, and a pair from two sources names a combination the session may never have run as).
  test("the peers row comes before the gateway's request", async () => {
    const { root, store } = await mountWithStore(
      [{ ...peer(IDLE), model: "claude-opus-5" }],
      [idle(IDLE)],
    );
    await act(() =>
      store.dispatch({
        type: "llm-requests/loaded",
        requests: [
          { ts: 1, session_id: IDLE, prefix: "484eda9c", main: true, model: "claude-haiku-5" },
        ],
      }),
    );
    expect(modelOf(root, IDLE)).toBe("opus");
  });

  // The open session's subscription wins over its peers row; the other row keeps its peers row's value, so moving from one session to another does not take the first one's model away (the subscription's entry is dropped when the view unsubscribes).
  test("the open session's subscription wins, and a row left keeps the peers row's value", async () => {
    const { root, store } = await mountWithStore(
      [
        { ...peer(OPEN), model: "claude-opus-5", effort: "high" },
        { ...peer(IDLE), model: "claude-fable-5-2", effort: "low" },
      ],
      [idle(OPEN), idle(IDLE)],
    );
    await act(() => store.dispatch(statusWith(OPEN, "claude-fable-5-2", "max")));
    expect(modelOf(root, OPEN)).toBe("fable/max");
    expect(modelOf(root, IDLE)).toBe("fable/low");
    await act(() => store.dispatch({ type: "session-status/cleared", sid: OPEN }));
    expect(modelOf(root, OPEN)).toBe("opus/high");
  });

  // The overrides of the session's requests (DR-0041 §5) are what its requests go out with, so the row shows the value in force the way the Status tab's MODEL / EFFORT and the TL's ctx line do: the one-shot override, else the session override, else the session's own. Every tab gets every session's overrides (ev:"request_overrides" / "request_override"), so a row never opened follows them too. The row keeps its own notation (the family, no 📌 / ⏱️).
  test("an override changes the row at once, opened or not", async () => {
    const { root, store } = await mountWithStore(
      [
        { ...peer(OPEN), model: "fable[1m]", effort: "low" },
        { ...peer(IDLE), model: "fable[1m]", effort: "low" },
      ],
      [idle(OPEN), idle(IDLE)],
    );
    await act(() => store.dispatch(statusWith(OPEN, "claude-fable-5-2", "low")));
    expect(modelOf(root, OPEN)).toBe("fable/low");
    expect(modelOf(root, IDLE)).toBe("fable/low");

    const none = { model: null, effort: null };
    await act(() =>
      store.dispatch({
        type: "request-overrides/loaded",
        sessions: [{ session_id: IDLE, session: { model: null, effort: "high" }, once: none }],
      }),
    );
    expect(modelOf(root, IDLE)).toBe("fable/high");
    expect(modelOf(root, OPEN)).toBe("fable/low");

    await act(() =>
      store.dispatch({
        type: "request-overrides/changed",
        sid: OPEN,
        target: "session",
        values: { model: "sonnet", effort: null },
      }),
    );
    expect(modelOf(root, OPEN)).toBe("sonnet/low");

    // The one-shot override comes before the session override.
    await act(() =>
      store.dispatch({
        type: "request-overrides/changed",
        sid: IDLE,
        target: "once",
        values: { model: null, effort: "max" },
      }),
    );
    expect(modelOf(root, IDLE)).toBe("fable/max");

    // Both cleared: back to the session's own.
    await act(() => {
      store.dispatch({
        type: "request-overrides/changed",
        sid: IDLE,
        target: "once",
        values: none,
      });
      store.dispatch({
        type: "request-overrides/changed",
        sid: IDLE,
        target: "session",
        values: none,
      });
    });
    expect(modelOf(root, IDLE)).toBe("fable/low");
  });

  // No source names a model: the row shows none (no placeholder).
  test("a peers row without a model, and nothing else, shows no model", async () => {
    const root = await mount([peer(IDLE)], [idle(IDLE)]);
    expect(rowOf(root, IDLE).querySelector(".session-model")).toBeNull();
  });
});

// The row's sid and path lines: the sid is shown as its first 8 characters
// and the path line appears only for a row
// that has neither repo nor ws to say where it is.
describe("SessionList sid and path lines", () => {
  const BARE_PEER: PeerInfo = { ...peer(BARE), ...peerLocation("", "") };

  function pin(sid: string, repo: string | null, ws: string | null): Pin {
    return {
      sid,
      cwd: `/pinned/${sid}`,
      repo,
      ws,
      title: null,
      file: "",
      updated_at: SINCE,
    };
  }

  test("a row with repo/ws shows the short sid and has no path line", async () => {
    const root = await mount([peer(IDLE)], [agent(IDLE, { status: "idle" })]);
    const row = rowOf(root, IDLE);
    const sid = row.querySelector(".session-sid");
    expect(sid?.textContent).toBe(IDLE.slice(0, 8));
    expect(row.querySelector(".session-line4")).toBeNull();
  });

  test("a row with neither repo nor ws has the path line carrying the cwd", async () => {
    const root = await mount([BARE_PEER], [agent(BARE, { status: "idle" })]);
    const row = rowOf(root, BARE);
    expect(row.querySelector(".session-line4 .session-cwd")?.textContent).toBe(`/w/${BARE}`);
  });

  test("a pinned row follows the same sid and path-line rules", async () => {
    const { root, store } = await mountWithStore([], []);
    await act(() =>
      store.dispatch({
        type: "pinned/hydrated",
        pins: [pin(IDLE, "repo", "main"), pin(BARE, null, null)],
      }),
    );
    const rows = [...root.querySelectorAll(".pinned-section li.session-row")];
    const rowFor = (sid: string): Element | undefined => rows.find((li) => sidOfRow(li) === sid);

    const withRepo = rowFor(IDLE);
    expect(withRepo?.querySelector(".session-sid")?.textContent).toBe(IDLE.slice(0, 8));
    expect(withRepo?.querySelector(".session-line4")).toBeNull();

    const withoutRepo = rowFor(BARE);
    expect(withoutRepo?.querySelector(".session-sid")?.textContent).toBe(BARE.slice(0, 8));
    expect(withoutRepo?.querySelector(".session-line4 .session-cwd")?.textContent).toBe(
      `/pinned/${BARE}`,
    );
  });
});

// The row carries no hover text: what a row said in `title` is on the Status tab.
// The `aria-label` of the dot, the stale-client mark and the unpin button stays.
describe("SessionList rows carry no title attribute", () => {
  test("neither a session row nor anything in it has a title", async () => {
    const root = await mount(
      [
        {
          ...peer(RESPONDING),
          stale_client: { version: "0.1.0", protocol: { major: 1, minor: 0 }, last_seen: SINCE },
        },
        { ...peer(IDLE), model: "claude-fable-5-2", effort: "low" },
      ],
      [
        agent(RESPONDING, { status: "idle", turn: { state: "responding", since: SINCE } }),
        agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } }),
      ],
      [{ session_id: IDLE, tool_use_id: "toolu_p", ts: SINCE }],
      [{ session_id: IDLE, tool_use_id: "toolu_s", ts: SINCE }],
    );
    const rows = [...root.querySelectorAll("li.session-row")];
    expect(rows.length).toBe(2);
    expect(root.querySelector(".session-stale-client")?.getAttribute("aria-label")).toBe(
      "ccmsg クライアントが古い",
    );
    expect(root.querySelectorAll(".notif-badge").length).toBe(2);
    expect(root.querySelector(".session-live-dot")?.getAttribute("aria-label")).toBe("responding");
    for (const row of rows) {
      expect(row.hasAttribute("title")).toBe(false);
      expect(row.querySelectorAll("[title]").length).toBe(0);
    }
  });

  test("neither a pinned row (virtual badge, unpin button) nor anything in it has a title", async () => {
    const { root, store } = await mountWithStore([], []);
    await act(() =>
      store.dispatch({
        type: "pinned/hydrated",
        pins: [
          {
            sid: IDLE,
            cwd: "/pinned/a",
            repo: "repo",
            ws: "main",
            title: "t",
            file: "",
            updated_at: SINCE,
          },
          {
            sid: BARE,
            cwd: "/pinned/b",
            repo: null,
            ws: null,
            title: null,
            file: "",
            updated_at: SINCE,
          },
        ],
      }),
    );
    const rows = [...root.querySelectorAll(".pinned-section li.session-row")];
    expect(rows.length).toBe(2);
    expect(root.querySelector(".pinned-section .session-badge-offline")).not.toBeNull();
    expect(root.querySelector(".pinned-unpin-btn")?.getAttribute("aria-label")).toBe("ピン解除");
    for (const row of rows) {
      expect(row.hasAttribute("title")).toBe(false);
      expect(row.querySelectorAll("[title]").length).toBe(0);
    }
  });
});
