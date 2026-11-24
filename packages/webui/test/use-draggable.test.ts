// useDraggable の pure helper (`clampPosition` / `isPanelDragHandle`) の
// 検証。hook 本体は DOM + pointerevent 前提なので、composer 系テストと同様
// に「切り出したロジック」だけを bun test で回す。
import { describe, expect, test } from "bun:test";
import {
  alignBottomRight,
  clampPosition,
  isPanelDragHandle,
  nearViewport,
  placeNear,
} from "../src/client/useDraggable.ts";

describe("clampPosition", () => {
  test("clamps within viewport", () => {
    // 要素が viewport 内に収まる: そのままの座標。
    expect(clampPosition({ x: 100, y: 50, w: 40, h: 40, vw: 800, vh: 600 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  test("clamps to right/bottom edge", () => {
    // 右端 / 下端はみ出し: viewport - element size に丸まる。
    expect(clampPosition({ x: 1000, y: 900, w: 40, h: 40, vw: 800, vh: 600 })).toEqual({
      x: 760,
      y: 560,
    });
  });

  test("clamps to left/top edge (negative)", () => {
    // 負座標: 0 に丸まる (viewport 外へ逃げない)。
    expect(clampPosition({ x: -50, y: -20, w: 40, h: 40, vw: 800, vh: 600 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  test("element larger than viewport falls back to 0", () => {
    // element size > viewport 時、maxX = max(0, vw - w) で 0 に丸まる — 負の
    // 上限に吸い込まれて画面外へ飛ばない保険。
    expect(clampPosition({ x: 100, y: 100, w: 900, h: 900, vw: 800, vh: 600 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  test("visual viewport offset (vx/vy) 対応: 可視領域内に clamp", () => {
    // iOS でキーボードが出ている想定: layout viewport = 400x800、visual
    // viewport は下 300px が隠れて 400x500、offset は (0, 0) から
    // 変わらないケース。可視領域は y=[0, 500]。
    // element (40x40) を y=600 にドラッグしようとしても、可視領域末端
    // (500 - 40 = 460) に丸まる。
    expect(clampPosition({ x: 100, y: 600, w: 40, h: 40, vw: 400, vh: 500, vx: 0, vy: 0 })).toEqual(
      { x: 100, y: 460 },
    );
  });

  test("visual viewport offset (vy > 0) 対応: 上端も offset に合わせる", () => {
    // iOS で input focus によりページが上スクロールされ、visual viewport の
    // offsetTop = 100 になっているケース。layout 座標系で可視領域は
    // y=[100, 100+500=600]。y=50 にドラッグしても vy=100 に丸まる。
    expect(
      clampPosition({ x: 100, y: 50, w: 40, h: 40, vw: 400, vh: 500, vx: 0, vy: 100 }),
    ).toEqual({ x: 100, y: 100 });
    // 下端は vy + vh - h = 100 + 500 - 40 = 560 に丸まる。
    expect(
      clampPosition({ x: 100, y: 999, w: 40, h: 40, vw: 400, vh: 500, vx: 0, vy: 100 }),
    ).toEqual({ x: 100, y: 560 });
  });

  test("vx/vy 省略時は 0 (従来挙動を維持)", () => {
    // vx/vy 未指定なら 0 起点で clamp。
    expect(clampPosition({ x: -10, y: -20, w: 40, h: 40, vw: 800, vh: 600 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("alignBottomRight (FAB ↔ panel 位置連動)", () => {
  const viewport = { vw: 1000, vh: 800 };

  test("FAB → panel: bottom-right 角を揃える (パネルは大きいので左上に伸びる)", () => {
    // FAB (40x40) が (900, 700)。bottom-right 角は (940, 740)。
    // panel (300x200) の bottom-right 角を (940, 740) に揃えると top-left は
    // (640, 540)。
    expect(
      alignBottomRight({
        anchor: { x: 900, y: 700, w: 40, h: 40 },
        target: { w: 300, h: 200 },
        viewport,
      }),
    ).toEqual({ x: 640, y: 540 });
  });

  test("panel → FAB: bottom-right 角を揃える (FAB は小さいので右下に来る)", () => {
    // panel (300x200) が (100, 100)。bottom-right 角は (400, 300)。
    // FAB (40x40) の bottom-right 角を (400, 300) に揃えると top-left は
    // (360, 260)。
    expect(
      alignBottomRight({
        anchor: { x: 100, y: 100, w: 300, h: 200 },
        target: { w: 40, h: 40 },
        viewport,
      }),
    ).toEqual({ x: 360, y: 260 });
  });

  test("往復で bottom-right 角が保存される (羃等性)", () => {
    // FAB → panel → FAB で元の FAB 位置に戻る (bottom-right 角が保存されるため)。
    const fab = { x: 800, y: 600, w: 40, h: 40 };
    const panelSize = { w: 300, h: 200 };
    const panelPos = alignBottomRight({
      anchor: fab,
      target: panelSize,
      viewport,
    });
    const fabAgain = alignBottomRight({
      anchor: { x: panelPos.x, y: panelPos.y, w: panelSize.w, h: panelSize.h },
      target: { w: fab.w, h: fab.h },
      viewport,
    });
    expect(fabAgain).toEqual({ x: fab.x, y: fab.y });
  });

  test("viewport はみ出しは clamp される (左上/右下)", () => {
    // FAB が左上に近い → panel は左上に食い込む → 0 に clamp。
    expect(
      alignBottomRight({
        anchor: { x: 10, y: 10, w: 40, h: 40 },
        target: { w: 300, h: 200 },
        viewport,
      }),
    ).toEqual({ x: 0, y: 0 });
    // panel が右下に近すぎ → FAB は viewport - size に丸まる。
    expect(
      alignBottomRight({
        anchor: { x: 900, y: 700, w: 300, h: 200 },
        target: { w: 40, h: 40 },
        viewport,
      }),
    ).toEqual({ x: 960, y: 760 });
  });
});

// 何を保証するか (DR-0062 §3、kawaz 2026-11-24): 「返信」から開いたコメントのフォームは、
// 返信のボタンに重ねて上端どうしを揃え (フォームの top = ボタンの top)、下に入り切らなければ
// 下端どうしを揃える。横はボタンと右端を揃える。どの場合も置ける範囲 (画面の端の余白と
// ソフトキーボードを除いた所) の外には出さない。範囲は 0..800 × 0..600 (左上 0)、フォームは
// 300×200。
describe("placeNear: 返信から開いた時 (ボタンに重ねる)", () => {
  const viewport = { vw: 800, vh: 600 };
  const target = { w: 300, h: 200 };
  const cover = true;
  const align = "right";

  test("下に入るなら、上端をボタンの上端に、右端をボタンの右端に揃える", () => {
    const anchor = { x: 500, y: 100, w: 60, h: 20 };
    expect(placeNear({ anchor, target, viewport, cover, align })).toEqual({ x: 260, y: 100 });
  });

  test("下に入り切らなければ、下端をボタンの下端に揃える", () => {
    const anchor = { x: 500, y: 450, w: 60, h: 20 };
    // 下は 450 + 200 > 600 で入らない。上はボタンの下端 470 - 200 = 270。
    expect(placeNear({ anchor, target, viewport, cover, align })).toEqual({ x: 260, y: 270 });
  });

  test("下にちょうど入るなら下 (境界)", () => {
    const anchor = { x: 500, y: 400, w: 60, h: 20 };
    expect(placeNear({ anchor, target, viewport, cover, align }).y).toBe(400);
  });

  test("上下どちらにも入り切らなければ、広い側に置いて範囲の中へ寄せる", () => {
    // 背の高いフォーム (500): ボタンの上端から下は 450、ボタンの下端から上は 170 の余り。
    // 下の方が広いので下の側で、下端が範囲の下端に寄る。
    const tall = { w: 300, h: 500 };
    const high = { x: 500, y: 150, w: 60, h: 20 };
    expect(placeNear({ anchor: high, target: tall, viewport, cover, align })).toEqual({
      x: 260,
      y: 100,
    });
    // 上の方が広ければ (下 180、上 440) 上の側で、上端が範囲の上端 0 に寄る。
    const low = { x: 500, y: 420, w: 60, h: 20 };
    expect(placeNear({ anchor: low, target: tall, viewport, cover, align })).toEqual({
      x: 260,
      y: 0,
    });
  });

  test("横は画面の外に出さない (開いた元が左端・右端にある時)", () => {
    const left = { x: 10, y: 100, w: 60, h: 20 };
    expect(placeNear({ anchor: left, target, viewport, cover, align }).x).toBe(0);
    const right = { x: 780, y: 100, w: 60, h: 20 };
    expect(placeNear({ anchor: right, target, viewport, cover, align }).x).toBe(500);
  });

  test("置ける範囲の左上が 0 でない時 (余白・キーボード) もその中に置く", () => {
    // 範囲: x 20..780、y 20..380 (下はキーボードに隠れている)。
    const inner = { vx: 20, vy: 20, vw: 760, vh: 360 };
    const anchor = { x: 500, y: 300, w: 60, h: 20 };
    // 下 (300 + 200 > 380) に入らず、上 (320 - 200 = 120 >= 20) に入る。
    expect(placeNear({ anchor, target, viewport: inner, cover, align })).toEqual({
      x: 260,
      y: 120,
    });
    const corner = { x: 0, y: 0, w: 10, h: 10 };
    expect(placeNear({ anchor: corner, target, viewport: inner, cover, align })).toEqual({
      x: 20,
      y: 20,
    });
  });

  test("範囲より広いフォームは範囲の左端に置き、縦だけ開いた元に合わせる (狭い画面)", () => {
    // 390 幅の画面で 358 幅のフォーム: 範囲を CSS の既定の位置 (左 12) から
    // フォームの幅だけにすると、横はそこに決まる。
    const narrow = { vx: 12, vw: 358, vh: 700 };
    const wide = { w: 358, h: 200 };
    const anchor = { x: 300, y: 250, w: 60, h: 20 };
    expect(placeNear({ anchor, target: wide, viewport: narrow, cover, align })).toEqual({
      x: 12,
      y: 250,
    });
  });
});

// 何を保証するか (DR-0062 §3、kawaz 2026-11-24): 範囲選択から開いたコメントのフォームは、
// 上端を選択範囲の全体の下端に揃え (フォームの top = 選択の bottom、隙間なし)、下に入り切らな
// ければ下端を選択範囲の上端に揃える。横は選んだ文字の左端に揃える (選んだ文字の真下から
// フォームが始まる)。入り切らなければ範囲の中へ寄せる。
describe("placeNear: 範囲選択から開いた時 (選択範囲の外に接する)", () => {
  const viewport = { vx: 300, vw: 900, vh: 800 };
  const target = { w: 400, h: 200 };
  const cover = false;
  const align = "left";
  test("上端を選択範囲の下端に、左端を選んだ文字の左端に揃える", () => {
    const chosen = { x: 500, y: 100, w: 120, h: 18 };
    expect(placeNear({ anchor: chosen, target, viewport, cover, align })).toEqual({
      x: 500,
      y: 118,
    });
  });
  test("下に入り切らなければ、下端を選択範囲の上端に揃える", () => {
    // 下は 718 + 200 > 800 で入らない。上は 700 - 200 = 500。
    const chosen = { x: 500, y: 700, w: 120, h: 18 };
    expect(placeNear({ anchor: chosen, target, viewport, cover, align }).y).toBe(500);
  });
  test("下にちょうど入るなら下 (境界)", () => {
    const chosen = { x: 500, y: 582, w: 120, h: 18 };
    expect(placeNear({ anchor: chosen, target, viewport, cover, align }).y).toBe(600);
  });
  test("上下どちらにも入り切らなければ、広い側に置いて範囲の中へ寄せる", () => {
    // 範囲は 0..600。背の高い (複数行の) 選択範囲: 上に 150、下に 130 の余り。上の方が
    // 広いので上の側で、上端は範囲の上端 0 に寄る。
    const small = { vw: 800, vh: 600 };
    const form = { w: 300, h: 200 };
    const tall = { x: 500, y: 150, w: 60, h: 320 };
    expect(placeNear({ anchor: tall, target: form, viewport: small, cover, align })).toEqual({
      x: 500,
      y: 0,
    });
    // 下の方が広ければ下の側で、下端が範囲の下端に寄る。
    const low = { x: 500, y: 100, w: 60, h: 320 };
    expect(placeNear({ anchor: low, target: form, viewport: small, cover, align })).toEqual({
      x: 500,
      y: 400,
    });
  });
  test("右へはみ出すなら範囲の中へ寄せる", () => {
    const chosen = { x: 1000, y: 100, w: 120, h: 18 };
    expect(placeNear({ anchor: chosen, target, viewport, cover, align }).x).toBe(800);
  });
});

// 何を保証するか (DR-0062 §3、kawaz 2026-11-24): フォームを置ける範囲は、画面の端の余白
// (CSS の既定の右下の余白、左も同じだけ) を除いた所で、セッションの画面の枠 (`within`) が
// あればその中に絞る (サイドバーやタブの見出しの上に出さない)。範囲より広いフォームは範囲の
// 右端に揃えた位置 (狭い画面ではほぼ全幅) から始まる。
describe("nearViewport (フォームを置ける範囲)", () => {
  const margin = { right: 20, bottom: 20, top: 20 };
  test("枠が無ければ画面から端の余白を除いた所", () => {
    expect(nearViewport({ box: { w: 1280, h: 900 }, margin, within: null, width: 640 })).toEqual({
      vx: 20,
      vy: 20,
      vw: 1240,
      vh: 860,
    });
  });
  test("セッションの画面の枠の中に絞る", () => {
    // サイドバー (0..285) とタブの見出し (..76) の外。
    const within = { left: 289, right: 1276, top: 80, bottom: 896 };
    expect(nearViewport({ box: { w: 1280, h: 900 }, margin, within, width: 640 })).toEqual({
      vx: 289,
      vy: 80,
      vw: 1260 - 289,
      vh: 800,
    });
  });
  test("枠より広いフォームは枠の右端に揃えた所から (狭い画面のほぼ全幅)", () => {
    const within = { left: 4, right: 386, top: 80, bottom: 840 };
    expect(nearViewport({ box: { w: 390, h: 844 }, margin, within, width: 358 })).toEqual({
      vx: 12,
      vy: 80,
      vw: 358,
      vh: 744,
    });
  });
});

describe("isPanelDragHandle", () => {
  /** An event target with `closest()` (what an Element has), answering a hit
   * for the selectors `hits` picks. */
  class ClosestTarget extends EventTarget {
    constructor(private readonly hits: (sel: string) => boolean) {
      super();
    }
    closest(sel: string): object | null {
      return this.hits(sel) ? {} : null;
    }
  }

  test("rejects null / targets without closest()", () => {
    expect(isPanelDragHandle(null)).toBe(false);
    // closest 未実装 = Element ではないので false。
    expect(isPanelDragHandle(new EventTarget())).toBe(false);
  });

  test("rejects targets inside form controls", () => {
    // closest が form control セレクタにヒットする target (= textarea 上等)。
    const target = new ClosestTarget((sel) => sel.includes("textarea"));
    expect(isPanelDragHandle(target)).toBe(false);
  });

  test("allows targets outside form controls", () => {
    // closest が何にもヒットしない = 純粋な panel 余白領域。
    const target = new ClosestTarget(() => false);
    expect(isPanelDragHandle(target)).toBe(true);
  });
});
