// An item of the Timeline folded to one line (DR-0062 §12「解決済みのスレッドの
// 吹き出しの畳み」, P37; DR-0068 §5): what its wrapper (`.tl-item`) carries for
// it. Its bubble is drawn as always (its translation, markdown and source are
// what they are open); app.css cuts it to its first line, hides its buttons
// and the rows under it, and puts the label on its frame.
//
// Whether it folds and its label are item-fold.ts's (one pure function for
// every kind of item); this only reads them. Opened or not is the Timeline's
// FoldOpenStore's, by the item's key, as a fold's is.
import type { JSX } from "preact";
import { useContext, useLayoutEffect, useState } from "preact/hooks";
import { itemFoldOf, type FoldSubject, type ItemFold } from "../../item-fold.ts";
import type { TimelineFilter } from "../../locator.ts";
import type { ScrollHold } from "../../useScrollHold.ts";
import { FoldOpenContext, TimelineFilterContext, TimelineScrollHoldContext } from "./context.ts";

/** How the item moves between its line and its whole bubble: `open` grows
 * from its line, `close` shrinks to it (a press of it, or its thread resolved
 * or it read while it was seen). app.css draws both. */
type FoldMotion = "open" | "close";

/** What the item's wrapper takes: its attributes, the control that opens it
 * while folded, and what a click on it does first. */
export interface ItemFolding {
  attrs: {
    tabIndex?: number;
    "data-folded"?: string;
    "data-fold-motion"?: FoldMotion;
    /** The label on the folded bubble's frame, as a CSS string (app.css's
     * `content`). */
    style?: { "--tl-item-fold-label": string };
    onTransitionEnd?: (event: JSX.TargetedTransitionEvent<HTMLDivElement>) => void;
    onTransitionCancel?: (event: JSX.TargetedTransitionEvent<HTMLDivElement>) => void;
  };
  /** While folded: the button that opens it, for the keyboard and assistive
   * technology. Else null. */
  control: JSX.Element | null;
  /** What a click on the item does first, where it folds in this view (not
   * under a filter). Where it is folded or opened from its line, a click on
   * its bubble that is not on a control (`onControl`) nor ends a choice of
   * its text opens it or folds it back, and is taken (true); any other is
   * left to the item (false). Either press, and one of the controls that fold
   * or unfold it (FOLDING_CONTROLS), keeps the item where it is on the screen
   * while its height changes (P37). Null where it does not fold in this
   * view. */
  press: ((event: MouseEvent, onControl: boolean) => boolean) | null;
}

const NOT_FOLDING: ItemFolding = { attrs: {}, control: null, press: null };

/** The controls in a bubble whose press folds or unfolds its item, through
 * its state (the response's 既読, a thread's 解決, a say's 既読, a request's
 * 既読 and まとめて許可): the item is kept in place while it shrinks or grows.
 * Not every control: one that moves the Timeline (「コメントした場所へ」,
 * 「↓続きへ↓」, links) holds its own place. */
const FOLDING_CONTROLS =
  ".tl-read-mark, .tl-comment-resolve, .say-read-btn, .permit-read, .permit-grant";

/** The item's own bubble `target` is in, if any: the child of the item's
 * wrapper it is under, when that is a bubble (app.css's `.tl-item > :is(.tl-bubble,
 * .tl-btw, .say)`). */
function onOwnBubble(item: EventTarget | null, target: EventTarget | null): boolean {
  if (!(item instanceof Element) || !(target instanceof Element)) return false;
  let child: Element | null = target;
  while (child !== null && child.parentElement !== item) child = child.parentElement;
  return child?.matches(":is(.tl-bubble, .tl-btw, .say)") ?? false;
}

/** Holds the item pressed where it is on the screen while it grows or
 * shrinks (P37): its top stays at its distance from the top of what the
 * Timeline shows (under its sticky toolbar, toolbar-offset.ts). One whose top
 * is above that (a long bubble pressed in its middle) keeps its bottom at the
 * point pressed once it has shrunk that far, and stops with its top there, so
 * the line it folds to is not left above the screen. A place kept, not a move
 * asked for: an instant one (DR-0056), let go at the next scroll of the
 * person's (useScrollHold). */
function holdPressed(scrollHold: ScrollHold, item: HTMLElement, pressedAt: number): void {
  let start: { top: number; pressed: number } | null = null;
  scrollHold.toElement(item, (scroller, el) => {
    const toolbar = scroller.querySelector<HTMLElement>(".tl-toolbar");
    const shownTop =
      toolbar?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top;
    const box = el.getBoundingClientRect();
    const top = box.top - shownTop;
    start ??= { top, pressed: pressedAt - shownTop };
    const keep =
      start.top >= 0 ? start.top : Math.max(start.top, Math.min(0, start.pressed - box.height));
    return scroller.scrollTop + top - keep;
  });
}

/** How the item of `subject` folds (none: it never does, its wrapper is as
 * any other). */
