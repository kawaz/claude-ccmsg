// hook を 1 つだけ呼ぶ component をマウントして、hook の戻り値を外から読む。
// DOM が要るので、使う test file は冒頭で `withDom()` を呼ぶ。effect まで流す
// ために、マウント・props の差し替え・アンマウントは `act` で包む。
import { h, render, type ComponentChild } from "preact";
import { act } from "preact/test-utils";

export interface RenderedHook<P, R> {
  /** 直近の render で hook が返した値。 */
  current: () => R;
  /** hook が何回 render されたか。 */
  renders: () => number;
  rerender: (props: P) => Promise<void>;
  unmount: () => Promise<void>;
}

/** `hook(props)` を呼ぶ component をマウントする。`wrap` は context の
 * Provider など、hook の外側に置く要素を足す。`extra` は hook の component の
 * 中に描く要素 (hook に渡す ref を付ける DOM など)。 */
export async function renderHook<P, R>(
  hook: (props: P) => R,
  props: P,
  options: {
    wrap?: (child: ComponentChild) => ComponentChild;
    extra?: (result: R) => ComponentChild;
  } = {},
): Promise<RenderedHook<P, R>> {
  const box: { latest: { result: R } | null; renders: number } = { latest: null, renders: 0 };
  function Probe({ props: current }: { props: P }) {
    const result = hook(current);
    box.latest = { result };
    box.renders += 1;
    return options.extra ? options.extra(result) : null;
  }
  const root = document.createElement("div");
  document.body.append(root);
  const vnode = (current: P) => {
    const probe = h(Probe, { props: current });
    return options.wrap ? options.wrap(probe) : probe;
  };
  await act(() => render(vnode(props), root));
  return {
    current: () => {
      if (box.latest === null) throw new Error("the hook has not rendered");
      return box.latest.result;
    },
    renders: () => box.renders,
    rerender: (next) => act(() => render(vnode(next), root)),
    unmount: async () => {
      await act(() => render(null, root));
      root.remove();
    },
  };
}
