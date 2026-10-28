// RoomView と RoomList をマウントして、room が読み取り専用の閲覧 (DR-0036 §2)
// であることを DOM で固定する。
// - room を開くとそのログ (room_history) を 1 度だけ取りに行き、届いた event
//   から title・member・timeline を描く。書き込みの UI (入力欄・招待・
//   archive・title の編集) は無い
// - daemon が room_not_found と答えた room は 404 になる
// - サイドバーの room 一覧は畳んであり、開いた時に 1 度だけ一覧 (rooms) を
//   取りに行く
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf, StorageEvent } from "@ccmsg/protocol";
import { initialState } from "../src/client/store.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { AppContext } from "../src/client/context.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { RoomView } from "../src/client/components/RoomView.tsx";
import { RoomList } from "../src/client/components/RoomList.tsx";
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

/** room の読み取り要求を記録し、応答はテストが返す ws。それ以外の要求は
 * 接続していない本物の client に任せる (送ると reject されるので、使われたら
 * テストが気づく)。 */
class FakeRoomWs {
  readonly histories: string[] = [];
  readonly lists: number[] = [];
  #answerHistory: (reply: ReplyOf<"room_history">) => void = () => {};
  #answerRooms: (reply: ReplyOf<"rooms">) => void = () => {};
  readonly handle: WsHandle;

  constructor(store: Store) {
    const base = createWsClient((action) => store.dispatch(action));
    this.handle = {
      ...base,
      roomHistory: (room) => {
        this.histories.push(room);
        return new Promise((resolve) => {
          this.#answerHistory = resolve;
        });
      },
      rooms: () => {
        this.lists.push(this.lists.length);
        return new Promise((resolve) => {
          this.#answerRooms = resolve;
        });
      },
    };
  }

  /** 最後の room_history に答え、reducer と描画まで流す。 */
  answerHistory(reply: ReplyOf<"room_history">): Promise<void> {
    return act(async () => {
      this.#answerHistory(reply);
      await Promise.resolve();
    });
  }

  answerRooms(reply: ReplyOf<"rooms">): Promise<void> {
    return act(async () => {
      this.#answerRooms(reply);
      await Promise.resolve();
    });
  }
}

function roomStore(room: string): Store {
  const store = createStore(initialState());
  store.dispatch({
    type: "locator/changed",
    locator: { view: "room", room, mid: null },
    sidebar: CLOSED_SIDEBAR,
  });
  return store;
}

async function mount(store: Store, ws: FakeRoomWs, component: () => h.JSX.Element) {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await act(() =>
    render(h(AppContext.Provider, { value: { store, ws: ws.handle } }, h(component, {})), root),
  );
  return root;
}

const LOG: StorageEvent[] = [
  {
    type: "member",
    id: "a1",
    sid: "aaaaaaaa-0000-4000-8000-000000000001",
    repo: "o/repo",
    ws: "main",
    cwd: "/repo",
    joined_at: "2026-10-01T00:00:00.000Z",
  },
  { type: "title", title: "過去の会話", ts: "2026-10-01T00:00:01.000Z" },
  { type: "msg", mid: 1, from: "u1", ts: "2026-10-01T00:00:02.000Z", msg: "first" },
  { type: "msg", mid: 2, from: "a1", ts: "2026-10-01T00:00:03.000Z", msg: "second" },
];

describe("RoomView (read-only, DR-0036 §2)", () => {
  test("opening a room fetches its log once and draws it, with no way to write", async () => {
    const store = roomStore("r1");
    const ws = new FakeRoomWs(store);
    const root = await mount(store, ws, RoomView);
    expect(ws.histories).toEqual(["r1"]);
    expect(root.textContent).toContain("読み込み中");

    await ws.answerHistory({ ok: true, room: "r1", events: LOG });
    expect(ws.histories).toEqual(["r1"]);
    expect(root.querySelector("h2")?.textContent).toBe("過去の会話");
    const bodies = [...root.querySelectorAll(".msg")].map((el) => el.textContent ?? "");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("first");
    expect(bodies[1]).toContain("second");
    expect(root.querySelector(".room-readonly-note")?.textContent).toContain("読み取り専用");
    expect(root.textContent).not.toContain("読み込み中");
    // 書く口が無い: 入力欄も、押せる操作も描かない (member chip は表示だけ)。
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
  });

  test("a room the daemon does not have is the room's 404", async () => {
    const store = roomStore("r9");
    const ws = new FakeRoomWs(store);
    await mount(store, ws, RoomView);
    await ws.answerHistory({
      ok: false,
      error: { code: "room_not_found", msg: "no such room: r9" },
    });
    expect(store.getState().missingTarget).toEqual({ kind: "room", id: "r9" });
  });

  test("a failed read says so and is not retried in a loop", async () => {
    const store = roomStore("r1");
    const ws = new FakeRoomWs(store);
    const root = await mount(store, ws, RoomView);
    await ws.answerHistory({ ok: false, error: { code: "internal", msg: "boom" } });
    expect(root.textContent).toContain("読み込めませんでした");
    expect(store.getState().missingTarget).toBeNull();
    expect(ws.histories).toEqual(["r1"]);
  });
});

describe("RoomList (read-only, DR-0036 §2)", () => {
  test("the list is fetched when the fold is first opened, and only then", async () => {
    const store = createStore(initialState());
    const ws = new FakeRoomWs(store);
    const root = await mount(store, ws, RoomList);
    expect(ws.lists).toEqual([]);

    const toggle = instanceOf(
      root.querySelector("#sidebar-rooms button.sidebar-fold-toggle"),
      HTMLButtonElement,
      "the room fold's toggle",
    );
    await act(() => {
      toggle.click();
    });
    expect(ws.lists).toHaveLength(1);
    expect(root.textContent).toContain("読み込み中");

    await ws.answerRooms({
      ok: true,
      rooms: [
        { id: "r1", title: "past", members: [], last_mid: 4, last_ts: "2026-10-01T00:00:00.000Z" },
      ],
    });
    expect(root.querySelector('a[href="/r/r1"]')?.textContent).toContain("past");

    // 閉じて開き直しても取り直さない (ログはもう変わらない)。
    await act(() => {
      toggle.click();
    });
    await act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(ws.lists).toHaveLength(1);
  });
});
