// The session override's editor as mounted (DR-0041 §6.4): the ctx line's
// model and effort open it, the Status tab's row holds the same one. Each
// field is a select of the default and the session group; [適用], shown
// only while another option is chosen, sends that field's patch, and what
// became of it is said beside it. The values come from the store, which
// ev:"request_override" fills, the same in every tab.
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
    model: "claude-opus-5-5",
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

/** A select's groups as their labels and their options' labels. */
function groupsOf(select: HTMLSelectElement): (string | string[])[][] {
  return [...select.querySelectorAll("optgroup")].map((group) => [
    group.label,
    [...group.querySelectorAll("option")].map((option) => option.textContent ?? ""),
  ]);
}

/** What the closed select shows: its selected option's label. */
function collapsed(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.textContent ?? "";
}

/** The [適用] of a field, or null when none is shown. */
function applyOf(root: HTMLElement, field: "model" | "effort"): HTMLButtonElement | null {
  const button = selectOf(root, field).parentElement?.querySelector("button.override-apply");
  return button === null || button === undefined
    ? null
    : instanceOf(button, HTMLButtonElement, "the [適用]");
}

async function choose(root: HTMLElement, field: "model" | "effort", label: string): Promise<void> {
  const el = selectOf(root, field);
  const option = [...el.options].find((o) => o.textContent === label);
  if (option === undefined) throw new Error(`no option ${label}`);
  await act(() => {
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function apply(root: HTMLElement, field: "model" | "effort"): Promise<void> {
  const button = applyOf(root, field);
  if (button === null) throw new Error(`no [適用] for ${field}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

/** The session override in force: effort low over the session's own high. */
const LOW: RequestOverrideState = {
  session: { model: "claude-opus-5-5[1m]", effort: "low" },
  once: { model: null, effort: null },
};

describe("the ctx line's editor", () => {
  const context = (() => {
    const line = miniSummaryLines(SNAPSHOT, [], LOW).find((l) => l.context !== undefined);
    if (line?.context === undefined) throw new Error("no ctx line");
    return line.context;
  })();
  const own = SNAPSHOT.context;

  test("the overridden effort is marked; its button opens the selects of the session group, at the default", async () => {
    const { onChange } = recorder({ ok: true, delivery: "applied" });
    const root = await mountRoot(h(ContextLine, { context, state: LOW, own, onChange }));
    const buttons = [...root.querySelectorAll("button.ctx-value")];
    expect(buttons.map((b) => b.textContent)).toEqual(["opus-5-5", "low⁺"]);
    expect(buttons[1]?.classList.contains("ctx-value-overridden")).toBe(true);
    expect(root.querySelector(".ctx-override-popover")).toBeNull();
    await act(() => instanceOf(buttons[1], HTMLButtonElement, "the effort").click());
    // The effort first, then the model; each the default and the session
    // group, the session's own value 🏛️ in place of its 📌.
    expect([...root.querySelectorAll("select")]).toEqual([
      selectOf(root, "effort"),
      selectOf(root, "model"),
    ]);
    expect(groupsOf(selectOf(root, "effort"))).toEqual([
      ["default", ["📌low"]],
      ["session", ["📌low", "📌medium", "🏛️high", "📌xhigh", "📌max"]],
    ]);
    expect(groupsOf(selectOf(root, "model"))).toEqual([
      ["default", ["opus-5-5"]],
      ["session", ["📌fable", "🏛️opus", "📌sonnet", "📌haiku"]],
    ]);
    expect(collapsed(selectOf(root, "effort"))).toBe("📌low");
    expect([applyOf(root, "effort"), applyOf(root, "model")]).toEqual([null, null]);
  });

  test("[適用] only while an option other than the default is chosen; it sends that field alone", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "applied" });
    const root = await mountRoot(h(ContextLine, { context, state: LOW, own, onChange }));
    await act(() =>
      instanceOf(root.querySelector("button.ctx-value"), HTMLButtonElement, "the model").click(),
    );
    await choose(root, "model", "📌sonnet");
    expect(applyOf(root, "model")).not.toBeNull();
    expect(applyOf(root, "effort")).toBeNull();
    // Back to the default: nothing to apply.
    await choose(root, "model", "opus-5-5");
    expect(applyOf(root, "model")).toBeNull();
    await choose(root, "model", "📌sonnet");
    await apply(root, "model");
    expect(patches).toEqual([{ model: "sonnet" }]);
    // Applied, the select is at the default again, nothing said.
    expect(collapsed(selectOf(root, "model"))).toBe("opus-5-5");
    expect(applyOf(root, "model")).toBeNull();
    expect(root.querySelector(".override-notice")).toBeNull();
    // Escape closes the editor.
    const popover = instanceOf(
      root.querySelector(".ctx-override-popover"),
      HTMLElement,
      "the editor",
    );
    await act(() => {
      popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(root.querySelector(".ctx-override-popover")).toBeNull();
  });

  // §6.5: 🏛️ clears the field's session and one-shot overrides, as null.
  // With no override at all, it is offered and sent all the same.
  test("🏛️ sends null; with no override too", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "applied" });
    const root = await mountRoot(h(ContextLine, { context, state: LOW, own, onChange }));
    await act(() =>
      instanceOf(root.querySelector("button.ctx-value"), HTMLButtonElement, "the model").click(),
    );
    await choose(root, "effort", "🏛️high");
    await apply(root, "effort");
    await choose(root, "model", "🏛️opus");
    await apply(root, "model");
    expect(patches).toEqual([{ effort: null }, { model: null }]);
  });

  test("a reply other than applied is said beside the select; one that failed keeps the choice", async () => {
    const noModule = recorder({ ok: true, delivery: "no_module" });
    const root = await mountRoot(
      h(ContextLine, { context, state: LOW, own, onChange: noModule.onChange }),
    );
    await act(() =>
      instanceOf(root.querySelector("button.ctx-value"), HTMLButtonElement, "the model").click(),
    );
    await choose(root, "effort", "📌max");
    await apply(root, "effort");
    expect(root.querySelector(".override-notice")?.textContent).toContain(
      "受け口 (hooks module) が無い",
    );
    // The daemon holds it: the select is back at the default.
    expect(collapsed(selectOf(root, "effort"))).toBe("📌low");

    const refused = recorder({ ok: false, error: { code: "invalid_args", msg: "effort: x" } });
    const other = await mountRoot(
      h(ContextLine, { context, state: LOW, own, onChange: refused.onChange }),
    );
    await act(() =>
      instanceOf(other.querySelector("button.ctx-value"), HTMLButtonElement, "the model").click(),
    );
    await choose(other, "effort", "📌max");
    await apply(other, "effort");
    expect(other.querySelector(".override-notice")?.textContent).toBe(
      "変更できなかった (invalid_args): effort: x",
    );
    expect(collapsed(selectOf(other, "effort"))).toBe("📌max");
    expect(applyOf(other, "effort")).not.toBeNull();
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
    return {
      store,
      root: await mountRoot(h(AppContext.Provider, { value: { store, ws } }, h(Host, null))),
    };
  }

  test("the same editor, from the store: the one-shot in force shows in the default", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "applied" });
    const { store, root } = await mountStatus(SNAPSHOT, onChange, [
      {
        session_id: SID,
        session: { model: "fable", effort: "high" },
        once: { model: null, effort: "max" },
      },
    ]);
    const row = instanceOf(root.querySelector(".status-override"), HTMLElement, "the override row");
    expect(collapsed(selectOf(row, "model"))).toBe("📌fable");
    expect(collapsed(selectOf(row, "effort"))).toBe("⏱️max");
    expect(row.textContent).not.toContain("単発");
    expect(groupsOf(selectOf(row, "effort")).map(([label]) => label)).toEqual([
      "default",
      "session",
    ]);
    await choose(row, "model", "📌haiku");
    await apply(row, "model");
    expect(patches).toEqual([{ model: "haiku" }]);
    expect(row.querySelector(".override-notice")).toBeNull();
    // The one-shot ending with its turn (ev:"request_override") redraws the
    // default.
    await act(() =>
      store.dispatch({
        type: "request-overrides/changed",
        sid: SID,
        target: "once",
        values: { model: null, effort: null },
      }),
    );
    expect(collapsed(selectOf(row, "effort"))).toBe("high");
  });
});
