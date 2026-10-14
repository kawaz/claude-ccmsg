// RoomView をマウントして、送信下書きが room に属する契約を DOM で固定する。
// - 同じ room の中では、popup を閉じて開き直しても書きかけが残り、fab が
//   「下書きあり」を示す
// - 別の room へ移ると書きかけは持ち越されない (持ち越すと、送信先が新しい
//   room になった書きかけを誤って送れる)
// 出典: docs/findings/2026-10-14-webui-hooks-review-react-guidance.md (high 2)
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ADMIN_ID, initialState } from "../src/client/store.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { AppContext } from "../src/client/context.ts";
import { createWsClient } from "../src/client/ws.ts";
import { RoomView } from "../src/client/components/RoomView.tsx";
import { instanceOf } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

/** Two rooms, each introduced by a delivered message — a room the store first
 * hears of this way is born with its history loaded, so nothing is fetched.
 * The socket is never connected: nothing here may depend on a reply. */
function twoRooms(): Store {
  const store = createStore(initialState());
  for (const room of ["r1", "r2"]) {
    store.dispatch({
      type: "protocol-event",
      event: {
        type: "msg",
        mid: 1,
        from: ADMIN_ID,
        ts: "2026-10-14T00:00:00.000Z",
        msg: "hi",
        r: room,
      },
    });
  }
  return store;
}

function openRoom(store: Store, room: string): void {
  store.dispatch({
    type: "locator/changed",
    locator: { view: "room", room, mid: null },
    sidebar: CLOSED_SIDEBAR,
  });
}

async function mount(store: Store): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  const ws = createWsClient(
    (action) => store.dispatch(action),
    () => store.getState(),
  );
  await act(() =>
    render(h(AppContext.Provider, { value: { store, ws } }, h(RoomView, null)), root),
  );
  return root;
}

function element(root: HTMLElement, selector: string): HTMLElement {
  return instanceOf(root.querySelector(selector), HTMLElement, selector);
}

function textarea(root: HTMLElement): HTMLTextAreaElement {
  const selector = ".room-composer-panel textarea";
  return instanceOf(root.querySelector(selector), HTMLTextAreaElement, selector);
}

async function openComposer(root: HTMLElement): Promise<void> {
  await act(() => element(root, ".room-composer-fab").click());
}

async function closeComposer(root: HTMLElement): Promise<void> {
  await act(() => element(root, ".composer-panel-close").click());
}

async function type(root: HTMLElement, text: string): Promise<void> {
  const field = textarea(root);
  await act(() => {
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RoomView draft mounted", () => {
  test("closing and reopening the composer in the same room keeps the draft", async () => {
    const store = twoRooms();
    openRoom(store, "r1");
    const root = await mount(store);
    await openComposer(root);
    await type(root, "half-written for r1");
    await closeComposer(root);
    expect(element(root, ".room-composer-fab").classList.contains("composer-fab-draft")).toBe(true);
    await openComposer(root);
    expect(textarea(root).value).toBe("half-written for r1");
  });

  test("switching to another room does not carry the draft over", async () => {
    const store = twoRooms();
    openRoom(store, "r1");
    const root = await mount(store);
    await openComposer(root);
    await type(root, "half-written for r1");
    await closeComposer(root);

    await act(() => openRoom(store, "r2"));
    expect(element(root, ".room-composer-fab").classList.contains("composer-fab-draft")).toBe(
      false,
    );
    await openComposer(root);
    expect(textarea(root).value).toBe("");
  });
});
