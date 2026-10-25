// DR-0018 §3.9: the launch form as mounted — every field at once under
// claude's option names, the model / effort it opens on, a launch the schema
// refuses is never sent, what is sent, the result panel, and the launch
// affordances that `launch_available` gates (the sidebar's "+ 新規", Session
// Search's "resume").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import {
  LAUNCH_CHOOSE_MESSAGE,
  type LaunchInput,
  type ReplyOf,
  type SessionSearchHit,
  type SessionLaunchResponse,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionCreator } from "../src/client/components/SessionCreator.tsx";
import { SessionSearchPanel } from "../src/client/components/SessionSearchPanel.tsx";
import { Sidebar } from "../src/client/components/Sidebar.tsx";
import type { LaunchSeed } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";

withDom();

const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_SID = "cccccccc-0000-4000-8000-000000000003";

let roots: HTMLElement[] = [];
let restores: Array<() => void> = [];
let navigated: string[] = [];

beforeEach(() => {
  navigated = [];
  restores = [
    stubGlobal("navigation", {
      navigate(url: string) {
        navigated.push(url);
      },
    }),
  ];
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  for (const restore of restores.reverse()) restore();
});

interface Harness {
  root: HTMLElement;
  store: Store;
  launches: LaunchInput[];
}

async function mountWith(
  node: ComponentChild,
  options: {
    launchAvailable?: boolean;
    config?: ReplyOf<"session_launcher_config">;
    reply?: ReplyOf<"session_launch">;
    hits?: SessionSearchHit[];
  } = {},
): Promise<Harness> {
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: options.launchAvailable ?? true });
  const launches: LaunchInput[] = [];
  const reply: ReplyOf<"session_launch"> = options.reply ?? {
    ok: true,
    exit_code: 0,
    stdout: "",
    stderr: "",
  };
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    sessionLauncherConfig: () =>
      Promise.resolve(
        options.config ?? { ok: true, root_dirs: ["/repos/"], default_effort: { fable: "high" } },
      ),
    dirTree: () => Promise.resolve({ ok: true, entries: [] }),
    sessionLaunch: (req) => {
      launches.push(req.launch);
      return Promise.resolve(reply);
    },
    sessionSearch: () => Promise.resolve({ ok: true, hits: options.hits ?? [], truncated: false }),
  };
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(h(AppContext.Provider, { value: { store, ws } }, node), root));
  await settle();
  return { root, store, launches };
}

/** Let the config / launch / search promises and the renders they cause land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
}

function creator(seed: LaunchSeed = {}): ComponentChild {
  return h(SessionCreator, { onClose: () => {}, seed });
}

/** The labels of the fields shown, in order. */
function labels(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".session-creator-label")].map((el) => el.textContent ?? "");
}

/** The control of the field labelled `name`. */
function control(root: HTMLElement, name: string): Element {
  const label = [...root.querySelectorAll(".session-creator-label")].find(
    (el) => el.textContent === name,
  );
  const control = label?.parentElement?.querySelector("select, input, textarea");
  if (!control) throw new Error(`no control for ${name}`);
  return control;
}

