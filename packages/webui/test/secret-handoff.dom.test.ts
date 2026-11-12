// The Status tab's secret handoff, mounted (DR-0052 §3, §7): the field and
// the send button work on the value not yet sent, in paste mode (empty: a
// paste is kept off the page and counted in the placeholder) or text mode
// (typed, masked, with an eye), and the delete button works on the value the
// daemon holds, counting its seconds down from what the daemon answered
// (`secret_status` as the tab comes to the front, `secret_put`). What came
// of a send shows in the tab's result box only when it is not plain, and the
// value not yet sent is emptied as the tab comes to the front and leaves.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import {
  lineCount,
  SecretHandoff,
  secretPlaceholder,
} from "../src/client/components/SecretHandoff.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, MemStorage, stubGlobal, stubProperty } from "./helpers.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000007";
const SECRET = "test-secret-0123\n";
const DELIVERED: ReplyOf<"secret_put"> = {
  ok: true,
  notice: { sid: SID, outcome: "delivered" },
  chars: 17,
  ttl_ms: 300_000,
};

let roots: HTMLElement[] = [];
let restores: (() => void)[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  for (const restore of restores.splice(0)) restore();
});

interface Mounted {
  root: HTMLElement;
  store: Store;
  puts: Array<[string, string]>;
  deletes: string[];
  /** The sids `secret_status` was asked for, in order. */
  asks: string[];
  /** Render again with the tab in front or not. */
  show: (shown: boolean) => Promise<void>;
}

interface Replies {
  put?: ReplyOf<"secret_put">;
  /** `null`: the ask fails (the connection closed). */
  status?: ReplyOf<"secret_status"> | null;
  discard?: ReplyOf<"secret_discard">;
}

