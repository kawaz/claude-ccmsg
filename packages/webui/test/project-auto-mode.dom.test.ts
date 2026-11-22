// The Status tab's autoMode of the session's project, mounted (DR-0063 §6):
// every section heads with its $defaults row, then the project's entries
// (edited in place: a click opens a textarea, ⌘Enter saves, Esc leaves it,
// an empty save removes, [＋] adds), the user's lists and the built-in
// defaults (read only; the latter only where they hold, folded with its
// count). A push of the project redraws it but not a textarea being edited.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type {
  AutoModeSectionName,
  AutoModeSections,
  ProjectAutoModeChange,
  ReplyOf,
  UserAutoMode,
} from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { ProjectAutoMode } from "../src/client/components/ProjectAutoMode.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf } from "./helpers.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000009";
const KEY = "repo:github.com/kawaz/demo";

const PROJECT: AutoModeSections = {
  environment: { defaults: true, entries: [] },
  allow: { defaults: false, entries: ["run the tests", "read the docs"] },
  soft_deny: { defaults: true, entries: [] },
  hard_deny: { defaults: true, entries: [] },
};
const USER: UserAutoMode = {
  config_dir_name: ".claude-x",
  autoMode: { allow: ["user allow"], soft_deny: ["$defaults", "user deny"] },
};
const BUILTIN = {
  environment: ["e1", "e2"],
  allow: ["a1"],
  soft_deny: ["s1", "s2", "s3"],
  hard_deny: ["h1"],
};

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
});

/** The built-in defaults are kept per version for the page's life: each
 * mount names its own. */
let versions = 0;

interface Writes {
  calls: Array<{ section: AutoModeSectionName; change: ProjectAutoModeChange }>;
  /** What the next write answers; a promise the test settles, or the
   * project changed as asked. */
  next: (() => Promise<ReplyOf<"project_auto_mode_write">>) | null;
}

interface Mounted {
  root: HTMLElement;
  store: Store;
  writes: Writes;
  reads: number;
  /** While set, project_auto_mode_read fails (the connection is down). */
  readFails: boolean;
  /** While set, auto_mode_defaults_read answers that claude did not. */
  builtinFails: boolean;
  builtinAsks: number;
  /** Render again with the tab in front or not. */
  show: (shown: boolean) => Promise<void>;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function mount(
  options: {
    project?: AutoModeSections;
    user?: UserAutoMode;
    launch?: boolean;
    builtinFails?: boolean;
  } = {},
): Promise<Mounted> {
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: options.launch ?? true });
  const project = options.project ?? PROJECT;
  const version = `v${String((versions += 1))}`;
  const writes: Writes = { calls: [], next: null };
  const mounted: Mounted = {
    root: document.createElement("div"),
    store,
    writes,
    reads: 0,
    readFails: false,
    builtinFails: options.builtinFails ?? false,
    builtinAsks: 0,
    show: () => Promise.resolve(),
  };
  const ws = {
    ...createWsClient((action) => store.dispatch(action)),
    projectAutoModeRead: (sid: string): Promise<ReplyOf<"project_auto_mode_read">> => {
      expect(sid).toBe(SID);
      mounted.reads += 1;
      if (mounted.readFails) return Promise.reject(new Error("ws not open"));
      const current = store.getState().projectAutoModes.get(KEY) ?? project;
      store.dispatch({ type: "project-auto-mode/loaded", key: KEY, project: current });
      return Promise.resolve({
        ok: true,
        key: KEY,
        label: "github.com/kawaz/demo",
        project: current,
        user: options.user ?? USER,
        builtin_version: version,
      });
    },
    projectAutoModeWrite: (
      _sid: string,
      section: AutoModeSectionName,
      change: ProjectAutoModeChange,
    ): Promise<ReplyOf<"project_auto_mode_write">> => {
      writes.calls.push({ section, change });
      if (writes.next !== null) return writes.next();
      return Promise.resolve({
        ok: true,
        project: store.getState().projectAutoModes.get(KEY) ?? project,
      });
    },
    autoModeDefaultsRead: (v: string): Promise<ReplyOf<"auto_mode_defaults_read">> => {
      mounted.builtinAsks += 1;
      return Promise.resolve(
        mounted.builtinFails
          ? {
              ok: false,
              error: { code: "auto_mode_defaults_unavailable", msg: "did not end within 10 s" },
            }
          : { ok: true, version: v, label: "2.1.330 (Claude Code)", defaults: BUILTIN },
      );
    },
  };
  document.body.append(mounted.root);
  roots.push(mounted.root);
  mounted.show = async (shown: boolean): Promise<void> => {
    await act(() => {
      render(
        h(AppContext.Provider, { value: { store, ws } }, h(ProjectAutoMode, { sid: SID, shown })),
        mounted.root,
      );
    });
    await settle();
  };
  await mounted.show(true);
  return mounted;
}

