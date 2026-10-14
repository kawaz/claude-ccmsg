// TL 右端のフロートパネル (auto open の設定など) の開閉と、開いている間に TL の
// 列が右に空ける幅。判断は timeline-side-panel.ts、ここは DOM への配線だけ。
import { useCallback, useEffect, useRef, useState, type MutableRef } from "preact/hooks";
import {
  shouldCloseSidePanel,
  sidePanelReserveWidth,
  TL_SIDE_PANEL_MIN_CONTENT_PX,
} from "../timeline-side-panel.ts";

/** `listRef` は TL 項目が並ぶ要素 (`.tl-lines`)。そこへのクリックは項目の
 * 選択なのでパネルを閉じない。 */
export function useSidePanel(listRef: { readonly current: Element | null }): {
  open: boolean;
  toggle: () => void;
  /** パネル (`.tl-auto-open-float`) に付ける ref。 */
  panelRef: MutableRef<HTMLDivElement | null>;
  /** 開いている間に TL の列が右に空けておく幅 (px)。 */
  reserve: number;
} {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // パネル外 click で自動収納 (kawaz r38 mid=66)。useFabPopup と同じ理由で
  // click イベント (tap 完了) のみ — mousedown/touchstart はスクロール目的の
  // タッチでも閉じてしまう。open 中だけ listener を張る。項目リストへの
  // click だけは畳まない (判断は shouldCloseSidePanel)。
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (shouldCloseSidePanel(e.target, panelRef.current, listRef.current)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open, listRef]);
  // 開いている間だけ TL の列を右に詰めて、パネルの真下に隠れて押せない項目を
  // 無くす (issue 2026-08-16-timeline-float-panel-blocks-record-click)。パネル
  // 幅は中身 (fork の説明文 / dump の出力先パス) で変わるので実測して渡す。
  const [reserve, setReserve] = useState(0);
  useEffect(() => {
    const panel = panelRef.current;
    const column = panel?.parentElement;
    if (!panel || !column) return;
    const measure = () => {
      setReserve(
        sidePanelReserveWidth(
          open,
          panel.getBoundingClientRect().width,
          column.getBoundingClientRect().width,
          TL_SIDE_PANEL_MIN_CONTENT_PX,
        ),
      );
    };
    measure();
    // padding-right は column の border-box 幅も panel の幅も変えないので、
    // この observe が自分自身を再発火させるループにはならない。
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(column);
    return () => observer.disconnect();
  }, [open]);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  return { open, toggle, panelRef, reserve };
}
