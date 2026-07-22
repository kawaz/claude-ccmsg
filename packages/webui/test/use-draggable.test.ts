// useDraggable の pure helper (`clampPosition` / `isPanelDragHandle`) の
// 検証。hook 本体は DOM + pointerevent 前提なので、composer 系テストと同様
// に「切り出したロジック」だけを bun test で回す。
import { describe, expect, test } from "bun:test";
import { clampPosition, isPanelDragHandle } from "../src/client/useDraggable.ts";

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
