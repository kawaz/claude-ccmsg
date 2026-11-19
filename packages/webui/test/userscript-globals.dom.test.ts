// The userscript in GLOBALS and its edit dialog, mounted (DR-0057 §1, §3),
// and the notice of a page whose userscript failed (§4).
//
// 何を保証するか:
//   - 行は `userscript: none` (保存が無い、文字) / enabled・disabled (保存があり、このブラウザで有効・無効。
//     緑・赤の select) と edit。保存の有無が未着の間は — で edit は押せない
//   - select はこのブラウザの切り替え: localStorage に書き、daemon には何も送らない
//   - edit で dialog が開き、保存された元のソース (無ければ既定の雛形) が textarea に入る
//   - 保存: 送るのは textarea の今の中身。断られたら確認の出力をそのまま出し、通れば「読み込み直すと効く」と言い、
//     行は none から保存ありになる (このブラウザの切り替えは変えない)。保存は今のページの userscript を走らせない
//   - 削除: 保存がある時だけ出る。確認で断れば何も送らない。通れば userscript_delete を送り、行は none になり
//     dialog が閉じる。失敗は dialog に出す
//   - 知らせは失敗の文と ?userscript=off の案内を出し、閉じると消える
import { afterEach, describe, expect, test } from "bun:test";
import { type ComponentChild, h, render } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import {
  USERSCRIPT_DELETE_CONFIRM,
  UserscriptFailureNotice,
  UserscriptLine,
} from "../src/client/components/UserscriptGlobals.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { USERSCRIPT_DEVICE_KEY, USERSCRIPT_TEMPLATE } from "../src/client/userscript.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, stubProperty } from "./helpers.ts";
import { dialogTitled } from "./status-actions.ts";

withDom();

const SAVED =
  "export async function userscript(util: unknown): Promise<void> {\n  document.title = 'x';\n}\n";

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  localStorage.removeItem(USERSCRIPT_DEVICE_KEY);
});

interface Replies {
  read?: ReplyOf<"userscript_read">;
  write?: ReplyOf<"userscript_write">;
  delete?: ReplyOf<"userscript_delete">;
}

interface Mounted {
  root: HTMLElement;
  store: Store;
  writes: string[];
  /** Every request the row and the dialog sent, by op. */
  sent: string[];
  loads: number;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function mount(
  prepare: (store: Store) => void,
  replies: Replies = {},
  component: () => ComponentChild = () => h(UserscriptLine, null),
): Promise<Mounted> {
  const store = createStore(initialState());
  prepare(store);
  const mounted: Mounted = {
    root: document.createElement("div"),
    store,
    writes: [],
    sent: [],
    loads: 0,
  };
  const ws: WsHandle = {
    ...createWsClient((action) => store.dispatch(action)),
    userscriptRead: () => {
      mounted.sent.push("userscript_read");
      return Promise.resolve(replies.read ?? { ok: true });
    },
    userscriptWrite: (source) => {
      mounted.sent.push("userscript_write");
      mounted.writes.push(source);
      return Promise.resolve(replies.write ?? { ok: true });
    },
    userscriptDelete: () => {
      mounted.sent.push("userscript_delete");
      return Promise.resolve(replies.delete ?? { ok: true });
    },
    userscriptLoad: () => {
      mounted.sent.push("userscript_load");
      mounted.loads++;
      return Promise.resolve({ ok: true });
    },
  };
  document.body.append(mounted.root);
  roots.push(mounted.root);
  await act(() =>
    render(h(AppContext.Provider, { value: { store, ws } }, component()), mounted.root),
  );
  return mounted;
}

function row(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".sidebar-globals-userscript"), HTMLElement, "the row");
}

function stateSelect(root: HTMLElement): HTMLSelectElement | null {
  const found = root.querySelector("select.sidebar-globals-userscript-state");
  return found instanceof HTMLSelectElement ? found : null;
}

function editButton(root: HTMLElement): HTMLButtonElement {
  return instanceOf(
    root.querySelector(".sidebar-globals-userscript-edit"),
    HTMLButtonElement,
    "the edit button",
  );
}

