// DR-0028 「restart」: the Status tab's 再起動 as mounted — beside the kill
// button in the danger zone, with its look; offered only when the daemon can
// launch, the session's process is there and it runs in the config dir the
// launch command starts claude in; no confirm, but a form in place whose text,
// RESTART_PROMPT to begin with, is the resumed session's first prompt; both
// buttons disabled while either runs; what it came to under them.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import {
  RESTART_PROMPT,
  type AgentInfo,
  type ErrorResponse,
  type SessionEnvResponse,
  type SessionKillResponse,
  type SessionRestartResponse,
  type SessionStatusSnapshot,
  type UserMessageResponse,
  type RequestOverrideResponse,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000005";
const CONFIG_DIR = "/home/u/.claude-personal";
const SNAPSHOT: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };

let roots: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

function agentRow(configDir: string): AgentInfo {
  return {
    pid: 4242,
    cwd: "/w",
    kind: "interactive",
    startedAt: 0,
    sessionId: SID,
    config_dir: configDir,
  };
}

interface Mounted {
  root: HTMLElement;
  /** Render the view again with the Status panel's snapshot. */
  show: (snapshot: SessionStatusSnapshot | undefined) => Promise<void>;
  /** The prompts of the restarts asked for, oldest first. */
  restarts: () => string[];
  /** Answers the pending restart. */
  answer: (reply: SessionRestartResponse | ErrorResponse) => Promise<void>;
}

async function mount(options: {
  launchAvailable?: boolean;
  launchConfigDir?: string;
  agentConfigDir?: string | null;
  /** The kill's reply never comes, so the kill stays running. */
  killHangs?: boolean;
}): Promise<Mounted> {
  const store = createStore(initialState());
  store.dispatch({
    type: "launch/availability",
    available: options.launchAvailable ?? true,
    ...(options.launchConfigDir !== undefined ? { configDir: options.launchConfigDir } : {}),
  });
  const agentConfigDir = options.agentConfigDir === undefined ? CONFIG_DIR : options.agentConfigDir;
  if (agentConfigDir !== null) {
    store.dispatch({ type: "agents/loaded", agents: [agentRow(agentConfigDir)] });
  }
  const prompts: string[] = [];
  let resolve: ((reply: SessionRestartResponse | ErrorResponse) => void) | undefined;
  const onRestart = (
    _sid: string,
    prompt: string,
  ): Promise<SessionRestartResponse | ErrorResponse> => {
    prompts.push(prompt);
    return new Promise((r) => {
      resolve = r;
    });
  };
  const onKill = (): Promise<SessionKillResponse | ErrorResponse> =>
    options.killHangs === true
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, terminated: true });
  const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, pid: 4242, env: {} });
  const onAgentInput = (): Promise<UserMessageResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, outcome: "appended" });
  const onOverride = (): Promise<RequestOverrideResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, delivery: "applied" });
  const ws = createWsClient((action) => store.dispatch(action));
  /** The session's view as far as the restart goes: it holds the restart,
   * and the Status panel inside it may go (no snapshot while the session is
   * between processes). */
  function Host({ snapshot }: { snapshot: SessionStatusSnapshot | undefined }) {
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
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const show = (snapshot: SessionStatusSnapshot | undefined) =>
    act(() =>
      render(h(AppContext.Provider, { value: { store, ws } }, h(Host, { snapshot })), root),
    );
  await show(SNAPSHOT);
  return {
    root,
    show,
    restarts: () => [...prompts],
    answer: async (reply) => {
      await act(() => {
        resolve?.(reply);
        return Promise.resolve();
      });
      for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    },
  };
}

function restartButton(root: HTMLElement): HTMLButtonElement | null {
  const found = root.querySelector(".status-restart-button");
  return found === null ? null : instanceOf(found, HTMLButtonElement, "the restart button");
}

function killButton(root: HTMLElement): HTMLButtonElement | null {
  const found = root.querySelector(".status-kill-button:not(.status-restart-button)");
  return found === null ? null : instanceOf(found, HTMLButtonElement, "the kill button");
}

function restartForm(root: HTMLElement): HTMLFormElement | null {
  const found = root.querySelector(".status-restart-form");
  return found === null ? null : instanceOf(found, HTMLFormElement, "the restart form");
}

