// Starting a navigation (a session tab click, a link to another session) reads
// no element's scroll position in the session view. In Chromium each such read
// on an element inside a closed <details> runs a layout of the whole document,
// so reading them across a Timeline that older has read to its start freezes
// the tab for minutes (docs/findings/2026-11-05-older-tab-freeze-fix.md).
// happy-dom computes no layout, so the reads are counted at the getters.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import type { PeerInfo } from "@ccmsg/protocol";
import { SessionView } from "../src/client/components/SessionView.tsx";
import { BEFORE_NAVIGATION_EVENT } from "../src/client/navigation.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
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
let restores: Array<() => void> = [];

beforeEach(() => {
  restores = [stubGlobal("navigation", { navigate() {} })];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

/** Runs `run` with the scroll position getters of every element counting
 * their reads (and answering 0), and returns the count. */
function countScrollReads(run: () => void): number {
  let reads = 0;
  const counting: PropertyDescriptor = {
    configurable: true,
    get() {
      reads += 1;
      return 0;
    },
    set() {},
  };
  const restoreTop = stubProperty(Element.prototype, "scrollTop", counting);
  const restoreLeft = stubProperty(Element.prototype, "scrollLeft", counting);
  try {
    run();
  } finally {
    restoreLeft();
    restoreTop();
  }
  return reads;
}

describe("a shown SessionView", () => {
  test("reads no element's scroll position when a navigation starts", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "peers/loaded", peers: [PEER] });
    store.dispatch({ type: "conn/status", status: "connected" });
    const ws = new FakeTranscriptWs(store);
    const root = await mounted.mount(
      store,
      ws.handle,
      h(SessionView, { sid: SID, tab: "timeline", agent: null, active: true }),
    );
    await ws.lastRead().answer(page([...exchange(1), ...exchange(2)]));
    expect(root.querySelectorAll(".tl-lines *").length).toBeGreaterThan(0);

    expect(countScrollReads(() => window.dispatchEvent(new Event(BEFORE_NAVIGATION_EVENT)))).toBe(
      0,
    );
  });
});
