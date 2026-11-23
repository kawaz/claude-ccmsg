// SessionView's session_status subscription (DR-0020 Phase 2): the subscribe
// response is the snapshot plus `ok` / `sid`, and every snapshot field reaches
// `sessionStatuses` — the Status tab, the sidebar badge and the composer all
// read the store, so a field dropped here is missing from all of them.
//
// 何を保証するか (DR-0020 Addendum 2026-11-09 の終了済みのセッション、kawaz 2026-11-24):
//   - 状態の購読が断られても、終了済みで transcript の手掛かりが何も無くても、Status タブは
//     エラーや状況の説明の文に置き換わらず、普段の枠 (計器・セッション情報・セッション操作・
//     危険ゾーン) で描かれ、取れない値は「—」になる
//   - 生きているセッション (peers か agents の行に居る) の購読の失敗は、枠の頭に「Status を
//     読み込めません: <理由>」を枠と一緒に出す。終了済みのセッションの失敗は何も言わない
//   - 「読み込み中…」は購読して状態を待っている間だけで、購読しないセッションでは出ない
//   - peers にも agents の行にも栞・検索のヒットにも無いセッション (終わったもの) は、sid で
//     session_search を 1 回引き、見つかればそのヒット (searchHit) で Status の購読・CWD・
//     起動、Timeline の読み込みが戻る。開いたまま終わった時も同じ。見つからなければ枠のまま
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import type { AgentInfo, PeerInfo, ReplyOf, SessionSearchHit } from "@ccmsg/protocol";
import { act } from "preact/test-utils";
import {
  NO_TRANSCRIPT_MESSAGE,
  SESSION_LOOKUP_WITHIN,
  SessionView,
} from "../src/client/components/SessionView.tsx";
import { DEFAULT_TIMELINE_SEARCH, initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { fullSessionStatusSnapshot } from "./session-status-fixture.ts";
import { Mounted } from "./timeline-harness.ts";
import { peerLocation } from "./helpers.ts";

withDom();

const SID = "aaaaaaaa-0000-4000-8000-000000000002";
const PEER: PeerInfo = {
  sid: SID,
  ...peerLocation("owner/repo", "main"),
  cwd: "/work/repo",
  transcript_path: "/work/.claude/projects/repo/session.jsonl",
};

const mounted = new Mounted();
afterEach(() => mounted.unmount());

function connectedStore(): Store {
  const store = createStore(initialState());
  store.dispatch({ type: "peers/loaded", peers: [PEER] });
  store.dispatch({ type: "conn/status", status: "connected" });
  return store;
}

/** A ws whose session_status_subscribe answers `reply`; every other request
 * goes to a client that is not connected (it rejects). */
function wsAnswering(
  store: Store,
  reply: ReplyOf<"session_status_subscribe">,
): {
  ws: WsHandle;
  subscribed: string[];
} {
  const subscribed: string[] = [];
  const base = createWsClient((action) => store.dispatch(action));
  const ws: WsHandle = {
    ...base,
    sessionStatusSubscribe: (sid) => {
      subscribed.push(sid);
      return Promise.resolve(reply);
    },
    sessionStatusUnsubscribe: (sid) => Promise.resolve({ ok: true, sid }),
  };
  return { ws, subscribed };
}

describe("SessionView session_status_subscribe", () => {
  test("every snapshot field of the response is put in sessionStatuses", async () => {
    const store = connectedStore();
    const snapshot = fullSessionStatusSnapshot();
    const { ws, subscribed } = wsAnswering(store, { ok: true, sid: SID, ...snapshot });

    await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "status", agent: null, active: true }),
    );

    expect(subscribed).toEqual([SID]);
    expect(store.getState().sessionStatuses.get(SID)).toEqual(snapshot);
  });

  test("a live session's failed subscribe: nothing in sessionStatuses, the usual frame, and why at its head", async () => {
    const store = connectedStore();
    const { ws } = wsAnswering(store, {
      ok: false,
      error: { code: "session_not_found", msg: "no transcript for the session" },
    });

    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "status", agent: null, active: true }),
    );

    expect(store.getState().sessionStatuses.has(SID)).toBe(false);
    const view = root.querySelector('[data-session-tab="status"] .status-view');
    expect(view?.firstElementChild?.textContent).toBe(
      "Status を読み込めません: no transcript for the session",
    );
    expect(root.querySelector(".status-loading")).toBeNull();
    expect(view?.querySelector(".status-session-info")).not.toBeNull();
  });

  test("an ended session's failed subscribe: the usual frame, and no word of why", async () => {
    // Ended: no peer nor agents row, its transcript known from the hit it was
    // opened from, and the daemon not folding it.
    const store = createStore(initialState());
    store.dispatch({ type: "conn/status", status: "connected" });
    store.dispatch({
      type: "session-search/opened",
      hit: {
        sid: SID,
        config_dir: "/home/u/.claude",
        file: "/home/u/.claude/projects/-work-repo/gone.jsonl",
        cwd: "/work/repo",
        repo: null,
        ws: null,
        created_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:10:00.000Z",
        size: 1,
        matches: [],
        title: null,
      },
      search: { ...DEFAULT_TIMELINE_SEARCH },
    });
    const { ws, subscribed } = wsAnswering(store, {
      ok: false,
      error: { code: "not_found", msg: "the transcript is gone" },
    });

    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "status", agent: null, active: true }),
    );

    expect(subscribed).toEqual([SID]);
    expect(root.textContent).not.toContain("the transcript is gone");
    expect(root.textContent).not.toContain("Status を読み込めません");
    expect(root.querySelector(".status-loading")).toBeNull();
    expect(root.querySelector('[data-session-tab="status"] .status-session-info')).not.toBeNull();
  });
});

