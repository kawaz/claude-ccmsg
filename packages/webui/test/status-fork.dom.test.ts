// DR-0028 「restart」 / DR-0018 §3.9: the Status tab's fork as mounted — a row
// of セッション操作 under 再起動 whose button opens a modal dialog with the
// restart's form: its text, FORK_PROMPT or the prompt saved under its own key,
// the first prompt of the fork; its model and effort opening, as the
// restart's do, on what the session runs as as the daemon reads it when the
// form opens (`session_runs_as`), and going with the launch as shown (a model
// chosen taking its own effort), a field the form cannot name left for the
// daemon to fill (kawaz 2026-11-18: a fork is a restart's resume with one
// parameter more); the send is `session_launch` resuming the session with
// `fork_session` under its name, never a restart or a kill; a fork launched
// closes the dialog, anything else keeps it open with what it came to, which
// also shows under the list; it needs the cwd, not the session's process.
//
// 何を保証するか (DR-0028 restart の終了済みのセッション、kawaz 2026-11-24): 終了済み
// (peers にも agents の行にも居ない) のセッションにも「再起動」が出て、説明は生きている時の
// 文から止める段を除いた「同じ session_id で resume する」。押すと再起動のフォーム (model / effort の選択は無い) が出て、
// 送ると止める段を踏まずに `session_launch` を `resume` (開いているセッションの id) と cwd で
// 頼む (`continue`・model・effort・fork_session は渡さない)。cwd が分からなければ押せず、
// 説明は起動と同じ既存の文。生きているセッションの再起動の説明は今のまま。
//
// Unless a test gives one, the daemon names nothing of the session (`{}`).
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  AgentInfo,
  ErrorResponse,
  LaunchInput,
  ReplyOf,
  RequestOverrideResponse,
  SessionContextUsage,
  SessionEnvResponse,
  SessionKillResponse,
  SessionRestartResponse,
  SessionStatusSnapshot,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { StatusPanel, useSessionRestart } from "../src/client/components/StatusPanel.tsx";
import { FORK_PROMPT } from "../src/client/status-session-forms.ts";
import { RESTART_PROMPT } from "@ccmsg/protocol";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";
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

const SID = "ffffffff-0000-4000-8000-000000000007";
const OTHER_SID = "ffffffff-0000-4000-8000-000000000008";
const NEW_SID = "ffffffff-0000-4000-8000-000000000009";
const CWD = "/repos/app";
const NAME = "🟢app 20261115T0100";

let roots: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  localStorage.clear();
});

interface Mounted {
  root: HTMLElement;
  launches: LaunchInput[];
  /** Restarts and kills asked for, in order: a fork asks for neither. */
  stops: string[];
  answer: (reply: ReplyOf<"session_launch">) => Promise<void>;
}