function formText(root: HTMLElement): HTMLTextAreaElement {
  return instanceOf(
    restartForm(root)?.querySelector("textarea"),
    HTMLTextAreaElement,
    "the restart form's text",
  );
}

function formButton(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...(restartForm(root)?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === label,
  );
  return instanceOf(found, HTMLButtonElement, `the form's ${label}`);
}

/** Open the form with 再起動 and send it as it is. */
async function restartWithDefault(root: HTMLElement): Promise<void> {
  await act(() => restartButton(root)?.click());
  await act(() => formButton(root, "再起動").click());
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function resultText(root: HTMLElement): string {
  return root.querySelector(".status-restart-result")?.textContent ?? "";
}

describe("Status の再起動", () => {
  test("offered beside the kill button, with its look, when the session runs in the launch command's config dir", async () => {
    const { root } = await mount({ launchConfigDir: CONFIG_DIR });
    const button = restartButton(root);
    expect(button?.textContent).toBe("再起動");
    expect(button?.classList.contains("status-kill-button")).toBe(true);
    const zone = button?.closest(".status-kill-zone");
    const labels = [...(zone?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(["セッションを終了", "再起動"]);
  });

  test("not offered for a session in another config dir", async () => {
    const { root } = await mount({ launchConfigDir: "/home/u/.claude-other" });
    expect(restartButton(root)).toBeNull();
  });

  test("not offered when the daemon cannot launch, or without the session's process", async () => {
    expect(restartButton((await mount({ launchAvailable: false })).root)).toBeNull();
    const noDir = await mount({});
    expect(restartButton(noDir.root)).toBeNull();
    const noProcess = await mount({ launchConfigDir: CONFIG_DIR, agentConfigDir: null });
    expect(restartButton(noProcess.root)).toBeNull();
  });

  test("pressed, it restarts without asking, stays disabled until the reply, then says it restarted", async () => {
    const confirms: string[] = [];
    const restore = stubGlobal("confirm", (message: string) => {
      confirms.push(message);
      return false;
    });
    try {
      const mounted = await mount({ launchConfigDir: CONFIG_DIR });
      await restartWithDefault(mounted.root);
      expect(mounted.restarts()).toEqual([RESTART_PROMPT]);
      expect(confirms).toEqual([]);
      expect(restartButton(mounted.root)?.disabled).toBe(true);
      expect(restartButton(mounted.root)?.textContent).toBe("再起動中…");
      expect(killButton(mounted.root)?.disabled).toBe(true);
      await mounted.answer({
        ok: true,
        restarted: true,
        session_id: SID,
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
      expect(restartButton(mounted.root)?.disabled).toBe(false);
      expect(killButton(mounted.root)?.disabled).toBe(false);
      expect(resultText(mounted.root)).toBe("再起動しました");
    } finally {
      restore();
    }
  });

  test("pressed, it opens a form in place with RESTART_PROMPT, not selected, and restarts nothing yet", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    expect(restartForm(mounted.root)).toBeNull();
    await act(() => restartButton(mounted.root)?.click());
    expect(restartForm(mounted.root)?.closest(".status-kill-zone")).not.toBeNull();
    const text = formText(mounted.root);
    expect(text.value).toBe(RESTART_PROMPT);
    expect(text.classList.contains("session-input-textarea")).toBe(true);
    expect(document.activeElement).toBe(text);
    expect(text.selectionStart).toBe(RESTART_PROMPT.length);
    expect(text.selectionEnd).toBe(RESTART_PROMPT.length);
    expect(restartButton(mounted.root)?.disabled).toBe(true);
    expect(mounted.restarts()).toEqual([]);
  });

  test("the form's text, as the person left it, is the prompt the restart is asked with", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await act(() => restartButton(mounted.root)?.click());
    const edited = `${RESTART_PROMPT}\nテストの続きから`;
    await typeInto(formText(mounted.root), edited);
    await act(() => formButton(mounted.root, "再起動").click());
    expect(mounted.restarts()).toEqual([edited]);
    // While it runs, the form stays, nothing in it to press or edit.
    expect(formText(mounted.root).disabled).toBe(true);
    expect(formButton(mounted.root, "再起動").disabled).toBe(true);
    expect(formButton(mounted.root, "キャンセル").disabled).toBe(true);
    await mounted.answer({
      ok: true,
      restarted: true,
      session_id: SID,
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    expect(restartForm(mounted.root)).toBeNull();
    expect(resultText(mounted.root)).toBe("再起動しました");
  });

  test("an empty text cannot be sent", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await act(() => restartButton(mounted.root)?.click());
    await typeInto(formText(mounted.root), " \n");
    expect(formButton(mounted.root, "再起動").disabled).toBe(true);
    await act(() => restartForm(mounted.root)?.requestSubmit());
    expect(mounted.restarts()).toEqual([]);
  });

  test("⌘+Enter in the form's text sends the restart like 再起動; a bare Enter does not", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await act(() => restartButton(mounted.root)?.click());
    const edited = `${RESTART_PROMPT}\n続きから`;
    await typeInto(formText(mounted.root), edited);
    await act(() => {
      formText(mounted.root).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(mounted.restarts()).toEqual([]);
    expect(formText(mounted.root).placeholder).toContain("⌘+Enter で送信");
    await act(() => {
      formText(mounted.root).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(mounted.restarts()).toEqual([edited]);
  });

  test("キャンセル and Esc close the form without restarting", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await act(() => restartButton(mounted.root)?.click());
    await act(() => formButton(mounted.root, "キャンセル").click());
    expect(restartForm(mounted.root)).toBeNull();
    expect(restartButton(mounted.root)?.disabled).toBe(false);

    await act(() => restartButton(mounted.root)?.click());
    await act(() => {
      formText(mounted.root).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(restartForm(mounted.root)).toBeNull();
    expect(mounted.restarts()).toEqual([]);

    // Opened again, it starts from RESTART_PROMPT, not what was left.
    await act(() => restartButton(mounted.root)?.click());
    await typeInto(formText(mounted.root), "途中まで書いた");
    await act(() => formButton(mounted.root, "キャンセル").click());
    await act(() => restartButton(mounted.root)?.click());
    expect(formText(mounted.root).value).toBe(RESTART_PROMPT);
  });

  test("while the kill runs, the restart is disabled too", async () => {
    const restore = stubGlobal("confirm", () => true);
    try {
      const mounted = await mount({ launchConfigDir: CONFIG_DIR, killHangs: true });
      await act(() => killButton(mounted.root)?.click());
      expect(killButton(mounted.root)?.disabled).toBe(true);
      expect(restartButton(mounted.root)?.disabled).toBe(true);
      expect(mounted.restarts()).toEqual([]);
    } finally {
      restore();
    }
  });

  test("the result outlives the Status panel going while the session is between processes", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await restartWithDefault(mounted.root);
    await mounted.show(undefined);
    expect(restartButton(mounted.root)).toBeNull();
    await mounted.answer({
      ok: true,
      restarted: true,
      session_id: SID,
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    await mounted.show(SNAPSHOT);
    expect(resultText(mounted.root)).toBe("再起動しました");
    expect(restartButton(mounted.root)?.disabled).toBe(false);
  });

  test("a launch command that did not resume is shown with its output", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await restartWithDefault(mounted.root);
    await mounted.answer({
      ok: true,
      restarted: true,
      session_id: SID,
      exit_code: 2,
      stdout: "",
      stderr: "hyoui not found",
    });
    expect(resultText(mounted.root)).toContain(
      "停止したが、起動コマンドが 2 で終わった (resume していない)",
    );
    expect(resultText(mounted.root)).toContain("hyoui not found");
  });

  test("a process not seen gone says it was not started", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await restartWithDefault(mounted.root);
    await mounted.answer({
      ok: false,
      error: { code: "restart_timeout", msg: "not seen gone" },
    });
    expect(resultText(mounted.root)).toBe("停止を確認できなかったので起動していない");
  });

  test("another refusal names its code and message", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await restartWithDefault(mounted.root);
    await mounted.answer({ ok: false, error: { code: "not_found", msg: "no process" } });
    expect(resultText(mounted.root)).toBe("再起動できなかった (not_found): no process");
  });
});
