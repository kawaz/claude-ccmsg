// Shared "click outside to cancel" behavior for inline edit/create forms
// (RoomTitle's rename editor, SessionRooms's new-room form). Both forms used
// to cancel on the input's `onBlur`, but that fires on `mousedown` — before a
// [保存]/[作成] button's own `click` handler gets a chance to run — so a
// literal button click inside the form was indistinguishable from a click
// truly outside it, and the confirm button was unpressable (kawaz
// 2026-07-12). Listening for `pointerdown`/`pointerup` on `document` instead
// and testing `contains()` against a ref around the *whole* form (input +
// buttons) fixes that: a pointerdown/pointerup inside the ref'd container is
// never treated as "outside", no matter which descendant it lands on.
import { useEffect, useRef } from "preact/hooks";

/** Minimal ref shape this hook needs — matches what `useRef<T>(null)` returns
 * without pulling in preact's own `Ref<T>` type (which additionally allows a
 * callback-ref form this hook never uses). */
interface ElementRef<T extends HTMLElement> {
  current: T | null;
}

// pointerdown→pointerup 間の移動量がこれを超えたら「タップ/クリック」でなく
// 「スクロール/ドラッグ」とみなし dismiss しない。タッチ端末では document
// への pointerdown はスクロール操作の開始でも発火するため、pointerdown 単発
// で即 dismiss すると外側を撫でてスクロールしようとしただけで draft が失わ
// れる (この hook の導入動機である iPad がまさに踏みやすい、kawaz
// 2026-07-12)。
const CLICK_MOVE_THRESHOLD_PX = 8;

/**
 * While `active` is true, listens for `pointerdown`/`pointerup` on `document`
 * and calls `onDismiss` once when a tap/click (pointerdown followed by a
 * pointerup with little movement) lands outside the element `containerRef`
 * currently points at. No-op (and no listeners registered) while `active` is
 * false, and always cleaned up on unmount / dependency change — callers don't
 * need their own active-tracking cleanup logic.
 */
export function useDismissOnOutsidePointer<T extends HTMLElement>(
  containerRef: ElementRef<T>,
  active: boolean,
  onDismiss: () => void,
): void {
  // 呼び出し元 (RoomTitle/SessionRooms) の onDismiss は毎レンダー新規関数
  // になりがちなので ref に落とす — 依存配列から外すことで、editing 中の
  // 無関係な再レンダーのたびに listener を張り替えなくて済む (動作自体は
  // どちらでも同じ、churn を消すだけ)。
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!active) return;
    let downOutside = false;
    let downX = 0;
    let downY = 0;
    function isOutside(target: EventTarget | null): boolean {
      const el = containerRef.current;
      if (!el) return false;
      return !(target instanceof Node && el.contains(target));
    }
    function onPointerDown(e: PointerEvent): void {
      downOutside = isOutside(e.target);
      downX = e.clientX;
      downY = e.clientY;
    }
    function onPointerUp(e: PointerEvent): void {
      if (!downOutside) return;
      downOutside = false;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD_PX) return;
      if (!isOutside(e.target)) return;
      onDismissRef.current();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [active, containerRef]);
}
