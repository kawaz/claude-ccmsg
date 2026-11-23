// The Status tab's autoMode of the session's project, mounted (DR-0063 §6):
// four sections, each a fold closed at the start with the count of the
// project's entries; open, the project's entries (edited in place: a click
// opens a textarea, ⌘Enter saves, Esc leaves it, an empty save removes, [＋]
// adds) and two read-only folds, the user's settings and the built-in
// defaults (the latter only where they hold), each named with its section.
// Every entry carries the timeline's translation tabs. `$defaults` is
// nowhere on screen. A push of the project redraws it but not a textarea
// being edited.
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
import { _resetPlamoStateForTest } from "../src/client/plamo-translate.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf, stubGlobal } from "./helpers.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000009";
const KEY = "repo:github.com/kawaz/demo";

const PROJECT: AutoModeSections = {
  environment: [],
  allow: ["run the tests", "read the docs"],
  soft_deny: [],
  hard_deny: [],
};
/** As the daemon reads it (readUserAutoMode): the user writes allow without
 * `$defaults` and soft_deny with it, which the daemon leaves out. */
const USER: UserAutoMode = {
  config_dir_name: ".claude-x",
  autoMode: { allow: ["user allow"], soft_deny: ["user deny"] },
  defaults_dropped: ["allow"],
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
    /** The translation server's URL the hello named (DR-0049). */
    plamoUrl?: string;
    hostTranslator?: boolean;
    /** Press the row's button once mounted (the editor is closed at the start). */
    opened?: boolean;
  } = {},
): Promise<Mounted> {
  const store = createStore(initialState());
  store.dispatch({ type: "launch/availability", available: options.launch ?? true });
  if (options.plamoUrl !== undefined) {
    store.dispatch({ type: "translator/plamo", url: options.plamoUrl });
  }
  if (options.hostTranslator === true)
    store.dispatch({ type: "translator/availability", host: true });
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
  if (options.opened ?? true) await click(toggle(mounted.root));
  return mounted;
}

function toggle(root: HTMLElement): HTMLButtonElement {
  return instanceOf(
    root.querySelector(".status-actions button"),
    HTMLButtonElement,
    "the row's button",
  );
}

function section(root: HTMLElement, name: AutoModeSectionName): HTMLElement {
  const found = [...root.querySelectorAll(".status-automode-section")].find((li) =>
    li.querySelector(".status-automode-section-name")?.textContent?.startsWith(`${name} (`),
  );
  return instanceOf(found, HTMLElement, `the ${name} section`);
}

/** A section's fold. */
function fold(sec: HTMLElement): HTMLDetailsElement {
  return instanceOf(sec.querySelector(":scope > details"), HTMLDetailsElement, "the fold");
}

/** Every fold open: what a person sees once they opened them all. */
function openAll(root: HTMLElement): void {
  for (const d of root.querySelectorAll("details")) d.open = true;
}

function layer(sec: HTMLElement, which: "user" | "builtin"): HTMLDetailsElement | null {
  const found = sec.querySelector(`.status-automode-layer-${which}`);
  return found instanceof HTMLDetailsElement ? found : null;
}