function section(root: HTMLElement, name: AutoModeSectionName): HTMLElement {
  const found = [...root.querySelectorAll(".status-automode-section")].find(
    (li) => li.querySelector(".status-automode-section-name")?.textContent === name,
  );
  return instanceOf(found, HTMLElement, `the ${name} section`);
}

function layer(sec: HTMLElement, which: "project" | "user" | "builtin"): HTMLDetailsElement | null {
  const found = sec.querySelector(`.status-automode-layer-${which}`);
  return found instanceof HTMLDetailsElement ? found : null;
}

function textOf(el: Element | null): string {
  return el?.textContent ?? "";
}

function checkbox(sec: HTMLElement): HTMLInputElement {
  return instanceOf(sec.querySelector('input[type="checkbox"]'), HTMLInputElement, "the check");
}

function textarea(sec: HTMLElement): HTMLTextAreaElement | null {
  const found = sec.querySelector("textarea");
  return found instanceof HTMLTextAreaElement ? found : null;
}

function entryButtons(sec: HTMLElement): HTMLButtonElement[] {
  return [...sec.querySelectorAll(".status-automode-entry-editable")].filter(
    (b): b is HTMLButtonElement => b instanceof HTMLButtonElement,
  );
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
  await settle();
}

async function type(area: HTMLTextAreaElement, value: string): Promise<void> {
  await act(() => {
    area.value = value;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(area: HTMLTextAreaElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    area.dispatchEvent(event);
    await Promise.resolve();
  });
  await settle();
  return event;
}

function project(m: Mounted): AutoModeSections {
  return defined(m.store.getState().projectAutoModes.get(KEY), "the project");
}

describe("what each section shows", () => {
  // Without the row, a section emptied by hand and one inheriting the
  // defaults would look the same (kawaz, DR-0063 §6).
  test("every section heads with its $defaults row, entries or not, in the four's order", async () => {
    const { root } = await mount();
    const names = [...root.querySelectorAll(".status-automode-section-name")].map(textOf);
    expect(names).toEqual(["environment", "allow", "soft_deny", "hard_deny"]);
    const env = section(root, "environment");
    expect(checkbox(env).checked).toBe(true);
    expect(textOf(env.querySelector(".status-automode-user-state"))).toBe("ユーザ: 書いていない");
    expect(textOf(env.querySelector(".status-automode-result"))).toBe(
      "どの設定もこのセクションを書いていないので組み込みが効いています",
    );
    const allow = section(root, "allow");
    expect(checkbox(allow).checked).toBe(false);
    expect(textOf(allow.querySelector(".status-automode-user-state"))).toBe(
      "ユーザ: $defaults なし (1 件)",
    );
    expect(textOf(allow.querySelector(".status-automode-result"))).toBe("組み込みは効いていません");
    expect(textOf(root.querySelector(".status-automode-key"))).toBe("github.com/kawaz/demo");
  });

  test("the layers: the project's and the user's open, the built-in only where it holds, closed with its count", async () => {
    const { root } = await mount();
    const allow = section(root, "allow");
    expect(layer(allow, "project")?.open).toBe(true);
    expect(textOf(layer(allow, "project")?.querySelector("summary") ?? null)).toBe(
      "プロジェクト (編集できる)",
    );
    expect(entryButtons(allow).map(textOf)).toEqual(["run the tests", "read the docs"]);
    expect(layer(allow, "user")?.open).toBe(true);
    expect(textOf(layer(allow, "user")?.querySelector("summary") ?? null)).toBe(
      "ユーザ (.claude-x/settings.json、読むだけ)",
    );
    // Not in effect for allow: the project's check is off and the user's
    // list has no $defaults.
    expect(layer(allow, "builtin")).toBeNull();

    const softDeny = section(root, "soft_deny");
    const userLayer = layer(softDeny, "user");
    expect([...(userLayer?.querySelectorAll("li") ?? [])].map(textOf)).toEqual([
      "$defaults ← ここに組み込みの既定が入る",
      "user deny",
    ]);
    // Read only: no control in the user's layer.
    expect(userLayer?.querySelector("button, textarea, input")).toBeNull();
    const builtin = layer(softDeny, "builtin");
    expect(builtin?.open).toBe(false);
    expect(textOf(builtin?.querySelector("summary") ?? null)).toBe(
      "組み込みの既定 (3)Claude Code 2.1.330、読むだけ",
    );
    expect(builtin?.querySelector("button, textarea, input")).toBeNull();
    expect(textOf(layer(section(root, "hard_deny"), "user")?.querySelector("p") ?? null)).toBe(
      "書いていない",
    );
  });

  test("the note says the start does not carry it where no launch command is configured", async () => {
    const withLauncher = await mount();
    expect(textOf(withLauncher.root.querySelector(".status-automode-note"))).not.toContain(
      "起動コマンドが設定されていないので、起動には渡らない",
    );
    const without = await mount({ launch: false });
    expect(textOf(without.root.querySelector(".status-automode-note"))).toContain(
      "起動コマンドが設定されていないので、起動には渡らない",
    );
  });

  test("a user's settings that do not read say why in the user's layer", async () => {
    const { root } = await mount({ user: { unavailable: "settings.json が読めない: x" } });
    const env = section(root, "environment");
    expect(textOf(env.querySelector(".status-automode-user-state"))).toBe("ユーザ: 読めない");
    expect(textOf(layer(env, "user")?.querySelector("p") ?? null)).toBe(
      "settings.json が読めない: x",
    );
  });
});

describe("editing the project's entries", () => {
  test("a click opens the entry's text; ⌘Enter saves it as a replacement, Enter alone is a line break", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    const [first] = entryButtons(allow);
    await click(defined(first, "the first entry"));
    const area = instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea");
    expect(area.value).toBe("run the tests");
    // The caret goes into it, after its text.
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe("run the tests".length);
    const enter = await press(area, { key: "Enter" });
    expect(enter.defaultPrevented).toBe(false);
    expect(m.writes.calls).toEqual([]);
    await type(area, "run the unit tests");
    const save = await press(area, { key: "Enter", metaKey: true });
    expect(save.defaultPrevented).toBe(true);
    expect(m.writes.calls).toEqual([
      {
        section: "allow",
        change: { index: 0, before: "run the tests", text: "run the unit tests" },
      },
    ]);
    expect(textarea(section(m.root, "allow"))).toBeNull();
  });

  test("Esc leaves the entry as it was and saves nothing; losing the focus keeps the textarea", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[1], "the second entry"));
    const area = instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea");
    await type(area, "changed");
    await act(() => {
      area.dispatchEvent(new FocusEvent("blur"));
    });
    expect(textarea(section(m.root, "allow"))).not.toBeNull();
    await press(area, { key: "Escape" });
    expect(textarea(section(m.root, "allow"))).toBeNull();
    expect(m.writes.calls).toEqual([]);
    expect(entryButtons(section(m.root, "allow")).map(textOf)).toEqual([
      "run the tests",
      "read the docs",
    ]);
  });

  test("an empty save removes the entry", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    const area = instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea");
    await type(area, "  \n ");
    await press(area, { key: "Enter", ctrlKey: true });
    expect(m.writes.calls).toEqual([
      { section: "allow", change: { index: 0, before: "run the tests", text: "  \n " } },
    ]);
  });

  test("[＋] opens an empty textarea at the end: empty saves nothing, text is appended", async () => {
    const m = await mount();
    const env = section(m.root, "environment");
    const add = instanceOf(env.querySelector(".status-automode-add"), HTMLElement, "＋");
    await click(add);
    const area = instanceOf(textarea(env), HTMLTextAreaElement, "the new textarea");
    expect(area.value).toBe("");
    await press(area, { key: "Enter", metaKey: true });
    expect(textarea(section(m.root, "environment"))).toBeNull();
    expect(m.writes.calls).toEqual([]);

    await click(instanceOf(env.querySelector(".status-automode-add"), HTMLElement, "＋"));
    const again = instanceOf(textarea(env), HTMLTextAreaElement, "the new textarea");
    await type(again, "This repo is a personal OSS project");
    await press(again, { key: "Enter", metaKey: true });
    expect(m.writes.calls).toEqual([
      { section: "environment", change: { text: "This repo is a personal OSS project" } },
    ]);
  });

  test("while it saves the textarea is disabled; a refusal keeps it open with the reason", async () => {
    const m = await mount();
    const pending = Promise.withResolvers<ReplyOf<"project_auto_mode_write">>();
    m.writes.next = () => pending.promise;
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    const area = instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea");
    await type(area, "x");
    await press(area, { key: "Enter", metaKey: true });
    expect(area.disabled).toBe(true);
    pending.resolve({
      ok: false,
      error: { code: "file_conflict", msg: "the entry at allow[0] was changed elsewhere" },
    });
    await settle();
    const still = instanceOf(textarea(section(m.root, "allow")), HTMLTextAreaElement, "kept");
    expect(still.disabled).toBe(false);
    expect(still.value).toBe("x");
    expect(textOf(section(m.root, "allow").querySelector(".status-automode-error"))).toBe(
      "file_conflict: the entry at allow[0] was changed elsewhere",
    );
  });

  // Another tab or device saved: the entries and the result follow, and what
  // this page is writing stays.
  test("a push of the project redraws the entries and the result, but not a textarea being edited", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[1], "the second entry"));
    await type(instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea"), "half written");
    await act(() => {
      m.store.dispatch({
        type: "project-auto-mode/loaded",
        key: KEY,
        project: {
          ...project(m),
          allow: { defaults: true, entries: ["from elsewhere", "read the docs"] },
        },
      });
    });
    const after = section(m.root, "allow");
    expect(entryButtons(after).map(textOf)).toEqual(["from elsewhere"]);
    expect(textarea(after)?.value).toBe("half written");
    expect(checkbox(after).checked).toBe(true);
    expect(textOf(after.querySelector(".status-automode-result"))).toBe(
      "プロジェクトの $defaults で組み込みが効いています",
    );
    expect(layer(after, "builtin")).not.toBeNull();
  });
});

