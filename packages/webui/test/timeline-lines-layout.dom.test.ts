// How the Timeline's list of rows (`.tl-lines`) lays its rows out (app.css).
// The rows go in a one-column grid, not a column flex box: in WebKit, a
// column flex box of rows that are flex boxes themselves and hold absolutely
// positioned descendants (each row's jsonl toggle, a code block's copy
// button) takes layout time that grows with the square of the row count,
// about a second per change in a long Timeline; the one-column grid does not
// (measured: docs/findings/2026-11-15-timeline-base-cost.md). The grid has to
// place the rows exactly where the column flex box did, which takes three
// more declarations, each pinned below. happy-dom does no layout, so this pins
// the computed styles the layout depends on; the boxes themselves were
// compared in Chromium and WebKit at 1280px and 390px (every element's rect
// and every pixel the same as with the column flex box).
import { afterEach, beforeAll, expect, test } from "bun:test";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";

withDom();

beforeAll(async () => {
  const style = document.createElement("style");
  style.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
  document.head.append(style);
});

let root: HTMLElement | null = null;
afterEach(() => {
  root?.remove();
  root = null;
});

/** A list of rows as Timeline.tsx draws it: rows (`.tl-item`), then the
 * filter's 「全て既読」 and 「TL に戻る」 at its end. `filter` is the
 * list's `data-filter`, set while the Timeline is filtered to one kind. */
function mountLines(filter?: "say" | "permit"): HTMLElement {
  const lines = document.createElement("div");
  lines.className = "tl-lines";
  if (filter !== undefined) lines.dataset.filter = filter;
  lines.innerHTML = [
    '<div class="tl-item" data-notif="say"><div class="say">say</div></div>',
    '<div class="tl-item"><div class="tl-bubble tl-bubble-right">prompt</div></div>',
    '<button type="button" class="tl-filter-read-all">全て既読</button>',
    '<button type="button" class="tl-wide-button tl-filter-back">TL に戻る</button>',
  ].join("");
  document.body.append(lines);
  root = lines;
  return lines;
}

// 何を保証するか: 行の列は 1 列の grid で、列の幅は minmax(0, 1fr)。既定の
// auto の列は中身の min-content まで広がるので、横に長い pre (white-space:
// pre のコードブロックや tool の出力) を持つ行があると、列ごと TL の幅を突き
// 破ってページが横にずれる (fold を全部開いた幅 1280px の TL では、993px の列
// が 3,917px まで広がる)。minmax(0, 1fr) なら列は TL の幅で止まり、pre が自分で横スクロール
// する。flex の列で並べると WebKit の layout が行数の 2 乗で重くなるので、
// display を flex に戻すのも不可 (上の冒頭の説明)。
test("the rows go in one grid column that never grows past the Timeline's width", () => {
  const lines = mountLines();
  const style = getComputedStyle(lines);
  expect(style.display).toBe("grid");
  expect(style.gridTemplateColumns).toBe("minmax(0, 1fr)");
});

// 何を保証するか: 行は列の上に詰める (align-content: start)。フィルタ中は残る
// 行が少ないので、TL の下の状態行を下端に置くために行の列を伸ばす
// (`.tl-lines[data-filter]` の flex-grow)。grid の既定 (stretch) では、その
// 余りの高さが各行に配られて行が縦に伸びる (行の少ない 🔐 のフィルタで、
// 「TL に戻る」の高さが 28px から 160px になる)。フィルタ中も外した時も同じ。
test("the rows are packed at the top, also while a filter stretches the list", () => {
  for (const filter of [undefined, "say", "permit"] as const) {
    const style = getComputedStyle(mountLines(filter));
    expect(style.alignContent).toBe("start");
    root?.remove();
  }
});

// 何を保証するか: 「全て既読」は文字の分の幅でバブルと同じ左端に置く (DR-0050
// §4: ただの操作のボタンなので横幅いっぱいにしない)。grid の子は既定で列の幅
// に伸びるので justify-self: start で左に寄せる (寄せないと 68px のボタンが
// 列の幅の 969px まで伸びる)。「TL に戻る」は押すとそこに TL が現れるボタンなので、横幅
// いっぱい (width: 100%) のまま。
test("「全て既読」 keeps the width of its label at the left edge; 「TL に戻る」 spans the list", () => {
  const lines = mountLines("say");
  const readAll = defined(lines.querySelector<HTMLElement>(".tl-filter-read-all"), "全て既読");
  const back = defined(lines.querySelector<HTMLElement>(".tl-filter-back"), "TL に戻る");
  expect(getComputedStyle(readAll).justifySelf).toBe("start");
  expect(getComputedStyle(back).width).toBe("100%");
});
