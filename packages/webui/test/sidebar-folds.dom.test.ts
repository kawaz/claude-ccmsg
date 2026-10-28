// The sidebar as a column of folds (DR-0043), mounted: it starts with only
// SESSIONS open and starts there again on every load (nothing is kept), the
// buttons on SESSIONS' heading never open or close it because they sit beside
// the toggle rather than inside it, ROOMS fetches its list on the first open,
// and GLOBALS carries the endpoint, the daemon's version (which the Status tab
// no longer repeats) and the host's Claude Code version.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  AgentInfo,
  ErrorResponse,
  ReplyOf,
  SessionEnvResponse,
  SessionKillResponse,
  SessionRestartResponse,
  UserMessageResponse,
  RequestOverrideResponse,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { Sidebar } from "../src/client/components/Sidebar.tsx";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf, stubProperty } from "./helpers.ts";

withDom();

const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const FOLDS = ["sidebar-sessions", "sidebar-rooms", "sidebar-globals"] as const;

let roots: HTMLElement[] = [];
let restores: (() => void)[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  for (const restore of restores) restore();
  restores = [];
});

/** What the mounted sidebar asked the daemon and the navigation for. */
interface Calls {
  rooms: number;
  peers: number;
  navigations: string[];
  assigned: string[];
}

function agentRow(startedAt: number, version?: string): AgentInfo {
  return {
    pid: 1,
    cwd: "/w",
    kind: "interactive",
    startedAt,
    sessionId: SID,
    config_dir: "/c",
    ...(version !== undefined ? { version } : {}),
  };
}

async function mountSidebar(
  prepare: (store: Store) => void = () => {},
): Promise<{ root: HTMLElement; calls: Calls }> {
  const calls: Calls = { rooms: 0, peers: 0, navigations: [], assigned: [] };
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: true });
  prepare(store);
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    rooms: (): Promise<ReplyOf<"rooms">> => {
      calls.rooms++;
      return Promise.resolve({ ok: true, rooms: [] });
    },
    peers: (): Promise<ReplyOf<"peers">> => {
      calls.peers++;
      return Promise.resolve({ ok: true, peers: [] });
    },
  };
  // The panel toggles navigate (the URL is their state); the endpoint moves
  // the page. Neither is the fold's business, so both are only recorded.
  restores.push(
    stubProperty(window, "navigation", {
      value: { navigate: (url: string) => calls.navigations.push(url) },
      configurable: true,
    }),
    stubProperty(location, "assign", {
      value: (url: string) => calls.assigned.push(url),
      configurable: true,
    }),
  );
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(h(AppContext.Provider, { value: { store, ws } }, h(Sidebar, null)), root));
  return { root, calls };
}

function toggleOf(root: HTMLElement, fold: string): HTMLButtonElement {
  return instanceOf(
    root.querySelector(`#${fold} > .sidebar-fold-head > h2 > button.sidebar-fold-toggle`),
    HTMLButtonElement,
    `the toggle of ${fold}`,
  );
}

function bodyOf(root: HTMLElement, fold: string): HTMLElement {
  return instanceOf(
    root.querySelector(`#${fold} > .sidebar-fold-body`),
    HTMLElement,
    `the body of ${fold}`,
  );
}

/** Which folds read open, both in what the toggle says and in what the body
 * shows — the two must never disagree. */
