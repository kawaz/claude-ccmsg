// Which of the Timeline's items get a day band or a gap above them (DR-0054),
// and when the last row of the loaded window was written (the end of the
// last turn, for the mark at the bottom).
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
import type { SessionPermit, SessionSay } from "@ccmsg/protocol";
import type { TimelineFilter } from "../../locator.ts";
import {
  calendarDayOf,
  dayMarksOf,
  itemSpanOf,
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
const localDayOf = calendarDayOf();

/** A bubble merged into the Timeline by its time rather than drawn from a row
 * of the window (time-slots.ts): a worker's say, and under a filter the says
 * and requests for permission outside the window. */
export type SlotBubble =
  | { kind: "listed-permit"; item: SessionPermit }
  | { kind: "agent-say"; item: SessionSay }
  | { kind: "listed-say"; item: SessionSay };

/** The bubbles merged in before one group, in the order they were made. */
export function slotBubbles(
  slot: number,
  slots: {
    listedPermits: readonly (readonly SessionPermit[])[];
    agentSays: readonly (readonly SessionSay[])[];
    listedSays: readonly (readonly SessionSay[])[];
  },
): SlotBubble[] {
  return [
    ...(slots.listedPermits[slot] ?? []).map(
      (item): SlotBubble => ({ kind: "listed-permit", item }),
    ),
    ...(slots.agentSays[slot] ?? []).map((item): SlotBubble => ({ kind: "agent-say", item })),
    ...(slots.listedSays[slot] ?? []).map((item): SlotBubble => ({ kind: "listed-say", item })),
  ].sort((a, b) => Date.parse(a.item.ts) - Date.parse(b.item.ts));
}

/** The key the Timeline gives a merged bubble (and the marks above it). */
export function slotBubbleKey(bubble: SlotBubble): string {
  return `${bubble.kind}-${bubble.item.tool_use_id}`;
}

/** The key of the marks above a group: its first row's byte offset. */
export function groupMarkKey(group: TimelineGroup): string {
  return `g${group.kind === "entry" ? group.offset : group.entries[0].offset}`;
}

type Boundary = ReturnType<typeof classifyBoundaryLine> | null;

/** Whether a group draws anything under `filter`. A row that is no boundary
 * draws nothing, and nor does a ccmsg row all of whose bubbles are drawn
 * elsewhere (useTranscriptModel's `visibleCcmsgKeys`). */
function groupShown(
  group: TimelineGroup,
  boundary: Boundary | undefined,
  filter: TimelineFilter | null,
  visibleCcmsgKeys: ReadonlySet<string>,
): boolean {
  if (group.kind === "fold") return filter === null;
  if (boundary === undefined || boundary === null) return false;
  if (filter === "say") return boundary.kind === "say" || boundary.kind === "push-notification";
  if (filter === "permit") return boundary.kind === "permit";
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
  }
}

/** An item the Timeline shows, with what it is dated by. */
export interface ShownItem {
  key: string;
  source: TimelineGroup | SessionSay | SessionPermit;
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
}: {
  groups: readonly TimelineGroup[];
  boundaries: readonly Boundary[];
  visibleCcmsgKeys: ReadonlySet<string>;
  slots: Parameters<typeof slotBubbles>[1];
  filter: TimelineFilter | null;
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
    if (groupShown(group, boundaries[i], filter, visibleCcmsgKeys)) {
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
  gaps: ReadonlyArray<{ gap: DayGap; views: readonly TimelineView[] }>;
}

/** The marks of one view, by the item's key. */
function viewMarks(
  items: readonly ShownItem[],
  spans: WeakMap<ShownItem["source"], ItemSpan | null>,
): ReadonlyMap<string, DayMark> {
  const marks = dayMarksOf(
    items.map((item) => {
      const known = spans.get(item.source);
      if (known !== undefined) return known;
      const span = spanOf(item.source);
      spans.set(item.source, span);
      return span;
    }),
  );
  const byKey = new Map<string, DayMark>();
  items.forEach((item, i) => {
    const mark = marks[i];
    if (mark !== undefined && mark !== null) byKey.set(item.key, mark);
  });
  return byKey;
}

/** The marks of every view put together, by the item's key. A band is one
 * mark whichever views it is in (it says the item's own day), and so is a gap
 * of the same length. */
export function mergeViewMarks(
  views: ReadonlyArray<readonly [TimelineView, ReadonlyMap<string, DayMark>]>,
): ReadonlyMap<string, ItemMarks> {
  const merged = new Map<
    string,
    { day: CalendarDay; band: TimelineView[]; gaps: Array<{ gap: DayGap; views: TimelineView[] }> }
  >();
  for (const [view, marks] of views) {
    for (const [key, mark] of marks) {
      const item = merged.get(key) ?? { day: mark.day, band: [], gaps: [] };
      merged.set(key, item);
      item.band.push(view);
      const { gap } = mark;
      if (gap === null) continue;
      const same = item.gaps.find((g) => g.gap.days === gap.days && g.gap.ms === gap.ms);
      if (same !== undefined) same.views.push(view);
      else item.gaps.push({ gap, views: [view] });
    }
  }
  return merged;
}

/** The marks above the Timeline's items in each view, by the item's key
 * (only the items that get one are there). Every view's marks are drawn and
 * the filter shows its own (app.css), so switching the filter draws nothing
 * anew (DR-0050 §5). Each item is dated once, whichever views it is in. */
export function useDayMarks({
  all: allItems,
  say: sayItems,
  permit: permitItems,
}: Record<TimelineView, readonly ShownItem[]>): ReadonlyMap<string, ItemMarks> {
  const [spans] = useState(() => new WeakMap<ShownItem["source"], ItemSpan | null>());
  const all = useMemo(() => viewMarks(allItems, spans), [allItems, spans]);
  const say = useMemo(() => viewMarks(sayItems, spans), [sayItems, spans]);
  const permit = useMemo(() => viewMarks(permitItems, spans), [permitItems, spans]);
  return useMemo(
    () =>
      mergeViewMarks([
        ["all", all],
        ["say", say],
        ["permit", permit],
      ]),
    [all, say, permit],
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
