// useDraggable の pure helper (`clampPosition` / `isPanelDragHandle`) の
// 検証。hook 本体は DOM + pointerevent 前提なので、composer 系テストと同様
// に「切り出したロジック」だけを bun test で回す。
import { describe, expect, test } from "bun:test";
import { alignBottomRight, clampPosition, isPanelDragHandle } from "../src/client/useDraggable.ts";

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

  test("visual viewport offset (vx/vy) 対応: 可視領域内に clamp (r46m52)", () => {
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
    // r46m51 以前と同じ振る舞い: vx/vy 未指定なら 0 起点で clamp。
    expect(clampPosition({ x: -10, y: -20, w: 40, h: 40, vw: 800, vh: 600 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("alignBottomRight (FAB ↔ panel 位置連動、r46m51)", () => {
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

describe("isPanelDragHandle", () => {
  test("rejects null / targets without closest()", () => {
    expect(isPanelDragHandle(null)).toBe(false);
    // closest 未実装 = Element ではないので false。
    expect(isPanelDragHandle({} as EventTarget)).toBe(false);
  });

  test("rejects targets inside form controls", () => {
    // closest が form control セレクタにヒットする target (= textarea 上等)。
    const target = {
      closest: (sel: string) => (sel.includes("textarea") ? ({} as Element) : null),
    } as unknown as EventTarget;
    expect(isPanelDragHandle(target)).toBe(false);
  });

  test("allows targets outside form controls", () => {
    // closest が何にもヒットしない = 純粋な panel 余白領域。
    const target = { closest: () => null } as unknown as EventTarget;
    expect(isPanelDragHandle(target)).toBe(true);
  });
});
