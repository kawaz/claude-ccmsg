// SessionView's Timeline tab keeps one Timeline mounted while the session's
// agent tree comes and goes. The status snapshot arrives after the Timeline
// has mounted (and is cleared whenever the session is left), so a Timeline
// that moved into the agent-tree layout when the tree appeared was torn down
// and mounted again: its arrival read and live-tail subscription ran twice,
// and its scroll and fold state started over.
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo } from "@ccmsg/protocol";
import { SessionView } from "../src/client/components/SessionView.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import type { WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { fullSessionStatusSnapshot } from "./session-status-fixture.ts";
import { exchange, FakeTranscriptWs, Mounted, page, SID } from "./timeline-harness.ts";

withDom();

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

/** The transcript requests are recorded; the status subscription is answered
 * by the test dispatching the snapshot itself. */
function wsFor(store: Store): { fake: FakeTranscriptWs; ws: WsHandle } {
  const fake = new FakeTranscriptWs(store);
  const ws: WsHandle = {
    ...fake.handle,
    sessionStatusSubscribe: () => new Promise(() => {}),
    sessionStatusUnsubscribe: (sid) => Promise.resolve({ ok: true, sid }),
  };
  return { fake, ws };
}

describe("SessionView Timeline tab", () => {
  test("the agent tree appearing and going does not mount the Timeline again", async () => {
    const store = connectedStore();
    const { fake, ws } = wsFor(store);
    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "timeline", agent: null, active: true }),
    );
    await fake.lastRead().answer(page(exchange(1)));
    expect(fake.reads).toHaveLength(1);
    expect(fake.subscribes).toEqual([SID]);
    expect(root.querySelector(".timeline-pane-tree")).toBeNull();

    await act(() =>
      store.dispatch({
        type: "session-status/loaded",
        sid: SID,
        snapshot: fullSessionStatusSnapshot(),
      }),
    );
    expect(root.querySelector(".timeline-pane-tree")).not.toBeNull();
    await act(() => store.dispatch({ type: "session-status/cleared", sid: SID }));
    expect(root.querySelector(".timeline-pane-tree")).toBeNull();

    expect(fake.reads).toHaveLength(1);
    expect(fake.subscribes).toEqual([SID]);
    expect(fake.unsubscribes).toEqual([]);
    expect(root.textContent).toContain("question 1");
  });
});
