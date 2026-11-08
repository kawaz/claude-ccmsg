// The protocol version (`major.minor`, DR-0002 §4) as the webui shows it,
// mounted. A session whose ccmsg speaks the daemon's major with another minor
// is served, but can drop what the daemon sends it without a word: its ccmsg
// is drawn in yellow on the Timeline's ctx line, in the Status tab and on its
// Sessions row, each with a hover text saying a reload does not fix it and
// restarting the session does. A tab whose bundle speaks another major than
// the daemon is refused outright: the reload button turns red.
import { afterEach, describe, expect, test } from "bun:test";
import { type ComponentChildren, h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  ErrorResponse,
  PeerInfo,
  ProtocolVersion,
  RequestOverrideResponse,
  SessionEnvResponse,
  SessionKillResponse,
  SessionRestartResponse,
  SessionStatusSnapshot,
  UserMessageResponse,
} from "@ccmsg/protocol";
import { App } from "../src/client/components/App.tsx";
import { SessionList } from "../src/client/components/SessionList.tsx";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { AppContext, useApp } from "../src/client/context.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store, useStoreState } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore } from "./timeline-harness.ts";

withDom();

const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const DAEMON: ProtocolVersion = { major: 2, minor: 1 };
const OLDER_MINOR: ProtocolVersion = { major: 2, minor: 0 };
const SKEW_TEXT =
  "このセッションの ccmsg の protocol は 2.0 で daemon は 2.1。リロードでは直らない。セッションを起動し直すと直る";

let roots: HTMLElement[] = [];
const restores: Array<() => void> = [];
const mounted = new Mounted();

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  await mounted.unmount();
  for (const restore of restores.splice(0).reverse()) restore();
});

function peer(sid: string, protocol: ProtocolVersion): PeerInfo {
  return {
    sid,
    repo: "owner/repo",
    ws: sid.slice(0, 4),
    cwd: `/w/${sid}`,
    ccmsg_version: "0.218.0",
    protocol,
  };
}

/** A session whose sidecar of another major is being refused. */
function stalePeer(sid: string): PeerInfo {
  return {
    ...peer(sid, DAEMON),
    stale_client: {
      last_seen: "2026-11-08T01:00:00.000Z",
      version: "0.217.1",
      protocol: { major: 1 },
    },
  };
}

/** What a connected tab learns of the daemon from its ping. */
function daemonSpeaks(store: Store, protocol: ProtocolVersion): void {
  store.dispatch({ type: "daemon-info/loaded", version: "0.219.0", protocol });
}

async function mountStatus(store: Store): Promise<HTMLElement> {
  const snapshot: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };
  const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => new Promise(() => {});
  const onKill = (): Promise<SessionKillResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, terminated: true });
  const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, pid: 4242, env: {} });
  const onAgentInput = (): Promise<UserMessageResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, outcome: "appended" });
  const onOverride = (): Promise<RequestOverrideResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, delivery: "applied" });
  function Host() {
    const restart = useSessionRestart(SID, onRestart);
    return h(StatusPanel, {
      snapshot,
      sid: SID,
      onKill,
      restart,
      onLoadEnv,
      onAgentInput,
      onOverride,
    });
  }
  return mountInto(store, h(Host, null));
}

async function mountInto(store: Store, node: ComponentChildren): Promise<HTMLElement> {
  const ws = createWsClient((action) => store.dispatch(action));
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(h(AppContext.Provider, { value: { store, ws } }, node), root));
  return root;
}

