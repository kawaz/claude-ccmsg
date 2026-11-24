// The items' ☆ / ⭐ (DR-0058 §2, §3), and the wrapper of the items the
// Timeline merges in by time (a worker's say, and under a filter the says,
// requests and bookmarked items outside the window).
import { type ComponentChildren } from "preact";
import { useContext, useRef } from "preact/hooks";
import type { TimelineFilter } from "../../locator.ts";
import { StarMark } from "../StarMark.tsx";
import { TimelineBookmarksContext, TimelineFilterContext } from "./context.ts";
import { useFilterClamp } from "./useFilterClamp.ts";
import type { ThreadPlace } from "../../comment-threads.ts";
import { threadPressKey } from "../../comment-view.ts";
import { TimelineCommentsContext } from "./comment-context.ts";

/** What an item carries of its place in the 💬 filter (DR-0062 §13): its
 * place in the list as `--thread-order` (the filter's CSS `order`), the line
 * above it between two threads, whether it is of the agent's side
 * (`data-comment-agent`) and whether its thread is open (`data-thread-open`):
 * the filter's CSS shows the agent's side and a btw's answer only in an open
 * thread. The filter's own: its CSS reads them only under the 💬 filter. */
export function threadPlaceAttributes(place: ThreadPlace | undefined): {
  style?: Record<string, string>;
  "data-thread-order"?: string;
  "data-thread-sep"?: string;
  "data-comment-agent"?: string;
  "data-thread-open"?: string;
} {
  if (place === undefined) return {};
  return {
    style: { "--thread-order": String(place.order) },
    "data-thread-order": String(place.order),
    ...(place.sep ? { "data-thread-sep": "" } : {}),
    ...(place.agent ? { "data-comment-agent": "" } : {}),
    ...(place.open ? { "data-thread-open": "" } : {}),
  };
}

/** The ☆ / ⭐ of one item. An item with a row's uuid toggles its bookmark;
 * one without (its row is not a position of the Timeline: a fold's rows, a
 * worker's say, a filter's say or request outside the window, an agent's
 * Timeline) shows ☆ that does nothing, disabled. Where it stands is app.css's
 * (.tl-item-star): right of the jsonl toggle at the item's top right corner,
 * or just above a user's prompt. Its click never selects the item: a
 * button's click is the button's (raw.tsx selectPositionOnClick). */
export function BookmarkStar({ uuid }: { uuid: string | undefined }) {
  const bookmarks = useContext(TimelineBookmarksContext);
  const target = uuid !== undefined && bookmarks !== null ? { uuid, bookmarks } : null;
  const on = target !== null && target.bookmarks.marked.has(target.uuid);
  return (
    <button
      type="button"
      class="tl-item-star"
      aria-pressed={target === null ? undefined : on}
      disabled={target === null}
      aria-label={
        target === null
          ? "ブックマークできない項目"
          : on
            ? "ブックマークを外す"
            : "ブックマークする"
      }
      title={
        target === null
          ? "この項目は TL の位置を持たないのでブックマークできない"
          : on
            ? "ブックマークを外す"
            : "ブックマークする"
      }
      onClick={target === null ? undefined : () => target.bookmarks.set(target.uuid, !on)}
    >
      <StarMark on={on} />
    </button>
  );
}

/** Whether a click landed on something that acts on its own (a link, a
 * button, a field, a fold's summary), not on the item. */
export function clickIsOnControl(event: MouseEvent): boolean {
  const { target } = event;
  if (!(target instanceof Element)) return true;
  return target.closest("a, button, input, textarea, select, summary") !== null;
}

