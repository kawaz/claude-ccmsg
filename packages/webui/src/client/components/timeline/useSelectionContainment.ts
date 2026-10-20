// Timeline の 1 つの項目 (コードの塊、吹き出しの本文、thinking の本文、
// 吹き出しの外の発言) の中で始まった選択を、選択範囲を調節している間その
// 項目の外へ広げない。
//
// Design rationale: CSS UI 4 の `user-select: contain` がこの振る舞いそのもの
// だが、実装しているブラウザが無い (MDN の互換データに値が無く、Chrome 155 /
// 157 Beta / WebKit 26.6 で `CSS.supports` が false、drag した選択は項目の外へ
// 出る)。代わりに選択が始まった時点で「その項目以外を選択不可
// (`user-select: none`)」にする。選択の端をどこに置けるかの判断はブラウザが
// 持ったまま (操作の種類によらず user-select の規則で決まる。マウスの drag で
// 確認済み、タッチのハンドルは実機で未確認 — DR-0010 §9) で、JS は始まった
// 場所を覚えて属性を付け外すだけにする。Selection を
// JS で書き戻す方式は、ユーザが動かしているタッチのハンドルと書き換えが同じ
// 選択を奪い合う。
import { useEffect } from "preact/hooks";

/** 選択の始点から、閉じ込める先の項目を決める。コードの塊を最優先
 * (コピーしたいのは大抵コードで、隣の本文まで選びたい時は本文から始める)。
 * 吹き出しの本文は中の段落より優先する — 複数の段落・segment にまたがって
 * 選べるようにするため。 */
export function selectionHostOf(start: EventTarget | null): Element | null {
  const el = start instanceof Element ? start : start instanceof Node ? start.parentElement : null;
  if (el === null || el.closest(".timeline-view") === null) return null;
  return (
    el.closest("pre") ??
    el.closest(".tl-bubble-body") ??
    el.closest(".tl-thinking-body") ??
    el.closest(".tl-text")
  );
}

/** 閉じ込め中であることを示す :root の属性 (app.css が見る)。 */
export const CONTAINED_ATTR = "data-select-contained";
/** 閉じ込め先の項目に付ける属性 (app.css が見る)。 */
export const HOST_ATTR = "data-select-host";

/**
 * `doc` に選択の閉じ込めを入れ、外す関数を返す。
 *
 * - 選択が始まった (`selectstart`) 場所が項目の中なら、その項目だけを選択
 *   可能にする。項目の外で始まった選択は閉じ込めない
 * - 項目の外を押したら外す (別の場所から新しく選び始められるように、
 *   ブラウザが押下を処理する前に)
 * - 押していない間に選択が畳まれたら外す。押している間 (drag 中) は、押した
 *   瞬間に選択が一度畳まれるので見ない
 */
export function installSelectionContainment(doc: Document): () => void {
  let host: Element | null = null;
  let pressed = false;

  const release = () => {
    if (host === null) return;
    host.removeAttribute(HOST_ATTR);
    doc.documentElement.removeAttribute(CONTAINED_ATTR);
    host = null;
  };
  const hold = (next: Element) => {
    if (host === next) return;
    release();
    host = next;
    next.setAttribute(HOST_ATTR, "");
    doc.documentElement.setAttribute(CONTAINED_ATTR, "");
  };
  const collapsed = () => {
    const selection = doc.getSelection();
    return selection === null || selection.isCollapsed;
  };

  const onPointerDown = (e: PointerEvent) => {
    pressed = true;
    if (host !== null && !(e.target instanceof Node && host.contains(e.target))) release();
  };
  const onPointerEnd = () => {
    pressed = false;
    if (collapsed()) release();
  };
  const onSelectStart = (e: Event) => {
    const next = selectionHostOf(e.target);
    if (next === null) release();
    else hold(next);
  };
  const onSelectionChange = () => {
    if (!pressed && collapsed()) release();
  };

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointerup", onPointerEnd, true);
  doc.addEventListener("pointercancel", onPointerEnd, true);
  doc.addEventListener("selectstart", onSelectStart, true);
  doc.addEventListener("selectionchange", onSelectionChange);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("pointerup", onPointerEnd, true);
    doc.removeEventListener("pointercancel", onPointerEnd, true);
    doc.removeEventListener("selectstart", onSelectStart, true);
    doc.removeEventListener("selectionchange", onSelectionChange);
    release();
  };
}

const installed = new WeakMap<Document, { users: number; uninstall: () => void }>();

/** Timeline が mount されている間、文書に閉じ込めを入れておく。Timeline は
 * 同時に複数 mount されうる (分割表示) が、選択は文書に 1 つなので 1 つだけ
 * 入れ、最後の Timeline が外れた時に外す。 */
export function useSelectionContainment(): void {
  useEffect(() => {
    const entry = installed.get(document) ?? {
      users: 0,
      uninstall: installSelectionContainment(document),
    };
    entry.users += 1;
    installed.set(document, entry);
    return () => {
      entry.users -= 1;
      if (entry.users > 0) return;
      entry.uninstall();
      installed.delete(document);
    };
  }, []);
}