describe("保存 and やめる under the textarea (DR-0063 §6, kawaz 2026-11-22)", () => {
  function rowButton(sec: HTMLElement, label: string): HTMLButtonElement {
    const found = [...sec.querySelectorAll(".status-automode-edit-row > button")].find(
      (b) => b.textContent === label,
    );
    return instanceOf(found, HTMLButtonElement, `the ${label} button`);
  }

  // A screen with no keyboard has neither ⌘Enter nor Esc.
  test("保存 saves as ⌘Enter does, やめる leaves it as Esc does", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    expect(
      [...section(m.root, "allow").querySelectorAll(".status-automode-edit-row > button")].map(
        textOf,
      ),
    ).toEqual(["やめる", "保存"]);
    await type(instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea"), "changed");
    await click(rowButton(section(m.root, "allow"), "やめる"));
    expect(textarea(section(m.root, "allow"))).toBeNull();
    expect(m.writes.calls).toEqual([]);

    await click(defined(entryButtons(section(m.root, "allow"))[0], "the first entry"));
    await type(
      instanceOf(textarea(section(m.root, "allow")), HTMLTextAreaElement, "the textarea"),
      "run the unit tests",
    );
    await click(rowButton(section(m.root, "allow"), "保存"));
    expect(m.writes.calls).toEqual([
      {
        section: "allow",
        change: { index: 0, before: "run the tests", text: "run the unit tests" },
      },
    ]);
    expect(textarea(section(m.root, "allow"))).toBeNull();
  });

  test("both are disabled while it saves", async () => {
    const m = await mount();
    const pending = Promise.withResolvers<ReplyOf<"project_auto_mode_write">>();
    m.writes.next = () => pending.promise;
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    await click(rowButton(section(m.root, "allow"), "保存"));
    expect(rowButton(section(m.root, "allow"), "保存").disabled).toBe(true);
    expect(rowButton(section(m.root, "allow"), "やめる").disabled).toBe(true);
    pending.resolve({ ok: true, project: project(m) });
    await settle();
  });
});