export function useItemFold(subject: FoldSubject | undefined): ItemFolding {
  const filter = useContext(TimelineFilterContext);
  const store = useContext(FoldOpenContext);
  const scrollHold = useContext(TimelineScrollHoldContext);
  const fold = subject === undefined ? null : itemFoldOf(subject, filter);
  const key = fold?.key;
  const state = fold?.state;
  const [, bump] = useState(0);
  // Subscribed in a layout effect, as useFoldOpen does: a landing's open in
  // an effect of the same commit is not missed.
  useLayoutEffect(
    () => (key === undefined ? undefined : store.subscribe(key, () => bump((n) => n + 1))),
    [store, key],
  );
  const opened = key !== undefined && store.isOpen(key, false);
  const folded = state === "folded" && !opened;
  // One that does not fold now holds no open: put on again, it starts folded
  // (§12). An open asked of it (a landing on its row) is let go at once.
  useLayoutEffect(() => {
    if (key !== undefined && state === "none" && opened) store.forget(key);
  }, [store, key, state, opened]);
  // Its state and the filter as the render before saw them (react.dev's
  // "Storing information from previous renders", as useResolveMoves): the
  // motion is decided in the render that sees the change, so it is in the
  // same commit as the change.
  const [seen, setSeen] = useState<{
    state: ItemFold["state"] | undefined;
    filter: TimelineFilter | null;
    motion: FoldMotion | null;
  }>(() => ({ state, filter, motion: null }));
  let motion = seen.motion;
  // Only an item that folds keeps it (every item of the Timeline takes this
  // hook, and a filter changed would draw each one twice).
  if (fold !== null && (seen.state !== state || seen.filter !== filter)) {
    // Resolved (or read) while seen as its bubble: it shrinks to its line
    // (P37, DR-0068 §5). A filter coming or going does not move it, nor does
    // a mark taken off (its items come back as they are).
    motion = seen.filter === filter && seen.state === "none" && state === "folded" ? "close" : null;
    setSeen({ state, filter, motion });
  }
  if (fold === null || key === undefined) return NOT_FOLDING;
  const endMotion = (event: JSX.TargetedTransitionEvent<HTMLDivElement>) => {
    const { target } = event;
    if (event.propertyName !== "height") return;
    if (!(target instanceof Element) || !target.matches(".tl-bubble-body, .say")) return;
    if (!onOwnBubble(event.currentTarget, target)) return;
    setSeen((before) => (before.motion === null ? before : { ...before, motion: null }));
  };
  /** Opens it or folds it back, as a person asked (P37): its state (read,
   * resolved) stays and no op goes. */
  const turn = (item: HTMLElement, open: boolean) => {
    // Opened by its button, the button goes: the focus goes to the item,
    // which takes it from the program only. Not scrolled to.
    if (open) item.focus({ preventScroll: true });
    setSeen((before) => ({ ...before, motion: open ? "open" : "close" }));
    store.set(key, open);
  };
  const press = (event: MouseEvent, onControl: boolean) => {
    const item = event.currentTarget;
    const { target } = event;
    if (!(item instanceof HTMLElement) || !onOwnBubble(item, target)) return false;
    if (onControl) {
      if (target instanceof Element && target.closest(FOLDING_CONTROLS) !== null) {
        if (scrollHold !== null) holdPressed(scrollHold, item, event.clientY);
      }
      return false;
    }
    if (state !== "folded") return false;
    // A click that ends a choice of its text is the choice's (a comment on a
    // range starts from it).
    const choice = document.getSelection();
    if (choice !== null && !choice.isCollapsed) return false;
    if (scrollHold !== null) holdPressed(scrollHold, item, event.clientY);
    turn(item, folded);
    return true;
  };
  const openByControl = (button: HTMLElement) => {
    const item = button.closest<HTMLElement>(".tl-item");
    if (item === null) return;
    if (scrollHold !== null) holdPressed(scrollHold, item, item.getBoundingClientRect().top);
    turn(item, true);
  };
  return {
    attrs: {
      // Focused by the program when it opens (and kept focused while open).
      // Not where it does not fold now: an item is not a control (DR-0062 §13).
      ...(state === "folded" ? { tabIndex: -1 } : {}),
      ...(folded ? { "data-folded": "" } : {}),
      ...(motion !== null ? { "data-fold-motion": motion } : {}),
      ...(fold.state === "folded"
        ? { style: { "--tl-item-fold-label": JSON.stringify(fold.label) } }
        : {}),
      onTransitionEnd: endMotion,
      onTransitionCancel: endMotion,
    },
    control:
      folded && fold.state === "folded" ? (
        <FoldOpenButton label={fold.label} onOpen={openByControl} />
      ) : null,
    press: state === "filtered" ? null : press,
  };
}

/** The button that opens a folded item (P37), for the keyboard and assistive
 * technology: not seen (a press of the bubble opens it for a pointer), its
 * focus drawn on the bubble's frame (app.css). Its name is the label on the
 * frame. It is there only while the item is folded (it goes as the item
 * opens), so it is `aria-expanded="false"` while there. */
function FoldOpenButton({
  label,
  onOpen,
}: {
  label: string;
  onOpen: (button: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      class="tl-item-fold"
      aria-expanded="false"
      aria-label={label}
      onClick={(event) => onOpen(event.currentTarget)}
    />
  );
}