async function mount(
  replies: Replies | ReplyOf<"secret_put"> = {},
  shown = true,
): Promise<Mounted> {
  const {
    put: reply = DELIVERED,
    status = { ok: true },
    discard = { ok: true },
  }: Replies = "ok" in replies ? { put: replies } : replies;
  const store = createStore(initialState());
  const puts: Array<[string, string]> = [];
  const deletes: string[] = [];
  const asks: string[] = [];
  const ws = {
    ...createWsClient((action) => store.dispatch(action)),
    secretPut: (sid: string, value: string): Promise<ReplyOf<"secret_put">> => {
      puts.push([sid, value]);
      return Promise.resolve(reply);
    },
    secretDiscard: (sid: string): Promise<ReplyOf<"secret_discard">> => {
      deletes.push(sid);
      return Promise.resolve(discard);
    },
    secretStatus: (sid: string): Promise<ReplyOf<"secret_status">> => {
      asks.push(sid);
      return status === null ? Promise.reject(new Error("ws not open")) : Promise.resolve(status);
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const draw = (inFront: boolean) =>
    act(async () => {
      render(
        h(
          AppContext.Provider,
          { value: { store, ws } },
          h(SecretHandoff, { sid: SID, shown: inFront }),
        ),
        root,
      );
      await Promise.resolve();
    });
  await draw(shown);
  return { root, store, puts, deletes, asks, show: draw };
}

function field(root: HTMLElement): HTMLInputElement {
  return instanceOf(
    root.querySelector('input[aria-label="シークレット"]'),
    HTMLInputElement,
    "the field",
  );
}

function button(root: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...root.querySelectorAll(".status-secret-controls > button")].find((b) =>
    label.test(b.textContent ?? ""),
  );
  return instanceOf(found, HTMLButtonElement, `the ${label.source} button`);
}

function eye(root: HTMLElement): HTMLButtonElement | null {
  const found = root.querySelector(".status-secret-eye");
  return found instanceof HTMLButtonElement ? found : null;
}

async function paste(input: HTMLInputElement, text: string): Promise<ClipboardEvent> {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    input.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

/** Type `value` into the field as the browser does: its value, then input. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(
  input: HTMLInputElement,
  init: KeyboardEventInit & { isComposing?: boolean },
): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

/** The result box under the field: its tone and lines. */
function resultBox(root: HTMLElement): { tone: string | null; lines: string[] } | null {
  const box = root.querySelector(".status-secrets .status-op-result");
  if (box === null) return null;
  return {
    tone: box.getAttribute("data-tone"),
    lines: [...box.querySelectorAll("p")].map((p) => p.textContent ?? ""),
  };
}

describe("the placeholder's count", () => {
  test("lines are the newlines of the trimmed value and one: blank lines and newlines before and after count for nothing", () => {
    expect([
      lineCount("a"),
      lineCount("a\n"),
      lineCount("a\nb"),
      lineCount("a\nb\n"),
      lineCount("\n\na\n\n"),
      lineCount("\na\r\nb\r\n\r\n"),
      lineCount("a\n\nb"),
    ]).toEqual([1, 1, 2, 2, 1, 2, 3]);
    expect(secretPlaceholder(null)).toBe("貼り付けモード (通常入力もできます)");
    expect(secretPlaceholder("123456")).toBe("入力済み: 6 文字");
    // The count of characters is of the value as pasted, untrimmed.
    expect(secretPlaceholder("鍵🔑\n")).toBe("入力済み: 3 文字");
    expect(secretPlaceholder("\n123456\n")).toBe("入力済み: 8 文字");
    expect(secretPlaceholder("-----BEGIN-----\nAAAA\n-----END-----\n")).toBe(
      "入力済み: 35 文字 (3 行)",
    );
  });
});

describe("Status tab secret handoff", () => {
  test("empty, it is in paste mode: the placeholder says so, and 送信 and 削除 cannot be pressed", async () => {
    const { root } = await mount();
    expect(field(root).placeholder).toBe("貼り付けモード (通常入力もできます)");
    expect(field(root).value).toBe("");
    expect(button(root, /^送信$/).disabled).toBe(true);
    expect(button(root, /^削除$/).disabled).toBe(true);
    expect(eye(root)).toBeNull();
  });

  test("a paste is kept off the page, counted in the placeholder, and takes the focus out of the field", async () => {
    const storage = new MemStorage();
    restores.push(stubGlobal("localStorage", storage));
    const { root, store, puts } = await mount();
    const input = field(root);
    input.focus();
    const event = await paste(input, "-----BEGIN-----\ntest-secret-0123\n-----END-----\n");

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(field(root).value).toBe("");
    expect(field(root).placeholder).toBe("入力済み: 47 文字 (3 行)");
    expect(button(root, /^送信$/).disabled).toBe(false);
    expect(puts).toEqual([]);
    expect(document.body.innerHTML).not.toContain("test-secret-0123");
    expect(JSON.stringify(store.getState())).not.toContain("test-secret-0123");
    expect(storage.length).toBe(0);
    expect(location.href).not.toContain("test-secret-0123");
  });

  test("a second paste replaces the first, and an empty one changes nothing but the focus", async () => {
    const { root } = await mount();
    await paste(field(root), "first");
    await paste(field(root), "second!");
    expect(field(root).placeholder).toBe("入力済み: 7 文字");
    const input = field(root);
    input.focus();
    await paste(input, "");
    expect(document.activeElement).not.toBe(input);
    expect(field(root).placeholder).toBe("入力済み: 7 文字");
  });

  test("typing starts text mode: the pasted value is let go, the typed one is masked with an eye, and emptying goes back to paste mode", async () => {
    const { root, puts } = await mount({
      ok: true,
      notice: { sid: SID, outcome: "not_delivered", reason: "no_module" },
      chars: 6,
    });
    await paste(field(root), "pasted");
    await type(field(root), "123456");
    expect(field(root).value).toBe("123456");
    expect(field(root).classList.contains("status-secret-masked")).toBe(true);
    const shut = eye(root);
    expect(shut?.getAttribute("aria-pressed")).toBe("false");

    await click(instanceOf(shut, HTMLButtonElement, "the eye"));
    expect(field(root).classList.contains("status-secret-masked")).toBe(false);
    expect(eye(root)?.getAttribute("aria-pressed")).toBe("true");
    await click(instanceOf(eye(root), HTMLButtonElement, "the eye"));
    expect(field(root).classList.contains("status-secret-masked")).toBe(true);

    // What is sent is what was typed, the paste let go.
    await click(button(root, /^送信$/));
    expect(puts).toEqual([[SID, "123456"]]);

    await type(field(root), "");
    expect(field(root).placeholder).toBe("貼り付けモード (通常入力もできます)");
    expect(eye(root)).toBeNull();
    expect(button(root, /^送信$/).disabled).toBe(true);
  });

  test("in text mode a paste goes into the typed text as in any field", async () => {
    const { root } = await mount();
    await type(field(root), "12");
    const event = await paste(field(root), "34");
    expect(event.defaultPrevented).toBe(false);
  });

  test("Enter, ⌘Enter and Ctrl+Enter send; an IME's confirming Enter does not", async () => {
    const { root, puts } = await mount({
      ok: true,
      notice: { sid: SID, outcome: "not_delivered", reason: "no_module" },
      chars: 6,
    });
    await type(field(root), "123456");
    await press(field(root), { key: "Enter", isComposing: true });
    expect(puts).toEqual([]);
    await press(field(root), { key: "Enter" });
    await press(field(root), { key: "Enter", metaKey: true });
    await press(field(root), { key: "Enter", ctrlKey: true });
    expect(puts).toEqual([
      [SID, "123456"],
      [SID, "123456"],
      [SID, "123456"],
    ]);
  });

  test("a value that arrived leaves the field in paste mode with no result box", async () => {
    const { root, puts } = await mount();
    await paste(field(root), SECRET);
    await click(button(root, /^送信$/));
    expect(puts).toEqual([[SID, SECRET]]);
    expect(field(root).placeholder).toBe("貼り付けモード (通常入力もできます)");
    expect(button(root, /^送信$/).disabled).toBe(true);
    expect(resultBox(root)).toBeNull();
  });

  test("a value not known to have arrived is let go too, and said in the running tone", async () => {
    const { root } = await mount({
      ok: true,
      notice: { sid: SID, outcome: "unconfirmed" },
      chars: 6,
    });
    await type(field(root), "123456");
    await press(field(root), { key: "Enter" });
    expect(field(root).value).toBe("");
    expect(resultBox(root)).toEqual({
      tone: "running",
      lines: [
        "送信した (未確認)",
        "6 文字を受けた。知らせが届いたかは確かめられなかった。最長 5 分で消える",
      ],
    });
  });

  test("a value that was not sent stays to send again, and the reason is said in the error tone", async () => {
    const { root } = await mount({
      ok: true,
      notice: { sid: SID, outcome: "not_delivered", reason: "no_module" },
      chars: 6,
    });
    await paste(field(root), "123456");
    await click(button(root, /^送信$/));
    expect(field(root).placeholder).toBe("入力済み: 6 文字");
    expect(button(root, /^送信$/).disabled).toBe(false);
    expect(resultBox(root)).toEqual({
      tone: "error",
      lines: ["送れなかった", "セッションに知らせが届かなかった (no_module) ので、預からなかった"],
    });
    // Changing the value takes the box away.
    await paste(field(root), "654321");
    expect(resultBox(root)).toBeNull();
  });

  test("a refused send keeps the typed value and says the daemon's reason", async () => {
    const { root } = await mount({ ok: false, error: { code: "bad_request", msg: "no" } });
    await type(field(root), "123456");
    await press(field(root), { key: "Enter" });
    expect(field(root).value).toBe("123456");
    expect(resultBox(root)).toEqual({
      tone: "error",
      lines: ["送れなかった", "(bad_request): no"],
    });
  });

  test("in front, it asks the daemon once what is held; hidden, it does not ask", async () => {
    const hidden = await mount({}, false);
    expect(hidden.asks).toEqual([]);
    await hidden.show(true);
    expect(hidden.asks).toEqual([SID]);
    // Drawn again while in front: no second ask.
    await hidden.show(true);
    expect(hidden.asks).toEqual([SID]);
    await hidden.show(false);
    await hidden.show(true);
    expect(hidden.asks).toEqual([SID, SID]);
  });

  test("leaving and coming back to the front empty the value not yet sent", async () => {
    const { root, show } = await mount({
      put: { ok: false, error: { code: "bad_request", msg: "no" } },
    });
    await paste(field(root), "pasted");
    await show(false);
    await show(true);
    expect(field(root).placeholder).toBe("貼り付けモード (通常入力もできます)");
    await type(field(root), "123456");
    await click(instanceOf(eye(root), HTMLButtonElement, "the eye"));
    await press(field(root), { key: "Enter" });
    expect(resultBox(root)).not.toBeNull();
    await show(false);
    expect(field(root).value).toBe("");
    expect(resultBox(root)).toBeNull();
    await show(true);
    expect(field(root).value).toBe("");
    expect(eye(root)).toBeNull();
    expect(button(root, /^送信$/).disabled).toBe(true);
  });

  test("a held value's 削除 counts down from the daemon's answer, deletes the session's value, and leaves the value not yet sent", async () => {
    const { root, deletes } = await mount({
      status: { ok: true, held: { ttl_ms: 299_000, chars: 6 } },
    });
    const remove = button(root, /^削除 \(\d+秒\)$/);
    expect(remove.textContent).toBe("削除 (299秒)");
    expect(remove.disabled).toBe(false);
    await paste(field(root), "unsent");
    await click(remove);
    expect(deletes).toEqual([SID]);
    expect(button(root, /^削除$/).disabled).toBe(true);
    expect(field(root).placeholder).toBe("入力済み: 6 文字");
  });

  test("a value that arrived counts its 削除 down from the reply's ttl", async () => {
    const { root } = await mount();
    await paste(field(root), SECRET);
    await click(button(root, /^送信$/));
    expect(button(root, /^削除 \(\d+秒\)$/).textContent).toBe("削除 (300秒)");
  });

  test("a value already gone when 削除 is pressed (not_found) leaves 削除 idle, with no result box", async () => {
    const { root } = await mount({
      status: { ok: true, held: { ttl_ms: 120_000, chars: 6 } },
      discard: {
        ok: false,
        error: { code: "not_found", msg: "no secret is held for this session" },
      },
    });
    await click(button(root, /^削除 \(\d+秒\)$/));
    expect(button(root, /^削除$/).disabled).toBe(true);
    expect(resultBox(root)).toBeNull();
  });

  test("a held value with no time left shows 削除 idle", async () => {
    const { root } = await mount({ status: { ok: true, held: { ttl_ms: 0, chars: 6 } } });
    expect(button(root, /^削除$/).disabled).toBe(true);
  });

  test("an ask that fails leaves 削除 idle, with no result box", async () => {
    const { root, asks } = await mount({ status: null });
    expect(asks).toEqual([SID]);
    expect(button(root, /^削除$/).disabled).toBe(true);
    expect(resultBox(root)).toBeNull();
  });

  // The paste goes no further than the field: a paste handler around it or on
  // the document (the composer's takes pasted text and files) gets nothing.
  test("the paste does not reach the elements around the field or the document", async () => {
    const { root } = await mount();
    const heard: string[] = [];
    const onRoot = (): void => {
      heard.push("root");
    };
    const onDocument = (): void => {
      heard.push("document");
    };
    root.addEventListener("paste", onRoot);
    document.addEventListener("paste", onDocument);
    try {
      await paste(field(root), SECRET);
      await type(field(root), "12");
      await paste(field(root), "34");
    } finally {
      root.removeEventListener("paste", onRoot);
      document.removeEventListener("paste", onDocument);
    }
    expect(heard).toEqual([]);
  });

  test("the page writes nothing of the value to the console", async () => {
    const written: string[] = [];
    for (const name of ["log", "info", "warn", "error", "debug"]) {
      restores.push(
        stubProperty(console, name, {
          value: (...args: readonly string[]) => {
            written.push(args.join(" "));
          },
          configurable: true,
          writable: true,
        }),
      );
    }
    const { root } = await mount();
    await paste(field(root), SECRET);
    await click(button(root, /^送信$/));
    expect(written.filter((line) => line.includes("test-secret-0123"))).toEqual([]);
  });
});