describe("the $defaults check", () => {
  test("a press saves at once and is disabled until the reply; the result follows the save", async () => {
    const m = await mount();
    const pending = Promise.withResolvers<ReplyOf<"project_auto_mode_write">>();
    m.writes.next = () => pending.promise;
    const allow = section(m.root, "allow");
    await click(checkbox(allow));
    expect(m.writes.calls).toEqual([{ section: "allow", change: { defaults: true } }]);
    expect(checkbox(section(m.root, "allow")).disabled).toBe(true);
    pending.resolve({
      ok: true,
      project: { ...project(m), allow: { ...PROJECT.allow, defaults: true } },
    });
    await settle();
    const after = section(m.root, "allow");
    expect(checkbox(after).disabled).toBe(false);
    expect(checkbox(after).checked).toBe(true);
    expect(textOf(after.querySelector(".status-automode-result"))).toBe(
      "プロジェクトの $defaults で組み込みが効いています",
    );
  });

  test("a refused press goes back to the saved state and says why", async () => {
    const m = await mount();
    m.writes.next = () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "project_auto_mode_unreadable",
          msg: "project-auto-mode.json does not read",
        },
      });
    await click(checkbox(section(m.root, "soft_deny")));
    const after = section(m.root, "soft_deny");
    expect(checkbox(after).checked).toBe(true);
    expect(textOf(after.querySelector(".status-automode-error"))).toBe(
      "project_auto_mode_unreadable: project-auto-mode.json does not read",
    );
  });
});

