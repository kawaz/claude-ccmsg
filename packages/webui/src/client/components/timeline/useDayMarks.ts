// Which of the Timeline's items get a day band or a gap above them (DR-0054),
// whether the end of the Timeline gets the band of today, and when the last
// row of the loaded window was written (the end of the last turn, for the
// mark at the bottom).
//
// The marks are decided over the items the Timeline shows, in the order it
// shows them: under a filter only the items of its kind (DR-0050 §5), and a
// fold group as one item whatever is folded inside it. Each view's marks are
// decided apart and all of them drawn, for the filter to show its own. What each item spans
// is read once per item object and kept (the groups of rows that did not
// change keep their identity across a live-tail append and an older page,
// useTranscriptModel.ts), so an append dates the rows it brought and walks
// the item list once, and a render that changes neither does nothing.
import { useMemo, useState } from "preact/hooks";
import type { BtwRecord, SessionPermit, SessionSay } from "@ccmsg/protocol";
import type { TimelineFilter } from "../../locator.ts";
import type { ListedBookmark } from "../../listed-bookmarks.ts";
import {
  calendarDayOf,
  dayMarksOf,
  isoDateOf,
  itemSpanOf,
  tailBandOf,
  type CalendarDay,
  type DayGap,
  type DayMark,
  type ItemSpan,
} from "../../timeline-day-marks.ts";
import {
  ccmsgUnitKey,
  type classifyBoundaryLine,
  type ParsedLine,
  type TimelineGroup,
} from "../../transcript-model.ts";

/** The calendar day of an instant in the browser's zone. */
export const localDayOf = calendarDayOf();

/** A bubble merged into the Timeline by its time rather than drawn from a row
 * of the window (time-slots.ts): a worker's say, and under a filter the says,
 * requests for permission, bookmarked items and the person's prompts outside
 * the window. */
export type SlotBubble =
  | { kind: "listed-permit"; item: SessionPermit }
  | { kind: "agent-say"; item: SessionSay }
  | { kind: "listed-say"; item: SessionSay }
  | { kind: "listed-bookmark"; item: ListedBookmark }
  | { kind: "listed-prompt"; item: ListedBookmark }
  | { kind: "listed-search"; item: ListedBookmark }
  | { kind: "btw"; item: BtwRecord };

/** The bubbles merged in before one group, in the order they were made. */
export function slotBubbles(
  slot: number,
  slots: {
    listedPermits: readonly (readonly SessionPermit[])[];
    agentSays: readonly (readonly SessionSay[])[];
    listedSays: readonly (readonly SessionSay[])[];
    listedBookmarks: readonly (readonly ListedBookmark[])[];
    listedPrompts: readonly (readonly ListedBookmark[])[];
    listedSearch: readonly (readonly ListedBookmark[])[];
    /** The session's btws (btw-slots.ts, DR-0060 §7): placed by their
     * anchor, not by time, so they keep their slot's order after the bubbles
     * of the same slot. */
    btws: readonly (readonly BtwRecord[])[];
  },
): SlotBubble[] {
  return [
    ...(slots.listedPermits[slot] ?? []).map(
      (item): SlotBubble => ({ kind: "listed-permit", item }),
    ),
    ...(slots.agentSays[slot] ?? []).map((item): SlotBubble => ({ kind: "agent-say", item })),
    ...(slots.listedSays[slot] ?? []).map((item): SlotBubble => ({ kind: "listed-say", item })),
    ...(slots.listedBookmarks[slot] ?? []).map(
      (item): SlotBubble => ({ kind: "listed-bookmark", item }),
    ),
    ...(slots.listedPrompts[slot] ?? []).map(
      (item): SlotBubble => ({ kind: "listed-prompt", item }),
    ),
    ...(slots.listedSearch[slot] ?? []).map(
      (item): SlotBubble => ({ kind: "listed-search", item }),
    ),
  ]
    .sort((a, b) => Date.parse(a.item.ts) - Date.parse(b.item.ts))
    .concat((slots.btws[slot] ?? []).map((item): SlotBubble => ({ kind: "btw", item })));
}

/** The key the Timeline gives a merged bubble (and the marks above it). */
export function slotBubbleKey(bubble: SlotBubble): string {
  return bubble.kind === "listed-bookmark" ||
    bubble.kind === "listed-prompt" ||
    bubble.kind === "listed-search"
    ? `${bubble.kind}-${bubble.item.uuid}`
    : bubble.kind === "btw"
      ? `btw-${bubble.item.id}`
      : `${bubble.kind}-${bubble.item.tool_use_id}`;
}

/** The key of the marks above a group: its first row's byte offset. */
export function groupMarkKey(group: TimelineGroup): string {
  return `g${group.kind === "entry" ? group.offset : group.entries[0].offset}`;
}

type Boundary = ReturnType<typeof classifyBoundaryLine> | null;

/** Whether a group draws anything under `filter`. A row that is no boundary
 * draws nothing, and nor does a ccmsg row all of whose bubbles are drawn
 * elsewhere (useTranscriptModel's `visibleCcmsgKeys`). Under the 👤 filter, a
 * person's prompt; under the ⭐ filter, a row whose uuid is bookmarked
 * (`marked`); under the 🔍 filter, a row the search matched (`searchHits`). */