/** A press of an item of the 💬 filter on a person's comment (DR-0062 §13,
 * kawaz 2026-11-24): it selects that comment (`place.selects`), which opens
 * its thread (the agent's side shown), and on the first comment of a thread
 * open, closes it (threadPressKey). Null where a press does neither: another
 * filter, the agent's side, a FAB's draft. A press that makes or leaves a text
 * choice is the choice's.
 *
 * Design rationale: the press on the whole item is for a pointer only, beside
 * the real control: the keyboard and assistive technology reach the same
 * through the comment's head, a disclosure button (`aria-expanded`,
 * ThreadToggleLabel in comments.tsx). The item holds other controls (返信, the
 * comment's own buttons and links), so it is not made a button itself: a
 * button's content is presentational, and controls nested in one are not
 * reached as their own (the clickable card pattern, a real control with the
 * container's click as an enhancement). */
export function useThreadPress(place: ThreadPlace | undefined): (() => void) | null {
  const filter = useContext(TimelineFilterContext);
  const comments = useContext(TimelineCommentsContext);
  const cid = place?.selects;
  if (filter !== "comment" || comments === null || cid === undefined) return null;
  return () => {
    const choice = document.getSelection();
    if (choice !== null && !choice.isCollapsed) return;
    comments.select(threadPressKey(comments.records, comments.selected, cid));
  };
}

/** Whether the item of `uuid` is bookmarked (its wrapper's `data-bookmarked`,
 * which the ⭐ filter keeps shown). */
export function useBookmarked(uuid: string | undefined): boolean {
  const bookmarks = useContext(TimelineBookmarksContext);
  return uuid !== undefined && bookmarks !== null && bookmarks.marked.has(uuid);
}

/**
 * An item the Timeline merges in by time rather than draws from a row of the
 * window: the same wrapper as a row's (`.tl-item`), with the star, and none of
 * a row's position or jsonl. `onActivate` is what a click on it does (under a
 * filter, move to it in the Timeline, DR-0058 §6); a click on something that
 * acts on its own (a link, a button, a field) is that thing's.
 */
export function MergedItem({
  controlsAbove = false,
  notif,
  filterOnly,
  uuid,
  onActivate,
  place,
  children,
}: {
  /** The star stands just above the item (a user's prompt), as
   * ItemRawToggle's `controlsAbove`. */
  controlsAbove?: boolean;
  /** The filter that keeps it shown (DR-0050 §5). */
  notif?: TimelineFilter;
  /** It is a filter's only, taken out when the filter comes off. */
  filterOnly?: TimelineFilter;
  /** The uuid of its row, when known (a bookmarked item outside the window). */
  uuid?: string;
  onActivate?: () => void;
  /** Where it stands in the 💬 filter, by thread (DR-0062 §13). */
  place?: ThreadPlace | undefined;
  children: ComponentChildren;
}) {
  const bookmarked = useBookmarked(uuid);
  const itemRef = useRef<HTMLDivElement>(null);
  const filter = useContext(TimelineFilterContext);
  const clamp = useFilterClamp(
    itemRef,
    filter,
    filter !== null &&
      (notif === filter || filterOnly === filter || (filter === "bookmark" && bookmarked)),
  );
  const pressThread = useThreadPress(place);
  return (
    <div
      ref={itemRef}
      class={`tl-item${controlsAbove ? " tl-item-controls-above" : ""}`}
      data-notif={notif}
      data-filter-only={filterOnly}
      data-bookmarked={bookmarked ? "" : undefined}
      data-activatable={
        clamp.clamped || onActivate !== undefined || pressThread !== null ? "" : undefined
      }
      data-clamped={clamp.clamped ? "" : undefined}
      data-expanded={clamp.expanded ? "" : undefined}
      {...threadPlaceAttributes(place)}
      onClick={(event) => {
        if (clickIsOnControl(event)) return;
        // Under the 💬 filter a person's comment opens or closes its thread;
        // an open thread's items are not clamped (DR-0062 §13).
        if (pressThread !== null) {
          pressThread();
          return;
        }
        // A body the filter clamps is opened by the click instead (DR-0058 §6).
        if (clamp.clamped) {
          clamp.expand();
          return;
        }
        onActivate?.();
      }}
    >
      {children}
      <BookmarkStar uuid={uuid} />
    </div>
  );
}