function openFolds(root: HTMLElement): string[] {
  return FOLDS.filter((fold) => {
    const expanded = toggleOf(root, fold).getAttribute("aria-expanded") === "true";
    const shown = !bodyOf(root, fold).hasAttribute("hidden");
    expect(shown).toBe(expanded);
    return expanded;
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(() => {
    el.click();
  });
}

describe("the sidebar's folds", () => {
  test("start with only SESSIONS open, GLOBALS last in the column", async () => {
    const { root } = await mountSidebar();
    expect(openFolds(root)).toEqual(["sidebar-sessions"]);
    const column = defined(root.querySelector("#sidebar-lists"), "the column of folds");
    expect([...column.children].map((child) => child.id)).toEqual([...FOLDS]);
  });

  test("are a heading button naming a region it labels", async () => {
    const { root } = await mountSidebar();
    for (const fold of FOLDS) {
      const toggle = toggleOf(root, fold);
      const body = bodyOf(root, fold);
      expect(toggle.getAttribute("aria-controls")).toBe(body.id);
      expect(body.getAttribute("role")).toBe("region");
      expect(body.getAttribute("aria-labelledby")).toBe(toggle.id);
    }
    expect(toggleOf(root, "sidebar-sessions").textContent).toBe("Sessions");
    expect(toggleOf(root, "sidebar-rooms").textContent).toBe("Rooms (読み取り専用)");
    expect(toggleOf(root, "sidebar-globals").textContent).toBe("Globals");
  });

  test("open and close on their own, several at once", async () => {
    const { root } = await mountSidebar();
    await click(toggleOf(root, "sidebar-globals"));
    expect(openFolds(root)).toEqual(["sidebar-sessions", "sidebar-globals"]);
    await click(toggleOf(root, "sidebar-sessions"));
    expect(openFolds(root)).toEqual(["sidebar-globals"]);
    await click(toggleOf(root, "sidebar-rooms"));
    expect(openFolds(root)).toEqual(["sidebar-rooms", "sidebar-globals"]);
  });

  // Nothing is kept: a reload starts from the first view whatever was left.
  test("start from the first view again on the next mount", async () => {
    const first = await mountSidebar();
    await click(toggleOf(first.root, "sidebar-sessions"));
    await click(toggleOf(first.root, "sidebar-globals"));
    expect(openFolds(first.root)).toEqual(["sidebar-globals"]);
    const second = await mountSidebar();
    expect(openFolds(second.root)).toEqual(["sidebar-sessions"]);
  });

  test("the buttons on SESSIONS' heading leave every fold as it was", async () => {
    const { root, calls } = await mountSidebar();
    const tools = defined(
      root.querySelector("#sidebar-sessions > .sidebar-fold-head > .sidebar-fold-tools"),
      "SESSIONS' tools",
    );
    const buttons = [...tools.querySelectorAll("button")];
    expect(buttons.map((b) => b.id)).toEqual([
      "session-creator-toggle",
      "session-search-toggle",
      "peers-sort",
      "peers-refresh",
    ]);
    for (const button of buttons) {
      await click(button);
      expect(openFolds(root)).toEqual(["sidebar-sessions"]);
    }
    // and each did its own job.
    expect(calls.navigations).toHaveLength(2);
    expect(calls.peers).toBe(1);
  });

  // The tools are the toggle's siblings: no interactive element inside
  // another, and nothing to stop a click on the way to the toggle.
  test("the toggle holds no button, link or field, and the tools are not inside it", async () => {
    const { root } = await mountSidebar();
    for (const fold of FOLDS) {
      const toggle = toggleOf(root, fold);
      expect(toggle.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    }
    const tools = defined(root.querySelector(".sidebar-fold-tools"), "SESSIONS' tools");
    expect(toggleOf(root, "sidebar-sessions").contains(tools)).toBe(false);
    expect(tools.parentElement?.className).toBe("sidebar-fold-head");
  });

  test("ROOMS fetches its list on the first open only", async () => {
    const { root, calls } = await mountSidebar();
    expect(calls.rooms).toBe(0);
    await click(toggleOf(root, "sidebar-rooms"));
    expect(calls.rooms).toBe(1);
    await click(toggleOf(root, "sidebar-rooms"));
    await click(toggleOf(root, "sidebar-rooms"));
    expect(calls.rooms).toBe(1);
  });

  // Find-in-page opens a closed body by itself and fires beforematch first;
  // the fold has to read open from then on, so closing it hides it again.
  test("a find-in-page match opens the fold it is in", async () => {
    const { root } = await mountSidebar();
    const body = bodyOf(root, "sidebar-globals");
    await act(() => {
      body.removeAttribute("hidden");
      body.dispatchEvent(new Event("beforematch"));
    });
    expect(openFolds(root)).toEqual(["sidebar-sessions", "sidebar-globals"]);
    await click(toggleOf(root, "sidebar-globals"));
    expect(openFolds(root)).toEqual(["sidebar-sessions"]);
  });
});

describe("GLOBALS", () => {
  function rows(root: HTMLElement): string[] {
    return [...root.querySelectorAll("#sidebar-globals .sidebar-globals-row")].map(
      (row) => row.textContent ?? "",
    );
  }

  test("the daemon's version, and the Claude Code version of the session started last", async () => {
    const { root } = await mountSidebar((store) => {
      store.dispatch({ type: "daemon-info/loaded", version: "0.200.0" });
      store.dispatch({
        type: "agents/loaded",
        agents: [agentRow(300, "2.1.312"), agentRow(100, "2.1.400"), agentRow(400)],
      });
    });
    expect(rows(root).slice(1)).toEqual(["daemon v0.200.0", "claude v2.1.312"]);
  });

  test("a dash for a version nothing has told yet", async () => {
    const { root } = await mountSidebar();
    expect(rows(root).slice(1)).toEqual(["daemon —", "claude —"]);
  });

  test("the endpoint is plain text when there is nowhere else to go", async () => {
    const { root } = await mountSidebar((store) => {
      store.dispatch({ type: "daemon-info/loaded", version: "0.200.0", webuiUrls: [] });
    });
    expect(root.querySelector("#sidebar-globals select")).toBeNull();
    // The test page is at http://, so the scheme is written out.
    expect(rows(root)[0]).toBe(`endpoint: http://${location.host}`);
  });

  test("the endpoint offers the daemon's origins and moves the page to the one chosen", async () => {
    const { root, calls } = await mountSidebar((store) => {
      store.dispatch({
        type: "daemon-info/loaded",
        version: "0.200.0",
        webuiUrls: ["https://ccmsg.a.example.com", "https://ccmsg.v6.example.com"],
      });
    });
    const select = instanceOf(
      root.querySelector("#sidebar-globals select"),
      HTMLSelectElement,
      "the endpoint choice",
    );
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      [location.origin, `http://${location.host}`],
      ["https://ccmsg.a.example.com", "ccmsg.a.example.com"],
      ["https://ccmsg.v6.example.com", "ccmsg.v6.example.com"],
    ]);
    expect(select.value).toBe(location.origin);
    // Choosing where the page already is goes nowhere.
    await act(() => {
      select.dispatchEvent(new Event("change"));
    });
    expect(calls.assigned).toEqual([]);
    await act(() => {
      select.value = "https://ccmsg.v6.example.com";
      select.dispatchEvent(new Event("change"));
    });
    expect(calls.assigned).toEqual([
      `https://ccmsg.v6.example.com${location.pathname}${location.search}${location.hash}`,
    ]);
  });
});

describe("the Status tab", () => {
  // The daemon's version moved to GLOBALS; the Status tab holds only what
  // belongs to the session.
  test("no longer shows the daemon's version", async () => {
    const store = createStore(initialState());
    store.dispatch({ type: "daemon-info/loaded", version: "0.200.0" });
    const ws = createWsClient((action) => store.dispatch(action));
    const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => new Promise(() => {});
    const onKill = (): Promise<SessionKillResponse | ErrorResponse> =>
      Promise.resolve({ ok: true, terminated: true });
    const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
      Promise.resolve({ ok: true, pid: 1, env: {} });
    const onAgentInput = (): Promise<UserMessageResponse | ErrorResponse> =>
      Promise.resolve({ ok: true, outcome: "appended" });
    const onOverride = (): Promise<RequestOverrideResponse | ErrorResponse> =>
      Promise.resolve({ ok: true, delivery: "applied" });
    function Host() {
      const restart = useSessionRestart(SID, onRestart);
      return h(StatusPanel, {
        snapshot: { todos: [], workflows: [], background: [] },
        sid: SID,
        onKill,
        restart,
        onLoadEnv,
        onAgentInput,
        onOverride,
      });
    }
    const root = document.createElement("div");
    document.body.append(root);
    roots.push(root);
    await act(() => render(h(AppContext.Provider, { value: { store, ws } }, h(Host, null)), root));
    expect(root.textContent).not.toContain("0.200.0");
    expect(root.textContent).not.toContain("daemon v");
  });
});
