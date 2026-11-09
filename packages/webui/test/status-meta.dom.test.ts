// The Status tab's identity table, mounted: TITLE is an input from the start
// and the place to rename the session (DR-0047 §4) — Enter sends the name with
// `session_rename`, Escape puts the shown name back, the note under the input
// says whether the name changes now or after the turn, and a session no hooks
// module speaks for gets a read-only input. Each copy button sits before the
// value it copies, and CONTEXT shows the usage alone.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  AgentInfo,
  ErrorResponse,
  ReplyOf,
  RequestOverrideResponse,
  SessionEnvResponse,
  SessionKillResponse,
  SessionRestartResponse,
  SessionStatusSnapshot,
  UserMessageResponse,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000005";
const SINCE = "2026-11-09T01:00:00.000Z";

const SNAPSHOT: SessionStatusSnapshot = {
  todos: [],
  workflows: [],
  background: [],
  context: { tokens: 56_000, window: 200_000, model: "claude-fable-5-1", timestamp: SINCE },
};

/** The session's agents row. `turn` present = a hooks module speaks for it. */
function agentRow(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    pid: 4242,
    cwd: "/w/repo",
    kind: "interactive",
    startedAt: Date.now(),
    sessionId: SID,
    config_dir: "/c",
    name: "最初の名前",
    hyoui_session_id: "hy-7",
    turn: { state: "idle", since: SINCE },
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

interface Mounted {
  root: HTMLElement;
  store: Store;
  /** Every `session_rename` the panel sent, as `[sid, title]`. */
  renames: Array<[string, string]>;
}

/** Mount the Status tab with `agent` as the session's agents row (none when
 * undefined). `reply` is what the daemon answers each `session_rename` with. */
async function mountStatus(
  agent: AgentInfo | undefined,
  reply: (title: string) => ReplyOf<"session_rename"> = (title) => ({
    ok: true,
    title,
    outcome: "renamed",
  }),
): Promise<Mounted> {
  const store = createStore(initialState());
  if (agent) store.dispatch({ type: "agents/loaded", agents: [agent] });
  const renames: Array<[string, string]> = [];
  const ws = {
    ...createWsClient((action) => store.dispatch(action)),
    sessionRename: (sid: string, title: string): Promise<ReplyOf<"session_rename">> => {
      renames.push([sid, title]);
      return Promise.resolve(reply(title));
    },
  };
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
      snapshot: SNAPSHOT,
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
  return { root, store, renames };
}

/** The `<dd>` the identity table puts under `term`. */
function metaCell(root: HTMLElement, term: string): HTMLElement {
  const dt = [...root.querySelectorAll(".status-meta dt")].find((d) => d.textContent === term);
  return instanceOf(dt?.nextElementSibling, HTMLElement, `the ${term} value`);
}

function titleInput(root: HTMLElement): HTMLInputElement {
  return instanceOf(
    metaCell(root, "TITLE").querySelector("input"),
    HTMLInputElement,
    "the TITLE input",
  );
}

function titleNote(root: HTMLElement): string | null {
  return metaCell(root, "TITLE").querySelector(".status-title-note")?.textContent ?? null;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Press `key` in the input and let a send it starts settle inside the same
 * `act`, so the note's timer is set while act still owns the effects. The
 * stubbed `sessionRename` answers with an already-resolved promise, so the
 * panel's continuation after it is queued before the one awaited here. */
async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("Status tab TITLE input", () => {
  test("starts as an input holding the session's name", async () => {
    const { root } = await mountStatus(agentRow());
    const input = titleInput(root);
    expect(input.value).toBe("最初の名前");
    expect(input.readOnly).toBe(false);
  });

  test("Enter sends the trimmed name for this session and notes the rename", async () => {
    const { root, renames } = await mountStatus(agentRow());
    const input = titleInput(root);
    await type(input, "  新しい名前 ");
    await press(input, "Enter");
    expect(renames).toEqual([[SID, "新しい名前"]]);
    expect(titleNote(root)).toBe("名前を変更: 新しい名前");
  });

  test("a rename queued behind the turn says it changes after the response", async () => {
    const { root } = await mountStatus(agentRow(), (title) => ({
      ok: true,
      title,
      outcome: "queued",
    }));
    const input = titleInput(root);
    await type(input, "後の名前");
    await press(input, "Enter");
    expect(titleNote(root)).toBe("応答の後に名前を変更: 後の名前");
  });

  test("the note clears itself after six seconds", async () => {
    jest.useFakeTimers();
    try {
      const { root } = await mountStatus(agentRow());
      const input = titleInput(root);
      await type(input, "新しい名前");
      await press(input, "Enter");
      expect(titleNote(root)).toBe("名前を変更: 新しい名前");
      await act(() => {
        jest.advanceTimersByTime(5_999);
      });
      expect(titleNote(root)).toBe("名前を変更: 新しい名前");
      await act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(titleNote(root)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a refused rename keeps the draft and shows the daemon's message", async () => {
    const { root } = await mountStatus(agentRow(), () => ({
      ok: false,
      error: { code: "rename_failed", msg: "名前を変えられなかった" },
    }));
    const input = titleInput(root);
    await type(input, "通らない名前");
    await press(input, "Enter");
    expect(input.value).toBe("通らない名前");
    expect(titleNote(root)).toBe("名前を変えられなかった");
    expect(metaCell(root, "TITLE").querySelector(".status-title-error")).not.toBeNull();
  });

  test("Escape puts the shown name back without sending", async () => {
    const { root, renames } = await mountStatus(agentRow());
    const input = titleInput(root);
    await type(input, "やめる名前");
    await press(input, "Escape");
    expect(input.value).toBe("最初の名前");
    expect(renames).toEqual([]);
  });

  test("an empty or unchanged name is not sent", async () => {
    const { root, renames } = await mountStatus(agentRow());
    const input = titleInput(root);
    await type(input, "   ");
    await press(input, "Enter");
    await type(input, "最初の名前");
    await press(input, "Enter");
    expect(renames).toEqual([]);
    expect(input.value).toBe("最初の名前");
  });

  test("follows the agents rows' name, but not while being edited", async () => {
    const { root, store } = await mountStatus(agentRow());
    const input = titleInput(root);
    await act(() =>
      store.dispatch({ type: "agents/loaded", agents: [agentRow({ name: "二番目" })] }),
    );
    expect(input.value).toBe("二番目");

    await type(input, "書きかけ");
    await act(() =>
      store.dispatch({ type: "agents/loaded", agents: [agentRow({ name: "三番目" })] }),
    );
    expect(input.value).toBe("書きかけ");

    await press(input, "Escape");
    expect(input.value).toBe("三番目");
  });

  test("is read-only for a session no hooks module speaks for", async () => {
    const { root, renames } = await mountStatus(agentRow({ turn: undefined }));
    const input = titleInput(root);
    expect(input.readOnly).toBe(true);
    await press(input, "Enter");
    expect(renames).toEqual([]);
  });

  test("is read-only without the session's agents row", async () => {
    const { root } = await mountStatus(undefined);
    expect(titleInput(root).readOnly).toBe(true);
  });
});

describe("Status tab copy buttons", () => {
  test("sit before the value they copy", async () => {
    const { root } = await mountStatus(agentRow());
    for (const term of ["TITLE", "CWD", "SESSION_ID", "PID", "HYOUI_SESSION_ID"]) {
      const cell = metaCell(root, term);
      const first = cell.firstElementChild;
      expect(first?.tagName).toBe("BUTTON");
      expect(first?.getAttribute("aria-label")).toBe(`${term} をコピー`);
      expect(cell.querySelectorAll("button.status-meta-copy")).toHaveLength(1);
    }
  });
});

describe("Status tab CONTEXT row", () => {
  test("is labelled CONTEXT and shows the usage with no note after it", async () => {
    const { root } = await mountStatus(agentRow());
    const labels = [...root.querySelectorAll(".status-meta dt")].map((d) => d.textContent);
    expect(labels).toContain("CONTEXT");
    expect(labels).not.toContain("CTX");
    const cell = metaCell(root, "CONTEXT");
    expect(cell.textContent).toBe("28% / fable-5-1[200K]");
    expect(cell.children).toHaveLength(0);
    expect(root.textContent).not.toContain("上限は推定");
  });
});
