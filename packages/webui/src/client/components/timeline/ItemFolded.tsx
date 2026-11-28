// An item of the Timeline folded to a bubble of one line (DR-0062 §12「解決済みの
// スレッドの吹き出しの畳み」, P37; DR-0068 §5): the bubble its wrapper
// (`.tl-item`) shows in place of what it draws, and what the wrapper carries
// for it.
//
// Whether it folds and what its line says are item-fold.ts's (one pure
// function for every kind of item); this only reads them. Opened or not is
// the Timeline's FoldOpenStore's, by the item's key, as a fold's is.
import type { JSX } from "preact";
import { useContext, useLayoutEffect, useState } from "preact/hooks";
import { itemFoldOf, type FoldFrame, type FoldSubject, type ItemFold } from "../../item-fold.ts";
import type { TimelineFilter } from "../../locator.ts";
import { FoldOpenContext, TimelineFilterContext, TimelineScrollHoldContext } from "./context.ts";

/** How the item moves between its line and what it draws: `open` grows from
 * its line (a press of it), `close` shrinks to its line (its thread resolved,
 * or it read, while it was seen). app.css draws both. */
type FoldMotion = "open" | "close";

/** What the item's wrapper takes: its attributes, whether what it draws is
 * drawn, and the folded bubble to put in it. */
export interface ItemFolding {
  attrs: {
    tabIndex?: number;
    "data-folded"?: string;
    "data-fold-motion"?: FoldMotion;
    onTransitionEnd?: (event: JSX.TargetedTransitionEvent<HTMLDivElement>) => void;
    onTransitionCancel?: (event: JSX.TargetedTransitionEvent<HTMLDivElement>) => void;
  };
  /** Whether the item's own content is in the page: not until it is first
   * shown, and kept (hidden) once it has been, as a fold's body is (its
   * translation and md | source stay). */
  drawn: boolean;
  /** The bubble of one line while folded, else null. */
  bubble: JSX.Element | null;
}

const NOT_FOLDING: ItemFolding = { attrs: {}, drawn: true, bubble: null };

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
  const [shownOnce, setShownOnce] = useState(!folded);
  if (!folded && !shownOnce) setShownOnce(true);
  if (fold === null || key === undefined) return NOT_FOLDING;
  const endMotion = (event: JSX.TargetedTransitionEvent<HTMLDivElement>) => {
    const { target, currentTarget } = event;
    if (event.propertyName !== "height") return;
    if (!(target instanceof Element) || target.parentElement !== currentTarget) return;
    setSeen((before) => (before.motion === null ? before : { ...before, motion: null }));
  };
  const open = (button: HTMLElement) => {
    // A press takes the Timeline from where it was held (an assistive
    // technology's press may give no pointer or key the hold lets go on), so
    // the item grows from its top and the end is not followed (P37).
    scrollHold?.release();
    // The button goes as the item opens: the focus goes to the item, which
    // takes it from the program only. Not scrolled to.
    button.closest<HTMLElement>(".tl-item")?.focus({ preventScroll: true });
    setSeen((before) => ({ ...before, motion: "open" }));
    store.set(key, true);
  };
  return {
    attrs: {
      // Focused by the program when it opens (and kept focused while open).
      // Not where it does not fold now: an item is not a control (DR-0062 §13).
      ...(state === "folded" ? { tabIndex: -1 } : {}),
      ...(folded ? { "data-folded": "" } : {}),
      ...(motion !== null ? { "data-fold-motion": motion } : {}),
      onTransitionEnd: endMotion,
      onTransitionCancel: endMotion,
    },
    drawn: !folded || shownOnce || store.isBodyMounted(key),
    bubble: folded && fold.state === "folded" ? <FoldedBubble fold={fold} onOpen={open} /> : null,
  };
}

/** The bubble's side, as its own bubble's (a person's comment at the right,
 * the agent's side at the left). Its frame (ground, border, corners) is the
 * same rules' as that bubble's, by `data-frame` (app.css). */
const SIDE: Record<FoldFrame, string> = {
  comment: "tl-bubble-right",
  reply: "tl-bubble-left",
  response: "tl-bubble-left",
  say: "tl-bubble-left",
  permit: "tl-bubble-left",
};

/** The bubble of one line an item is folded to (P37): a button, its name the
 * words seen (「✅解決済み: <start>」, 「✅既読: <start>」), in a frame like its
 * own bubble's. A press opens the item.
 * It is never pressed to close (none is the open's: it goes as the item
 * opens), so it is `aria-expanded="false"` while there. */
function FoldedBubble({
  fold,
  onOpen,
}: {
  fold: Extract<ItemFold, { state: "folded" }>;
  onOpen: (button: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      class={`tl-item-fold tl-bubble ${SIDE[fold.frame]}`}
      data-frame={fold.frame}
      aria-expanded="false"
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span class="tl-bubble-body tl-item-fold-line">
        <span class="tl-item-fold-text">{fold.line}</span>
      </span>
    </button>
  );
}
