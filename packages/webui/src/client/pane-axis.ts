// splitter の位置を「どの軸に沿った、どちらの端からの寸法か」に読み替える
// 共通の語彙。分割を持つ 3 か所 (Sidebar / FilesPanes / TimelinePanes) が
// 同じ関数を通す。
//
// 軸を決めるのは CSS だけ: コンテナの `flex-direction` を読むので、幅の閾値は
// app.css の @media が 1 か所で持つ。JS 側に同じ px を書くと、片方だけ動かした
// ときに軸の解釈と見た目がずれる。
//
// 語彙は `row` / `column` の 2 値に限る。並びを逆にしたいときは
// `flex-direction: *-reverse` ではなく子の `order` で表す約束なので
// (app.css)、reverse はここでは扱わない — 子が 3 つ以上あるとき reverse は
// 「全部まとめてひっくり返す」しかできず、任意の順を指定できない。
import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

export type PaneAxis = "row" | "column";

/** `getComputedStyle(el).flexDirection` の値を軸に落とす。 */
export function paneAxis(flexDirection: string): PaneAxis {
  return flexDirection === "column" ? "column" : "row";
}

/** その軸に沿ったコンテナの端・長さと、ポインタの位置。呼び出し側は
 * 「一覧側がどちらの端にあるか」だけを決めればよく (`pointer - start` か
 * `end - pointer` か)、clientX / clientY のどちらを見るかは考えない。 */
export interface PaneAxisMetrics {
  /** 軸の手前側の端 (row なら `rect.left`、column なら `rect.top`)。 */
  start: number;
  /** 軸の奥側の端 (`rect.right` / `rect.bottom`)。 */
  end: number;
  /** その軸に沿ったコンテナの長さ。 */
  size: number;
  /** その軸に沿ったポインタの位置 (`clientX` / `clientY`)。 */
  pointer: number;
}

export function paneAxisMetrics(
  axis: PaneAxis,
  rect: DOMRect,
  pointer: { clientX: number; clientY: number },
): PaneAxisMetrics {
  return axis === "column"
    ? { start: rect.top, end: rect.bottom, size: rect.height, pointer: pointer.clientY }
    : { start: rect.left, end: rect.right, size: rect.width, pointer: pointer.clientX };
}

/** 要素が今どちらの軸で並んでいるか。ドラッグ中の解釈はこれを直接呼んで
 * 常に最新を読む。 */
export function readPaneAxis(el: Element | null): PaneAxis {
  return el === null ? "row" : paneAxis(getComputedStyle(el).flexDirection);
}

/** 描画に軸が要るとき (`aria-orientation` など) 用。監視が ResizeObserver
 * なのは、軸が変わる場面 (メディアクエリの切り替え) が必ずこの要素の寸法変化を
 * 伴うため — 軸そのものを購読する API は無い。 */
export function usePaneAxis(ref: RefObject<HTMLElement | null>): PaneAxis {
  const [axis, setAxis] = useState<PaneAxis>("row");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setAxis(readPaneAxis(el));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return axis;
}
