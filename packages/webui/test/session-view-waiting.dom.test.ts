// セッション本体の TL は、そのセッションが Waiting (サイドバーの Waiting と同じ
// 判定) の間だけ末尾に `Waiting...` の行を出す (DR-0059)。Waiting は agents の行に
// しか無く transcript に現れないので、TL の一番下を見て応答を待っている人に
// 気づかせる手段がこれしかない。subagent の TL と他のタブ、Error のセッション
// (エラーは TL に出る) には出さない。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo } from "@ccmsg/protocol";
import { SessionView } from "../src/client/components/SessionView.tsx";
import type { AgentRef, SessionTab } from "../src/client/locator.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { stubGlobal, peerLocation } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { exchange, FakeTranscriptWs, Mounted, page, SID } from "./timeline-harness.ts";

withDom();

const PEER: PeerInfo = {
  sid: SID,
  ...peerLocation("owner/repo", "main"),
  cwd: "/work/repo",
  transcript_path: "/work/.claude/projects/repo/session.jsonl",
};

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    pid: 1,
    cwd: PEER.cwd,
    kind: "interactive",
    startedAt: 1,
    sessionId: SID,
    config_dir: "/c",
    ...overrides,
  };
}

const WAITING = agent({ status: "waiting", waitingFor: "dialog open" });
const IDLE = agent({ turn: { state: "idle", since: "2026-11-21T00:00:00.000Z" } });

const mounted = new Mounted();
let restores: Array<() => void> = [];

beforeEach(() => {
  restores = [stubGlobal("navigation", { navigate() {} })];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

async function open(
  agents: AgentInfo[],
  view: { tab?: SessionTab; agent?: AgentRef | null } = {},
): Promise<{ store: Store; root: HTMLElement }> {
  const store = createStore(initialState());
  store.dispatch({ type: "peers/loaded", peers: [PEER] });
  store.dispatch({ type: "agents/loaded", agents });
  store.dispatch({ type: "conn/status", status: "connected" });
  const ws = new FakeTranscriptWs(store);
  const tab = view.tab ?? "timeline";
  const root = await mounted.mount(
    store,
    ws.handle,
    h(SessionView, { sid: SID, tab, agent: view.agent ?? null, active: true }),
  );
  if (tab === "timeline") await ws.lastRead().answer(page(exchange(1)));
  return { store, root };
}

/** The Waiting row, and whether nothing shown follows it in the Timeline
 * (the filter's buttons after the list stay there hidden). */
function waitingRow(root: HTMLElement): { text: string | null; last: boolean } | null {
  const row = root.querySelector(".tl-waiting-notice");
  if (row === null) return null;
  let last = true;
  for (let next = row.nextElementSibling; next !== null; next = next.nextElementSibling) {
    if (!(next instanceof HTMLElement) || !next.hidden) last = false;
  }
  return { text: row.textContent, last };
}

describe("the session's own Timeline while the session is Waiting", () => {
  test("ends with Waiting... while the session waits, and loses it once it no longer does", async () => {
    const { store, root } = await open([WAITING]);
    expect(root.textContent).toContain("answer 1");
    expect(waitingRow(root)).toEqual({ text: "Waiting...", last: true });

    await act(() => store.dispatch({ type: "agents/loaded", agents: [IDLE] }));
    expect(waitingRow(root)).toBeNull();

    await act(() => store.dispatch({ type: "agents/loaded", agents: [WAITING] }));
    expect(waitingRow(root)).toEqual({ text: "Waiting...", last: true });
  });

  test("has no Waiting... while the session does not wait", async () => {
    const { root } = await open([IDLE]);
    expect(root.textContent).toContain("answer 1");
    expect(waitingRow(root)).toBeNull();
  });

  // The sidebar puts such a session under Error, not Waiting: the error is in
  // the TL already.
  test("has no Waiting... while the session is stopped on an API error", async () => {
    const { store, root } = await open([WAITING]);
    await act(() =>
      store.dispatch({
        type: "session-errors/loaded",
        errors: [{ sid: SID, text: "API Error: 500", timestamp: "2026-11-21T00:00:00Z" }],
      }),
    );
    expect(waitingRow(root)).toBeNull();
  });
});

describe("views other than the session's own Timeline", () => {
  test("a subagent's Timeline has no Waiting... while the session waits", async () => {
    const { root } = await open([WAITING], { agent: { agentId: "a1234567" } });
    expect(root.textContent).toContain("answer 1");
    expect(waitingRow(root)).toBeNull();
  });

  test("the Status tab has no Waiting... while the session waits", async () => {
    const { root } = await open([WAITING], { tab: "status" });
    expect(root.querySelector('[data-session-tab="status"]')).not.toBeNull();
    expect(waitingRow(root)).toBeNull();
  });
});