async function mount(
  options: {
    sid?: string;
    /** The session's cwd; CWD unless given. */
    cwd?: string;
    /** The session's process (its agents row) with its name; none at all
     * when null, the cwd then known from a bookmark ("unknown": not even that). */
    agent?: { name?: string } | null | "unknown";
    /** What the session ran as, in the tab's snapshot. */
    context?: SessionContextUsage;
    /** The session override's values (DR-0041 §5), as the tab holds them. */
    override?: { model: string | null; effort: string | null };
    /** What the daemon reads the session as running as, each time it is
     * asked (the last one again past the end); `{}` unless given. */
    runsAs?: readonly ReplyOf<"session_runs_as">[];
  } = {},
): Promise<Mounted> {
  const sid = options.sid ?? SID;
  const cwd = options.cwd ?? CWD;
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: true });
  if (options.agent === "unknown") {
    // Neither a process nor a bookmark: the webui knows no cwd for the session.
  } else if (options.agent === null) {
    store.dispatch({
      type: "session-bookmarks/added",
      bookmark: {
        sid,
        cwd,
        repo: null,
        ws: null,
        title: null,
        file: "",
        updated_at: "2026-11-15T00:00:00.000Z",
      },
    });
  } else {
    const agent: AgentInfo = {
      pid: 4242,
      cwd,
      kind: "interactive",
      startedAt: 0,
      sessionId: sid,
      config_dir: "/home/u/.claude-personal",
      ...(options.agent?.name === undefined ? {} : { name: options.agent.name }),
    };
    store.dispatch({ type: "agents/loaded", agents: [agent] });
  }
  if (options.override !== undefined) {
    store.dispatch({
      type: "request-overrides/changed",
      sid,
      target: "session",
      values: options.override,
    });
  }
  const launches: LaunchInput[] = [];
  const stops: string[] = [];
  let resolve: ((reply: ReplyOf<"session_launch">) => void) | undefined;
  const runsAs = options.runsAs ?? [{ ok: true }];
  let runsAsReads = 0;
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    sessionLauncherConfig: () => Promise.resolve({ ok: true, root_dirs: ["/repos/"] }),
    sessionRunsAs: () => {
      const reply = runsAs[Math.min(runsAsReads, runsAs.length - 1)] ?? { ok: true };
      runsAsReads++;
      return Promise.resolve(reply);
    },
    sessionLaunch: (req) => {
      launches.push(req.launch);
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => {
    stops.push("session_restart");
    return new Promise(() => {});
  };
  const onKill = (): Promise<SessionKillResponse | ErrorResponse> => {
    stops.push("session_kill");
    return Promise.resolve({ ok: true, terminated: true });
  };
  const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, pid: 4242, env: {} });
  const onOverride = (): Promise<RequestOverrideResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, delivery: "applied" });
  const snapshot: SessionStatusSnapshot = {
    todos: [],
    workflows: [],
    background: [],
    ...(options.context === undefined ? {} : { context: options.context }),
  };
  function Host() {
    const restart = useSessionRestart(sid, onRestart);
    return h(StatusPanel, {
      shown: true,
      snapshot,
      loading: true,
      failure: null,
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
  await act(() => render(h(AppContext.Provider, { value: { store, ws } }, h(Host, {})), root));
  return {
    root,
    launches,
    stops,
    answer: async (reply) => {
      await act(() => {
        resolve?.(reply);
        return Promise.resolve();
      });
      for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    },
  };
}

const FORK = "fork";

/** The daemon reads the session as running on opus / high. */
const OPUS_HIGH: ReplyOf<"session_runs_as"> = {
  ok: true,
  model: "claude-opus-5-5",
  effort: "high",
};

function forkDialog(root: HTMLElement): HTMLDialogElement | null {
  return dialogTitled(root, FORK);
}

function forkForm(root: HTMLElement): HTMLFormElement | null {
  const found = root.querySelector(".status-fork-form");
  return found === null ? null : instanceOf(found, HTMLFormElement, "the fork form");
}

function formText(root: HTMLElement): HTMLTextAreaElement {
  return instanceOf(
    forkForm(root)?.querySelector("textarea"),
    HTMLTextAreaElement,
    "the fork form's text",
  );
}

function formButton(root: HTMLElement, className: string): HTMLButtonElement {
  return instanceOf(
    forkForm(root)?.querySelector(`button.${className}`),
    HTMLButtonElement,
    `the fork form's ${className}`,
  );
}

function sendButton(root: HTMLElement): HTMLButtonElement {
  return formButton(root, "session-input-send");
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  return formButton(root, "session-input-secondary");
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The fork's result card under the list (outside the dialog). */
function tabResult(root: HTMLElement): HTMLElement | null {
  const found = root.querySelector(".status-session-actions > .status-fork-result");
  return found === null ? null : instanceOf(found, HTMLElement, "the fork result");
}

describe("Status の fork", () => {
  test("a row under 再起動, its button fork; pressed anywhere, the row opens the restart's form in a dialog titled fork", async () => {
    const { root } = await mount({ agent: { name: NAME }, runsAs: [OPUS_HIGH] });
    expect(actionNames(root, ".status-session-actions")).toEqual([
      "新セッションを起動",
      "再起動",
      FORK,
    ]);
    expect(actionButton(root, FORK).textContent).toBe("fork");
    expect(actionRow(root, FORK)?.textContent).toContain(
      "このセッションを続けたまま、同じ履歴の新しいセッションを起動する",
    );
    expect(forkDialog(root)).toBeNull();
    const desc = actionRow(root, FORK)?.querySelector(".status-action-desc");
    await act(() => instanceOf(desc, HTMLElement, "the fork row's description").click());
    for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    expect(forkDialog(root)?.open).toBe(true);
    const text = formText(root);
    expect(text.value).toBe(FORK_PROMPT);
    expect(document.activeElement).toBe(text);
    const row = text.parentElement?.nextElementSibling;
    expect(row?.classList.contains("session-input-actions")).toBe(true);
    expect(
      [...(row?.children ?? [])].map((el) => el.getAttribute("aria-label") ?? el.textContent),
    ).toEqual(["本文の表示形式", "デフォルトに保存", "--model", "--effort", "fork"]);
  });

  test("the model and effort open on what the daemon reads the session as running as, and fork sends session_launch resuming it with fork_session under its name and what the form shows, no restart, no kill", async () => {
    const mounted = await mount({ agent: { name: NAME }, runsAs: [OPUS_HIGH] });
    await openAction(mounted.root, FORK);
    const form = forkForm(mounted.root);
    expect(pickText(form, "--model").textContent).toBe("opus");
    expect(pickText(form, "--effort").textContent).toBe("high");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      {
        cwd: CWD,
        resume: SID,
        fork_session: true,
        model: "opus",
        effort: "high",
        name: NAME,
        prompt: FORK_PROMPT,
      },
    ]);
    expect(mounted.stops).toEqual([]);
    expect(sendButton(mounted.root).textContent).toBe("fork 中…");
    expect(sendButton(mounted.root).disabled).toBe(true);
    expect(formText(mounted.root).readOnly).toBe(true);
    await mounted.answer({ ok: true, session_id: NEW_SID, exit_code: 0, stdout: "", stderr: "" });
    expect(forkDialog(mounted.root)).toBeNull();
    const result = tabResult(mounted.root);
    expect(result?.dataset.tone).toBe("ok");
    expect(result?.querySelector(".status-op-result-title")?.textContent).toBe("fork");
    expect(result?.querySelector(".session-creator-result a")?.textContent).toBe(NEW_SID);
    expect(mounted.stops).toEqual([]);
  });

  test("a mythos session opens on mythos and its effort, as the daemon reads it, whatever its spelling, and the launch carries what is shown", async () => {
    for (const [model, effort] of [
      ["mythos", "low"],
      ["claude-mythos-5-2", "high"],
      ["mythos[1m]", "max"],
    ] as const) {
      const mounted = await mount({ agent: { name: NAME }, runsAs: [{ ok: true, model, effort }] });
      await openAction(mounted.root, FORK);
      const form = forkForm(mounted.root);
      expect(pickText(form, "--model").textContent).toBe("mythos");
      expect(pickText(form, "--effort").textContent).toBe(effort);
      await act(() => sendButton(mounted.root).click());
      expect(mounted.launches).toEqual([
        {
          cwd: CWD,
          resume: SID,
          fork_session: true,
          model: "mythos",
          effort,
          name: NAME,
          prompt: FORK_PROMPT,
        },
      ]);
      await act(() => render(null, mounted.root));
    }
  });

  // The tab's own status and override store lag the session (an override
  // push not yet come, one kept from a process that has gone): the form goes
  // by the daemon's reading only, the one it fills a resume with, so it
  // cannot show one model while the fork goes on another.
  test("the tab's snapshot and override store are not what it opens on: the daemon's reading is", async () => {
    const mounted = await mount({
      agent: { name: NAME },
      context: {
        model: "claude-fable-5-2",
        effort: "low",
        engine: { model: "fable[1m]", effort: "low" },
        timestamp: "2026-11-11T00:00:00.000Z",
      },
      override: { model: "sonnet", effort: "xhigh" },
      runsAs: [{ ok: true, model: "claude-mythos-5-2", effort: "medium" }],
    });
    await openAction(mounted.root, FORK);
    expect(pickText(forkForm(mounted.root), "--model").textContent).toBe("mythos");
    expect(pickText(forkForm(mounted.root), "--effort").textContent).toBe("medium");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      {
        cwd: CWD,
        resume: SID,
        fork_session: true,
        model: "mythos",
        effort: "medium",
        name: NAME,
        prompt: FORK_PROMPT,
      },
    ]);
  });

  test("an effort chosen alone goes with the launch, the model as shown with it", async () => {
    const mounted = await mount({ agent: { name: NAME }, runsAs: [OPUS_HIGH] });
    await openAction(mounted.root, FORK);
    await choosePick(forkForm(mounted.root), "--effort", "max");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      {
        cwd: CWD,
        resume: SID,
        fork_session: true,
        model: "opus",
        effort: "max",
        name: NAME,
        prompt: FORK_PROMPT,
      },
    ]);
  });

  test("a model chosen takes its effort, over the session's and one chosen before; an effort may be chosen alone", async () => {
    const mounted = await mount({ agent: { name: NAME }, runsAs: [OPUS_HIGH] });
    await openAction(mounted.root, FORK);
    const form = forkForm(mounted.root);
    await choosePick(form, "--effort", "max");
    expect(pickText(form, "--model").textContent).toBe("opus");
    await choosePick(form, "--model", "fable");
    expect(pickText(form, "--effort").textContent).toBe("low");
    await choosePick(form, "--model", "opus");
    expect(pickText(form, "--effort").textContent).toBe("medium");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.launches[0]).toMatchObject({
      fork_session: true,
      model: "opus",
      effort: "medium",
    });
  });

  // A field the daemon names nothing of, or names with a spelling the launch
  // cannot (another vendor's model, an effort given as a budget), shows
  // 元の model / 元の effort and is left out, as a restart's: the daemon then
  // fills it with what the session runs as, which names none of it either,
  // so the launch command decides it.
  test("a model or effort it cannot name for the session opens on 元の model / 元の effort and is left out; no name, no name sent", async () => {
    for (const runsAs of [{ ok: true }, { ok: true, model: "gpt-5", effort: "12000" }] as const) {
      const mounted = await mount({ runsAs: [runsAs] });
      await openAction(mounted.root, FORK);
      expect(pickText(forkForm(mounted.root), "--model").textContent).toBe("元の model");
      expect(pickText(forkForm(mounted.root), "--effort").textContent).toBe("元の effort");
      await act(() => sendButton(mounted.root).click());
      expect(mounted.launches).toEqual([
        { cwd: CWD, resume: SID, fork_session: true, prompt: FORK_PROMPT },
      ]);
      await act(() => render(null, mounted.root));
    }
  });

  // As the restart's: a choice holds while the form is open, and the form
  // opened again reads the session anew.
  test("opened again, it reads the session anew and starts on that, not on what was chosen", async () => {
    const mounted = await mount({
      agent: { name: NAME },
      runsAs: [
        { ok: true, model: "fable[1m]", effort: "low" },
        { ok: true, model: "mythos", effort: "high" },
      ],
    });
    await openAction(mounted.root, FORK);
    await choosePick(forkForm(mounted.root), "--model", "haiku");
    expect(pickText(forkForm(mounted.root), "--model").textContent).toBe("haiku");
    const dialog = forkDialog(mounted.root);
    if (dialog === null) throw new Error("expected the fork dialog");
    await pressEscape(dialog);
    await openAction(mounted.root, FORK);
    expect(pickText(forkForm(mounted.root), "--model").textContent).toBe("mythos");
    expect(pickText(forkForm(mounted.root), "--effort").textContent).toBe("high");
    await act(() => sendButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      {
        cwd: CWD,
        resume: SID,
        fork_session: true,
        model: "mythos",
        effort: "high",
        name: NAME,
        prompt: FORK_PROMPT,
      },
    ]);
  });

  test("while the session is read, the dialog says 確認中… and holds no form", async () => {
    const mounted = await mount({ runsAs: [OPUS_HIGH] });
    await act(() => actionButton(mounted.root, FORK).click());
    expect(forkDialog(mounted.root)?.open).toBe(true);
    expect(forkForm(mounted.root)).toBeNull();
    expect(forkDialog(mounted.root)?.textContent).toContain("確認中…");
    for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    expect(forkForm(mounted.root)).not.toBeNull();
  });

  test("a read of the session that fails says why in the dialog, and no fork can be sent", async () => {
    const mounted = await mount({
      runsAs: [{ ok: false, error: { code: "internal", msg: "the tail was not read" } }],
    });
    await openAction(mounted.root, FORK);
    expect(forkForm(mounted.root)).toBeNull();
    expect(forkDialog(mounted.root)?.textContent).toContain("the tail was not read");
    expect(mounted.launches).toEqual([]);
  });

  test("デフォルトに保存 keeps the prompt only, apart from the restart's, and the form opens on it", async () => {
    const mounted = await mount({ agent: { name: NAME }, runsAs: [OPUS_HIGH] });
    await openAction(mounted.root, FORK);
    await choosePick(forkForm(mounted.root), "--model", "haiku");
    await typeInto(formText(mounted.root), "fork の続き");
    await act(() => saveButton(mounted.root).click());
    expect(saveButton(mounted.root).textContent).toBe("保存済み");
    expect(JSON.parse(localStorage.getItem("ccmsg.statusForms") ?? "null")).toEqual({
      v: 1,
      fork: { prompt: "fork の続き" },
    });
    const dialog = forkDialog(mounted.root);
    if (dialog === null) throw new Error("expected the fork dialog");
    await act(() => closeButton(dialog).click());
    await openAction(mounted.root, FORK);
    expect(formText(mounted.root).value).toBe("fork の続き");
    expect(pickText(forkForm(mounted.root), "--model").textContent).toBe("opus");
    expect(pickText(forkForm(mounted.root), "--effort").textContent).toBe("high");

    const elsewhere = await mount({ sid: OTHER_SID, cwd: "/repos/other", agent: { name: NAME } });
    await openAction(elsewhere.root, FORK);
    expect(formText(elsewhere.root).value).toBe("fork の続き");
    expect(saveButton(elsewhere.root).textContent).toBe("保存済み");
  });

  test("a value left under the key of a cwd is not read", async () => {
    localStorage.setItem(`ccmsg.statusForms.${CWD}`, '{"v":1,"fork":{"prompt":"前の鍵の続き"}}');
    const mounted = await mount({ agent: { name: NAME } });
    await openAction(mounted.root, FORK);
    expect(formText(mounted.root).value).toBe(FORK_PROMPT);
    expect(saveButton(mounted.root).textContent).toBe("デフォルトに保存");
    const successor = await mount({ sid: OTHER_SID, runsAs: [OPUS_HIGH] });
    await openAction(successor.root, "再起動");
    const restartText = successor.root.querySelector(".status-restart-form textarea");
    expect(instanceOf(restartText, HTMLTextAreaElement, "the restart text").value).not.toBe(
      "fork の続き",
    );
  });

  test("an empty text cannot be sent", async () => {
    const mounted = await mount({ runsAs: [OPUS_HIGH] });
    await openAction(mounted.root, FORK);
    await typeInto(formText(mounted.root), " \n");
    expect(sendButton(mounted.root).disabled).toBe(true);
    await act(() => forkForm(mounted.root)?.requestSubmit());
    expect(mounted.launches).toEqual([]);
  });

  test("⌘+Enter in the text forks like the button; a bare Enter does not", async () => {
    const mounted = await mount({ runsAs: [OPUS_HIGH] });
    await openAction(mounted.root, FORK);
    expect(formText(mounted.root).placeholder).toContain("⌘+Enter で fork");
    expect(sendButton(mounted.root).title).toContain("⌘+Enter");
    await act(() => {
      formText(mounted.root).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(mounted.launches).toEqual([]);
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
    expect(mounted.launches).toHaveLength(1);
  });

  test("a launch command that did not exit 0 keeps the dialog open with what it came to, there and under the list; while it ran, the dialog stayed", async () => {
    const mounted = await mount({ runsAs: [OPUS_HIGH] });
    await openAction(mounted.root, FORK);
    await typeInto(formText(mounted.root), "続きから");
    await act(() => sendButton(mounted.root).click());
    const dialog = forkDialog(mounted.root);
    if (dialog === null) throw new Error("expected the fork dialog");
    expect(await pressEscape(dialog)).toBe(false);
    expect(closeButton(dialog).disabled).toBe(true);
    expect(
      instanceOf(
        mounted.root.querySelector(".status-kill-zone .status-kill-button"),
        HTMLButtonElement,
        "the kill button",
      ).disabled,
    ).toBe(true);
    await mounted.answer({ ok: true, exit_code: 1, stdout: "", stderr: "untrusted cwd" });
    expect(forkDialog(mounted.root)?.open).toBe(true);
    expect(formText(mounted.root).value).toBe("続きから");
    const inDialog = forkDialog(mounted.root)?.querySelector(".status-fork-result");
    expect(inDialog?.getAttribute("data-tone")).toBe("error");
    expect(inDialog?.textContent).toContain("untrusted cwd");
    expect(tabResult(mounted.root)?.textContent).toContain("untrusted cwd");
  });

  // session_launch resumes a transcript whether or not its process runs, so
  // a fork needs the cwd only: a session whose process is gone forks from
  // the cwd its bookmark keeps.
  test("without a known cwd, the row says why and does not open", async () => {
    const { root } = await mount({ agent: "unknown" });
    expect(actionRow(root, FORK)?.textContent).toContain("cwd が分からないので fork できません");
    expect(actionButton(root, FORK).disabled).toBe(true);
    const name = actionRow(root, FORK)?.querySelector(".status-action-name");
    await act(() => instanceOf(name, HTMLElement, "the fork row's name").click());
    expect(forkDialog(root)).toBeNull();
  });

  test("offered without the session's process when the cwd is known, as 再起動 is", async () => {
    const mounted = await mount({ agent: null });
    expect(actionNames(mounted.root, ".status-session-actions")).toEqual([
      "新セッションを起動",
      "再起動",
      FORK,
    ]);
    await openAction(mounted.root, FORK);
    await act(() => sendButton(mounted.root).click());
    expect(mounted.launches[0]).toMatchObject({ cwd: CWD, resume: SID, fork_session: true });
  });
});

