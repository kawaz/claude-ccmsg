// The sidebar's Sessions list, mounted: which section a session lands in and
// what its live dot says come from the agents rows the daemon pushes, whose
// `turn` is the session's hooks module's word (DR-0035 §3). A session no
// module speaks for is shown as such, not as running or idle.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo, PermitRequestRecord } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
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
  permitRequests: PermitRequestRecord[] = [],
): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({ type: "agents/loaded", agents });
  store.dispatch({ type: "permit-requests/loaded", requests: permitRequests });
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

// A session waiting for the person's permission (DR-0040) is marked in the
// list as a say is, with 🔐 and the count of the requests not yet acted on.
describe("the Sessions list's unread requests for permission", () => {
  const request = (id: string, sid: string, read: boolean): PermitRequestRecord => ({
    id,
    sid,
    ts: SINCE,
    blocked: "x",
    attachments: [],
    intents: [],
    commands: ["ls"],
    read,
  });

  test("marks each session with its unread requests, counting past one", async () => {
    const root = await mount(
      [peer(RESPONDING), peer(IDLE), peer(BARE)],
      [
        agent(RESPONDING, { status: "idle", turn: { state: "idle", since: SINCE } }),
        agent(IDLE, { status: "idle", turn: { state: "idle", since: SINCE } }),
        agent(BARE, { status: "idle", turn: { state: "idle", since: SINCE } }),
      ],
      [
        request("i/1", RESPONDING, false),
        request("i/2", IDLE, false),
        request("i/3", IDLE, false),
        request("i/4", IDLE, true),
        request("i/5", BARE, true),
      ],
    );
    const mark = (sid: string) => rowOf(root, sid).querySelector(".session-permit-unread");
    expect(mark(RESPONDING)?.textContent).toBe("🔐");
    expect(mark(IDLE)?.textContent).toBe("🔐2");
    expect(mark(IDLE)?.getAttribute("aria-label")).toBe("未確認の許可依頼 2 件");
    expect(mark(BARE)).toBeNull();
  });
});