describe("the Status tab of a session that ended", () => {
  // 終了ボタンで終わらせた後: peers にも agents の行にも栞・検索のヒットにも無い。
  test("the usual frame with its operations, empty values, and no word of why", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "conn/status", status: "connected" });
    store.dispatch({ type: "launch/availability", available: true });
    const { ws, subscribed } = wsAnswering(store, {
      ok: true,
      sid: SID,
      ...fullSessionStatusSnapshot(),
    });

    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "status", agent: null, active: true }),
    );

    // Nothing says where its transcript is: no subscribe, nothing to wait for.
    expect(subscribed).toEqual([]);
    expect(root.textContent).not.toContain(NO_TRANSCRIPT_MESSAGE);
    expect(root.querySelector(".status-loading")).toBeNull();
    const panel = root.querySelector('[data-session-tab="status"] .status-view');
    expect(panel).not.toBeNull();
    const facts = new Map(
      [...(panel?.querySelectorAll(".status-fact") ?? [])].map((fact) => [
        fact.querySelector("dt")?.textContent ?? "",
        fact.querySelector(".status-scroll")?.textContent ?? "",
      ]),
    );
    expect(facts.get("SESSION_ID")).toBe(SID);
    expect(facts.get("CWD")).toBe("—");
    expect(facts.get("PID")).toBe("—");
    // What does not need the session alive is there: the session's operations
    // and the danger zone.
    expect(panel?.querySelector(".status-session-actions")).not.toBeNull();
    expect(panel?.querySelector(".status-kill-zone")).not.toBeNull();
  });
});

const HIT: SessionSearchHit = {
  sid: SID,
  config_dir: "/home/u/.claude",
  file: "/home/u/.claude/projects/-work-repo/aaaaaaaa-0000-4000-8000-000000000002.jsonl",
  cwd: "/work/repo",
  repo: null,
  ws: null,
  created_at: "2030-01-01T00:00:00.000Z",
  updated_at: "2030-01-01T00:10:00.000Z",
  size: 1234,
  matches: [],
  title: "repo 20300101T0000",
};

/** A ws for a session that ended: session_search by its sid answers `hits`
 * when the test says (`answer`, inside act so what it sets off is drawn and
 * its effects run), the status subscribe answers a snapshot, and transcript
 * reads are kept. */
