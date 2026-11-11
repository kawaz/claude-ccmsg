// The Status tab's secret handoff, mounted (DR-0052 §3, §7): a field that
// takes a paste and nothing typed, which hands the pasted value to the daemon
// for the session at once and keeps it nowhere of the page, and the secrets
// the daemon holds for the session (ev:"secrets"), each with its length, what
// is left of its time and 破棄.
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { HeldSecret, ReplyOf } from "@ccmsg/protocol";
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
  discards: string[];
}

async function mount(
  reply: ReplyOf<"secret_put"> = {
    ok: true,
    notice: { sid: SID, outcome: "delivered" },
    key: "k1",
    chars: 17,
  },
): Promise<Mounted> {
  const store = createStore(initialState());
  const puts: Array<[string, string]> = [];
  const discards: string[] = [];
  const ws = {
    ...createWsClient((action) => store.dispatch(action)),
    secretPut: (sid: string, value: string): Promise<ReplyOf<"secret_put">> => {
      puts.push([sid, value]);
      return Promise.resolve(reply);
    },
    secretDiscard: (key: string): Promise<ReplyOf<"secret_discard">> => {
      discards.push(key);
      return Promise.resolve({ ok: true });
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(h(AppContext.Provider, { value: { store, ws } }, h(SecretHandoff, { sid: SID })), root),
  );
  return { root, store, puts, discards };
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

function held(overrides: Partial<HeldSecret> = {}): HeldSecret {
  const receivedAt = Date.now();
  return {
    key: "k1",
    session_id: SID,
    received_at: receivedAt,
    expires_at: receivedAt + 5 * 60 * 1000,
    chars: 17,
    ...overrides,
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
    expect(JSON.stringify(store.getState().secrets)).not.toContain("test-secret-0123");
    expect(storage.length).toBe(0);
    expect(location.href).not.toContain("test-secret-0123");
    expect(root.querySelector(".status-secret-result")?.textContent).toBe(
      "17 文字を受けた。セッションに取り出し方を知らせた",
    );
  });

  test("a notice that did not arrive is said under the field", async () => {
    const { root } = await mount({
      ok: true,
      notice: { sid: SID, outcome: "not_delivered", reason: "no_module" },
      chars: 17,
    });
    await paste(field(root), SECRET);
    expect(root.querySelector(".status-secret-result")?.textContent).toBe(
      "セッションに知らせが届かなかった (no_module) ので、預からなかった",
    );
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

  test("the session's held secrets are listed with their length and time left, and 破棄 sends their key", async () => {
    const { root, store, discards } = await mount();
    await act(() => {
      store.dispatch({
        type: "secrets/loaded",
        secrets: [
          held(),
          held({ key: "other", session_id: "ffffffff-0000-4000-8000-000000000000" }),
        ],
      });
    });
    const rows = [...root.querySelectorAll(".status-action")].slice(1);
    expect(rows).toHaveLength(1);
    const row = instanceOf(rows[0], HTMLElement, "the held row");
    expect(row.querySelector(".status-action-name")?.textContent).toBe("17 文字");
    expect(row.querySelector(".status-action-desc")?.textContent).toMatch(
      /に受けた。残り 4m5\ds$|に受けた。残り 5m0s$/,
    );
    const button = instanceOf(row.querySelector("button"), HTMLButtonElement, "破棄");
    expect(button.textContent).toBe("破棄");
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(discards).toEqual(["k1"]);

    await act(() => {
      store.dispatch({ type: "secrets/loaded", secrets: [] });
    });
    expect(root.querySelectorAll(".status-action")).toHaveLength(1);
  });
});
