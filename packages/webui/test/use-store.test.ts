// useStoreState の購読契約を、useSyncExternalStore に渡す snapshot 関数
// (selectionReader) の側から固定する。useSyncExternalStore は snapshot が
// Object.is で変わった時だけ再描画し、購読開始時にも snapshot を読み直す
// (react.dev "useSyncExternalStore") ので、「無関係な dispatch で再描画しない」
// は「snapshot が同じ参照を返す」、「初回 render と購読開始の間の dispatch を
// 取りこぼさない」は「snapshot が呼ばれた時点の state を読む」に置き換わる。
//
// マウントしての検証 (DOM 基盤) は未導入 (docs/TESTING.md)。導入されたら
// コンポーネント単位の再描画数をここに足す。
import { describe, expect, test } from "bun:test";
import type { PeerInfo } from "@ccmsg/protocol";
import { initialState, type AppState } from "../src/client/store.ts";
import { createStore, sameJson, selectionReader, shallowEqual } from "../src/client/useStore.ts";

function peer(sid: string, ws = "main"): PeerInfo {
  return { sid, repo: "repo", ws, cwd: `/work/${sid}` };
}

const headerSlice = (state: AppState) => ({
  connStatus: state.connStatus,
  sidebarOpen: state.sidebarOpen,
});

const noCommit = () => null;

describe("selectionReader", () => {
  test("a dispatch that leaves the slice equal hands back the same selection", () => {
    const store = createStore(initialState());
    const read = selectionReader(store, headerSlice, shallowEqual, noCommit);
    const first = read();
    store.dispatch({ type: "fork/availability", available: true });
    store.dispatch({ type: "llm-requests/loaded", requests: [] });
    expect(read()).toBe(first);
  });

  test("a dispatch that changes the slice hands back the new selection", () => {
    const store = createStore(initialState());
    const read = selectionReader(store, headerSlice, shallowEqual, noCommit);
    const first = read();
    store.dispatch({ type: "conn/status", status: "connected" });
    const next = read();
    expect(next).not.toBe(first);
    expect(next.connStatus).toBe("connected");
  });

  test("a row replaced by an equal copy keeps the reference the component holds", () => {
    // peers / agents は push のたびに全行が新しいオブジェクトで届く。
    const store = createStore(initialState());
    store.dispatch({ type: "peers/loaded", peers: [peer("a"), peer("b")] });
    const read = selectionReader(
      store,
      (state) => state.peers.find((p) => p.sid === "a"),
      sameJson,
      noCommit,
    );
    const first = read();
    store.dispatch({ type: "peers/loaded", peers: [peer("a"), peer("b", "other")] });
    expect(read()).toBe(first);
    store.dispatch({ type: "peers/loaded", peers: [peer("a", "renamed"), peer("b", "other")] });
    expect(read()?.ws).toBe("renamed");
  });

  test("reads the state at the moment it is asked, so a dispatch before the subscription is not lost", () => {
    // 初回 render で読んだ後、購読が始まる前に dispatch が来た状況。
    // useSyncExternalStore は購読開始時に snapshot を読み直して比べる。
    const store = createStore(initialState());
    const read = selectionReader(store, (state) => state.connStatus, Object.is, noCommit);
    const rendered = read();
    store.dispatch({ type: "conn/status", status: "connected" });
    expect(read()).not.toBe(rendered);
    expect(read()).toBe("connected");
  });

  test("a re-render with a new selector closure keeps the committed selection when it is equal", () => {
    // インライン selector は render ごとに作り直される。前回 commit した値と
    // 等しければ同じ参照を返し、下流の memo / deps を壊さない。
    const store = createStore(initialState());
    const committed = { selection: headerSlice(store.getState()) };
    const read = selectionReader(
      store,
      (state) => ({ connStatus: state.connStatus, sidebarOpen: state.sidebarOpen }),
      shallowEqual,
      () => committed,
    );
    expect(read()).toBe(committed.selection);
  });
});

describe("shallowEqual", () => {
  test("compares each key's value by identity", () => {
    const rooms = new Map<string, number>();
    expect(shallowEqual({ a: 1, rooms }, { a: 1, rooms })).toBe(true);
    expect(shallowEqual({ a: 1, rooms }, { a: 1, rooms: new Map<string, number>() })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  test("a key present on one side only is a difference", () => {
    expect(shallowEqual<{ a?: number; b?: number }>({ a: 1 }, { b: 1 })).toBe(false);
    expect(shallowEqual<{ a?: number; b?: number }>({ a: 1 }, { a: 1, b: 1 })).toBe(false);
  });
});

describe("sameJson", () => {
  test("equal wire records are equal whatever their identity", () => {
    expect(sameJson(peer("a"), peer("a"))).toBe(true);
    expect(sameJson(peer("a"), peer("a", "other"))).toBe(false);
  });

  test("an absent row differs from a present one", () => {
    expect(sameJson<PeerInfo | undefined>(undefined, undefined)).toBe(true);
    expect(sameJson<PeerInfo | undefined>(undefined, peer("a"))).toBe(false);
  });
});
