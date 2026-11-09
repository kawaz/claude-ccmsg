// DR-0028 「restart」: the Status tab's 再起動 as mounted — a fold above the
// danger zone, after 新セッションを起動, the zone keeping the kill alone;
// offered only when the daemon can launch and the session's process is there,
// whatever its config dir; no confirm, but a form in the fold whose text,
// RESTART_PROMPT or the default saved for the cwd to begin with, is the resumed
// session's first prompt; the send and the kill disabled while either runs;
// what it came to under the fold.
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
/** Another session in the same cwd: the one that follows SID there. */
const OTHER_SID = "eeeeeeee-0000-4000-8000-000000000006";
const CONFIG_DIR = "/home/u/.claude-personal";
const SNAPSHOT: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };

let roots: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  localStorage.clear();
});

function agentRow(configDir: string, sid: string): AgentInfo {
  return {
    pid: 4242,
    cwd: "/w",
    kind: "interactive",
    startedAt: 0,
    sessionId: sid,
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
  /** The session shown; SID unless given. */
  sid?: string;
  launchAvailable?: boolean;
  agentConfigDir?: string | null;
  /** The kill's reply never comes, so the kill stays running. */
  killHangs?: boolean;
}): Promise<Mounted> {
  const sid = options.sid ?? SID;
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: options.launchAvailable ?? true });
  const agentConfigDir = options.agentConfigDir === undefined ? CONFIG_DIR : options.agentConfigDir;
  if (agentConfigDir !== null) {
    store.dispatch({ type: "agents/loaded", agents: [agentRow(agentConfigDir, sid)] });
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
    const restart = useSessionRestart(sid, onRestart);
    return h(StatusPanel, {
      snapshot,
      sid,
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

/** The fold titled `title` among the Status tab's session forms. */
function fold(root: HTMLElement, title: string): HTMLDetailsElement | null {
  const found = [...root.querySelectorAll(".status-session-forms > details")].find(
    (details) => details.querySelector("summary")?.textContent === title,
  );
  return found === undefined ? null : instanceOf(found, HTMLDetailsElement, `the ${title} fold`);
}

function restartFold(root: HTMLElement): HTMLDetailsElement | null {
  return fold(root, "再起動");
}

/** Opens or closes a fold as the browser does, and lets the toggle land. */
async function setOpen(details: HTMLDetailsElement | null, open: boolean): Promise<void> {
  if (details === null) throw new Error("expected the fold, found none");
  await act(async () => {
    const toggled = new Promise((resolve) =>
      details.addEventListener("toggle", resolve, { once: true }),
    );
    details.open = open;
    await toggled;
  });
}

function killButton(root: HTMLElement): HTMLButtonElement | null {
  const found = root.querySelector(".status-kill-zone .status-kill-button");
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

function formButton(root: HTMLElement, className: string): HTMLButtonElement {
  return instanceOf(
    restartForm(root)?.querySelector(`button.${className}`),
    HTMLButtonElement,
    `the form's ${className}`,
  );
}

function sendButton(root: HTMLElement): HTMLButtonElement {
  return formButton(root, "status-form-submit");
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  return formButton(root, "status-form-save");
}

/** Open the fold and send the form as it is. */
async function restartWithDefault(root: HTMLElement): Promise<void> {
  await setOpen(restartFold(root), true);
  await act(() => sendButton(root).click());
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
  test("offered as a fold after 新セッションを起動, above the danger zone, which keeps the kill alone", async () => {
    const { root } = await mount({});
    const titles = [...root.querySelectorAll(".status-session-forms > details > summary")].map(
      (summary) => summary.textContent,
    );
    expect(titles).toEqual(["新セッションを起動", "再起動"]);
    expect(restartFold(root)?.open).toBe(false);
    expect(restartFold(root)?.closest(".status-kill-zone")).toBeNull();
    const zone = root.querySelector(".status-kill-zone");
    const labels = [...(zone?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(["セッションを終了"]);
    const forms = root.querySelector(".status-session-forms");
    expect(
      forms !== null &&
        zone !== null &&
        (forms.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  // The daemon resumes a session in the config dir it runs in, so a session
  // of any config dir is offered one.
  test("offered for a session of any config dir", async () => {
    const { root } = await mount({ agentConfigDir: "/home/u/.claude-other" });
    expect(restartFold(root)).not.toBeNull();
  });

  test("not offered when the daemon cannot launch, or without the session's process", async () => {
    const unavailable = await mount({ launchAvailable: false });
    expect(restartFold(unavailable.root)).toBeNull();
    expect(unavailable.root.querySelector(".status-session-forms")).toBeNull();
    const noProcess = await mount({ agentConfigDir: null });
    expect(restartFold(noProcess.root)).toBeNull();
  });

  test("sent, it restarts without asking, stays disabled until the reply, then says it restarted", async () => {
    const confirms: string[] = [];
    const restore = stubGlobal("confirm", (message: string) => {
      confirms.push(message);
      return false;
    });
    try {
      const mounted = await mount({});
      await restartWithDefault(mounted.root);
      expect(mounted.restarts()).toEqual([RESTART_PROMPT]);
      expect(confirms).toEqual([]);
      expect(sendButton(mounted.root).disabled).toBe(true);
      expect(sendButton(mounted.root).textContent).toBe("再起動中…");
      expect(killButton(mounted.root)?.disabled).toBe(true);
      await mounted.answer({
        ok: true,
        restarted: true,
        session_id: SID,
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
      expect(killButton(mounted.root)?.disabled).toBe(false);
      expect(resultText(mounted.root)).toBe("再起動しました");
    } finally {
      restore();
    }
  });

  test("opened, the fold holds a form with RESTART_PROMPT, not selected, and restarts nothing yet", async () => {
    const mounted = await mount({});
    expect(restartForm(mounted.root)).toBeNull();
    await setOpen(restartFold(mounted.root), true);
    expect(restartForm(mounted.root)?.closest("details")).toBe(restartFold(mounted.root));
    const text = formText(mounted.root);
    expect(text.value).toBe(RESTART_PROMPT);
    expect(text.classList.contains("session-input-textarea")).toBe(true);
    expect(document.activeElement).toBe(text);
    expect(text.selectionStart).toBe(RESTART_PROMPT.length);
    expect(text.selectionEnd).toBe(RESTART_PROMPT.length);
    expect(sendButton(mounted.root).textContent).toBe("再起動");
    expect(mounted.restarts()).toEqual([]);
  });

  test("the send is the primary button and the save the quiet one, neither the danger zone's", async () => {
    const mounted = await mount({});
    await setOpen(restartFold(mounted.root), true);
    expect(sendButton(mounted.root).classList.contains("status-kill-button")).toBe(false);
    expect(saveButton(mounted.root).classList.contains("status-kill-button")).toBe(false);
    expect(saveButton(mounted.root).textContent).toBe("デフォルトに保存");
  });

  test("the form's text, as the person left it, is the prompt the restart is asked with", async () => {
    const mounted = await mount({});
    await setOpen(restartFold(mounted.root), true);
    const edited = `${RESTART_PROMPT}\nテストの続きから`;
    await typeInto(formText(mounted.root), edited);
    await act(() => sendButton(mounted.root).click());
    expect(mounted.restarts()).toEqual([edited]);
    // While it runs, the form stays, nothing in it to send or edit.
    expect(formText(mounted.root).disabled).toBe(true);
    expect(sendButton(mounted.root).disabled).toBe(true);
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
    const mounted = await mount({});
    await setOpen(restartFold(mounted.root), true);
    await typeInto(formText(mounted.root), " \n");
    expect(sendButton(mounted.root).disabled).toBe(true);
    await act(() => restartForm(mounted.root)?.requestSubmit());
    expect(mounted.restarts()).toEqual([]);
  });

  test("⌘+Enter in the form's text sends the restart like 再起動; a bare Enter does not", async () => {
    const mounted = await mount({});
    await setOpen(restartFold(mounted.root), true);
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

  test("Esc and the fold's closing close the form without restarting; opened again, it starts from RESTART_PROMPT", async () => {
    const mounted = await mount({});
    await setOpen(restartFold(mounted.root), true);
    await typeInto(formText(mounted.root), "途中まで書いた");
    await act(() => {
      formText(mounted.root).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(restartForm(mounted.root)).toBeNull();
    expect(restartFold(mounted.root)?.open).toBe(false);
    expect(mounted.restarts()).toEqual([]);

    await setOpen(restartFold(mounted.root), true);
    expect(formText(mounted.root).value).toBe(RESTART_PROMPT);
    await typeInto(formText(mounted.root), "途中まで書いた");
    await setOpen(restartFold(mounted.root), false);
    expect(restartForm(mounted.root)).toBeNull();
    await setOpen(restartFold(mounted.root), true);
    expect(formText(mounted.root).value).toBe(RESTART_PROMPT);
    expect(mounted.restarts()).toEqual([]);
  });

  test("デフォルトに保存 keeps the text for the cwd: the label says so, and the form opens on it, for the next session in the cwd too", async () => {
    const mounted = await mount({});
    await setOpen(restartFold(mounted.root), true);
    const mine = `${RESTART_PROMPT}\nいつもの続き`;
    await typeInto(formText(mounted.root), mine);
    await act(() => saveButton(mounted.root).click());
    expect(saveButton(mounted.root).textContent).toBe("保存済み");
    expect(saveButton(mounted.root).disabled).toBe(true);
    await typeInto(formText(mounted.root), `${mine}!`);
    expect(saveButton(mounted.root).textContent).toBe("デフォルトに保存");

    await setOpen(restartFold(mounted.root), false);
    await setOpen(restartFold(mounted.root), true);
    expect(formText(mounted.root).value).toBe(mine);
    expect(saveButton(mounted.root).textContent).toBe("保存済み");

    const successor = await mount({ sid: OTHER_SID });
    await setOpen(restartFold(successor.root), true);
    expect(formText(successor.root).value).toBe(mine);
  });

  test("while the kill runs, the restart cannot be sent", async () => {
    const restore = stubGlobal("confirm", () => true);
    try {
      const mounted = await mount({ killHangs: true });
      await setOpen(restartFold(mounted.root), true);
      await act(() => killButton(mounted.root)?.click());
      expect(killButton(mounted.root)?.disabled).toBe(true);
      expect(sendButton(mounted.root).disabled).toBe(true);
      await act(() => restartForm(mounted.root)?.requestSubmit());
      expect(mounted.restarts()).toEqual([]);
    } finally {
      restore();
    }
  });

  test("the result outlives the Status panel going while the session is between processes", async () => {
    const mounted = await mount({});
    await restartWithDefault(mounted.root);
    await mounted.show(undefined);
    expect(restartFold(mounted.root)).toBeNull();
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
    expect(restartFold(mounted.root)?.open).toBe(false);
    expect(killButton(mounted.root)?.disabled).toBe(false);
  });

  test("a launch command that did not resume is shown with its output", async () => {
    const mounted = await mount({});
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
    const mounted = await mount({});
    await restartWithDefault(mounted.root);
    await mounted.answer({
      ok: false,
      error: { code: "restart_timeout", msg: "not seen gone" },
    });
    expect(resultText(mounted.root)).toBe("停止を確認できなかったので起動していない");
  });

  test("another refusal names its code and message", async () => {
    const mounted = await mount({});
    await restartWithDefault(mounted.root);
    await mounted.answer({ ok: false, error: { code: "not_found", msg: "no process" } });
    expect(resultText(mounted.root)).toBe("再起動できなかった (not_found): no process");
  });
});
