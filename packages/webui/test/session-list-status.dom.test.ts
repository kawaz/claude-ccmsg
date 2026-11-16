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
  store.dispatch({ type: "permit-state/loaded", unread: unreadPermits, granted: [], applied: [] });
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

/** Each section's heading, and the sid of each of its rows. */
function sections(root: HTMLElement): { summary: string; sids: string[] }[] {
  return [...root.querySelectorAll("details.session-section")].map((fold) => ({
    summary: fold.querySelector("summary")?.textContent ?? "",
    sids: [...fold.querySelectorAll("li.session-row")].map(
      (row) => row.querySelector(".session-sid")?.getAttribute("title") ?? "",
    ),
  }));
}

function rowOf(root: HTMLElement, sid: string): HTMLElement {
  const row = [...root.querySelectorAll("li.session-row")].find(
    (li) => li.querySelector(".session-sid")?.getAttribute("title") === sid,
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
      store.dispatch({ type: "permit-state/loaded", unread: [], granted: [], applied: [] }),
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

  /** A status snapshot whose context says the session answered as `model`
   * at `effort` — the source the row reads both from. */
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
    // The model loses its version: the row says which family, the hover keeps
    // the full name it ran as.
    const model = row.querySelector(".session-model");
    expect(model?.textContent).toBe("fable/low");
    expect(model?.getAttribute("title")).toBe("model claude-fable-5-2 / effort low");
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
    expect(model?.getAttribute("title")).toBe("model claude-opus-5-5");
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

// The row's sid and path lines: the sid is shown as its first 8 characters
// (the full one rides on `title`), and the path line appears only for a row
// that has neither repo nor ws to say where it is.
describe("SessionList sid and path lines", () => {
  const BARE_PEER: PeerInfo = { ...peer(BARE), repo: "", ws: "" };

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

  test("a row with repo/ws shows the short sid, keeps the full sid in title, and has no path line", async () => {
    const root = await mount([peer(IDLE)], [agent(IDLE, { status: "idle" })]);
    const row = rowOf(root, IDLE);
    const sid = row.querySelector(".session-sid");
    expect(sid?.textContent).toBe(IDLE.slice(0, 8));
    expect(sid?.getAttribute("title")).toBe(IDLE);
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
    const rowFor = (sid: string): Element | undefined =>
      rows.find((li) => li.querySelector(".session-sid")?.getAttribute("title") === sid);

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
