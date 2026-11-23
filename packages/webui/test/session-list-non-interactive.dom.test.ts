// The SESSIONS list's Non-interactive fold (DR-0060 §8), mounted: a session
// whose process Claude Code records as started by `claude -p` or an SDK (a
// btw's fork among them) is not in the owner tree nor among the sessions
// waiting for the person, but in one fold at the very bottom, closed until
// the reader opens it; a list with none has no such fold.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, peerLocation } from "./helpers.ts";

withDom();

const PERSON = "aaaaaaaa-0000-4000-8000-000000000001";
const FORK = "bbbbbbbb-0000-4000-8000-000000000002";
const SINCE = "2026-11-22T01:00:00.000Z";

function peer(sid: string): PeerInfo {
  return { sid, ...peerLocation("alice/app", "main"), cwd: `/w/${sid}`, connected_at: SINCE };
}

function agent(sid: string, entrypoint: string, status = "idle"): AgentInfo {
  return {
    pid: 1,
    cwd: `/w/${sid}`,
    kind: "interactive",
    startedAt: 1,
    sessionId: sid,
    config_dir: "/c",
    entrypoint,
    status,
  };
}

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  localStorage.clear();
});

async function mount(agents: readonly AgentInfo[]): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({ type: "agents/loaded", agents: [...agents] });
  const ws = createWsClient((action) => store.dispatch(action));
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const peers = agents.map((a) => peer(a.sessionId));
  await act(() =>
    render(
      h(AppContext.Provider, { value: { store, ws } }, h(SessionList, { peers, currentSid: null })),
      root,
    ),
  );
  return root;
}

/** The sids of the session rows' links inside `el`. */
function sidsIn(el: Element): string[] {
  return [...el.querySelectorAll("a[href*='/s/']")].flatMap((a) => {
    const sid = /\/s\/([0-9a-f-]{36})/.exec(a.getAttribute("href") ?? "")?.[1];
    return sid === undefined ? [] : [sid];
  });
}

describe("the Non-interactive fold", () => {
  test("a claude -p session (a btw's fork, waiting too) sits at the bottom, closed, out of the tree and of Waiting", async () => {
    const root = await mount([agent(PERSON, "cli"), agent(FORK, "sdk-cli", "waiting")]);
    const list = instanceOf(root.querySelector("#session-list"), HTMLElement, "the list");
    const last = instanceOf(list.lastElementChild, HTMLDetailsElement, "the last fold");
    expect(last.classList.contains("session-tree-non-interactive")).toBe(true);
    expect(last.open).toBe(false);
    expect(last.querySelector(".session-tree-name")?.textContent).toBe("Non-interactive (1)");
    expect(new Set(sidsIn(last))).toEqual(new Set([FORK]));
    expect(list.querySelector(".session-waiting-section")).toBeNull();
    const owner = instanceOf(list.querySelector(".session-tree-owner"), HTMLElement, "owner");
    expect(new Set(sidsIn(owner))).toEqual(new Set([PERSON]));
  });

  test("with no such session there is no fold", async () => {
    const root = await mount([agent(PERSON, "cli")]);
    expect(root.querySelector(".session-tree-non-interactive")).toBeNull();
  });
});
