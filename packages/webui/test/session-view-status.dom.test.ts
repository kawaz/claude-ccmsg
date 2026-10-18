// SessionView's session_status subscription (DR-0020 Phase 2): the subscribe
// response is the snapshot plus `ok` / `sid`, and every snapshot field reaches
// `sessionStatuses` — the Status tab, the sidebar badge and the composer all
// read the store, so a field dropped here is missing from all of them.
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import type { PeerInfo, ReplyOf } from "@ccmsg/protocol";
import { SessionView } from "../src/client/components/SessionView.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { fullSessionStatusSnapshot } from "./session-status-fixture.ts";
import { Mounted } from "./timeline-harness.ts";

withDom();

const SID = "aaaaaaaa-0000-4000-8000-000000000002";
const PEER: PeerInfo = {
  sid: SID,
  repo: "owner/repo",
  ws: "main",
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

  test("a failed subscribe puts nothing in sessionStatuses and shows why", async () => {
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
    expect(root.textContent).toContain("no transcript for the session");
  });
});
