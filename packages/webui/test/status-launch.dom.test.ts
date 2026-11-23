// DR-0018 §3.9 / DR-0028 「restart」: the Status tab's 新セッションを起動 as
// mounted — a row of セッション操作 above the danger zone whose button opens a
// modal dialog with a form in this session's cwd, the FAB's prompt form (its
// textarea, then its row with the save, the --model / --effort selects as the
// FAB's effort select, and the send): model / effort start on what the
// session runs as as the daemon reads it when the form opens
// (`session_runs_as`, kawaz 2026-11-17), a value the launch cannot name
// asking for a choice, and `fable` / the model's effort (ccmsg's table) only
// where nothing names the field; a model chosen takes its own effort; the
// prompt on 準備して待て; what it sends is cwd, model, effort and prompt only; a
// session launched closes the dialog, anything else keeps it open with what
// it came to, which also shows under the list; デフォルトに保存 keeps the
// prompt and the form opens on it, the model and effort never on what was
// saved; while it runs, the kill waits and the dialog stays; no cwd, no
// dialog but the reason.
//
// The daemon's reading stands for what the session runs as here: which of
// the session override, the module's own values and the transcript decides
// it is the daemon's (session-restart.test.ts, `session_runs_as`). Unless a
// test gives one, the daemon names nothing of the session (`{}`).
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
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubProperty } from "./helpers.ts";
import {
  actionButton,
  actionRow,
  choosePick,
  closeButton,
  dialogTitled,
  openAction,
  pickText,
  pressEscape,
} from "./status-actions.ts";

withDom();

const SID = "dddddddd-0000-4000-8000-000000000004";
const OTHER_SID = "dddddddd-0000-4000-8000-000000000005";
const NEW_SID = "dddddddd-0000-4000-8000-000000000006";
const CWD = "/repos/app";

let roots: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  localStorage.clear();
});

function agentRow(sid: string, cwd: string): AgentInfo {
  return {
    pid: 4242,
    cwd,
    kind: "interactive",
    startedAt: 0,
    sessionId: sid,
    config_dir: "/home/u/.claude-personal",
  };
}

function snapshotWith(context: SessionContextUsage | undefined): SessionStatusSnapshot {
  return {
    todos: [],
    workflows: [],
    background: [],
    ...(context === undefined ? {} : { context }),
  };
}

interface Mounted {
  root: HTMLElement;
  launches: LaunchInput[];
  /** How many times the launch config was read. */
  configReads: () => number;
  /** The sessions whose runs-as was read, oldest first. */
  runsAsReads: () => string[];
  /** Answers the pending launch. */
  answer: (reply: ReplyOf<"session_launch">) => Promise<void>;
}