async function openEditor(root: HTMLElement): Promise<HTMLDialogElement> {
  await act(() => editButton(root).click());
  await settle();
  const dialog = dialogTitled(root, "userscript");
  if (dialog === null) throw new Error("expected the userscript dialog");
  return dialog;
}

function editor(dialog: HTMLDialogElement): HTMLTextAreaElement {
  return instanceOf(
    dialog.querySelector("textarea.userscript-editor"),
    HTMLTextAreaElement,
    "the textarea",
  );
}

async function type(dialog: HTMLDialogElement, text: string): Promise<void> {
  const area = editor(dialog);
  await act(() => {
    area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save(dialog: HTMLDialogElement): Promise<void> {
  const form = instanceOf(
    dialog.querySelector("form.userscript-form"),
    HTMLFormElement,
    "the form",
  );
  await act(() => {
    form.requestSubmit();
  });
  await settle();
}

const saved = (store: Store): void => store.dispatch({ type: "userscript/saved", saved: true });
const none = (store: Store): void => store.dispatch({ type: "userscript/saved", saved: false });

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("GLOBALS' userscript row (DR-0057 §3)", () => {
  test("before the daemon has said: — and edit cannot be pressed", async () => {
    const { root } = await mount(() => {});
    expect(row(root).textContent).toContain("userscript: —");
    expect(editButton(root).disabled).toBe(true);
  });

  test("none is plain text; a saved one is this browser's switch, disabled by default", async () => {
    const n = await mount(none);
    expect(row(n.root).textContent).toContain("userscript: none");
    expect(stateSelect(n.root)).toBeNull();
    expect(editButton(n.root).disabled).toBe(false);

    const off = await mount(saved);
    const select = stateSelect(off.root);
    expect(select?.value).toBe("disabled");
    expect(select?.classList.contains("is-disabled")).toBe(true);

    const on = await mount((s) => {
      saved(s);
      s.dispatch({ type: "userscript/device", enabled: true });
    });
    expect(stateSelect(on.root)?.value).toBe("enabled");
    expect(stateSelect(on.root)?.classList.contains("is-enabled")).toBe(true);
  });

  test("the select switches this browser in localStorage, and asks the daemon nothing", async () => {
    const m = await mount(saved);
    const select = stateSelect(m.root);
    if (select === null) throw new Error("expected the select");
    await choose(select, "enabled");
    expect(localStorage.getItem(USERSCRIPT_DEVICE_KEY)).toBe("on");
    expect(m.store.getState().userscript.deviceEnabled).toBe(true);
    expect(stateSelect(m.root)?.classList.contains("is-enabled")).toBe(true);
    const again = stateSelect(m.root);
    if (again === null) throw new Error("expected the select");
    await choose(again, "disabled");
    expect(localStorage.getItem(USERSCRIPT_DEVICE_KEY)).toBeNull();
    expect(m.store.getState().userscript.deviceEnabled).toBe(false);
    expect(m.sent).toEqual([]);
  });
});

describe("the edit dialog (DR-0057 §1)", () => {
  test("with none saved it opens on the template; a save sends the textarea, and the row has one saved", async () => {
    const m = await mount(none);
    const dialog = await openEditor(m.root);
    expect(editor(dialog).value).toBe(USERSCRIPT_TEMPLATE);
    await type(dialog, SAVED);
    await save(dialog);
    expect(m.writes).toEqual([SAVED]);
    expect(dialog.querySelector(".userscript-saved")?.textContent).toContain("読み込み直すと効く");
    expect(m.store.getState().userscript.saved).toBe(true);
    // The browser's switch is not touched by a save, and nothing runs now.
    expect(m.store.getState().userscript.deviceEnabled).toBe(false);
    expect(m.loads).toBe(0);
  });

  test("it opens on the saved source as written", async () => {
    const m = await mount(saved, { read: { ok: true, source: SAVED } });
    const dialog = await openEditor(m.root);
    expect(editor(dialog).value).toBe(SAVED);
  });

  test("a refused save shows the check's output as it is, and nothing changes", async () => {
    const output =
      'userscript.ts:2:9: Expected identifier but found "="\n    const = 1;\n          ^';
    const m = await mount(none, {
      write: { ok: false, error: { code: "userscript_invalid", msg: output } },
    });
    const dialog = await openEditor(m.root);
    await type(dialog, "export async function userscript(util) {\n  const = 1;\n}\n");
    await save(dialog);
    expect(dialog.querySelector(".userscript-check-output")?.textContent).toBe(output);
    expect(dialog.querySelector(".userscript-saved")).toBeNull();
    expect(m.store.getState().userscript.saved).toBe(false);
  });
});

describe("deleting from the edit dialog (DR-0057 §3)", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });

  /** window.confirm answering `answer`, recording what it asked. */
  function confirmAnswering(answer: boolean): string[] {
    const asked: string[] = [];
    restores.push(
      stubProperty(window, "confirm", {
        value: (message: string) => {
          asked.push(message);
          return answer;
        },
        configurable: true,
      }),
    );
    return asked;
  }

  function deleteButton(dialog: HTMLDialogElement): HTMLButtonElement | null {
    const found = dialog.querySelector(".userscript-delete");
    return found instanceof HTMLButtonElement ? found : null;
  }

  test("no 削除 while none is saved", async () => {
    const m = await mount(none);
    const dialog = await openEditor(m.root);
    expect(deleteButton(dialog)).toBeNull();
  });

  test("declining the confirmation sends nothing", async () => {
    const asked = confirmAnswering(false);
    const m = await mount(saved, { read: { ok: true, source: SAVED } });
    const dialog = await openEditor(m.root);
    const button = deleteButton(dialog);
    if (button === null) throw new Error("expected 削除");
    await act(() => button.click());
    await settle();
    expect(asked).toEqual([USERSCRIPT_DELETE_CONFIRM]);
    expect(m.sent).toEqual(["userscript_read"]);
    expect(dialogTitled(m.root, "userscript")).not.toBeNull();
  });

  test("confirmed: deletes, the row says none, and the dialog closes", async () => {
    confirmAnswering(true);
    const m = await mount(saved, { read: { ok: true, source: SAVED } });
    const dialog = await openEditor(m.root);
    const button = deleteButton(dialog);
    if (button === null) throw new Error("expected 削除");
    await act(() => button.click());
    await settle();
    expect(m.sent).toEqual(["userscript_read", "userscript_delete"]);
    expect(m.store.getState().userscript.saved).toBe(false);
    expect(dialogTitled(m.root, "userscript")).toBeNull();
    expect(row(m.root).textContent).toContain("userscript: none");
  });

  test("a delete that failed is said in the dialog, and the dialog stays", async () => {
    confirmAnswering(true);
    const m = await mount(saved, {
      read: { ok: true, source: SAVED },
      delete: { ok: false, error: { code: "internal", msg: "EACCES" } },
    });
    const dialog = await openEditor(m.root);
    const button = deleteButton(dialog);
    if (button === null) throw new Error("expected 削除");
    await act(() => button.click());
    await settle();
    expect(dialog.textContent).toContain("削除できなかった");
    expect(dialog.textContent).toContain("EACCES");
    expect(m.store.getState().userscript.saved).toBe(true);
  });
});

describe("the failure notice (DR-0057 §4)", () => {
  test("says what failed and how to open without it, and closes", async () => {
    const m = await mount(
      (s) => s.dispatch({ type: "userscript/failure", message: "TypeError: boom" }),
      {},
      () => h(UserscriptFailureNotice, null),
    );
    const notice = instanceOf(
      m.root.querySelector(".userscript-failure"),
      HTMLElement,
      "the notice",
    );
    expect(notice.textContent).toContain("?userscript=off");
    expect(notice.querySelector(".userscript-check-output")?.textContent).toBe("TypeError: boom");
    const close = instanceOf(notice.querySelector("button"), HTMLButtonElement, "the close");
    await act(() => close.click());
    expect(m.root.querySelector(".userscript-failure")).toBeNull();
  });

  test("nothing while nothing failed", async () => {
    const m = await mount(
      () => {},
      {},
      () => h(UserscriptFailureNotice, null),
    );
    expect(m.root.innerHTML).toBe("");
  });
});