describe("what is being written is not lost (DR-0063 §6)", () => {
  test("another page removing the entry before it keeps the textarea with its entry", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[1], "the second entry"));
    await type(instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea"), "half written");
    await act(() => {
      m.store.dispatch({
        type: "project-auto-mode/loaded",
        key: KEY,
        project: { ...project(m), allow: { defaults: false, entries: ["read the docs"] } },
      });
    });
    const after = section(m.root, "allow");
    expect(textarea(after)?.value).toBe("half written");
    expect(entryButtons(after)).toHaveLength(0);
    await press(instanceOf(textarea(after), HTMLTextAreaElement, "kept"), {
      key: "Enter",
      metaKey: true,
    });
    expect(m.writes.calls).toEqual([
      { section: "allow", change: { index: 0, before: "read the docs", text: "half written" } },
    ]);
  });

  test("another page removing the entry itself keeps the textarea; a save then says so, and the next one appends", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    await type(instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea"), "mine");
    await act(() => {
      m.store.dispatch({
        type: "project-auto-mode/loaded",
        key: KEY,
        project: { ...project(m), allow: { defaults: false, entries: ["read the docs"] } },
      });
    });
    const area = instanceOf(textarea(section(m.root, "allow")), HTMLTextAreaElement, "kept");
    expect(area.value).toBe("mine");
    expect(textOf(section(m.root, "allow").querySelector(".status-automode-edit-note"))).toBe(
      "別の画面が先にこの項目を消した",
    );
    await press(area, { key: "Enter", metaKey: true });
    expect(m.writes.calls).toEqual([]);
    expect(textOf(section(m.root, "allow").querySelector(".status-automode-edit-note"))).toBe(
      "別の画面が先にこの項目を消した。もう一度保存すると最後に足す",
    );
    await press(instanceOf(textarea(section(m.root, "allow")), HTMLTextAreaElement, "kept"), {
      key: "Enter",
      metaKey: true,
    });
    expect(m.writes.calls).toEqual([{ section: "allow", change: { text: "mine" } }]);
  });

  test("opening another entry, or [＋], keeps the textarea already open", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    await type(instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea"), "first, edited");
    await click(defined(entryButtons(section(m.root, "allow"))[0], "the other entry"));
    await click(
      instanceOf(section(m.root, "allow").querySelector(".status-automode-add"), HTMLElement, "＋"),
    );
    const areas = [...section(m.root, "allow").querySelectorAll("textarea")].map((a) => a.value);
    expect(areas).toEqual(["first, edited", "read the docs", ""]);
  });

  // The connection was down when the tab came back to the front: what was
  // on screen stays, with the reason, and comes back to life once it is up.
  test("a read that fails keeps what was read and the textarea, says why, and reads again on reconnect", async () => {
    const m = await mount();
    m.store.dispatch({ type: "conn/status", status: "connected" });
    await settle();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    await type(instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea"), "kept text");
    m.readFails = true;
    await m.show(false);
    await m.show(true);
    expect(textarea(section(m.root, "allow"))?.value).toBe("kept text");
    expect(textOf(m.root.querySelector(".status-automode > .status-automode-error"))).toBe(
      "Error: ws not open",
    );
    m.readFails = false;
    const before = m.reads;
    await act(() => {
      m.store.dispatch({ type: "conn/status", status: "disconnected" });
    });
    await act(() => {
      m.store.dispatch({ type: "conn/status", status: "connected" });
    });
    await settle();
    expect(m.reads).toBeGreaterThan(before);
    expect(m.root.querySelector(".status-automode > .status-automode-error")).toBeNull();
    expect(textarea(section(m.root, "allow"))?.value).toBe("kept text");
  });
});

