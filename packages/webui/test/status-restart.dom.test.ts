// DR-0028 「restart」: the Status tab's 再起動 as mounted — beside the kill
// button in the danger zone, with its look; offered only when the daemon can
// launch, the session's process is there and it runs in the config dir the
// launch command starts claude in; no confirm; both buttons disabled while
// either runs; what it came to under them.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  AgentInfo,
  ErrorResponse,
  SessionEnvResponse,
  SessionKillResponse,
  SessionRestartResponse,
  SessionStatusSnapshot,
  UserMessageResponse,
  RequestOverrideResponse,
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
  restarts: () => number;
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
  let count = 0;
  let resolve: ((reply: SessionRestartResponse | ErrorResponse) => void) | undefined;
  const onRestart = (): Promise<SessionRestartResponse | ErrorResponse> => {
    count += 1;
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
    restarts: () => count,
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
      await act(() => restartButton(mounted.root)?.click());
      expect(mounted.restarts()).toBe(1);
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

  test("while the kill runs, the restart is disabled too", async () => {
    const restore = stubGlobal("confirm", () => true);
    try {
      const mounted = await mount({ launchConfigDir: CONFIG_DIR, killHangs: true });
      await act(() => killButton(mounted.root)?.click());
      expect(killButton(mounted.root)?.disabled).toBe(true);
      expect(restartButton(mounted.root)?.disabled).toBe(true);
      expect(mounted.restarts()).toBe(0);
    } finally {
      restore();
    }
  });

  test("the result outlives the Status panel going while the session is between processes", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await act(() => restartButton(mounted.root)?.click());
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
    await act(() => restartButton(mounted.root)?.click());
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
    await act(() => restartButton(mounted.root)?.click());
    await mounted.answer({
      ok: false,
      error: { code: "restart_timeout", msg: "not seen gone" },
    });
    expect(resultText(mounted.root)).toBe("停止を確認できなかったので起動していない");
  });

  test("another refusal names its code and message", async () => {
    const mounted = await mount({ launchConfigDir: CONFIG_DIR });
    await act(() => restartButton(mounted.root)?.click());
    await mounted.answer({ ok: false, error: { code: "not_found", msg: "no process" } });
    expect(resultText(mounted.root)).toBe("再起動できなかった (not_found): no process");
  });
});
