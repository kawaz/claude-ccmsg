// Which row 過去分を読み込む keeps still (scrollAnchor.ts), with a fake layout
// (happy-dom lays nothing out): each child of the rows has a top, the scroller
// shows it at `top - scrollTop`.
// - the first drawn row with a position (`data-timeline-uuid`) is kept, past a
//   fold in front of it (a fold can be made again when the older page's own
//   fold joins it)
// - rows hidden by the filter (display: none) are passed over
// - with no row with a position, the first drawn child; with nothing drawn, none
// - holding the anchor moves scrollTop by how far the row moved
import { describe, expect, test } from "bun:test";
import {
  firstRowScrollAnchor,
  holdScrollAnchor,
} from "../src/client/components/timeline/scrollAnchor.ts";
import type { ScrollHold } from "../src/client/useScrollHold.ts";
import { withDom } from "./dom.ts";

withDom();

interface Row {
  id: string;
  uuid?: boolean;
  top: number;
  hidden?: boolean;
}

function layout(rows: readonly Row[]) {
  const scroller = document.createElement("div");
  const lines = document.createElement("div");
  scroller.append(lines);
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 100, 500);
  const tops = new Map(rows.map((row) => [row.id, row.top]));
  for (const row of rows) {
    const el = document.createElement("div");
    el.id = row.id;
    if (row.uuid ?? false) el.dataset.timelineUuid = row.id;
    const rect = () => new DOMRect(0, (tops.get(row.id) ?? 0) - scrollTop, 100, 40);
    el.getBoundingClientRect = rect;
    el.getClientRects = () => {
      const list: DOMRect[] = (row.hidden ?? false) ? [] : [rect()];
      return Object.assign(list, { item: (i: number) => list[i] ?? null });
    };
    lines.append(el);
  }
  return { scroller, lines, tops };
}

function anchoredId(rows: readonly Row[]): string | null {
  const { scroller, lines } = layout(rows);
  const anchor = firstRowScrollAnchor(scroller, lines);
  return anchor?.kind === "element" ? anchor.element.id : null;
}

describe("firstRowScrollAnchor", () => {
  test("keeps the first drawn row with a position, past a fold in front of it", () => {
    expect(
      anchoredId([
        { id: "fold", top: 0 },
        { id: "u1", uuid: true, top: 40 },
        { id: "u2", uuid: true, top: 80 },
      ]),
    ).toBe("u1");
  });

  test("passes over rows the filter hides", () => {
    expect(
      anchoredId([
        { id: "u1", uuid: true, top: 0, hidden: true },
        { id: "say", uuid: true, top: 0 },
      ]),
    ).toBe("say");
  });

  test("with no row with a position the first drawn child, with nothing drawn none", () => {
    expect(
      anchoredId([
        { id: "hidden", top: 0, hidden: true },
        { id: "fold", top: 0 },
      ]),
    ).toBe("fold");
    expect(anchoredId([{ id: "hidden", top: 0, hidden: true }])).toBeNull();
  });
});

describe("holdScrollAnchor", () => {
  test("moves scrollTop by how far the kept row moved, every time it is placed again", () => {
    const { scroller, lines, tops } = layout([{ id: "u1", uuid: true, top: 0 }]);
    scroller.scrollTop = 10;
    const anchor = firstRowScrollAnchor(scroller, lines);
    if (anchor === null) throw new Error("expected an anchor");
    const placed = { again: () => {} };
    const hold: ScrollHold = {
      toBottom: () => {},
      toElement: (target, how) => {
        placed.again = () => how(scroller, target);
        placed.again();
      },
      release: () => {},
    };
    holdScrollAnchor(anchor, hold);
    expect(scroller.scrollTop).toBe(10);
    tops.set("u1", 300);
    placed.again();
    expect(scroller.scrollTop).toBe(310);
    tops.set("u1", 350);
    placed.again();
    expect(scroller.scrollTop).toBe(360);
  });
});