describe("the 再起動 of a session that ended", () => {
  const RESTART = "再起動";
  const descOf = (root: HTMLElement): string | null | undefined =>
    actionRow(root, RESTART)?.querySelector(".status-action-desc")?.textContent;
  const restartDialog = (root: HTMLElement) => dialogTitled(root, RESTART);

  test("offered, saying it resumes the same session_id; sent, it resumes it in its cwd, stopping nothing", async () => {
    const mounted = await mount({ agent: null, runsAs: [OPUS_HIGH] });
    expect(descOf(mounted.root)).toBe("同じ session_id で resume する");
    await openAction(mounted.root, RESTART);
    const dialog = instanceOf(restartDialog(mounted.root), HTMLDialogElement, "the dialog");
    const form = instanceOf(dialog.querySelector(".status-restart-form"), HTMLFormElement, "form");
    // No model nor effort to choose: the resumed session goes on on its own.
    expect(form.querySelector("button.override-value")).toBeNull();
    const text = instanceOf(form.querySelector("textarea"), HTMLTextAreaElement, "text");
    expect(text.value).toBe(RESTART_PROMPT);
    const send = instanceOf(
      form.querySelector("button.session-input-send"),
      HTMLButtonElement,
      "send",
    );
    expect(send.textContent).toBe("再起動");
    await act(() => send.click());
    expect(mounted.launches).toEqual([{ cwd: CWD, resume: SID, prompt: RESTART_PROMPT }]);
    expect(mounted.stops).toEqual([]);
    await mounted.answer({
      ok: true,
      session_id: SID,
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    // Resumed: the dialog closes, and what it came to stays under the list.
    expect(restartDialog(mounted.root)).toBeNull();
    expect(
      mounted.root
        .querySelector(".status-session-actions > .status-restart-result")
        ?.getAttribute("data-tone"),
    ).toBe("ok");
  });

  test("without a cwd it cannot be pressed, and says so as 新セッションを起動 does", async () => {
    const mounted = await mount({ agent: "unknown" });
    expect(descOf(mounted.root)).toBe(
      "このセッションの cwd が分からないので起動できません (切断中)",
    );
    expect(actionButton(mounted.root, RESTART).disabled).toBe(true);
  });

  test("a live session's 再起動 is as it was: stop, then resume", async () => {
    const mounted = await mount({ agent: { name: NAME } });
    expect(descOf(mounted.root)).toBe("止めてから同じ session_id で resume する");
  });
});
