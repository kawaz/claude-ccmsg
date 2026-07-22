/** @jsxImportSource preact */
// Shared drag-splitter primitive (kawaz r26 mid=76: FilesPanes の splitter と
// sidebar 幅調整で pointer capture / drag lifecycle が重複し始めたので抽出)。
//
// 責務は「ドラッグの配管」だけ: pointer capture、dragging 状態、pointerup/
// cancel の解放。**位置 → レイアウト値の解釈は持たない** — FilesPanes は
// コンテナ相対の比率 (縦横自動判定込み)、sidebar は clientX の px 直読み、と
// 解釈が呼び出し側ごとに違うため、生の PointerEvent を onDrag に渡して
// 呼び出し側が解釈する。ここに解釈まで入れると「両方の長所を 1 つに」型の
// 統合になり、どちらかの都合で歪む。
import { useRef, useState } from "preact/hooks";

export function PaneSplitter({
  id,
  class: cls,
  ariaOrientation,
  onDrag,
}: {
  id?: string;
  class?: string;
  /** aria-orientation of the separator (visual bar direction). */
  ariaOrientation: "vertical" | "horizontal";
  /** Called for every pointermove while dragging, with the raw event —
   * the caller derives its own layout value (ratio / px / axis). */
  onDrag: (e: PointerEvent) => void;
}) {
  const draggingRef = useRef(false);
  // Mirrors draggingRef in state so the "being grabbed" class actually
  // re-renders (kawaz r46m40: wants visible feedback while dragging, not
  // just the drag plumbing). The ref stays the source of truth read inside
  // pointermove/up handlers to avoid stale-closure races; this state exists
  // purely to drive the class.
  const [dragging, setDragging] = useState(false);
  return (
    <div
      id={id}
      class={dragging ? `${cls} dragging` : cls}
      role="separator"
      aria-orientation={ariaOrientation}
      onPointerDown={(e) => {
        draggingRef.current = true;
        setDragging(true);
        // Pointer capture keeps pointermove/pointerup coming even after the
        // pointer leaves the splitter's own hitbox — otherwise a fast drag
        // would strand the splitter mid-move. Mouse and touch share the
        // pointer-events pipeline.
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        onDrag(e);
      }}
      onPointerUp={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      }}
    />
  );
}