function groupShown(
  group: TimelineGroup,
  boundary: Boundary | undefined,
  filter: TimelineFilter | null,
  visibleCcmsgKeys: ReadonlySet<string>,
  marked: ReadonlySet<string>,
  searchHits: ReadonlySet<number>,
): boolean {
  if (group.kind === "fold") return filter === null;
  if (boundary === undefined || boundary === null) return false;
  if (filter === "search") return searchHits.has(group.offset);
  if (filter === "prompt") return boundary.kind === "user-prompt";
  if (filter === "say") return boundary.kind === "say" || boundary.kind === "push-notification";
  if (filter === "permit") return boundary.kind === "permit";
  if (filter === "bookmark") {
    return (
      group.line.kind === "turn" && group.line.uuid !== undefined && marked.has(group.line.uuid)
    );
  }
  if (boundary.kind !== "ccmsg") return true;
  const { offset } = group;
  return boundary.messages.some((_, j) => visibleCcmsgKeys.has(ccmsgUnitKey(offset, j)));
}

function bubbleShown(bubble: SlotBubble, filter: TimelineFilter | null): boolean {
  switch (bubble.kind) {
    case "listed-permit":
      return filter === "permit";
    case "agent-say":
      return filter === null || filter === "say";
    case "listed-say":
      return filter === "say";
    case "listed-bookmark":
      return filter === "bookmark";
    case "listed-prompt":
      return filter === "prompt";
    case "listed-search":
      return filter === "search";
    case "btw":
      return filter === null;
  }
}

/** An item the Timeline shows, with what it is dated by. */
export interface ShownItem {
  key: string;
  source: TimelineGroup | SessionSay | SessionPermit | ListedBookmark | BtwRecord;
}

/** The items the Timeline shows under `filter`, top to bottom, in the order it
 * draws them: before each group the bubbles merged in before it, then the
 * group; after the last group the bubbles newer than every group. */
export function shownItems({
  groups,
  boundaries,
  visibleCcmsgKeys,
  slots,
  filter,
  marked,
  searchHits = new Set(),
}: {
  groups: readonly TimelineGroup[];
  boundaries: readonly Boundary[];
  visibleCcmsgKeys: ReadonlySet<string>;
  slots: Parameters<typeof slotBubbles>[1];
  filter: TimelineFilter | null;
  /** The bookmarked uuids, which the ⭐ filter shows. */
  marked: ReadonlySet<string>;
  /** The offsets of the rows the in-view search matched, which the 🔍
   * filter shows. */
  searchHits?: ReadonlySet<number>;
}): ShownItem[] {
  const items: ShownItem[] = [];
  const pushBubbles = (slot: number) => {
    for (const bubble of slotBubbles(slot, slots)) {
      if (bubbleShown(bubble, filter))
        items.push({ key: slotBubbleKey(bubble), source: bubble.item });
    }
  };
  groups.forEach((group, i) => {
    pushBubbles(i);
    if (groupShown(group, boundaries[i], filter, visibleCcmsgKeys, marked, searchHits)) {
      items.push({ key: groupMarkKey(group), source: group });
    }
  });
  pushBubbles(groups.length);
  return items;
}

function lineTs(line: ParsedLine): string | null {
  return line.kind === "broken" ? null : line.ts;
}

function spanOf(source: ShownItem["source"]): ItemSpan | null {
  if (!("kind" in source)) return itemSpanOf([source.ts], localDayOf);
  if (source.kind === "entry") return itemSpanOf([lineTs(source.line)], localDayOf);
  return itemSpanOf(
    source.entries.map((entry) => lineTs(entry.line)),
    localDayOf,
  );
}

/** A way the Timeline is looked at: all of it, or one filter's bubbles
 * (DR-0050 §4). */
export type TimelineView = "all" | TimelineFilter;

/** What goes above one item, in every view: the band of its day in the views
 * whose items start a day there, and above it the gaps, each in the views it
 * is in (a filter shows fewer items, so the item above, and the gap to it,
 * can differ from view to view). */
export interface ItemMarks {
  day: CalendarDay;
  band: readonly TimelineView[];
  /** The views in which the band is above every item the view shows. */
  top: readonly TimelineView[];
  gaps: ReadonlyArray<{ gap: DayGap; views: readonly TimelineView[] }>;
  /** The key the band is drawn with (`bandKeys`). */
  bandKey: string;
}

/** The band of today at the end of the Timeline, in the views whose last item
 * started on an earlier day (`tailBandOf`). */
export interface TailBand {
  day: CalendarDay;
  views: readonly TimelineView[];
  key: string;
}

/** The day marks of the Timeline: those above the items, by the item's key
 * (only the items that get one are there), and the band of today at the end. */
export interface DayMarks {
  above: ReadonlyMap<string, ItemMarks>;
  tail: TailBand | null;
}

