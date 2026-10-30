// The session override's fields as mounted (DR-0041 §5, §6.4): the ctx
// line's model and effort turn into them in place, the Status tab's row holds
// both. Each field is a select of the default and the session group;
// [適用], shown only while another option is chosen, sends that field's
// patch, and what became of it is said beside it. The values come from the store, which
// ev:"request_override" fills, the same in every tab.
import { afterEach, describe, expect, jest, test } from "bun:test";
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
import {
  ContextLine,
  CTX_LINE_NOTICE_MS,
} from "../src/client/components/RequestOverridePicker.tsx";
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
    engine: { model: "claude-opus-5-5[1m]", effort: "high" },
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

type Field = "model" | "effort";

/** A field's value at rest: the text that opens its select. */
function textOf(root: HTMLElement, field: Field): HTMLButtonElement {
  return instanceOf(
    root.querySelector(`button.override-value[aria-label="通しの上書き: ${field}"]`),
    HTMLButtonElement,
    `the session override's ${field} at rest`,
  );
}

/** A field's select, drawn while it is open. */
function selectOf(root: HTMLElement, field: Field): HTMLSelectElement {
  return instanceOf(
    root.querySelector(`select[aria-label="通しの上書き: ${field}"]`),
    HTMLSelectElement,
    `the session override's ${field} select`,
  );
}

/** Press a field's text: its select is drawn in its place. */
async function press(root: HTMLElement, field: Field): Promise<HTMLSelectElement> {
  const text = textOf(root, field);
  await act(() => text.click());
  return selectOf(root, field);
}

/** A select's groups as their labels and their options' labels. */
function groupsOf(select: HTMLSelectElement): (string | string[])[][] {
  return [...select.querySelectorAll("optgroup")].map((group) => [
    group.label,
    [...group.querySelectorAll("option")].map((option) => option.textContent ?? ""),
  ]);
}

