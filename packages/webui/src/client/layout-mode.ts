// Layout が「サイドバーと本文を並べて収められるか」を、CSS を正本にして知る
// ための読み取り (pane-axis.ts と同じ考え方)。
//
// 幅の閾値は app.css の @media が 1 か所で持ち、JS はその結果だけを読む:
// 収まらない幅では Layout が `overflow-x: auto` になり、本文が Layout の幅
// ちょうどを占めてサイドバーの右へ押し出される。収まる幅では `clip` のまま
// 横スクロールは生えない。
//
// ハンバーガーの意味がこの 2 つで変わる (収まる幅ではサイドバーを消す /
// 出す、収まらない幅ではどちら側を見るかの切り替え) ので、押した瞬間の判定は
// 呼び出し側が `layoutScrollsX` を直接呼んで常に最新を読み、描画に要る分
// (ラベル) だけ hook の値を使う。
import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

/** 今の幅が、サイドバーと本文を並べて収められない幅 (スマホの幅) か。境は
 * app.css の同じ @media が持ち、その中で立てる `--layout-narrow` を読む。DOM の
 * 無い所 (DOM を持たない test) では広い幅とみなす。 */
export function layoutNarrow(): boolean {
  if (typeof document === "undefined") return false;
  const flag = getComputedStyle(document.documentElement).getPropertyValue("--layout-narrow");
  return flag.trim() === "1";
}

export function layoutScrollsX(el: Element | null): boolean {
  return el !== null && getComputedStyle(el).overflowX === "auto";
}

/** 監視が ResizeObserver なのは pane-axis.ts と同じ理由 — 切り替わる場面
 * (メディアクエリの境界をまたぐリサイズ) が必ずこの要素の寸法変化を伴う。 */
export function useLayoutScrollsX(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setScrolls(layoutScrollsX(el));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return scrolls;
}
