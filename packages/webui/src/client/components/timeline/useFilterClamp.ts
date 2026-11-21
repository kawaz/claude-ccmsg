// 🔔 / 🔐 / ⭐ のフィルタの中で、項目の本文を 5〜6 行分の高さに抑える (DR-0050
// §4、DR-0058 §6)。抑える高さとフェードは app.css (`.tl-lines[data-filter]` の
// 中の本文の `max-height` と、`data-clamped` の項目の `mask-image`) が持ち、
// ここは「抑えた本文に収まらない分があるか」を測って項目に知らせ、項目の
// クリックで広げた状態を持つ。
//
// 収まるかどうかは描かれた高さで決まる (markdown・highlight・画像は後から伸び
// る) ので、本文の要素とその子の大きさの変化を ResizeObserver で追う。これは
// ブラウザの layout という外の仕組みとの同期なので Effect に置く (react.dev の
// 規律)。測るのは、フィルタの中でその項目が見えている間 (`active`) だけ: TL の
// 全部の項目に observer を付けない。
import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { TimelineFilter } from "../../locator.ts";
import { useResettableState } from "../../useKeyedState.ts";

/** 抑える本文。AI の応答・ユーザの発言の吹き出しの本文、許可依頼の中身 (帯と
 * 最後の行の「既読」「まとめて許可」を除く)、say の本文 (足元の行の既読を除く)
 * (kawaz 2026-11-20)。未読か既読かを見せる所は抑えない。app.css の抑える規則と
 * 同じ組。 */
export const CLAMPED_BODY_SELECTOR =
  ":scope > :is(.tl-bubble-right, .tl-bubble-assistant) > .tl-bubble-body, :scope > .tl-bubble-permit > .tl-bubble-body > .permit-content, :scope > .say > .say-body";

export interface FilterClamp {
  /** 本文が抑えた高さに収まらず、下を省いている (広げていない)。 */
  clamped: boolean;
  /** 項目のクリックで広げた (フィルタの中の一時の状態)。 */
  expanded: boolean;
  /** 広げる。戻す操作は持たない。 */
  expand: () => void;
}

/** `itemRef` の項目の本文が、フィルタの中で抑えた高さに収まるかを測る。
 * `active` はその項目がフィルタ `filter` の中で見えている間。フィルタが
 * 変わると広げた状態は戻る。 */
export function useFilterClamp(
  itemRef: RefObject<HTMLElement>,
  filter: TimelineFilter | null,
  active: boolean,
): FilterClamp {
  const [expanded, setExpanded] = useResettableState<boolean>([filter], () => false);
  const [overflowing, setOverflowing] = useState(false);
  const measuring = active && !expanded;
  useEffect(() => {
    if (!measuring) return;
    const body = itemRef.current?.querySelector<HTMLElement>(CLAMPED_BODY_SELECTOR);
    if (body === null || body === undefined) return;
    const measure = () => setOverflowing(body.scrollHeight > body.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    for (const child of body.children) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [measuring, itemRef]);
  return {
    clamped: measuring && overflowing,
    expanded,
    expand: () => setExpanded(true),
  };
}