describe("a save refused because another page changed the entry (DR-0063 §6, §7)", () => {
  test("shows the entry as it is now, and the next save overwrites it with that as before", async () => {
    const m = await mount();
    const allow = section(m.root, "allow");
    await click(defined(entryButtons(allow)[0], "the first entry"));
    await type(instanceOf(textarea(allow), HTMLTextAreaElement, "the textarea"), "mine");
    // Another page changed it; its push has arrived.
    await act(() => {
      m.store.dispatch({
        type: "project-auto-mode/loaded",
        key: KEY,
        project: {
          ...project(m),
          allow: { defaults: false, entries: ["theirs", "read the docs"] },
        },
      });
    });
    expect(textOf(section(m.root, "allow").querySelector(".status-automode-edit-note"))).toBe(
      "別の画面が先に変えた。今の文: theirs",
    );
    m.writes.next = () =>
      Promise.resolve({
        ok: false,
        error: { code: "file_conflict", msg: "the entry at allow[0] was changed elsewhere" },
      });
    await press(instanceOf(textarea(section(m.root, "allow")), HTMLTextAreaElement, "kept"), {
      key: "Enter",
      metaKey: true,
    });
    expect(textOf(section(m.root, "allow").querySelector(".status-automode-edit-note"))).toBe(
      "別の画面が先に変えた。もう一度保存すると上書きする。今の文: theirs",
    );
    m.writes.next = null;
    await press(instanceOf(textarea(section(m.root, "allow")), HTMLTextAreaElement, "kept"), {
      key: "Enter",
      metaKey: true,
    });
    expect(m.writes.calls).toEqual([
      { section: "allow", change: { index: 0, before: "run the tests", text: "mine" } },
      { section: "allow", change: { index: 0, before: "theirs", text: "mine" } },
    ]);
    expect(textarea(section(m.root, "allow"))).toBeNull();
  });
});

describe("the built-in defaults", () => {
  // The daemon keeps no failure (DR-0063 §7): neither does the page.
  test("a read that failed is asked again as the tab comes back to the front", async () => {
    const m = await mount({ builtinFails: true });
    const softDeny = section(m.root, "soft_deny");
    expect(textOf(layer(softDeny, "builtin")?.querySelector("p") ?? null)).toBe(
      "claude auto-mode defaults が答えなかった: did not end within 10 s",
    );
    m.builtinFails = false;
    const asked = m.builtinAsks;
    await m.show(false);
    await m.show(true);
    expect(m.builtinAsks).toBeGreaterThan(asked);
    expect(
      textOf(layer(section(m.root, "soft_deny"), "builtin")?.querySelector("summary") ?? null),
    ).toBe("組み込みの既定 (3)Claude Code 2.1.330、読むだけ");
  });
});