function wsForEnded(store: Store, hits: SessionSearchHit[]) {
  const searches: Array<{ sid: string | undefined; within: string | undefined }> = [];
  const pending: Array<() => void> = [];
  const subscribed: string[] = [];
  const reads: string[] = [];
  const base = createWsClient((action) => store.dispatch(action));
  const ws: WsHandle = {
    ...base,
    sessionSearch: (params) => {
      searches.push({ sid: params.sid, within: params.mtime_within });
      return new Promise((resolve) => {
        pending.push(() => resolve({ ok: true, hits, truncated: false }));
      });
    },
    sessionStatusSubscribe: (sid) => {
      subscribed.push(sid);
      return Promise.resolve({ ok: true, sid, ...fullSessionStatusSnapshot() });
    },
    sessionStatusUnsubscribe: (sid) => Promise.resolve({ ok: true, sid }),
    transcriptRead: (sid) => {
      reads.push(sid);
      return new Promise(() => {});
    },
  };
  const answer = () =>
    act(async () => {
      for (const resolve of pending.splice(0)) resolve();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  return { ws, searches, subscribed, reads, answer };
}

function factsOf(root: HTMLElement): Map<string, string> {
  return new Map(
    [...root.querySelectorAll('[data-session-tab="status"] .status-fact')].map((fact) => [
      fact.querySelector("dt")?.textContent ?? "",
      fact.querySelector(".status-scroll")?.textContent ?? "",
    ]),
  );
}

describe("a session nothing here locates: looked up by its sid", () => {
  test("found: the Status folds it, its cwd is the launch's, and the lookup is once", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "conn/status", status: "connected" });
    store.dispatch({ type: "launch/availability", available: true });
    const { ws, searches, subscribed, answer } = wsForEnded(store, [HIT]);

    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "status", agent: null, active: true }),
    );
    await answer();

    expect(searches).toEqual([{ sid: SID, within: SESSION_LOOKUP_WITHIN }]);
    expect(store.getState().sessionTrees.get(SID)?.searchHit).toEqual(HIT);
    // The status subscribe the found transcript sets off answers too.
    await answer();
    expect(subscribed).toEqual([SID]);
    expect(factsOf(root).get("CWD")).toBe("/work/repo");
    // Its name is the one its transcript records (the hit's title).
    const name = root.querySelector('[data-session-tab="status"] .status-fact input');
    expect(name instanceof HTMLInputElement ? name.value : null).toBe("repo 20300101T0000");
    const launch = root.querySelector(".status-session-actions .status-action-open");
    expect(launch instanceof HTMLButtonElement ? launch.disabled : null).toBe(false);
    expect(root.textContent).not.toContain("cwd が分からない");
  });

  test("not found: the frame stays, empty, the launch without a cwd as it says", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "conn/status", status: "connected" });
    store.dispatch({ type: "launch/availability", available: true });
    const { ws, searches, subscribed, answer } = wsForEnded(store, []);

    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "status", agent: null, active: true }),
    );
    await answer();

    expect(searches).toHaveLength(1);
    expect(subscribed).toEqual([]);
    expect(factsOf(root).get("CWD")).toBe("—");
    expect(root.textContent).not.toContain(NO_TRANSCRIPT_MESSAGE);
    expect(root.querySelector(".status-loading")).toBeNull();
  });

  test("a session ending while open is looked up then, and its Status keeps its cwd", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "conn/status", status: "connected" });
    const agent: AgentInfo = {
      sessionId: SID,
      pid: 4242,
      config_dir: "/home/u/.claude",
      cwd: "/work/repo",
      name: "repo",
      kind: "interactive",
      startedAt: 1,
      status: "idle",
    };
    store.dispatch({ type: "agents/loaded", agents: [agent] });
    const { ws, searches, answer } = wsForEnded(store, [HIT]);

    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "status", agent: null, active: true }),
    );
    await answer();
    // Alive: nothing to look up.
    expect(searches).toEqual([]);

    // The agents rows read again without it: it ended.
    await act(() => store.dispatch({ type: "agents/loaded", agents: [] }));
    await answer();
    // The status subscribe the found transcript sets off answers too.
    await answer();
    expect(searches).toHaveLength(1);
    expect(factsOf(root).get("CWD")).toBe("/work/repo");
  });

  test("its Timeline tab reads the transcript the lookup found", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "conn/status", status: "connected" });
    const { ws, reads, answer } = wsForEnded(store, [HIT]);

    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "timeline", agent: null, active: true }),
    );
    await answer();

    const tab = [...root.querySelectorAll(".session-tab")].find(
      (el) => el.textContent === "Timeline",
    );
    expect(tab?.getAttribute("aria-disabled")).not.toBe("true");
    expect(root.textContent).not.toContain(NO_TRANSCRIPT_MESSAGE);
    expect(reads).toContain(SID);
  });
});