async function choose(root: HTMLElement, name: string, value: string): Promise<void> {
  const select = instanceOf(control(root, name), HTMLSelectElement, name);
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function check(root: HTMLElement, name: string, checked: boolean): Promise<void> {
  const box = instanceOf(control(root, name), HTMLInputElement, name);
  await act(() => {
    box.checked = checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(root: HTMLElement, name: string, value: string): Promise<void> {
  const input = control(root, name);
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
    throw new Error(`${name} is not a text field`);
  }
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(root: HTMLElement): Promise<void> {
  const form = instanceOf(root.querySelector("form"), HTMLFormElement, "form");
  await act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function issueTexts(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".session-creator-issue")].map((el) => el.textContent ?? "");
}

function select(root: HTMLElement, name: string): HTMLSelectElement {
  return instanceOf(control(root, name), HTMLSelectElement, name);
}

describe("SessionCreator: every field, under claude's option names", () => {
  test("every field is shown at once, in the options' order", async () => {
    const { root } = await mountWith(creator());
    expect(labels(root)).toEqual([
      "cwd",
      "--model",
      "--effort",
      "--continue",
      "--resume",
      "--resume-session-at",
      "--fork-session",
      "--session-id",
      "--name",
      "PROMPT",
    ]);
  });

  // The daemon chooses the new session's id; the field only says so.
  test("--session-id takes no input and says it is generated", async () => {
    const { root } = await mountWith(creator());
    const id = instanceOf(control(root, "--session-id"), HTMLInputElement, "--session-id");
    expect(id.disabled).toBe(true);
    expect(id.placeholder).toBe("自動生成");
  });

  // A new session opens on fable and the effort the daemon's settings give
  // fable; choosing another model selects that model's default, or nothing
  // (to choose) where it has none.
  test("a new session opens on fable and its default effort, which follows the model", async () => {
    const { root } = await mountWith(creator());
    expect(select(root, "--model").value).toBe("fable");
    expect(select(root, "--effort").value).toBe("high");
    const model = select(root, "--model");
    expect(model.options[0]?.textContent).toBe("選んでください");
    expect(model.options[0]?.disabled).toBe(true);
    expect([...model.options].slice(1).map((o) => o.value)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    await choose(root, "--model", "opus");
    expect(select(root, "--effort").value).toBe("");
  });

  // Carrying on from a session may leave both to the launch command.
  test("--continue or --resume adds 指定しない to the selects and opens on it", async () => {
    const { root } = await mountWith(creator());
    await check(root, "--continue", true);
    for (const name of ["--model", "--effort"]) {
      expect(select(root, name).value).toBe("");
      expect(select(root, name).options[0]?.textContent).toBe("指定しない");
    }
    await check(root, "--continue", false);
    await type(root, "--resume", SID);
    expect(select(root, "--model").value).toBe("");
    const id = instanceOf(control(root, "--session-id"), HTMLInputElement, "--session-id");
    expect(id.placeholder).toBe("自動生成 (新規と --fork-session の時)");
    await check(root, "--fork-session", true);
    expect(id.placeholder).toBe("自動生成");
  });
});

describe("SessionCreator: what is sent", () => {
  test("a launch the schema refuses is not sent, and each field says why", async () => {
    const { root, launches } = await mountWith(creator(), {
      config: { ok: true, root_dirs: ["/repos/"], default_effort: {} },
    });
    await submit(root);
    expect(launches).toEqual([]);
    // cwd, and the effort a new session has to name (fable has no default).
    expect(issueTexts(root)).toEqual(["絶対パスで指定する", LAUNCH_CHOOSE_MESSAGE]);
    // Fixing a field drops its reason without another submit.
    await choose(root, "--effort", "low");
    expect(issueTexts(root)).toEqual(["絶対パスで指定する"]);
  });

  test("continue and resume together are refused on --resume, and not sent", async () => {
    const { root, launches } = await mountWith(creator({ cwd: "/r", resume: SID }));
    await check(root, "--continue", true);
    await submit(root);
    expect(launches).toEqual([]);
    expect(issueTexts(root)).toEqual(["continue と resume は同時に指定できない"]);
  });

  test("a new session sends the model and effort it shows", async () => {
    const { root, launches } = await mountWith(creator({ cwd: "/repos/app" }));
    await type(root, "PROMPT", "始めて");
    await submit(root);
    expect(launches).toEqual([
      { cwd: "/repos/app", model: "fable", effort: "high", prompt: "始めて" },
    ]);
  });

  test("a resume link sends the resume it carries", async () => {
    const { root, launches } = await mountWith(
      creator({ resume: SID, cwd: "/repos/app", name: "prep" }),
    );
    await type(root, "PROMPT", "続けて");
    await submit(root);
    expect(launches).toEqual([{ cwd: "/repos/app", resume: SID, name: "prep", prompt: "続けて" }]);
  });

  test("a fork link sends the fork and its fork point", async () => {
    const { root, launches } = await mountWith(
      creator({ resume: SID, resume_session_at: NEW_SID, fork_session: "true", cwd: "/r" }),
    );
    expect(
      instanceOf(control(root, "--fork-session"), HTMLInputElement, "--fork-session").checked,
    ).toBe(true);
    await submit(root);
    expect(launches).toEqual([
      { cwd: "/r", resume: SID, resume_session_at: NEW_SID, fork_session: true },
    ]);
  });
});

describe("SessionCreator: the result panel", () => {
  test("a new session's id links to its view; outputs show as they came", async () => {
    const result: SessionLaunchResponse = {
      ok: true,
      session_id: NEW_SID,
      exit_code: 0,
      stdout: "output is 5000 bytes, file: /state/launches/x/stdout",
      stderr: "",
    };
    const { root } = await mountWith(creator({ cwd: "/r", model: "fable", effort: "high" }), {
      reply: result,
    });
    await submit(root);
    const link = instanceOf(
      root.querySelector(".session-creator-result a"),
      HTMLAnchorElement,
      "link",
    );
    expect(link.getAttribute("href")).toBe(`/s/${NEW_SID}`);
    expect(link.textContent).toBe(NEW_SID);
    const text = root.querySelector(".session-creator-result")?.textContent ?? "";
    expect(text).toContain("exit_code: 0");
    expect(root.querySelector(".session-creator-result-body")?.textContent).toBe(
      "output is 5000 bytes, file: /state/launches/x/stdout",
    );
    expect(text).toContain("stderr出力なし");
  });

  test("without a session id there is no link, and a non-zero exit is shown as it is", async () => {
    const { root } = await mountWith(creator({ continue: "true", cwd: "/r" }), {
      reply: { ok: true, exit_code: 3, stdout: "", stderr: "no trust" },
    });
    await submit(root);
    expect(root.querySelector(".session-creator-result a")).toBeNull();
    const text = root.querySelector(".session-creator-result")?.textContent ?? "";
    expect(text).toContain("exit_code: 3");
    expect(text).toContain("no trust");
  });

  test("a refusal from the daemon says it did not launch, with its code and reason", async () => {
    const { root } = await mountWith(creator({ continue: "true", cwd: "/r" }), {
      reply: { ok: false, error: { code: "invalid_args", msg: "cwd: not a directory" } },
    });
    await submit(root);
    expect(root.querySelector(".session-creator-error")?.textContent).toBe(
      "ccmsg の daemon が起動を断ったので、起動していない (invalid_args): cwd: not a directory",
    );
  });

  test("an unconfigured daemon gets the setup guidance instead of the form", async () => {
    const { root } = await mountWith(creator(), {
      config: { ok: false, error: { code: "launcher_not_configured", msg: "" } },
    });
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector(".session-creator-guidance")?.textContent).toContain(
      "session_launcher",
    );
  });
});

describe("launch_available gates the launch affordances", () => {
  test("the sidebar's + 新規 is there only when the daemon can launch", async () => {
    const on = await mountWith(h(Sidebar, {}), { launchAvailable: true });
    expect(on.root.querySelector("#session-creator-toggle")).not.toBeNull();
    const off = await mountWith(h(Sidebar, {}), { launchAvailable: false });
    expect(off.root.querySelector("#session-creator-toggle")).toBeNull();
  });

  const hit: SessionSearchHit = {
    sid: SID,
    config_dir: "/home/u/.claude",
    file: `/home/u/.claude/projects/p/${SID}.jsonl`,
    cwd: "/repos/app",
    repo: "o/app",
    ws: "main",
    created_at: "2026-10-25T00:00:00.000Z",
    updated_at: "2026-10-25T00:00:00.000Z",
    size: 1,
    matches: [],
    title: "release prep",
    model: "claude-sonnet-5-5",
    effort: "low",
  };

  async function searched(launchAvailable: boolean): Promise<Harness> {
    const harness = await mountWith(h(SessionSearchPanel, { onClose: () => {}, query: "x" }), {
      launchAvailable,
      hits: [hit],
    });
    await submit(harness.root);
    return harness;
  }

  test("Session Search's resume opens the form on the hit as --resume", async () => {
    const { root } = await searched(true);
    const resume = instanceOf(
      root.querySelector(".session-search-hit-resume"),
      HTMLButtonElement,
      "resume",
    );
    await act(() => resume.click());
    const url = new URL(navigated.at(-1) ?? "", "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "sb.panel": "new",
      "sb.cwd": "/repos/app",
      "sb.model": "sonnet",
      "sb.effort": "low",
      "sb.resume": SID,
      "sb.name": "release prep",
    });
  });

  test("Session Search offers no resume when the daemon cannot launch", async () => {
    const { root } = await searched(false);
    expect(root.querySelector(".session-search-hit")).not.toBeNull();
    expect(root.querySelector(".session-search-hit-resume")).toBeNull();
  });
});
