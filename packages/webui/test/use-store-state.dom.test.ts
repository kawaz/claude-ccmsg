// useStoreState をマウントして、購読の契約を DOM と render 回数で固定する。
// - 選んだ slice が変わらない dispatch では、そのコンポーネントは render されない
// - 初回 render と購読開始の間に来た dispatch を取りこぼさない (tearing しない)
// - selector がインラインで毎 render 作り直されても、等しい slice なら同じ参照を返す
import { afterEach, describe, expect, test } from "bun:test";
import { h, render, type ComponentChild } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { act } from "preact/test-utils";
import { initialState, type AppState } from "../src/client/store.ts";
import { createStore, shallowEqual, useStoreState, type Store } from "../src/client/useStore.ts";
import { defined } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

let container: HTMLElement | null = null;

function mount(vnode: ComponentChild): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  return act(() => render(vnode, root)).then(() => root);
}

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

const selectConnStatus = (state: AppState) => state.connStatus;

/** 選んだ値を出し、render されるたびに数える。 */
function ConnStatusProbe({ store, renders }: { store: Store; renders: { count: number } }) {
  const status = useStoreState(store, selectConnStatus);
  renders.count += 1;
  return h("span", null, status);
}

describe("useStoreState mounted", () => {
  test("a dispatch that leaves the selected slice alone does not render the component", async () => {
    const store = createStore(initialState());
    const renders = { count: 0 };
    const root = await mount(h(ConnStatusProbe, { store, renders }));
    expect(root.textContent).toBe("connecting");
    const afterMount = renders.count;

    await act(() => {
      store.dispatch({ type: "launch/availability", available: true });
      store.dispatch({ type: "llm-requests/loaded", requests: [] });
      store.dispatch({ type: "peers/loaded", peers: [] });
    });
    expect(renders.count).toBe(afterMount);

    await act(() => store.dispatch({ type: "conn/status", status: "connected" }));
    expect(renders.count).toBe(afterMount + 1);
    expect(root.textContent).toBe("connected");
  });

  test("an object slice compared with shallowEqual renders only when one of its fields changes", async () => {
    const store = createStore(initialState());
    const renders = { count: 0 };
    const seen: Array<{ connStatus: string; sidebarOpen: boolean }> = [];
    function HeaderProbe() {
      // インラインの selector は render のたびに新しい関数になる。
      const slice = useStoreState(
        store,
        (state) => ({ connStatus: state.connStatus, sidebarOpen: state.sidebarOpen }),
        shallowEqual,
      );
      renders.count += 1;
      seen.push(slice);
      return h("span", null, `${slice.connStatus}/${String(slice.sidebarOpen)}`);
    }
    function Parent({ tick }: { tick: number }) {
      return h("div", { "data-tick": tick }, h(HeaderProbe, null));
    }
    const root = await mount(h(Parent, { tick: 0 }));
    const afterMount = renders.count;

    await act(() => store.dispatch({ type: "launch/availability", available: true }));
    expect(renders.count).toBe(afterMount);

    // 親の再描画で selector が作り直されても、等しい slice は同じ参照のまま。
    await act(() => render(h(Parent, { tick: 1 }), root));
    expect(renders.count).toBe(afterMount + 1);
    expect(seen.at(-1)).toBe(seen.at(-2));

    await act(() => store.dispatch({ type: "sidebar/set", open: !store.getState().sidebarOpen }));
    expect(renders.count).toBe(afterMount + 2);
    expect(seen.at(-1)).not.toBe(seen.at(-2));
    expect(root.textContent).toBe(`connecting/${String(store.getState().sidebarOpen)}`);
  });

  test("a dispatch between the first render and the subscription is not lost", async () => {
    // 購読は passive effect で始まる。同じ commit の layout effect (購読より
    // 先に走る) で dispatch し、購読開始時の読み直しで拾われることを見る。
    const store = createStore(initialState());
    const renders = { count: 0 };
    function DispatchOnCommit() {
      useLayoutEffect(() => {
        store.dispatch({ type: "conn/status", status: "connected" });
      }, []);
      return null;
    }
    const root = await mount(
      h("div", null, h(ConnStatusProbe, { store, renders }), h(DispatchOnCommit, null)),
    );
    expect(defined(root.querySelector("span"), "probe").textContent).toBe("connected");
  });
});