async function escape(el: HTMLElement): Promise<void> {
  await act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

/** Choose the option labelled `label` of a field, opening its select first
 * when it is at rest. */
async function choose(root: HTMLElement, field: Field, label: string): Promise<void> {
  const open = root.querySelector(`select[aria-label="通しの上書き: ${field}"]`);
  const el = open instanceof HTMLSelectElement ? open : await press(root, field);
  const option = [...el.options].find((o) => o.textContent === label);
  if (option === undefined) throw new Error(`no option ${label}`);
  await act(() => {
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The [適用] of a field, or null when none is shown. */
function applyOf(root: HTMLElement, field: Field): HTMLButtonElement | null {
  const button = textOf(root, field).parentElement?.querySelector("button.override-apply");
  return button === null || button === undefined
    ? null
    : instanceOf(button, HTMLButtonElement, "the [適用]");
}

async function apply(root: HTMLElement, field: Field): Promise<void> {
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

describe("the ctx line's fields", () => {
  const line = (() => {
    const found = miniSummaryLines(SNAPSHOT, [], LOW).find((l) => l.context !== undefined);
    if (found?.context === undefined) throw new Error("no ctx line");
    return found.context;
  })();
  const context = SNAPSHOT.context;

  async function mountLine(
    onChange: (p: Patch) => Promise<RequestOverrideResponse | ErrorResponse>,
  ) {
    return mountRoot(h(ContextLine, { line, state: LOW, context, onChange }));
  }
  /** A field of the line: the model's comes first, then the effort's. */
  const fieldOf = (root: HTMLElement, field: Field) =>
    instanceOf(
      root.querySelectorAll(".tl-status-mini-context > .override-field")[field === "model" ? 0 : 1],
      HTMLElement,
      `the ctx line's ${field}`,
    );
  /** A field's value at rest as the line shows it. */
  const ctxValue = (root: HTMLElement, field: Field) =>
    instanceOf(
      fieldOf(root, field).querySelector("button.ctx-value"),
      HTMLButtonElement,
      `the ctx line's ${field} at rest`,
    );
  const ctxApply = (root: HTMLElement, field: Field) =>
    fieldOf(root, field).querySelector("button.override-apply");
  async function pressValue(root: HTMLElement, field: Field): Promise<HTMLSelectElement> {
    const value = ctxValue(root, field);
    await act(() => value.click());
    return selectOf(root, field);
  }
  async function applyField(root: HTMLElement, field: Field): Promise<void> {
    const button = instanceOf(ctxApply(root, field), HTMLButtonElement, "the [適用]");
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }

  test("the overridden effort is marked; pressing it turns it into its select in place, no row of its own", async () => {
    const { onChange } = recorder({ ok: true, delivery: "applied" });
    const root = await mountLine(onChange);
    const buttons = [...root.querySelectorAll("button.ctx-value")];
    expect(buttons.map((b) => b.textContent)).toEqual(["opus-5-5", "low⁺"]);
    expect(buttons[1]?.classList.contains("ctx-value-overridden")).toBe(true);
    const effort = await pressValue(root, "effort");
    // The select is where the effort was, in the line; nothing else opened.
    expect(fieldOf(root, "effort").contains(effort)).toBe(true);
    expect(document.activeElement).toBe(effort);
    expect(root.querySelectorAll("select")).toHaveLength(1);
    expect(root.querySelector('[role="dialog"], .override-editor')).toBeNull();
    expect(root.querySelector('button[aria-label="閉じる"]')).toBeNull();
    expect(root.children).toHaveLength(1);
    // The model stays the line's own text.
    expect(ctxValue(root, "model").textContent).toBe("opus-5-5");
    // The default and the session group, the session's own value 🏛️ in
    // place of its 📌.
    expect(groupsOf(effort)).toEqual([
      ["default", ["📌low"]],
      ["session", ["📌low", "📌medium", "🏛️high", "📌xhigh", "📌max"]],
    ]);
    // Pressing the model moves the focus there: the effort goes back to the
    // line's text.
    const model = await pressValue(root, "model");
    expect(ctxValue(root, "effort").textContent).toBe("low⁺");
    expect(groupsOf(model)).toEqual([
      ["default", ["opus-5-5[1m]"]],
      ["session", ["📌fable", "🏛️opus", "📌sonnet", "📌haiku"]],
    ]);
    expect(root.querySelectorAll("button.override-apply")).toHaveLength(0);
  });

  test("Escape and blur take the select back to the line's text", async () => {
    const { onChange } = recorder({ ok: true, delivery: "applied" });
    const root = await mountLine(onChange);
    const model = await pressValue(root, "model");
    expect(document.activeElement).toBe(model);
    // Escape: the text takes the focus.
    await escape(model);
    expect(root.querySelector("select")).toBeNull();
    expect(document.activeElement).toBe(ctxValue(root, "model"));
    // The focus going elsewhere: back to the text, which does not take it.
    const effort = await pressValue(root, "effort");
    expect(document.activeElement).toBe(effort);
    const elsewhere = ctxValue(root, "model");
    await act(() => elsewhere.focus());
    expect(document.activeElement).toBe(elsewhere);
    expect(root.querySelector("select")).toBeNull();
    expect(ctxValue(root, "effort").textContent).toBe("low⁺");
  });

  test("[適用] only while an option other than the default is chosen; it sends that field alone", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "applied" });
    const root = await mountLine(onChange);
    await pressValue(root, "model");
    await choose(root, "model", "📌sonnet");
    // Chosen: the select is text again, the chosen value with [適用].
    expect(textOf(root, "model").textContent).toBe("📌sonnet");
    expect(ctxApply(root, "model")).not.toBeNull();
    expect(ctxApply(root, "effort")).toBeNull();
    // Back to the default: nothing to apply, the line's text again.
    await choose(root, "model", "opus-5-5[1m]");
    expect(ctxApply(root, "model")).toBeNull();
    expect(ctxValue(root, "model").textContent).toBe("opus-5-5");
    await pressValue(root, "model");
    await choose(root, "model", "📌sonnet");
    await applyField(root, "model");
    expect(patches).toEqual([{ model: "sonnet" }]);
    // Applied, the field is at the default again, nothing said.
    expect(ctxValue(root, "model").textContent).toBe("opus-5-5");
    expect(ctxApply(root, "model")).toBeNull();
    expect(root.querySelector(".override-notice")).toBeNull();
  });

  // §6.5: 🏛️ clears the field's session and one-shot overrides, as null.
  // With no override at all, it is offered and sent all the same.
  test("🏛️ sends null; with no override too", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "applied" });
    const root = await mountLine(onChange);
    await pressValue(root, "effort");
    await choose(root, "effort", "🏛️high");
    await applyField(root, "effort");
    await pressValue(root, "model");
    await choose(root, "model", "🏛️opus");
    await applyField(root, "model");
    expect(patches).toEqual([{ effort: null }, { model: null }]);
  });

  test("a reply other than applied is said beside the field; one that failed keeps the choice", async () => {
    const noModule = recorder({ ok: true, delivery: "no_module" });
    const root = await mountLine(noModule.onChange);
    await pressValue(root, "effort");
    await choose(root, "effort", "📌max");
    await applyField(root, "effort");
    expect(fieldOf(root, "effort").querySelector(".override-notice")?.textContent).toContain(
      "受け口 (hooks module) が無い",
    );
    // The daemon holds it: the field is back at the default.
    expect(ctxValue(root, "effort").textContent).toBe("low⁺");

    const refused = recorder({ ok: false, error: { code: "invalid_args", msg: "effort: x" } });
    const other = await mountLine(refused.onChange);
    await pressValue(other, "effort");
    await choose(other, "effort", "📌max");
    await applyField(other, "effort");
    expect(fieldOf(other, "effort").querySelector(".override-notice")?.textContent).toBe(
      "変更できなかった (invalid_args): effort: x",
    );
    expect(textOf(other, "effort").textContent).toBe("📌max");
    expect(ctxApply(other, "effort")).not.toBeNull();
  });

  // The ctx line is always on screen: what became of a change goes after a
  // while, as 「中断しました」 does. A failure keeps its choice and [適用].
  test("what became of a change goes after a while; a failure's choice stays", async () => {
    jest.useFakeTimers();
    try {
      const refused = recorder({ ok: false, error: { code: "invalid_args", msg: "effort: x" } });
      const root = await mountLine(refused.onChange);
      await pressValue(root, "effort");
      await choose(root, "effort", "📌max");
      await applyField(root, "effort");
      const notice = () => fieldOf(root, "effort").querySelector(".override-notice");
      expect(notice()?.textContent).toBe("変更できなかった (invalid_args): effort: x");
      await act(() => {
        jest.advanceTimersByTime(CTX_LINE_NOTICE_MS - 1);
      });
      expect(notice()).not.toBeNull();
      await act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(notice()).toBeNull();
      expect(textOf(root, "effort").textContent).toBe("📌max");
      expect(ctxApply(root, "effort")).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
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

  test("the same editor at rest, from the store: the one-shot in force shows in the default", async () => {
    const { onChange, patches } = recorder({ ok: true, delivery: "applied" });
    const { store, root } = await mountStatus(SNAPSHOT, onChange, [
      {
        session_id: SID,
        session: { model: "fable", effort: "high" },
        once: { model: null, effort: "max" },
      },
    ]);
    const row = instanceOf(root.querySelector(".status-override"), HTMLElement, "the override row");
    expect(row.querySelector("select")).toBeNull();
    expect(textOf(row, "model").textContent).toBe("📌fable");
    expect(textOf(row, "effort").textContent).toBe("⏱️max");
    expect(row.textContent).not.toContain("単発");
    expect(groupsOf(await press(row, "effort")).map(([label]) => label)).toEqual([
      "default",
      "session",
    ]);
    await escape(selectOf(row, "effort"));
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
    expect(textOf(row, "effort").textContent).toBe("high");
  });

  // DR-0041 §5, §6: after a response under 📌sonnet the transcript's model is
  // sonnet; 🏛️ and the default stay on the session's own (the engine).
  test("after a response under 📌sonnet, 🏛️ stays on the session's own family", async () => {
    const { onChange } = recorder({ ok: true, delivery: "applied" });
    const context = SNAPSHOT.context;
    if (context === undefined) throw new Error("no context");
    const answered = { ...SNAPSHOT, context: { ...context, model: "claude-sonnet-5-5" } };
    const { root } = await mountStatus(answered, onChange, [
      {
        session_id: SID,
        session: { model: "sonnet", effort: "high" },
        once: { model: null, effort: null },
      },
    ]);
    const row = instanceOf(root.querySelector(".status-override"), HTMLElement, "the override row");
    expect(textOf(row, "model").textContent).toBe("📌sonnet");
    expect(groupsOf(await press(row, "model"))).toEqual([
      ["default", ["📌sonnet"]],
      ["session", ["📌fable", "🏛️opus", "📌sonnet", "📌haiku"]],
    ]);
  });
});
