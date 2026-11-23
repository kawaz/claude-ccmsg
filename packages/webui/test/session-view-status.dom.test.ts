// SessionView's session_status subscription (DR-0020 Phase 2): the subscribe
// response is the snapshot plus `ok` / `sid`, and every snapshot field reaches
// `sessionStatuses` — the Status tab, the sidebar badge and the composer all
// read the store, so a field dropped here is missing from all of them.
//
// 何を保証するか (DR-0020 Addendum 2026-11-09 の終了済みのセッション、kawaz 2026-11-24):
//   - 状態の購読が断られても、終了済みで transcript の手掛かりが何も無くても、Status タブは
//     エラーや状況の説明の文に置き換わらず、普段の枠 (計器・セッション情報・セッション操作・
//     危険ゾーン) で描かれ、取れない値は「—」になる
//   - 「読み込み中…」は購読して状態を待っている間だけで、購読しないセッションでは出ない
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import type { PeerInfo, ReplyOf } from "@ccmsg/protocol";
import { NO_TRANSCRIPT_MESSAGE, SessionView } from "../src/client/components/SessionView.tsx";
import { initialState } from "../src/client/store.ts";
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

  test("a failed subscribe puts nothing in sessionStatuses and draws the usual frame, no error", async () => {
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
    expect(root.textContent).not.toContain("no transcript for the session");
    expect(root.textContent).not.toContain("Status を読み込めません");
    expect(root.querySelector(".status-loading")).toBeNull();
    expect(root.querySelector(".status-session-info")).not.toBeNull();
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