/** One view's marks, by the item's key, and the spans of its items in order. */
interface ViewMarks {
  byKey: ReadonlyMap<string, { mark: DayMark; top: boolean }>;
  spans: readonly (ItemSpan | null)[];
}

/** The marks of one view, by the item's key. A band is at the top of the view
 * when it goes above the view's first item: no item is above it. */
function viewMarks(
  items: readonly ShownItem[],
  known: WeakMap<ShownItem["source"], ItemSpan | null>,
): ViewMarks {
  const spans = items.map((item) => {
    const cached = known.get(item.source);
    if (cached !== undefined) return cached;
    const span = spanOf(item.source);
    known.set(item.source, span);
    return span;
  });
  const marks = dayMarksOf(spans);
  const byKey = new Map<string, { mark: DayMark; top: boolean }>();
  items.forEach((item, i) => {
    const mark = marks[i];
    if (mark !== undefined && mark !== null) byKey.set(item.key, { mark, top: i === 0 });
  });
  return { byKey, spans };
}

/**
 * The marks of every view put together, by the item's key, and the band of
 * `today` at the end. A band is one mark whichever views it is in (it says the
 * item's own day), and so is a gap of the same length.
 *
 * The bands are keyed by their day: the first band of a day that the whole
 * Timeline shows is `day-<date>`, and the rest add the item's key. So the band
 * of today at the end, once an item of today comes in below it, is the same
 * element as that item's band (it moves up above the item instead of being
 * drawn anew), and the band at the top, when older rows of its day come in
 * above, moves up with them.
 */
export function mergeViewMarks(
  views: ReadonlyArray<readonly [TimelineView, ViewMarks]>,
  today: CalendarDay,
): DayMarks {
  const merged = new Map<
    string,
    {
      day: CalendarDay;
      band: TimelineView[];
      top: TimelineView[];
      gaps: Array<{ gap: DayGap; views: TimelineView[] }>;
    }
  >();
  const tailViews: TimelineView[] = [];
  for (const [view, { byKey, spans }] of views) {
    for (const [key, { mark, top }] of byKey) {
      const item = merged.get(key) ?? { day: mark.day, band: [], top: [], gaps: [] };
      merged.set(key, item);
      item.band.push(view);
      if (top) item.top.push(view);
      const { gap } = mark;
      if (gap === null) continue;
      const same = item.gaps.find((g) => g.gap.days === gap.days && g.gap.ms === gap.ms);
      if (same !== undefined) same.views.push(view);
      else item.gaps.push({ gap, views: [view] });
    }
    if (tailBandOf(spans, today) !== null) tailViews.push(view);
  }
  const keyed = new Set<string>();
  const bandKey = (day: CalendarDay, views: readonly TimelineView[], own: string): string => {
    const date = isoDateOf(day);
    if (!views.includes("all") || keyed.has(date)) return `day-${date}-${own}`;
    keyed.add(date);
    return `day-${date}`;
  };
  const above = new Map<string, ItemMarks>();
  for (const [key, item] of merged) {
    above.set(key, { ...item, bandKey: bandKey(item.day, item.band, key) });
  }
  const tail =
    tailViews.length === 0
      ? null
      : { day: today, views: tailViews, key: bandKey(today, tailViews, "tail") };
  return { above, tail };
}

/** The day marks of the Timeline in each view (`DayMarks`). Every view's marks
 * are drawn and the filter shows its own (app.css), so switching the filter
 * draws nothing anew (DR-0050 §5). Each item is dated once, whichever views
 * it is in. `today` is the browser's calendar day now. */
export function useDayMarks(
  {
    all: allItems,
    prompt: promptItems,
    search: searchItems,
    say: sayItems,
    permit: permitItems,
    bookmark: bookmarkItems,
  }: Record<TimelineView, readonly ShownItem[]>,
  today: CalendarDay,
): DayMarks {
  const [spans] = useState(() => new WeakMap<ShownItem["source"], ItemSpan | null>());
  const all = useMemo(() => viewMarks(allItems, spans), [allItems, spans]);
  const prompt = useMemo(() => viewMarks(promptItems, spans), [promptItems, spans]);
  const search = useMemo(() => viewMarks(searchItems, spans), [searchItems, spans]);
  const say = useMemo(() => viewMarks(sayItems, spans), [sayItems, spans]);
  const permit = useMemo(() => viewMarks(permitItems, spans), [permitItems, spans]);
  const bookmark = useMemo(() => viewMarks(bookmarkItems, spans), [bookmarkItems, spans]);
  return useMemo(
    () =>
      mergeViewMarks(
        [
          ["all", all],
          ["prompt", prompt],
          ["search", search],
          ["say", say],
          ["permit", permit],
          ["bookmark", bookmark],
        ],
        today,
      ),
    [all, prompt, search, say, permit, bookmark, today],
  );
}

/** When the last row of the loaded window that carries a time was written
 * (epoch ms), or null when none does. */
export function lastRowTime(parsed: readonly ParsedLine[]): number | null {
  for (let i = parsed.length - 1; i >= 0; i--) {
    const line = parsed[i];
    const ts = line === undefined ? null : lineTs(line);
    if (ts === null) continue;
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}