function textOf(el: Element | null): string {
  return el?.textContent ?? "";
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

describe("the row that opens the editor (DR-0063 §6, kawaz 2026-11-23)", () => {
  test("closed at the start: the row's name and description, 編集する, no editor and no read", async () => {
    const m = await mount({ opened: false });
    const btn = toggle(m.root);
    expect(textOf(m.root.querySelector(".status-action-name"))).toBe("autoMode の調整");
    expect(textOf(m.root.querySelector(".status-action-desc"))).toBe(
      "このプロジェクト用に autoMode の設定を追加します",
    );
    expect(btn.textContent).toBe("編集する");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(m.root.querySelector(".status-automode")).toBeNull();
    expect(m.reads).toBe(0);
  });

  test("a press opens the editor under the row and turns the button to 閉じる; another press folds it", async () => {
    const m = await mount({ opened: false });
    await click(toggle(m.root));
    const btn = toggle(m.root);
    expect(btn.textContent).toBe("閉じる");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const panel = instanceOf(m.root.querySelector(".status-automode"), HTMLElement, "the editor");
    expect(btn.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.closest(".status-action")).not.toBeNull();
    expect(m.reads).toBe(1);
    await click(btn);
    expect(toggle(m.root).textContent).toBe("編集する");
    expect(toggle(m.root).getAttribute("aria-expanded")).toBe("false");
    expect(m.root.querySelector(".status-automode")).toBeNull();
  });

  // DR-0063 §6 (kawaz 2026-11-23): the row is of the danger zone, in its
  // colours (the title and the frame, as the kill's row); not drawn apart.
  test("the row is in the danger zone's list class, closed and open alike", async () => {
    const m = await mount({ opened: false });
    const list = (): Element | null => m.root.querySelector(".status-actions");
    expect(list()?.classList.contains("status-actions-danger")).toBe(true);
    await click(toggle(m.root));
    expect(list()?.classList.contains("status-actions-danger")).toBe(true);
  });

  // DR-0063 §6 (kawaz 2026-11-23): the project's key and what the lists are
  // for sit under the four folds, not above them.
  test("the key and the note come after the four sections", async () => {
    const { root } = await mount();
    const sections = defined(root.querySelector(".status-automode-sections"), "the sections");
    for (const cls of [".status-automode-key", ".status-automode-note"]) {
      const el = defined(root.querySelector(cls), cls);
      expect(
        sections.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${cls} follows the sections`,
      ).not.toBe(0);
    }
  });

  test("folding drops a textarea being written", async () => {
    const m = await mount();
    await click(defined(entryButtons(section(m.root, "allow"))[0], "an entry"));
    expect(textarea(section(m.root, "allow"))).not.toBeNull();
    await click(toggle(m.root));
    await click(toggle(m.root));
    expect(textarea(section(m.root, "allow"))).toBeNull();
  });
});

describe("what each section shows", () => {
  test("the four sections, closed at the start, each counting the project's entries only", async () => {
    const { root } = await mount();
    const summaries = [...root.querySelectorAll(".status-automode-section-name")].map(textOf);
    // The user's soft_deny entry and the built-in ones are not the project's.
    expect(summaries).toEqual(["environment (0)", "allow (2)", "soft_deny (0)", "hard_deny (0)"]);
    for (const name of ["environment", "allow", "soft_deny", "hard_deny"] as const) {
      expect(fold(section(root, name)).open).toBe(false);
    }
    expect(textOf(root.querySelector(".status-automode-key"))).toBe("github.com/kawaz/demo");
  });

  test("open, the project's entries, [＋], then the user's settings and the built-in defaults, named with the section", async () => {
    const { root } = await mount();
    openAll(root);
    const allow = section(root, "allow");
    const list = instanceOf(
      fold(allow).querySelector(":scope > .status-automode-entries"),
      HTMLElement,
      "the section's list",
    );
    const items = [...list.children].map((li) =>
      li.querySelector("summary") !== null
        ? textOf(li.querySelector("summary"))
        : li.querySelector(".status-automode-add") !== null
          ? "＋"
          : textOf(li.querySelector(".status-automode-entry")),
    );
    expect(items).toEqual([
      "run the tests",
      "read the docs",
      "＋",
      "ユーザ設定 (allow)",
      "デフォルト設定 (allow)",
    ]);
    for (const name of ["environment", "soft_deny", "hard_deny"] as const) {
      const sec = section(root, name);
      expect(textOf(layer(sec, "user")?.querySelector("summary") ?? null)).toBe(
        `ユーザ設定 (${name})`,
      );
      expect(textOf(layer(sec, "builtin")?.querySelector("summary") ?? null)).toBe(
        `デフォルト設定 (${name})`,
      );
    }
  });

  test("the user's settings and the built-in defaults are closed at the start and list their entries", async () => {
    const { root } = await mount();
    const softDeny = section(root, "soft_deny");
    expect(layer(softDeny, "user")?.open).toBe(false);
    expect(layer(softDeny, "builtin")?.open).toBe(false);
    const entries = (d: HTMLDetailsElement | null): string[] =>
      [...(d?.querySelectorAll(".status-automode-entry") ?? [])].map(textOf);
    expect(entries(layer(softDeny, "user"))).toEqual(["user deny"]);
    expect(entries(layer(softDeny, "builtin"))).toEqual(["s1", "s2", "s3"]);
    expect(textOf(layer(section(root, "hard_deny"), "user")?.querySelector("p") ?? null)).toBe(
      "項目なし",
    );
  });

  // The daemon puts `$defaults` first in every section with entries, so the
  // built-in defaults hold there; elsewhere only a user's list written
  // without it takes them away (DR-0063 §1).
  test("the built-in defaults show only where they hold", async () => {
    const m = await mount();
    // The user writes allow without $defaults, but the project has entries.
    expect(layer(section(m.root, "allow"), "builtin")).not.toBeNull();
    expect(layer(section(m.root, "environment"), "builtin")).not.toBeNull();
    await act(() => {
      m.store.dispatch({
        type: "project-auto-mode/loaded",
        key: KEY,
        project: { ...project(m), allow: [] },
      });
    });
    expect(layer(section(m.root, "allow"), "builtin")).toBeNull();
    expect(layer(section(m.root, "environment"), "builtin")).not.toBeNull();
  });

  test("the user's settings and the built-in defaults cannot be edited", async () => {
    const m = await mount();
    openAll(m.root);
    const softDeny = section(m.root, "soft_deny");
    for (const which of ["user", "builtin"] as const) {
      const d = defined(layer(softDeny, which), which);
      expect(d.querySelector(".status-automode-entry-editable, textarea, input")).toBeNull();
      const [entry] = d.querySelectorAll(".status-automode-entry");
      await click(instanceOf(entry, HTMLElement, "an entry"));
    }
    expect(textarea(section(m.root, "soft_deny"))).toBeNull();
    expect(m.writes.calls).toEqual([]);
  });

  // `$defaults` is the daemon's, put first in every section with entries
  // (DR-0063 §1): nothing on screen names it, the user's own included.
  test("$defaults is nowhere on screen", async () => {
    const { root } = await mount();
    openAll(root);
    await settle();
    expect(root.textContent).not.toContain("$defaults");
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

  test("a user's settings that do not read say why in the user's settings", async () => {
    const { root } = await mount({ user: { unavailable: "settings.json が読めない: x" } });
    const env = section(root, "environment");
    expect(textOf(layer(env, "user")?.querySelector("p") ?? null)).toBe(
      "settings.json が読めない: x",
    );
    // Whether the built-in defaults hold is not known for a section with no
    // entries: they are not shown as holding.
    expect(layer(env, "builtin")).toBeNull();
    expect(layer(section(root, "allow"), "builtin")).not.toBeNull();
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
        project: { ...project(m), allow: ["from elsewhere", "read the docs", "third"] },
      });
    });
    const after = section(m.root, "allow");
    expect(entryButtons(after).map(textOf)).toEqual(["from elsewhere", "third"]);
    expect(textarea(after)?.value).toBe("half written");
    expect(textOf(after.querySelector(".status-automode-section-name"))).toBe("allow (3)");
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
        project: { ...project(m), allow: ["read the docs"] },
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
        project: { ...project(m), allow: ["read the docs"] },
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
          allow: ["theirs", "read the docs"],
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
      [
        ...(layer(section(m.root, "soft_deny"), "builtin")?.querySelectorAll(
          ".status-automode-entry",
        ) ?? []),
      ].map(textOf),
    ).toEqual(["s1", "s2", "s3"]);
  });
});

describe("the translation tabs on every entry (DR-0049)", () => {
  let restore: Array<() => void> = [];
  afterEach(() => {
    for (const r of restore) r();
    restore = [];
    _resetPlamoStateForTest();
  });

  /** The selected tab of each of the `.status-automode-item`s under `el`. */
  function tabs(el: Element | null): Array<string | null> {
    return [...(el?.querySelectorAll(".status-automode-item") ?? [])].map(
      (item) =>
        item.querySelector('[aria-label="本文の言語"] [aria-selected="true"]')?.textContent ?? null,
    );
  }

  test("the project's entries, the user's and the built-in ones each carry the tabs", async () => {
    const m = await mount({ hostTranslator: true });
    const softDeny = section(m.root, "soft_deny");
    const allow = section(m.root, "allow");
    expect(tabs(allow).slice(0, 2)).toEqual(["original", "original"]);
    expect(tabs(layer(softDeny, "user"))).toEqual(["original"]);
    expect(tabs(layer(softDeny, "builtin"))).toEqual(["original", "original", "original"]);
    const labels = [...(allow.querySelector('[aria-label="本文の言語"]')?.children ?? [])].map(
      textOf,
    );
    expect(labels).toEqual(["original", "ja(host)"]);
  });

  // The timeline's default pick, as it is: ja(plamo) for an entry with an
  // English paragraph, original for one without.
  test("with ja(plamo), an English entry opens on it and a Japanese one stays on original", async () => {
    // The pick then runs without waiting for the entry to come near the view.
    restore.push(stubGlobal("IntersectionObserver", undefined));
    restore.push(
      stubGlobal("fetch", async () =>
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "訳" } }] }),
      ),
    );
    const m = await mount({
      plamoUrl: "https://translate.example.test",
      project: {
        ...PROJECT,
        allow: ["Running the repo's own test suite is fine", "テストを走らせて良い"],
      },
    });
    await settle();
    expect(tabs(section(m.root, "allow")).slice(0, 2)).toEqual(["ja(plamo)", "original"]);
  });
});
