// The session override's pickers as mounted (DR-0041 §5): the ctx line's
// model and effort open them, a pick goes to the daemon as a patch of that
// field, and what became of it is said beside them. The Status tab's row
// shows the overrides as ev:"request_override" put them in the store, the
// same in every tab.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  ErrorResponse,
  SessionEnvResponse,
  SessionKillResponse,
  RequestOverridePatch,
  RequestOverrideResponse,
  RequestOverrideState,
  SessionRestartResponse,
  SessionStatusSnapshot,
  UserMessageResponse,
} from "@ccmsg/protocol";
import { ContextLine } from "../src/client/components/RequestOverridePicker.tsx";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { AppContext } from "../src/client/context.ts";
import { miniSummaryLines } from "../src/client/session-status-view.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";
import { SID } from "./timeline-harness.ts";

withDom();

let roots: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

type Patch = RequestOverridePatch;

const SNAPSHOT: SessionStatusSnapshot = {
  todos: [],
  workflows: [],
  background: [],
  context: {
    tokens: 1000,
    window: 1_000_000,
    model: "claude-opus-5-5[1m]",
    effort: "high",
    timestamp: "t",
  },
};

/** A change that records each patch and answers `reply`. */
function recorder(reply: RequestOverrideResponse | ErrorResponse) {
  const patches: Patch[] = [];
  return {
    patches,
    onChange: async (patch: Patch) => {
      patches.push(patch);
      return reply;
    },
  };
}

async function mountRoot(vnode: Parameters<typeof render>[0]): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(vnode, root));
  return root;
}

function selectOf(root: HTMLElement, field: "model" | "effort"): HTMLSelectElement {
  return instanceOf(
    root.querySelector(`select[aria-label="通しの上書き: ${field}"]`),
    HTMLSelectElement,
    `the session override's ${field}`,
  );
}

async function pick(root: HTMLElement, field: "model" | "effort", value: string): Promise<void> {
  const el = selectOf(root, field);
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("the ctx line's pickers", () => {
  const context = (() => {
    const line = miniSummaryLines(SNAPSHOT, [], {
      session: { model: "claude-opus-5-5[1m]", effort: "low" },
      once: { model: null, effort: null },
    }).find((l) => l.context !== undefined);
    if (line?.context === undefined) throw new Error("no ctx line");
    return line.context;
  })();

  test("the overridden effort is marked; its button opens the pickers on what the daemon holds", async () => {
    const { onChange } = recorder({ ok: true, delivery: "applied" });
    const root = await mountRoot(h(ContextLine, { context, value: { effort: "low" }, onChange }));
    const buttons = [...root.querySelectorAll("button.ctx-value")];
    expect(buttons.map((b) => b.textContent)).toEqual(["opus-5-5[1m]", "low⁺"]);
    expect(buttons[1]?.classList.contains("ctx-value-overridden")).toBe(true);
    expect(root.querySelector(".ctx-override-popover")).toBeNull();
    await act(() => instanceOf(buttons[1], HTMLButtonElement, "the effort").click());
    expect(selectOf(root, "effort").value).toBe("low");
    expect(selectOf(root, "model").value).toBe("");
  });

  test("a pick sends that field alone, none as null, and says when no module took it", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "no_module" });
    const root = await mountRoot(h(ContextLine, { context, value: { effort: "low" }, onChange }));
    await act(() =>
      instanceOf(root.querySelector("button.ctx-value"), HTMLButtonElement, "the model").click(),
    );
    await pick(root, "model", "sonnet");
    await pick(root, "effort", "");
    expect(patches).toEqual([{ model: "sonnet" }, { effort: null }]);
    expect(root.querySelector(".override-notice")?.textContent).toContain(
      "受け口 (hooks module) が無い",
    );
    // Escape closes the pickers.
    const popover = instanceOf(
      root.querySelector(".ctx-override-popover"),
      HTMLElement,
      "the pickers",
    );
    await act(() => {
      popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(root.querySelector(".ctx-override-popover")).toBeNull();
  });
});

describe("the Status tab's override row", () => {
  async function mountStatus(
    snapshot: SessionStatusSnapshot,
    onOverride: (p: Patch) => Promise<RequestOverrideResponse | ErrorResponse>,
    sessions: readonly ({ session_id: string } & RequestOverrideState)[],
  ) {
    const store = createStore(initialState());
    store.dispatch({ type: "request-overrides/loaded", sessions });
    const ws = createWsClient((action) => store.dispatch(action));
    const onKill = (): Promise<SessionKillResponse | ErrorResponse> =>
      Promise.resolve({ ok: true, terminated: true });
    const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
      Promise.resolve({ ok: true, pid: 1, env: {} });
    const onAgentInput = (): Promise<UserMessageResponse | ErrorResponse> =>
      Promise.resolve({ ok: true, outcome: "appended" });
    const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => new Promise(() => {});
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
    return mountRoot(h(AppContext.Provider, { value: { store, ws } }, h(Host, null)));
  }

  test("the session override's pickers and the one-shot in force, from the store", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "applied" });
    const root = await mountStatus(SNAPSHOT, onChange, [
      {
        session_id: SID,
        session: { model: "fable", effort: "high" },
        once: { model: null, effort: "max" },
      },
    ]);
    const row = instanceOf(root.querySelector(".status-override"), HTMLElement, "the override row");
    expect(selectOf(row, "model").value).toBe("fable");
    // The session's own effort is not an override.
    expect(selectOf(row, "effort").value).toBe("");
    expect(row.textContent).toContain("単発effort max");
    await pick(row, "model", "haiku");
    expect(patches).toEqual([{ model: "haiku" }]);
    expect(row.querySelector(".override-notice")).toBeNull();
  });
});