describe("a session's ccmsg of another protocol minor than the daemon", () => {
  test("its Sessions row carries a yellow mark, saying how to fix it on hover", async () => {
    const store = createStore(initialState());
    daemonSpeaks(store, DAEMON);
    const root = await mountInto(
      store,
      h(SessionList, { peers: [peer(SID, OLDER_MINOR), peer(OTHER, DAEMON)], currentSid: null }),
    );
    const rowOf = (sid: string) =>
      instanceOf(
        [...root.querySelectorAll("li.session-row")].find((row) =>
          row.querySelector(".session-line3")?.textContent?.startsWith(sid.slice(0, 8)),
        ),
        HTMLElement,
        `the row of ${sid}`,
      );
    const mark = rowOf(SID).querySelector(".session-protocol-skew");
    expect(mark?.textContent).toBe("△");
    expect(mark?.getAttribute("title")).toBe(SKEW_TEXT);
    expect(rowOf(SID).title).toContain(SKEW_TEXT);
    // The daemon's own version: no mark.
    expect(rowOf(OTHER).querySelector(".session-protocol-skew")).toBeNull();
  });

  test("no mark before the tab knows the daemon's version", async () => {
    const store = createStore(initialState());
    const root = await mountInto(
      store,
      h(SessionList, { peers: [peer(SID, OLDER_MINOR)], currentSid: null }),
    );
    expect(root.querySelector(".session-protocol-skew")).toBeNull();
  });

  test("the Status tab's CCMSG is yellow, with the reason as its hover text", async () => {
    const store = createStore(initialState());
    daemonSpeaks(store, DAEMON);
    store.dispatch({ type: "peers/loaded", peers: [peer(SID, OLDER_MINOR)] });
    const root = await mountStatus(store);
    const dt = [...root.querySelectorAll(".status-meta dt")].find((d) => d.textContent === "CCMSG");
    const dd = instanceOf(dt?.nextElementSibling, HTMLElement, "the CCMSG value");
    expect(dd.title).toBe(SKEW_TEXT);
    const skew = dd.querySelector(".status-protocol-skew");
    expect(skew?.textContent).toBe("△ v0.218.0 (protocol 2.0)");
  });

  test("the Timeline's ctx line draws its ccmsg in yellow, the reason first on hover", async () => {
    const restore = stubGlobal("navigation", { navigate() {} });
    try {
      const store = timelineStore();
      daemonSpeaks(store, DAEMON);
      store.dispatch({ type: "peers/loaded", peers: [peer(SID, OLDER_MINOR)] });
      const root = await mountTimeline(store);
      const part = [...root.querySelectorAll(".tl-status-mini-context .ctx-part")].find(
        (p) => p.textContent === "ccmsg v0.218.0",
      );
      const ccmsg = instanceOf(part, HTMLElement, "the ccmsg part");
      expect(ccmsg.classList.contains("ctx-part-warn")).toBe(true);
      expect(ccmsg.title.split("\n")[0]).toBe(SKEW_TEXT);
    } finally {
      restore();
    }
  });

  test("a refused (stale) client: the Status body is the mark and version only, the reason is the title", async () => {
    const store = createStore(initialState());
    daemonSpeaks(store, DAEMON);
    store.dispatch({ type: "peers/loaded", peers: [stalePeer(SID)] });
    const root = await mountStatus(store);
    const dt = [...root.querySelectorAll(".status-meta dt")].find((d) => d.textContent === "CCMSG");
    const dd = instanceOf(dt?.nextElementSibling, HTMLElement, "the CCMSG value");
    expect(dd.querySelector(".status-stale-client")?.textContent).toBe("⚠ v0.217.1 (protocol 1)");
    expect(dd.textContent).not.toContain("古い");
    expect(dd.title).toContain("ccmsg クライアントが古い");
    expect(dd.title).toContain("セッションを再起動してください");
  });

  test("a refused (stale) client: the ctx line's ccmsg is yellow with the stale version and reason", async () => {
    const restore = stubGlobal("navigation", { navigate() {} });
    try {
      const store = timelineStore();
      daemonSpeaks(store, DAEMON);
      store.dispatch({ type: "peers/loaded", peers: [stalePeer(SID)] });
      const root = await mountTimeline(store);
      const part = [...root.querySelectorAll(".tl-status-mini-context .ctx-part")].find(
        (p) => p.textContent === "ccmsg v0.217.1",
      );
      const ccmsg = instanceOf(part, HTMLElement, "the ccmsg part");
      expect(ccmsg.classList.contains("ctx-part-warn")).toBe(true);
      expect(ccmsg.title.split("\n")[0]).toContain("ccmsg クライアントが古い");
    } finally {
      restore();
    }
  });

  test("the ctx line's ccmsg is plain while the session speaks the daemon's version", async () => {
    const restore = stubGlobal("navigation", { navigate() {} });
    try {
      const store = timelineStore();
      daemonSpeaks(store, DAEMON);
      store.dispatch({ type: "peers/loaded", peers: [peer(SID, DAEMON)] });
      const root = await mountTimeline(store);
      expect(root.querySelector(".tl-status-mini-context .ctx-part-warn")).toBeNull();
      expect(root.querySelector(".tl-status-mini-context")?.textContent).toContain(
        "ccmsg v0.218.0",
      );
    } finally {
      restore();
    }
  });
});

const CTX: SessionStatusSnapshot = {
  todos: [],
  workflows: [],
  background: [],
  context: {
    tokens: 120_000,
    window: 1_000_000,
    model: "claude-fable-5-1",
    effort: "low",
    timestamp: "2026-10-25T00:00:00.000Z",
  },
};

function TimelineOf() {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: CTX,
    agent: null,
    active: true,
    visible: true,
  });
}

async function mountTimeline(store: Store): Promise<HTMLElement> {
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, null));
  const read = ws.reads.at(-1);
  if (read === undefined) throw new Error("expected the initial read");
  await read.answer(page([]));
  return root;
}

describe("the reload button", () => {
  async function reloadButton(
    mismatch: { daemonVersion: string; protocolChanged: boolean } | null,
  ): Promise<HTMLElement> {
    const store = createStore(initialState());
    store.dispatch({ type: "version-mismatch/detected", mismatch });
    restores.push(
      stubGlobal("navigation", {
        canGoBack: false,
        canGoForward: false,
        navigate() {},
        addEventListener() {},
        removeEventListener() {},
      }),
    );
    const root = await mountInto(store, h(App, null));
    return instanceOf(root.querySelector("#app-reload"), HTMLElement, "the reload button");
  }

  test("is red, asking for a reload, when the daemon speaks another protocol major", async () => {
    const button = await reloadButton({ daemonVersion: "0.220.0", protocolChanged: true });
    expect(button.className).toBe("app-reload-protocol");
    expect(button.title).toBe(
      "ccmsg の protocol が変わった。リロードしてください (daemon v0.220.0)",
    );
  });

  test("stays blue for another version of the same major", async () => {
    const button = await reloadButton({ daemonVersion: "0.220.0", protocolChanged: false });
    expect(button.className).toBe("app-reload-update");
  });

  test("has no colour of its own without a mismatch", async () => {
    const button = await reloadButton(null);
    expect(button.className).toBe("");
    expect(button.title).toBe("ページを再読み込み");
  });
});
