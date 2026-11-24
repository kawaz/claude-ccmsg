// 何を保証するか (DR-0062 §3、kawaz 2026-11-24): コメントのフォームのような浮かせる
// パネルは、開いた元 (押した「返信」、選んだ範囲) の近くに出る (usePlacedNear)。
//
// - 最初の描画の前に置く: mount した時にはもう開いた元のすぐ下 (入らなければ上) に居て、
//   CSS の既定の右下から飛んでこない
// - 置ける範囲は画面から、CSS の既定 (右下) の右と下の余白を除いた所
// - 別の対象のパネル (key が替わって mount し直したもの) は新しい開いた元の近くに出る
// - 置き場の箱の大きさが変わったら (ソフトウェアキーボードが出た等) 置き直すが、
//   人がドラッグで動かした後は置き直さず、その位置を保つ
//
// happy-dom は配置を計算しないので、パネルの client rect は test が与える: style の
// left / top があればそこ、無ければ CSS の既定の右下 (右と下に 20px の余白)。置き場の箱は
// viewport (offsetParent が無い)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { useDraggable, usePlacedNear } from "../src/client/useDraggable.ts";
import { instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

const PANEL = { w: 300, h: 200 };
const MARGIN = 20;
let screen = { w: 1000, h: 800 };
let restores: Array<() => void> = [];
let resized: Array<() => void> = [];
let root: HTMLElement | null = null;

/** The panel's box as the page would lay it out. */
function panelRect(el: HTMLElement): DOMRect {
  const left =
    el.style.left === "" ? screen.w - MARGIN - PANEL.w : Number.parseFloat(el.style.left);
  const top = el.style.top === "" ? screen.h - MARGIN - PANEL.h : Number.parseFloat(el.style.top);
  return new DOMRect(left, top, PANEL.w, PANEL.h);
}

beforeEach(() => {
  screen = { w: 1000, h: 800 };
  resized = [];
  class FakeResizeObserver {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe(): void {
      resized.push(this.callback);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  restores = [
    stubGlobal("ResizeObserver", FakeResizeObserver),
    stubProperty(window, "innerWidth", { configurable: true, get: () => screen.w }),
    stubProperty(window, "innerHeight", { configurable: true, get: () => screen.h }),
    stubProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        return this.classList.contains("panel") ? panelRect(this) : new DOMRect();
      },
    }),
    stubProperty(HTMLElement.prototype, "getClientRects", {
      configurable: true,
      value(this: HTMLElement) {
        return this.classList.contains("panel") ? [panelRect(this)] : [];
      },
    }),
  ];
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted !== null) {
    await act(() => render(null, mounted));
    mounted.remove();
  }
  for (const restore of restores.reverse()) restore();
});

interface Near {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function Panel({ near }: { near: Near }) {
  const drag = useDraggable();
  const ref = usePlacedNear({ drag, near });
  return h("div", { class: "panel", ref, onPointerDown: drag.onPointerDown, style: drag.style });
}

/** Mounts (or re-renders) the panel of target `key` opened from `near`. */
async function show(key: string, near: Near): Promise<HTMLElement> {
  if (root === null) {
    root = document.createElement("div");
    document.body.append(root);
  }
  const mounted = root;
  await act(() => render(h(Panel, { key, near }), mounted));
  return instanceOf(mounted.querySelector(".panel"), HTMLElement, "the panel");
}

function at(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}

/** A 返信 button 60×24 whose top left is (x, y). */
function button(x: number, y: number): Near {
  return { left: x, top: y, right: x + 60, bottom: y + 24 };
}

async function drag(el: HTMLElement, dx: number, dy: number): Promise<void> {
  const from = el.getBoundingClientRect();
  const x = from.left + 5;
  const y = from.top + 5;
  const pointer = (type: string, cx: number, cy: number) =>
    new PointerEvent(type, { pointerId: 1, button: 0, clientX: cx, clientY: cy, bubbles: true });
  await act(() => {
    el.dispatchEvent(pointer("pointerdown", x, y));
    el.dispatchEvent(pointer("pointermove", x + dx, y + dy));
    el.dispatchEvent(pointer("pointerup", x + dx, y + dy));
  });
}

async function resize(w: number, h: number): Promise<void> {
  screen = { w, h };
  await act(() => {
    for (const callback of resized) callback();
    window.dispatchEvent(new Event("resize"));
  });
}

describe("usePlacedNear", () => {
  test("opens just below what it was opened from, right ends lined up", async () => {
    const el = await show("a", button(600, 100));
    // 右端 660 に揃えて x = 360、下端 124 + 4 の隙間。
    expect(at(el)).toEqual({ x: 360, y: 128 });
  });

  test("opens above when below it does not fit", async () => {
    const el = await show("a", button(600, 600));
    // 下は 628 + 200 > 780 (下の余白 20 の上まで) で入らず、上 600 - 4 - 200。
    expect(at(el)).toEqual({ x: 360, y: 396 });
  });

  test("keeps off the screen's edges", async () => {
    // 左端の返信: 右端を揃えると左へはみ出すので、左の余白まで寄せる。
    expect(at(await show("a", button(0, 100))).x).toBe(MARGIN);
    // 右端の返信: 右の余白を空ける。
    expect(at(await show("b", button(950, 100))).x).toBe(screen.w - MARGIN - PANEL.w);
  });

  test("a panel on another target opens near that one", async () => {
    await show("a", button(600, 100));
    const el = await show("b", button(200, 400));
    expect(at(el)).toEqual({ x: MARGIN, y: 428 });
  });

  test("the same target opened again from elsewhere stays where it is", async () => {
    await show("a", button(600, 100));
    const el = await show("a", button(200, 400));
    expect(at(el)).toEqual({ x: 360, y: 128 });
  });

  test("a screen that shrinks (a keyboard) places it again within what is seen", async () => {
    const el = await show("a", button(600, 300));
    expect(at(el)).toEqual({ x: 360, y: 328 });
    // 見える範囲が 500 の高さに縮む: 下 (328 + 200 > 480) に入らず、上へ。
    await resize(1000, 500);
    expect(at(el)).toEqual({ x: 360, y: 96 });
  });

  test("once dragged, it keeps where the person put it", async () => {
    const el = await show("a", button(600, 100));
    await drag(el, -200, 150);
    expect(at(el)).toEqual({ x: 160, y: 278 });
    await resize(1000, 790);
    expect(at(el)).toEqual({ x: 160, y: 278 });
    // Opened again on the same target: still where it was put.
    await show("a", button(100, 50));
    expect(at(el)).toEqual({ x: 160, y: 278 });
  });
});
