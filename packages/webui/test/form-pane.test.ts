// main ペイン側フォームパネルの幅の丸め (FormPane.tsx のドラッグと復元)。
import { describe, expect, test } from "bun:test";
import {
  clampFormPaneWidth,
  formPanePanel,
  sidebarInlinePanel,
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

// 幅ごとの担当 (D-Q1 裁定 = b / kawaz r259 m53)。3 つの panel は同じ規則に
// 従い、どの幅でもちょうど片方だけが描く。
describe("sidebarInlinePanel / formPanePanel", () => {
  const PANELS = ["session-creator", "session-search", "room-creator"] as const;

  test("デスクトップでは 3 つとも FormPane 側", () => {
    for (const panel of PANELS) {
      expect(formPanePanel(panel, false)).toBe(panel);
      expect(sidebarInlinePanel(panel, false)).toBeNull();
    }
  });

  // overlay の中にさらにパネルを重ねない。
  test("スマホ幅では 3 つともサイドバー内", () => {
    for (const panel of PANELS) {
      expect(sidebarInlinePanel(panel, true)).toBe(panel);
      expect(formPanePanel(panel, true)).toBeNull();
    }
  });

  // 本命: 片方だけが例外を持つと「どちらも描かない」「両方に mount される」
  // が生まれる (RoomCreator が FormPane 側だけ除外されていた形)。
  test("どの幅でも、描くのはちょうど片方だけ", () => {
    for (const panel of PANELS) {
      for (const narrow of [true, false]) {
        const hosts = [sidebarInlinePanel(panel, narrow), formPanePanel(panel, narrow)];
        expect(hosts.filter((host) => host !== null)).toEqual([panel]);
      }
    }
  });

  test("何も開いていなければどちらも描かない", () => {
    expect(sidebarInlinePanel(null, true)).toBeNull();
    expect(formPanePanel(null, false)).toBeNull();
  });
});
