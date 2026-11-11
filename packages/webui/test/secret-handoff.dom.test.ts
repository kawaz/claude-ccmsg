// The Status tab's secret handoff, mounted (DR-0052 §3, §7): a field that
// takes a paste and nothing typed, which hands the pasted value to the daemon
// for the session at once and keeps it nowhere of the page, and what came of
// it in the tab's result box (`.status-op-result`, the launch's and the
// restart's), until the next paste.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SecretHandoff } from "../src/client/components/SecretHandoff.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, MemStorage, stubGlobal, stubProperty } from "./helpers.ts";

withDom();

const SID = "eeeeeeee-0000-4000-8000-000000000007";
const SECRET = "test-secret-0123\n";

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
}

async function mount(
  reply: ReplyOf<"secret_put"> = {
    ok: true,
    notice: { sid: SID, outcome: "delivered" },
    chars: 17,
  },
): Promise<Mounted> {
  const store = createStore(initialState());
  const puts: Array<[string, string]> = [];
  const ws = {
    ...createWsClient((action) => store.dispatch(action)),
    secretPut: (sid: string, value: string): Promise<ReplyOf<"secret_put">> => {
      puts.push([sid, value]);
      return Promise.resolve(reply);
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(h(AppContext.Provider, { value: { store, ws } }, h(SecretHandoff, { sid: SID })), root),
  );
  return { root, store, puts };
}

function field(root: HTMLElement): HTMLInputElement {
  return instanceOf(
    root.querySelector('input[aria-label="シークレットを貼り付け"]'),
    HTMLInputElement,
    "the paste field",
  );
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

/** The result box under the field: its tone, title and line. */
function resultBox(root: HTMLElement): { tone: string | null; lines: string[] } | null {
  const box = root.querySelector(".status-secrets .status-op-result");
  if (box === null) return null;
  return {
    tone: box.getAttribute("data-tone"),
    lines: [...box.querySelectorAll("p")].map((p) => p.textContent ?? ""),
  };
}

describe("Status tab secret handoff", () => {
  test("typing is refused before it changes the field", async () => {
    const { root, puts } = await mount();
    const input = field(root);
    const typed = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "a",
      bubbles: true,
      cancelable: true,
    });
    await act(() => {
      input.dispatchEvent(typed);
    });
    expect(typed.defaultPrevented).toBe(true);
    // What an IME's composition got in anyway is cleared on its input.
    await act(() => {
      input.value = "あ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("");
    expect(puts).toEqual([]);
  });

  test("a paste hands the value to the daemon for the session at once, and the page keeps none of it", async () => {
    const storage = new MemStorage();
    restores.push(stubGlobal("localStorage", storage));
    const { root, store, puts } = await mount();
    const event = await paste(field(root), SECRET);

    expect(puts).toEqual([[SID, SECRET]]);
    expect(event.defaultPrevented).toBe(true);
    expect(field(root).value).toBe("");
    expect(document.body.innerHTML).not.toContain("test-secret-0123");
    expect(JSON.stringify(store.getState())).not.toContain("test-secret-0123");
    expect(storage.length).toBe(0);
    expect(location.href).not.toContain("test-secret-0123");
    expect(resultBox(root)).toEqual({
      tone: "ok",
      lines: ["送信成功", "17 文字を受けた。セッションに取り出し方を知らせた。最長 5 分で消える"],
    });
  });

  test("a notice not known to have arrived is said in the running tone", async () => {
    const { root } = await mount({
      ok: true,
      notice: { sid: SID, outcome: "unconfirmed" },
      chars: 17,
    });
    await paste(field(root), SECRET);
    expect(resultBox(root)).toEqual({
      tone: "running",
      lines: [
        "送信した (未確認)",
        "17 文字を受けた。知らせが届いたかは確かめられなかった。最長 5 分で消える",
      ],
    });
  });

  test("a notice that did not arrive is said in the error tone", async () => {
    const { root } = await mount({
      ok: true,
      notice: { sid: SID, outcome: "not_delivered", reason: "no_module" },
      chars: 17,
    });
    await paste(field(root), SECRET);
    expect(resultBox(root)).toEqual({
      tone: "error",
      lines: ["送れなかった", "セッションに知らせが届かなかった (no_module) ので、預からなかった"],
    });
  });

  test("a refused paste is said in the error tone with the daemon's reason", async () => {
    const { root } = await mount({ ok: false, error: { code: "bad_request", msg: "no" } });
    await paste(field(root), SECRET);
    expect(resultBox(root)).toEqual({
      tone: "error",
      lines: ["送れなかった", "送れなかった (bad_request): no"],
    });
  });

  test("nothing is shown before the first paste, and a result stays until the next paste", async () => {
    const { root } = await mount();
    expect(resultBox(root)).toBeNull();
    await paste(field(root), SECRET);
    expect(resultBox(root)?.tone).toBe("ok");
  });

  // The paste goes no further than the field: a paste handler around it or on
  // the document (the composer's takes pasted text and files) gets nothing.
  test("the paste does not reach the elements around the field or the document", async () => {
    const { root, puts } = await mount();
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
    } finally {
      root.removeEventListener("paste", onRoot);
      document.removeEventListener("paste", onDocument);
    }
    expect(puts).toEqual([[SID, SECRET]]);
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
    expect(written.filter((line) => line.includes("test-secret-0123"))).toEqual([]);
  });

  test("an empty paste sends nothing", async () => {
    const { root, puts } = await mount();
    await paste(field(root), "");
    expect(puts).toEqual([]);
  });

  // A touch device keeps its on-screen keyboard up while the field has the
  // focus, and the field takes no typing (DR-0052 §3).
  test("a paste takes the focus out of the field, an empty one too", async () => {
    const { root } = await mount();
    for (const text of [SECRET, ""]) {
      const input = field(root);
      input.focus();
      expect(document.activeElement).toBe(input);
      await paste(input, text);
      expect(document.activeElement).not.toBe(input);
    }
  });
});
