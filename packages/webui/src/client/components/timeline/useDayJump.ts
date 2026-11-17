// ↑ / ↓ on a day band (DR-0054 §9): step to the band before or after it in the
// view on show (all of the Timeline, or a filter's bubbles).
//
// - ↑ with no band above: read older pages in, one at a time, through the
//   Timeline's own 「過去分を上に読み込む」 (its anchoring and its 読み込み中…
//   go with it), until a band shows up above; at the start of the transcript
//   with still none, go to the top as ⤒ does. Under a filter nothing older is
//   read (the filter already shows every say / request, DR-0050 §5).
// - ↓ with no band below: go to the end as ⤓ does. The loaded window always
//   reaches the end of the transcript (a position outside it falls back to
//   the head, usePositionPin.ts), so nothing below is ever left to read.
// - Landing puts the band at the top of the Timeline, below the toolbar, held
//   as the landing on a position is (useScrollHold, toolbar-offset.ts), and
//   moves the focus to the same arrow of that band, so pressing on walks the
//   days. The move to it is the reader's own (a press), so it is a short
//   smooth one (DR-0056); the hold that keeps the page in place while older
//   pages come in is not, it stays instant.
//
// A search that reads older pages lets go once anything else happens: another
// press (of any arrow), the reader's own scrolling, a change of filter or of
// session. What it found after that moves nothing.
import { useCallback, useEffect, useRef } from "preact/hooks";
import type { TimelineFilter } from "../../locator.ts";
import type { ScrollHold } from "../../useScrollHold.ts";
import { topBelowToolbar } from "./toolbar-offset.ts";

export type DayStep = "up" | "down";

/**
 * The index in `days` (the ISO dates of the bands of a view, top to bottom)
 * of the band one step from `from`, or null when there is none that way.
 * `from` is the band's index, or, when the band is gone (older rows of its
 * own day came in above it and took its place), its date: the step is then
 * taken from the first band of that date, or from where that date would be.
 */
export function stepDayBand(
  days: readonly string[],
  from: { index: number } | { day: string },
  step: DayStep,
): number | null {
  let index: number;
  if ("index" in from) index = from.index;
  else {
    index = days.indexOf(from.day);
    if (index < 0) {
      if (step === "up") {
        const before = days.findLastIndex((day) => day < from.day);
        return before < 0 ? null : before;
      }
      const after = days.findIndex((day) => day > from.day);
      return after < 0 ? null : after;
    }
  }
  const next = step === "up" ? index - 1 : index + 1;
  return next >= 0 && next < days.length ? next : null;
}

/** The day bands of `view` in the Timeline's rows, top to bottom. */
function bandsOf(lines: HTMLElement, view: string): HTMLElement[] {
  return [...lines.querySelectorAll<HTMLElement>(":scope > [data-tl-marker='day']")].filter(
    (band) => band.dataset.tlViews?.split(" ").includes(view) === true,
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function useDayJump({
  sid,
  filter,
  linesRef,
  scrollHold,
  loadOlder,
  atStart,
  toTop,
  toBottom,
}: {
  sid: string;
  /** The view on show (DR-0050 §4); null is all of the Timeline. */
  filter: TimelineFilter | null;
  linesRef: { readonly current: HTMLElement | null };
  scrollHold: ScrollHold;
  /** Read one older page in as 「過去分を上に読み込む」 does; null when none
   * can be read now. */
  loadOlder: () => Promise<void> | null;
  /** Whether the loaded window starts at the start of the transcript. */
  atStart: () => boolean;
  /** What ⤒ does (a move the reader asked for). */
  toTop: () => void;
  /** What ⤓ does (a move the reader asked for). */
  toBottom: () => void;
}): {
  /** Step from `band` (a day band's element) toward `step`. */
  step: (band: HTMLElement, step: DayStep) => void;
  /** Let go of a search that is reading older pages. */
  cancel: () => void;
} {
  // Which press is the live one: every press, and everything that ends a
  // search, moves it on; a search that finds it moved stops.
  const turnRef = useRef(0);
  const cancel = useCallback(() => {
    turnRef.current += 1;
  }, []);
  useEffect(() => cancel, [sid, filter, cancel]);

  const step = (band: HTMLElement, direction: DayStep): void => {
    turnRef.current += 1;
    const turn = turnRef.current;
    const view = filter ?? "all";
    const day = band.dataset.tlDay ?? "";
    const land = (target: HTMLElement) => {
      scrollHold.toElement(target, topBelowToolbar, "user");
      target
        .querySelector<HTMLElement>(`.tl-day-step[data-step="${direction}"]`)
        ?.focus({ preventScroll: true });
    };
    const search = async (): Promise<void> => {
      for (;;) {
        const lines = linesRef.current;
        if (lines === null) return;
        const bands = bandsOf(lines, view);
        const index = band.isConnected ? bands.indexOf(band) : -1;
        const target = stepDayBand(
          bands.map((b) => b.dataset.tlDay ?? ""),
          index >= 0 ? { index } : { day },
          direction,
        );
        const found = target === null ? undefined : bands[target];
        if (found !== undefined) {
          land(found);
          return;
        }
        if (direction === "down") {
          toBottom();
          return;
        }
        const read = filter === null && !atStart() ? loadOlder() : null;
        if (read === null) {
          if (filter !== null || atStart()) toTop();
          return;
        }
        await read;
        await nextFrame();
        if (turnRef.current !== turn) return;
      }
    };
    void search();
  };

  return { step, cancel };
}
