// DR-0028 「restart」: the Status tab's 再起動 as mounted — a row of
// セッション操作 between 新セッションを起動 and fork, above the danger zone, the zone
// keeping the kill alone; offered only when the daemon can launch and the
// session's process is there, whatever its config dir; no confirm, but a form
// in a modal dialog whose text, RESTART_PROMPT or the default saved for the cwd
// to begin with, is the resumed session's first prompt, and whose model and
// effort start on what the session runs as and go with the request only as
// chosen (a model chosen taking its own effort), the rest the daemon's to fill
// with what the session runs as;
// the send and the kill disabled while either runs; a restart that resumed closes the dialog, any
// other outcome keeps it open with what it came to, which also shows under the
// list.
import { afterEach, describe, expect, jest, test } from "bun:test";
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
  type RequestOverrideResponse,
  type SessionContextUsage,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import {
  RESTART_DONE_NOTE_MS,
  StatusPanel,
  useSessionRestart,
} from "../src/client/components/StatusPanel.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient, type SessionRestartAsk } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import {
  actionButton,
  actionNames,
  actionRow,
  choosePick,
  closeButton,
  dialogTitled,
  openAction,
  pickText,
  pressEscape,
} from "./status-actions.ts";

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

function agentRow(configDir: string, sid: string, cwd: string): AgentInfo {
  return {
    pid: 4242,
    cwd,
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
  /** The restarts asked for, whole, oldest first. */
  asks: () => SessionRestartAsk[];
  /** Answers the pending restart. */
  answer: (reply: SessionRestartResponse | ErrorResponse) => Promise<void>;
}

async function mount(options: {
  /** The session shown; SID unless given. */
  sid?: string;
  /** The session's cwd; "/w" unless given. */
  cwd?: string;
  launchAvailable?: boolean;
  agentConfigDir?: string | null;
  /** The kill's reply never comes, so the kill stays running. */
  killHangs?: boolean;
  /** What each kill is answered with (the force asked for is recorded in
   * `kills`); terminated unless given. */
  killReply?: SessionKillResponse | ErrorResponse;
  kills?: Array<boolean>;
  /** What the session runs as, in the snapshot's context. */
  context?: SessionContextUsage;
  /** The session override's values (DR-0041 §5). */
  override?: { model: string | null; effort: string | null };
}): Promise<Mounted> {
  const sid = options.sid ?? SID;
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: options.launchAvailable ?? true });
  const agentConfigDir = options.agentConfigDir === undefined ? CONFIG_DIR : options.agentConfigDir;
  if (agentConfigDir !== null) {
    store.dispatch({
      type: "agents/loaded",
      agents: [agentRow(agentConfigDir, sid, options.cwd ?? "/w")],
    });
  }
  if (options.override !== undefined) {
    store.dispatch({
      type: "request-overrides/changed",
      sid,
      target: "session",
      values: options.override,
    });
  }
  const asks: SessionRestartAsk[] = [];
  let resolve: ((reply: SessionRestartResponse | ErrorResponse) => void) | undefined;
  const onRestart = (
    _sid: string,
    ask: SessionRestartAsk,
  ): Promise<SessionRestartResponse | ErrorResponse> => {
    asks.push(ask);
    return new Promise((r) => {
      resolve = r;
    });
  };
  const onKill = (opts?: { force?: boolean }): Promise<SessionKillResponse | ErrorResponse> => {
    options.kills?.push(opts?.force === true);
    return options.killHangs === true
      ? new Promise(() => {})
      : Promise.resolve(options.killReply ?? { ok: true, terminated: true });
  };
  const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, pid: 4242, env: {} });
  const onOverride = (): Promise<RequestOverrideResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, delivery: "applied" });
  const ws = createWsClient((action) => store.dispatch(action));
  /** The session's view as far as the restart goes: it holds the restart,
   * and the Status panel inside it may go (no snapshot while the session is
   * between processes). */
  function Host({ snapshot }: { snapshot: SessionStatusSnapshot | undefined }) {
    const restart = useSessionRestart(sid, onRestart);
    return h(StatusPanel, {
      shown: true,
      snapshot,
      sid,
      onKill,
      restart,
      onLoadEnv,
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
  await show(options.context === undefined ? SNAPSHOT : { ...SNAPSHOT, context: options.context });
  return {
    root,
    show,
    restarts: () => asks.map((ask) => ask.prompt ?? ""),
    asks: () => [...asks],
    answer: async (reply) => {
      await act(() => {
        resolve?.(reply);
        return Promise.resolve();
      });
      for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    },
  };
}

const RESTART = "再起動";

function restartDialog(root: HTMLElement): HTMLDialogElement | null {
  return dialogTitled(root, RESTART);
}

async function openRestart(root: HTMLElement): Promise<void> {
  await openAction(root, RESTART);
}

async function escapeRestart(root: HTMLElement): Promise<void> {
  const dialog = restartDialog(root);
  if (dialog === null) throw new Error("expected the restart dialog, found none");
  await pressEscape(dialog);
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
  return formButton(root, "session-input-send");
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  return formButton(root, "session-input-secondary");
}

/** Open the dialog and send the form as it is. */
async function restartWithDefault(root: HTMLElement): Promise<void> {
  await openRestart(root);
  await act(() => sendButton(root).click());
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** What the restart came to, under the list (outside the dialog). */
function resultText(root: HTMLElement): string {
  return root.querySelector(".status-session-actions > .status-restart-result")?.textContent ?? "";
}

/** What the restart came to, in its dialog. */
function dialogResultText(root: HTMLElement): string {
  return restartDialog(root)?.querySelector(".status-restart-result")?.textContent ?? "";
}

describe("Status の再起動", () => {
  test("offered as a row between 新セッションを起動 and fork in セッション操作, above the danger zone, which keeps the kill alone", async () => {
    const { root } = await mount({});
    expect(actionNames(root, ".status-session-actions")).toEqual([
      "新セッションを起動",
      RESTART,
      "fork",
    ]);
    expect(actionButton(root, RESTART).textContent).toBe("再起動");
    expect(restartDialog(root)).toBeNull();
    expect(actionRow(root, RESTART)?.closest(".status-kill-zone")).toBeNull();
    expect(actionNames(root, ".status-kill-zone")).toEqual(["セッションを終了"]);
    const zone = root.querySelector(".status-kill-zone");
    const labels = [...(zone?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(["終了"]);
    const actions = root.querySelector(".status-session-actions");
    expect(
      actions !== null &&
        zone !== null &&
        (actions.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  // The daemon resumes a session in the config dir it runs in, so a session
  // of any config dir is offered one.
  test("offered for a session of any config dir", async () => {
    const { root } = await mount({ agentConfigDir: "/home/u/.claude-other" });
    expect(actionRow(root, RESTART)).not.toBeNull();
  });

  test("not offered when the daemon cannot launch, or without the session's process", async () => {
    const unavailable = await mount({ launchAvailable: false });
    expect(actionRow(unavailable.root, RESTART)).toBeNull();
    expect(unavailable.root.querySelector(".status-session-actions")).toBeNull();
    const noProcess = await mount({ agentConfigDir: null });
    expect(actionRow(noProcess.root, RESTART)).toBeNull();
  });

  test("sent, it restarts without asking, stays disabled until the reply, then closes and says it restarted", async () => {
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
      expect(restartDialog(mounted.root)).toBeNull();
      expect(resultText(mounted.root)).toBe("再起動しました");
    } finally {
      restore();
    }
  });

  // 「再起動しました」 has nothing to act on once the session is back, so it
  // goes by itself; a restart that did not resume keeps its reason.
  test("「再起動しました」 goes after a while; a restart that did not resume stays", async () => {
    jest.useFakeTimers();
    try {
      const done = await mount({});
      await restartWithDefault(done.root);
      await done.answer({
        ok: true,
        restarted: true,
        session_id: SID,
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
      expect(resultText(done.root)).toBe("再起動しました");
      await act(() => {
        jest.advanceTimersByTime(RESTART_DONE_NOTE_MS - 1);
      });
      expect(resultText(done.root)).toBe("再起動しました");
      await act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(resultText(done.root)).toBe("");

      const failed = await mount({});
      await restartWithDefault(failed.root);
      await failed.answer({
        ok: true,
        restarted: true,
        session_id: SID,
        exit_code: 3,
        stdout: "",
        stderr: "boom",
      });
      const kept = resultText(failed.root);
      expect(kept).toContain("3");
      await act(() => {
        jest.advanceTimersByTime(RESTART_DONE_NOTE_MS * 10);
      });
      expect(resultText(failed.root)).toBe(kept);
    } finally {
      jest.useRealTimers();
    }
  });

  // The whole row opens the dialog, not only the button at its end; the
  // kill's row does not, so a click beside its button ends nothing.
  test("a click anywhere in the 再起動 row opens its dialog; in the kill's row, only the button acts", async () => {
    const confirms: string[] = [];
    const restore = stubGlobal("confirm", (message: string) => {
      confirms.push(message);
      return false;
    });
    try {
      const { root } = await mount({});
      const name = actionRow(root, RESTART)?.querySelector(".status-action-name");
      await act(() => instanceOf(name, HTMLElement, "the 再起動 row's name").click());
      expect(restartDialog(root)?.open).toBe(true);
      await escapeRestart(root);
      const kill = actionRow(root, "セッションを終了")?.querySelector(".status-action-desc");
      await act(() => instanceOf(kill, HTMLElement, "the kill row's description").click());
      expect(confirms).toEqual([]);
    } finally {
      restore();
    }
  });

  test("opened, the dialog holds a form with RESTART_PROMPT, not selected, and restarts nothing yet", async () => {
    const mounted = await mount({});
    expect(restartForm(mounted.root)).toBeNull();
    await openRestart(mounted.root);
    expect(restartDialog(mounted.root)?.open).toBe(true);
    expect(restartForm(mounted.root)?.closest("dialog")).toBe(restartDialog(mounted.root));
    const text = formText(mounted.root);
    expect(text.value).toBe(RESTART_PROMPT);
    expect(text.classList.contains("session-input-textarea")).toBe(true);
    // The FAB's row right under the text: デフォルトに保存 on the left, then
    // the model and effort, and 再起動 at the end.
    const row = text.nextElementSibling;
    expect(row?.classList.contains("session-input-actions")).toBe(true);
    expect(
      [...(row?.children ?? [])].map((el) => el.getAttribute("aria-label") ?? el.textContent),
    ).toEqual(["デフォルトに保存", "--model", "--effort", "再起動"]);
    expect(restartDialog(mounted.root)?.querySelector(".modal-dialog-foot")).toBeNull();
    expect(document.activeElement).toBe(text);
    expect(text.selectionStart).toBe(RESTART_PROMPT.length);
    expect(text.selectionEnd).toBe(RESTART_PROMPT.length);
    expect(sendButton(mounted.root).textContent).toBe("再起動");
    expect(mounted.restarts()).toEqual([]);
  });

  test("the send is the primary button and the save the quiet one, neither the danger zone's", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    expect(sendButton(mounted.root).classList.contains("status-kill-button")).toBe(false);
    expect(saveButton(mounted.root).classList.contains("status-kill-button")).toBe(false);
    expect(saveButton(mounted.root).textContent).toBe("デフォルトに保存");
  });

  test("the form's text, as the person left it, is the prompt the restart is asked with", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    const edited = `${RESTART_PROMPT}\nテストの続きから`;
    await typeInto(formText(mounted.root), edited);
    await act(() => sendButton(mounted.root).click());
    expect(mounted.restarts()).toEqual([edited]);
    // While it runs, the form stays, nothing in it to send or edit (the text
    // read-only, as the FAB's).
    expect(formText(mounted.root).readOnly).toBe(true);
    expect(saveButton(mounted.root).disabled).toBe(true);
    expect(pickText(restartForm(mounted.root), "--model").disabled).toBe(true);
    expect(pickText(restartForm(mounted.root), "--effort").disabled).toBe(true);
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

  // The resumed session goes on on the model it runs on: a model changed on
  // resume drops the thinking and writes the cache anew (kawaz 2026-11-15).
  // Left as it opened, a field is left out of the request, for the daemon to
  // fill with what the session runs as at the restart (DR-0028 step 3).
  test("the model and effort open on what the session runs as, and left so they are left out of the request", async () => {
    const mounted = await mount({
      context: {
        model: "claude-opus-5-5",
        effort: "medium",
        timestamp: "2026-11-11T00:00:00.000Z",
      },
    });
    await openRestart(mounted.root);
    const form = restartForm(mounted.root);
    expect(pickText(form, "--model").textContent).toBe("opus");
    expect(pickText(form, "--effort").textContent).toBe("medium");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.asks()).toEqual([{ prompt: RESTART_PROMPT }]);
  });

  test("a heavy session opens on its own: fable high on fable / high, opus xhigh on opus / xhigh", async () => {
    for (const [engine, shown] of [
      [{ model: "fable[1m]", effort: "high" }, ["fable", "high"]],
      [{ model: "opus", effort: "xhigh" }, ["opus", "xhigh"]],
    ] as const) {
      const mounted = await mount({
        context: {
          model: "claude-haiku-5-5",
          effort: "low",
          engine,
          timestamp: "2026-11-11T00:00:00.000Z",
        },
      });
      await openRestart(mounted.root);
      const form = restartForm(mounted.root);
      expect([
        pickText(form, "--model").textContent,
        pickText(form, "--effort").textContent,
      ]).toEqual([...shown]);
      await act(() => sendButton(mounted.root).click());
      expect(mounted.asks()).toEqual([{ prompt: RESTART_PROMPT }]);
      await act(() => render(null, mounted.root));
    }
  });

  // What the main thread's requests run on: the session override over the
  // session's own (DR-0041 §5). The daemon puts the override back on the
  // resumed run, so the request leaves the fields out all the same.
  test("under a session override, it opens on the override's values", async () => {
    const mounted = await mount({
      context: {
        model: "claude-fable-5-2",
        effort: "low",
        engine: { model: "fable[1m]", effort: "low" },
        timestamp: "2026-11-11T00:00:00.000Z",
      },
      override: { model: "opus", effort: "high" },
    });
    await openRestart(mounted.root);
    const form = restartForm(mounted.root);
    expect(pickText(form, "--model").textContent).toBe("opus");
    expect(pickText(form, "--effort").textContent).toBe("high");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.asks()).toEqual([{ prompt: RESTART_PROMPT }]);
  });

  test("a model or effort it cannot name for the session starts on 元の model / 元の effort and is left out", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    const form = restartForm(mounted.root);
    expect(pickText(form, "--model").textContent).toBe("元の model");
    expect(pickText(form, "--effort").textContent).toBe("元の effort");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.asks()).toEqual([{ prompt: RESTART_PROMPT }]);
  });

  test("an effort chosen alone goes with the request, the model left out", async () => {
    const mounted = await mount({
      context: {
        model: "claude-opus-5-5",
        effort: "medium",
        timestamp: "2026-11-11T00:00:00.000Z",
      },
    });
    await openRestart(mounted.root);
    const form = restartForm(mounted.root);
    await choosePick(form, "--effort", "high");
    expect(pickText(form, "--model").textContent).toBe("opus");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.asks()).toEqual([{ prompt: RESTART_PROMPT, effort: "high" }]);
  });

  test("a model chosen takes its effort, over the session's and one chosen before, and both go with the request", async () => {
    const mounted = await mount({
      context: {
        model: "claude-fable-5-2",
        effort: "high",
        timestamp: "2026-11-11T00:00:00.000Z",
      },
    });
    await openRestart(mounted.root);
    const form = restartForm(mounted.root);
    await choosePick(form, "--model", "opus");
    expect(pickText(form, "--effort").textContent).toBe("medium");
    await choosePick(form, "--effort", "xhigh");
    await choosePick(form, "--model", "haiku");
    expect(pickText(form, "--effort").textContent).toBe("low");
    await choosePick(form, "--model", "sonnet");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.asks()).toEqual([{ prompt: RESTART_PROMPT, model: "sonnet", effort: "medium" }]);
  });

  test("デフォルトに保存 keeps the prompt only: the model and effort open on the session's again", async () => {
    const mounted = await mount({
      context: {
        model: "claude-opus-5-5",
        effort: "medium",
        timestamp: "2026-11-11T00:00:00.000Z",
      },
    });
    await openRestart(mounted.root);
    await choosePick(restartForm(mounted.root), "--model", "haiku");
    await typeInto(formText(mounted.root), "いつもの再起動");
    await act(() => saveButton(mounted.root).click());
    expect(JSON.parse(localStorage.getItem("ccmsg.statusForms") ?? "null")).toEqual({
      v: 1,
      restart: { prompt: "いつもの再起動" },
    });
    await escapeRestart(mounted.root);
    await openRestart(mounted.root);
    expect(formText(mounted.root).value).toBe("いつもの再起動");
    expect(pickText(restartForm(mounted.root), "--model").textContent).toBe("opus");
    expect(pickText(restartForm(mounted.root), "--effort").textContent).toBe("medium");
  });

  test("an empty text cannot be sent", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    await typeInto(formText(mounted.root), " \n");
    expect(sendButton(mounted.root).disabled).toBe(true);
    await act(() => restartForm(mounted.root)?.requestSubmit());
    expect(mounted.restarts()).toEqual([]);
  });

  test("⌘+Enter in the form's text sends the restart like 再起動; a bare Enter does not", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    expect(formText(mounted.root).placeholder).toContain("⌘+Enter で再起動");
    expect(sendButton(mounted.root).title).toContain("⌘+Enter");
    const edited = `${RESTART_PROMPT}\n続きから`;
    await typeInto(formText(mounted.root), edited);
    await act(() => {
      formText(mounted.root).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(mounted.restarts()).toEqual([]);
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

  test("Escape and × close the dialog without restarting; opened again, it starts from RESTART_PROMPT", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    await typeInto(formText(mounted.root), "途中まで書いた");
    await escapeRestart(mounted.root);
    expect(restartForm(mounted.root)).toBeNull();
    expect(restartDialog(mounted.root)).toBeNull();
    expect(mounted.restarts()).toEqual([]);

    await openRestart(mounted.root);
    expect(formText(mounted.root).value).toBe(RESTART_PROMPT);
    await typeInto(formText(mounted.root), "途中まで書いた");
    const dialog = restartDialog(mounted.root);
    if (dialog === null) throw new Error("expected the restart dialog");
    await act(() => closeButton(dialog).click());
    expect(restartForm(mounted.root)).toBeNull();
    await openRestart(mounted.root);
    expect(formText(mounted.root).value).toBe(RESTART_PROMPT);
    expect(mounted.restarts()).toEqual([]);
  });

  test("デフォルトに保存 keeps the text for every session: the label says so, and the form opens on it, in the next session and in one in another cwd too", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    const mine = `${RESTART_PROMPT}\nいつもの続き`;
    await typeInto(formText(mounted.root), mine);
    await act(() => saveButton(mounted.root).click());
    expect(saveButton(mounted.root).textContent).toBe("保存済み");
    expect(saveButton(mounted.root).disabled).toBe(true);
    await typeInto(formText(mounted.root), `${mine}!`);
    expect(saveButton(mounted.root).textContent).toBe("デフォルトに保存");

    await escapeRestart(mounted.root);
    await openRestart(mounted.root);
    expect(formText(mounted.root).value).toBe(mine);
    expect(saveButton(mounted.root).textContent).toBe("保存済み");

    const successor = await mount({ sid: OTHER_SID });
    await openRestart(successor.root);
    expect(formText(successor.root).value).toBe(mine);

    const elsewhere = await mount({ sid: OTHER_SID, cwd: "/other" });
    await openRestart(elsewhere.root);
    expect(formText(elsewhere.root).value).toBe(mine);
  });

  test("a value left under the key of a cwd is not read", async () => {
    localStorage.setItem("ccmsg.statusForms./w", '{"v":1,"restart":{"prompt":"前の鍵の続き"}}');
    const mounted = await mount({});
    await openRestart(mounted.root);
    expect(formText(mounted.root).value).toBe(RESTART_PROMPT);
    expect(saveButton(mounted.root).textContent).toBe("デフォルトに保存");
  });

  test("while the kill runs, the restart cannot be sent", async () => {
    const restore = stubGlobal("confirm", () => true);
    try {
      const mounted = await mount({ killHangs: true });
      await act(() => killButton(mounted.root)?.click());
      expect(killButton(mounted.root)?.disabled).toBe(true);
      expect(killButton(mounted.root)?.textContent).toBe("終了処理中…");
      await openRestart(mounted.root);
      expect(sendButton(mounted.root).disabled).toBe(true);
      await act(() => restartForm(mounted.root)?.requestSubmit());
      expect(mounted.restarts()).toEqual([]);
    } finally {
      restore();
    }
  });

  test("while it runs, the dialog does not close", async () => {
    const mounted = await mount({});
    await restartWithDefault(mounted.root);
    expect(await pressEscape(restartDialog(mounted.root) ?? noDialog())).toBe(false);
    expect(restartDialog(mounted.root)?.open).toBe(true);
    expect(closeButton(restartDialog(mounted.root) ?? noDialog()).disabled).toBe(true);
  });

  test("the result outlives the Status panel going while the session is between processes", async () => {
    const mounted = await mount({});
    await restartWithDefault(mounted.root);
    await mounted.show(undefined);
    expect(restartDialog(mounted.root)).toBeNull();
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
    expect(restartDialog(mounted.root)).toBeNull();
    expect(killButton(mounted.root)?.disabled).toBe(false);
  });

  test("a launch command that did not resume keeps the dialog open, with its output there and under the list", async () => {
    const mounted = await mount({});
    await openRestart(mounted.root);
    const edited = `${RESTART_PROMPT}\nもう一度`;
    await typeInto(formText(mounted.root), edited);
    await act(() => sendButton(mounted.root).click());
    await mounted.answer({
      ok: true,
      restarted: true,
      session_id: SID,
      exit_code: 2,
      stdout: "",
      stderr: "hyoui not found",
    });
    for (const text of [resultText(mounted.root), dialogResultText(mounted.root)]) {
      expect(text).toContain("停止したが、起動コマンドが 2 で終わった (resume していない)");
      expect(text).toContain("hyoui not found");
    }
    expect(restartDialog(mounted.root)?.open).toBe(true);
    expect(formText(mounted.root).value).toBe(edited);
    expect(sendButton(mounted.root).disabled).toBe(false);
  });

  test("a process not seen gone says it was not started, the dialog kept open", async () => {
    const mounted = await mount({});
    await restartWithDefault(mounted.root);
    await mounted.answer({
      ok: false,
      error: { code: "restart_timeout", msg: "not seen gone" },
    });
    expect(resultText(mounted.root)).toBe("停止を確認できなかったので起動していない");
    expect(dialogResultText(mounted.root)).toBe("停止を確認できなかったので起動していない");
  });

  test("another refusal names its code and message", async () => {
    const mounted = await mount({});
    await restartWithDefault(mounted.root);
    await mounted.answer({ ok: false, error: { code: "not_found", msg: "no process" } });
    expect(resultText(mounted.root)).toBe("再起動できなかった (not_found): no process");
  });
});

describe("Status の危険ゾーン", () => {
  test("ends the session after the confirm; not seen gone, the row turns to the -KILL one, which sends SIGKILL", async () => {
    const confirms: string[] = [];
    const restore = stubGlobal("confirm", (message: string) => {
      confirms.push(message);
      return true;
    });
    try {
      const kills: boolean[] = [];
      const mounted = await mount({ kills, killReply: { ok: true, terminated: false } });
      await act(() => killButton(mounted.root)?.click());
      for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
      expect(kills).toEqual([false]);
      expect(confirms).toHaveLength(1);
      expect(actionNames(mounted.root, ".status-kill-zone")).toEqual(["強制終了 (-KILL)"]);
      expect(killButton(mounted.root)?.textContent).toBe("強制終了");
      expect(killButton(mounted.root)?.classList.contains("status-kill-button-force")).toBe(true);
      expect(mounted.root.querySelector(".status-kill-result")?.textContent).toBe(
        "シグナル送信済み (終了は未確認)。強制終了に切り替えました",
      );
      await act(() => killButton(mounted.root)?.click());
      expect(kills).toEqual([false, true]);
      expect(confirms[1]).toContain("SIGKILL");
    } finally {
      restore();
    }
  });

  // not_found says why in its msg: no pid for the session, or a pid whose
  // process could not be confirmed to be claude (a live process). The
  // result shows the code and the msg as the daemon sent them, never a fixed
  // text that would call a live process already gone.
  test("not_found shows its code and the daemon's msg, whichever refusal it is", async () => {
    const restore = stubGlobal("confirm", () => true);
    try {
      for (const msg of [
        `no process for session ${SID}`,
        `the process of session ${SID} (pid 4242) could not be confirmed to be claude`,
      ]) {
        const mounted = await mount({
          killReply: { ok: false, error: { code: "not_found", msg } },
        });
        await act(() => killButton(mounted.root)?.click());
        for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
        expect(mounted.root.querySelector(".status-kill-result")?.textContent).toBe(
          `終了できなかった (not_found): ${msg}`,
        );
        expect(killButton(mounted.root)?.textContent).toBe("終了");
      }
    } finally {
      restore();
    }
  });

  test("a declined confirm sends nothing", async () => {
    const restore = stubGlobal("confirm", () => false);
    try {
      const kills: boolean[] = [];
      const mounted = await mount({ kills });
      await act(() => killButton(mounted.root)?.click());
      expect(kills).toEqual([]);
      expect(killButton(mounted.root)?.textContent).toBe("終了");
    } finally {
      restore();
    }
  });
});

function noDialog(): never {
  throw new Error("expected the restart dialog");
}