async function mount(
  options: {
    sid?: string;
    /** The session's cwd, or null for one the webui does not know. */
    cwd?: string | null;
    context?: SessionContextUsage;
    /** The session override's values (DR-0041 §5). */
    override?: { model: string | null; effort: string | null };
    launchAvailable?: boolean;
    /** What the daemon reads the session as running as, each time it is
     * asked (the last one again past the end); `{}` unless given. */
    runsAs?: readonly ReplyOf<"session_runs_as">[];
  } = {},
): Promise<Mounted> {
  const sid = options.sid ?? SID;
  const cwd = options.cwd === undefined ? CWD : options.cwd;
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: options.launchAvailable ?? true });
  if (cwd !== null) store.dispatch({ type: "agents/loaded", agents: [agentRow(sid, cwd)] });
  if (options.override !== undefined) {
    store.dispatch({
      type: "request-overrides/changed",
      sid,
      target: "session",
      values: options.override,
    });
  }
  const launches: LaunchInput[] = [];
  let configReads = 0;
  const runsAsReads: string[] = [];
  const runsAs = options.runsAs ?? [{ ok: true }];
  let resolve: ((reply: ReplyOf<"session_launch">) => void) | undefined;
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    sessionLauncherConfig: () => {
      configReads++;
      return Promise.resolve({ ok: true, root_dirs: ["/repos/"] });
    },
    sessionRunsAs: (sessionId) => {
      const reply = runsAs[Math.min(runsAsReads.length, runsAs.length - 1)] ?? { ok: true };
      runsAsReads.push(sessionId);
      return Promise.resolve(reply);
    },
    sessionLaunch: (req) => {
      launches.push(req.launch);
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => new Promise(() => {});
  const onKill = (): Promise<SessionKillResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, terminated: true });
  const onLoadEnv = (): Promise<SessionEnvResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, pid: 4242, env: {} });
  const onOverride = (): Promise<RequestOverrideResponse | ErrorResponse> =>
    Promise.resolve({ ok: true, delivery: "applied" });
  const snapshot = snapshotWith(options.context);
  function Host() {
    const restart = useSessionRestart(sid, onRestart);
    return h(StatusPanel, {
      shown: true,
      snapshot,
      loading: true,
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
    configReads: () => configReads,
    runsAsReads: () => [...runsAsReads],
    answer: async (reply) => {
      await act(() => {
        resolve?.(reply);
        return Promise.resolve();
      });
      await settle();
    },
  };
}

/** Let the config / launch promises and the renders they cause land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
}

const LAUNCH = "新セッションを起動";

function launchDialog(root: HTMLElement): HTMLDialogElement | null {
  return dialogTitled(root, LAUNCH);
}

async function openLaunch(root: HTMLElement): Promise<void> {
  await openAction(root, LAUNCH);
}

/** Close the dialog with Escape. */
async function closeLaunch(root: HTMLElement): Promise<void> {
  const dialog = launchDialog(root);
  if (dialog === null) throw new Error("expected the launch dialog, found none");
  await pressEscape(dialog);
}

function launchForm(root: HTMLElement): HTMLFormElement | null {
  const found = root.querySelector(".status-launch-form");
  return found === null ? null : instanceOf(found, HTMLFormElement, "the launch form");
}

/** What the `--model` / `--effort` select shows at rest. */
function picked(root: HTMLElement, label: string): string | null {
  return pickText(launchForm(root), label).textContent;
}

async function pick(root: HTMLElement, label: string, value: string): Promise<void> {
  await choosePick(launchForm(root), label, value);
}

function promptText(root: HTMLElement): HTMLTextAreaElement {
  return instanceOf(
    launchForm(root)?.querySelector("textarea"),
    HTMLTextAreaElement,
    "the launch prompt",
  );
}

function button(root: HTMLElement, selector: string): HTMLButtonElement {
  return instanceOf(root.querySelector(selector), HTMLButtonElement, selector);
}

function launchButton(root: HTMLElement): HTMLButtonElement {
  return button(root, ".status-launch-form .session-input-send");
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  return button(root, ".status-launch-form .session-input-secondary");
}

/** The launch's result card under the list (outside the dialog). */
function tabResult(root: HTMLElement): HTMLElement | null {
  const found = root.querySelector(".status-session-actions > .status-launch-result");
  return found === null ? null : instanceOf(found, HTMLElement, "the launch result");
}

async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const CONTEXT: SessionContextUsage = {
  model: "claude-opus-5-5",
  effort: "medium",
  timestamp: "2026-11-09T00:00:00.000Z",
};

describe("Status の新セッションを起動", () => {
  test("a row in セッション操作 whose button opens the form in a modal dialog, the launch config read only then; Escape closes it", async () => {
    const mounted = await mount({ context: CONTEXT });
    const { root } = mounted;
    expect(actionRow(root, LAUNCH)?.closest(".status-session-actions")).not.toBeNull();
    expect(actionButton(root, LAUNCH).textContent).toBe("起動");
    expect(launchDialog(root)).toBeNull();
    expect(mounted.configReads()).toBe(0);
    await openLaunch(root);
    expect(launchDialog(root)?.open).toBe(true);
    expect(launchForm(root)?.closest("dialog")).toBe(launchDialog(root));
    expect(launchDialog(root)?.textContent).toContain(`cwd${CWD}`);
    expect(mounted.configReads()).toBe(1);
    await closeLaunch(root);
    expect(launchDialog(root)).toBeNull();
    expect(launchForm(root)).toBeNull();
  });

  test("the FAB's prompt form: the textarea, then right under it one row of デフォルトに保存, --model, --effort and 起動", async () => {
    const { root } = await mount({ context: CONTEXT });
    await openLaunch(root);
    const form = launchForm(root);
    const text = promptText(root);
    expect(text.classList.contains("session-input-textarea")).toBe(true);
    const row = text.nextElementSibling;
    expect(row?.classList.contains("session-input-actions")).toBe(true);
    const controls = [...(row?.children ?? [])].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(controls).toEqual(["デフォルトに保存", "--model", "--effort", "起動"]);
    expect(launchButton(root).classList.contains("session-input-send")).toBe(true);
    // The cwd it starts in is above the text; nothing is pinned to the dialog's bottom.
    expect(form?.firstElementChild?.textContent).toBe(`cwd${CWD}`);
    expect(launchDialog(root)?.querySelector(".modal-dialog-foot")).toBeNull();
  });

  test("--model and --effort are the FAB's select: pressed, the text turns into the select of the values", async () => {
    const { root } = await mount({ context: CONTEXT });
    await openLaunch(root);
    const form = launchForm(root);
    await act(() => pickText(form, "--model").click());
    const models = instanceOf(
      form?.querySelector('select[aria-label="--model"]'),
      HTMLSelectElement,
      "the --model select",
    );
    expect([...models.options].map((o) => o.value)).toEqual([
      "mythos",
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(models.value).toBe("fable");
  });

  test("a model chosen takes its effort, over one chosen before, and the launch goes with what is shown", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    await pick(mounted.root, "--effort", "high");
    await pick(mounted.root, "--model", "opus");
    expect(picked(mounted.root, "--effort")).toBe("medium");
    await pick(mounted.root, "--model", "fable");
    expect(picked(mounted.root, "--effort")).toBe("low");
    await pick(mounted.root, "--model", "opus");
    await act(() => launchButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      { cwd: CWD, model: "opus", effort: "medium", prompt: "準備して待て" },
    ]);
  });

  // Rule 4 of kawaz 2026-11-17: only where nothing names what the session
  // runs as (a session whose transcript has no answer yet and whose module
  // sent no facts) does a field fall to the defaults, `fable` and the
  // model's effort in ccmsg's table.
  test("where the daemon names nothing the session runs as, the model / effort start on fable / low", async () => {
    const { root } = await mount({ context: CONTEXT, runsAs: [{ ok: true }] });
    await openLaunch(root);
    expect(picked(root, "--model")).toBe("fable");
    expect(picked(root, "--effort")).toBe("low");
    expect(promptText(root).value).toBe("準備して待て");
    expect(document.activeElement).toBe(promptText(root));
  });

  // kawaz 2026-11-17: 「起動と再起動のフォームのモデルとエフォートは保存しない
  // し設定も見ないし、今のセッションの値にする」. A mythos session's form
  // showing fable was the defaults standing in for the session's value. The
  // value is the daemon's reading, the one a restart is filled with, read
  // when the form opens (not the tab's snapshot nor its override store, here
  // saying opus / xhigh, which a restart does not go by): the model by its
  // family, whatever spelling the source gives it.
  test("opens on what the session runs as as the daemon reads it: a mythos session on mythos and its effort, sent as shown", async () => {
    const mounted = await mount({
      context: { ...CONTEXT, engine: { model: "opus", effort: "xhigh" } },
      override: { model: "opus", effort: "xhigh" },
      runsAs: [{ ok: true, model: "mythos", effort: "high" }],
    });
    expect(mounted.runsAsReads()).toEqual([]);
    await openLaunch(mounted.root);
    expect(mounted.runsAsReads()).toEqual([SID]);
    expect(picked(mounted.root, "--model")).toBe("mythos");
    expect(picked(mounted.root, "--effort")).toBe("high");
    await act(() => launchButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      { cwd: CWD, model: "mythos", effort: "high", prompt: "準備して待て" },
    ]);

    for (const [model, sid] of [
      ["claude-mythos-5-2", OTHER_SID],
      ["mythos[1m]", NEW_SID],
    ] as const) {
      const spelled = await mount({ sid, runsAs: [{ ok: true, model, effort: "low" }] });
      await openLaunch(spelled.root);
      expect(picked(spelled.root, "--model")).toBe("mythos");
      expect(picked(spelled.root, "--effort")).toBe("low");
    }
  });

  // A model the select has no option for (another vendor's) is a value the
  // session runs as, not a missing one: offering fable in its place would
  // read as the session's model. The select asks for a choice (its
  // `model を選ぶ`), and the launch, which must name a model, waits for one.
  test("a model the launch cannot name opens asking for a choice, not on fable, and the launch waits for one", async () => {
    const mounted = await mount({ runsAs: [{ ok: true, model: "gpt-5", effort: "medium" }] });
    await openLaunch(mounted.root);
    expect(picked(mounted.root, "--model")).toBe("model を選ぶ");
    expect(picked(mounted.root, "--effort")).toBe("medium");
    await act(() => launchButton(mounted.root).click());
    expect(mounted.launches).toEqual([]);
    expect(launchForm(mounted.root)?.textContent).toContain(
      "--model: 選んでください (continue も resume も無い新規の起動では必須)",
    );
    await pick(mounted.root, "--model", "mythos");
    expect(picked(mounted.root, "--effort")).toBe("low");
    await act(() => launchButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      { cwd: CWD, model: "mythos", effort: "low", prompt: "準備して待て" },
    ]);
  });

  // Rule 4 is per field: an effort named is shown though the model falls to
  // the default, and an effort the launch cannot name (a budget) asks for one.
  test("each field on its own: an effort named over a defaulted model, an effort it cannot name asking for one", async () => {
    const effortOnly = await mount({ runsAs: [{ ok: true, effort: "xhigh" }] });
    await openLaunch(effortOnly.root);
    expect(picked(effortOnly.root, "--model")).toBe("fable");
    expect(picked(effortOnly.root, "--effort")).toBe("xhigh");

    const budget = await mount({
      sid: OTHER_SID,
      runsAs: [{ ok: true, model: "mythos", effort: "12000" }],
    });
    await openLaunch(budget.root);
    expect(picked(budget.root, "--model")).toBe("mythos");
    expect(picked(budget.root, "--effort")).toBe("effort を選ぶ");
    await act(() => launchButton(budget.root).click());
    expect(budget.launches).toEqual([]);
  });

  // Rule 5: what the person chose holds while the form is open; opened again,
  // the form reads the session anew and starts from that, not from the
  // choice, here after the session moved from mythos to opus.
  test("opened again, it reads the session anew and starts on that, not on what was chosen", async () => {
    const mounted = await mount({
      runsAs: [
        { ok: true, model: "mythos", effort: "low" },
        { ok: true, model: "claude-opus-5-5", effort: "max" },
      ],
    });
    await openLaunch(mounted.root);
    await pick(mounted.root, "--model", "sonnet");
    await pick(mounted.root, "--effort", "high");
    expect(picked(mounted.root, "--model")).toBe("sonnet");
    await closeLaunch(mounted.root);
    await openLaunch(mounted.root);
    expect(mounted.runsAsReads()).toEqual([SID, SID]);
    expect(picked(mounted.root, "--model")).toBe("opus");
    expect(picked(mounted.root, "--effort")).toBe("max");
  });

  test("a read of the session that fails says why in the dialog, and no form is offered", async () => {
    const mounted = await mount({
      runsAs: [{ ok: false, error: { code: "internal", msg: "the tail was not read" } }],
    });
    await openLaunch(mounted.root);
    expect(launchForm(mounted.root)).toBeNull();
    expect(launchDialog(mounted.root)?.textContent).toContain("the tail was not read");
    expect(mounted.launches).toEqual([]);
  });

  test("起動 sends cwd, model, effort and prompt only; a session launched closes the dialog, what it came to under the list", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    await pick(mounted.root, "--effort", "high");
    await typeInto(promptText(mounted.root), "続きをやって");
    await act(() => launchButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      { cwd: CWD, model: "fable", effort: "high", prompt: "続きをやって" },
    ]);
    expect(launchButton(mounted.root).textContent).toBe("起動中…");
    await mounted.answer({ ok: true, session_id: NEW_SID, exit_code: 0, stdout: "", stderr: "" });
    expect(launchDialog(mounted.root)).toBeNull();
    const result = tabResult(mounted.root);
    expect(result?.dataset.tone).toBe("ok");
    expect(result?.querySelector(".session-creator-result a")?.textContent).toBe(NEW_SID);
    expect(result?.textContent).toContain("exit_code: 0");
  });

  test("a launch command that did not exit 0 keeps the dialog open with what it came to, there and under the list", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    await typeInto(promptText(mounted.root), "続きをやって");
    await act(() => launchButton(mounted.root).click());
    await mounted.answer({ ok: true, exit_code: 1, stdout: "", stderr: "no such model" });
    expect(launchDialog(mounted.root)?.open).toBe(true);
    expect(promptText(mounted.root).value).toBe("続きをやって");
    expect(launchButton(mounted.root).textContent).toBe("起動");
    const inDialog = launchDialog(mounted.root)?.querySelector(".status-launch-result");
    expect(inDialog?.getAttribute("data-tone")).toBe("error");
    expect(inDialog?.textContent).toContain("no such model");
    expect(tabResult(mounted.root)?.textContent).toContain("no such model");
    // Closed, the result stays under the list.
    await closeLaunch(mounted.root);
    expect(tabResult(mounted.root)?.textContent).toContain("no such model");
  });

  test("a launch the daemon refused keeps the dialog open with the reason", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    await act(() => launchButton(mounted.root).click());
    await mounted.answer({ ok: false, error: { code: "launch_failed", msg: "spawn failed" } });
    expect(launchDialog(mounted.root)?.open).toBe(true);
    expect(
      launchDialog(mounted.root)?.querySelector(".status-launch-result")?.getAttribute("data-tone"),
    ).toBe("error");
  });

  test("an empty prompt is left out, as the launch command's to decide", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    await typeInto(promptText(mounted.root), "");
    await act(() => launchButton(mounted.root).click());
    expect(mounted.launches).toEqual([{ cwd: CWD, model: "fable", effort: "low" }]);
  });

  test("⌘+Enter in the prompt launches like 起動, as the placeholder and the button's title say", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    expect(promptText(mounted.root).placeholder).toContain("⌘+Enter で起動");
    expect(launchButton(mounted.root).title).toContain("⌘+Enter");
    await act(() => {
      promptText(mounted.root).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(mounted.launches).toEqual([
      { cwd: CWD, model: "fable", effort: "low", prompt: "準備して待て" },
    ]);
  });

  test("while it runs, the form and the kill wait, and the dialog does not close", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    await act(() => launchButton(mounted.root).click());
    expect(launchButton(mounted.root).disabled).toBe(true);
    // As the FAB's: the text stays what was sent, the selects and the save wait.
    expect(promptText(mounted.root).readOnly).toBe(true);
    expect(pickText(launchForm(mounted.root), "--model").disabled).toBe(true);
    expect(pickText(launchForm(mounted.root), "--effort").disabled).toBe(true);
    expect(saveButton(mounted.root).disabled).toBe(true);
    expect(button(mounted.root, ".status-kill-zone .status-kill-button").disabled).toBe(true);
    const dialog = launchDialog(mounted.root);
    if (dialog === null) throw new Error("expected the launch dialog");
    expect(await pressEscape(dialog)).toBe(false);
    expect(closeButton(dialog).disabled).toBe(true);
    expect(launchDialog(mounted.root)?.open).toBe(true);
    await mounted.answer({ ok: true, exit_code: 0, stdout: "", stderr: "" });
    expect(button(mounted.root, ".status-kill-zone .status-kill-button").disabled).toBe(false);
  });

  test("デフォルトに保存 keeps the prompt only, for every session: the form opens on it, the model and effort on fable / low, for the next session there too", async () => {
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    expect(saveButton(mounted.root).textContent).toBe("デフォルトに保存");
    await pick(mounted.root, "--model", "sonnet");
    await pick(mounted.root, "--effort", "high");
    await typeInto(promptText(mounted.root), "いつもの準備");
    await act(() => saveButton(mounted.root).click());
    expect(saveButton(mounted.root).textContent).toBe("保存済み");
    expect(saveButton(mounted.root).disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem("ccmsg.statusForms") ?? "null")).toEqual({
      v: 1,
      launch: { prompt: "いつもの準備" },
    });

    await closeLaunch(mounted.root);
    await openLaunch(mounted.root);
    expect(picked(mounted.root, "--model")).toBe("fable");
    expect(picked(mounted.root, "--effort")).toBe("low");
    expect(promptText(mounted.root).value).toBe("いつもの準備");
    expect(saveButton(mounted.root).textContent).toBe("保存済み");

    const successor = await mount({ sid: OTHER_SID, context: CONTEXT });
    await openLaunch(successor.root);
    expect(picked(successor.root, "--model")).toBe("fable");
    expect(promptText(successor.root).value).toBe("いつもの準備");

    const elsewhere = await mount({ sid: NEW_SID, cwd: "/repos/other", context: CONTEXT });
    await openLaunch(elsewhere.root);
    expect(picked(elsewhere.root, "--model")).toBe("fable");
    expect(promptText(elsewhere.root).value).toBe("いつもの準備");
  });

  test("a value left under the key of a cwd is not read", async () => {
    localStorage.setItem(`ccmsg.statusForms.${CWD}`, '{"v":1,"launch":{"prompt":"前の鍵の準備"}}');
    const { root } = await mount({ context: CONTEXT });
    await openLaunch(root);
    expect(promptText(root).value).toBe("準備して待て");
    expect(saveButton(root).textContent).toBe("デフォルトに保存");
  });

  // A model and effort saved before only the prompt was saved are not read:
  // a new session starts on the defaults (kawaz 2026-11-15). The prompt
  // stored beside them still is, and the next save writes the prompt alone.
  test("a model and effort stored before are not read: fable / low, the stored prompt kept, and a save writes the prompt alone", async () => {
    localStorage.setItem(
      "ccmsg.statusForms",
      '{"v":1,"launch":{"model":"opus","effort":"xhigh","prompt":"いつもの準備"},"restart":{"prompt":"続き"}}',
    );
    const mounted = await mount({ context: CONTEXT });
    await openLaunch(mounted.root);
    expect(picked(mounted.root, "--model")).toBe("fable");
    expect(picked(mounted.root, "--effort")).toBe("low");
    expect(promptText(mounted.root).value).toBe("いつもの準備");
    expect(saveButton(mounted.root).textContent).toBe("保存済み");
    await typeInto(promptText(mounted.root), "新しい準備");
    await act(() => saveButton(mounted.root).click());
    expect(JSON.parse(localStorage.getItem("ccmsg.statusForms") ?? "null")).toEqual({
      v: 1,
      launch: { prompt: "新しい準備" },
      restart: { prompt: "続き" },
    });
    await act(() => launchButton(mounted.root).click());
    expect(mounted.launches).toEqual([
      { cwd: CWD, model: "fable", effort: "low", prompt: "新しい準備" },
    ]);
  });

  test("a stored value it cannot read is ignored", async () => {
    localStorage.setItem("ccmsg.statusForms", '{"v":1,"launch":{"model":"gpt"}}');
    const warned: string[] = [];
    const restore = stubProperty(console, "warn", {
      value: (message: string) => warned.push(message),
      configurable: true,
      writable: true,
    });
    try {
      const { root } = await mount({ context: CONTEXT });
      await openLaunch(root);
      expect(picked(root, "--model")).toBe("fable");
      expect(warned.length).toBe(1);
    } finally {
      restore();
    }
  });

  test("without a known cwd, the row says why and its button does not open", async () => {
    const { root } = await mount({ cwd: null });
    expect(actionRow(root, LAUNCH)?.textContent).toContain("cwd が分からないので起動できません");
    expect(actionButton(root, LAUNCH).disabled).toBe(true);
    expect(launchDialog(root)).toBeNull();
    // The row is not the way around its disabled button.
    const name = actionRow(root, LAUNCH)?.querySelector(".status-action-name");
    await act(() => instanceOf(name, HTMLElement, "the 起動 row's name").click());
    expect(launchDialog(root)).toBeNull();
  });

  test("a click anywhere in the 新セッションを起動 row opens its dialog", async () => {
    const { root } = await mount({});
    const desc = actionRow(root, LAUNCH)?.querySelector(".status-action-desc");
    await act(() => instanceOf(desc, HTMLElement, "the 起動 row's description").click());
    for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
    expect(launchDialog(root)?.open).toBe(true);
  });

  test("the row's description does not open with 「このセッションと」", async () => {
    const { root } = await mount({});
    const desc = actionRow(root, LAUNCH)?.querySelector(".status-action-desc");
    expect(desc?.textContent).toBe("同じ cwd で、別のセッションを立てる");
  });

  test("not offered when the daemon cannot launch", async () => {
    const { root } = await mount({ launchAvailable: false });
    expect(actionRow(root, LAUNCH)).toBeNull();
  });
});
