// main ペイン側フォームパネルの幅の丸め (FormPane.tsx のドラッグと復元)。
import { describe, expect, test } from "bun:test";
import {
  clampFormPaneWidth,
  FORM_PANE_DEFAULT_PX,
  FORM_PANE_MAX_PX,
  FORM_PANE_MIN_PX,
} from "../src/client/form-pane.ts";

describe("clampFormPaneWidth", () => {
  test("範囲内はそのまま", () => {
    expect(clampFormPaneWidth(500)).toBe(500);
  });

  test("狭すぎ / 広すぎは範囲の端に丸める", () => {
    expect(clampFormPaneWidth(10)).toBe(FORM_PANE_MIN_PX);
    expect(clampFormPaneWidth(-200)).toBe(FORM_PANE_MIN_PX);
    expect(clampFormPaneWidth(5000)).toBe(FORM_PANE_MAX_PX);
  });

  // localStorage に数値でない値が入っていた / ドラッグ中に要素が消えた等。
  test("数値でなければ既定幅", () => {
    expect(clampFormPaneWidth(Number.NaN)).toBe(FORM_PANE_DEFAULT_PX);
    expect(clampFormPaneWidth(Number.POSITIVE_INFINITY)).toBe(FORM_PANE_DEFAULT_PX);
  });

  // 既定幅は cwd 確定表示に要る 422px を満たす
  // (docs/findings/2026-08-12-form-ux-width-survey.md)。
  test("既定幅は cwd 表示の所要幅を満たす", () => {
    expect(FORM_PANE_DEFAULT_PX).toBeGreaterThanOrEqual(422);
  });
});
