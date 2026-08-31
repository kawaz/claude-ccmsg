// TL フロートパネルが項目クリックを塞がないための 2 つの判断
// (issue 2026-08-16-timeline-float-panel-blocks-record-click) の検証。
// hook 本体は DOM + ResizeObserver 前提で bun test から回せないため、判断だけを
// 切り出して回す (use-fab-popup.test.ts / timeline-position.test.ts と同じ流儀)。
import { describe, expect, test } from "bun:test";
import {
  shouldCloseSidePanel,
  sidePanelReserveWidth,
  TL_SIDE_PANEL_MIN_CONTENT_PX,
} from "../src/client/components/timeline-side-panel.ts";

/** `contains` の戻り値だけを制御する要素 stub。 */
function containerStub(contains: boolean) {
  return { contains: () => contains };
}

const NODE = {} as unknown;

describe("shouldCloseSidePanel", () => {
  test("パネルの中の click では閉じない", () => {
    // fork / dump のボタンやタブを押した瞬間にパネルが消えたら操作できない。
    expect(shouldCloseSidePanel(NODE, containerStub(true), containerStub(false))).toBe(false);
  });

  test("項目リストの中の click では閉じない (= 選択を変えてもパネルは残る)", () => {
    // ここが true だと「パネルを開いたまま fork 地点を選び直す」ができず、
    // 選ぶたびにパネルを開き直す羽目になる (issue 本体の症状)。
    expect(shouldCloseSidePanel(NODE, containerStub(false), containerStub(true))).toBe(false);
  });

  test("パネルにも項目リストにも属さない click では閉じる (従来どおり)", () => {
    // sidebar / toolbar / composer など。自動収納の元の意図はここで生きる。
    expect(shouldCloseSidePanel(NODE, containerStub(false), containerStub(false))).toBe(true);
  });

  test("項目リストが未マウントでも パネル外なら閉じる", () => {
    // transcript 読み込み前 / エラー表示中は .tl-lines が無い。
    expect(shouldCloseSidePanel(NODE, containerStub(false), null)).toBe(true);
  });

  test("パネル ref が未設定なら閉じない", () => {
    // 内外を判定する基準が無い状態で閉じると、開いた直後に消えうる。
    expect(shouldCloseSidePanel(NODE, null, containerStub(false))).toBe(false);
  });
});

describe("sidePanelReserveWidth", () => {
  test("閉じている間は 0 (本文は全幅)", () => {
    expect(sidePanelReserveWidth(false, 365, 530, TL_SIDE_PANEL_MIN_CONTENT_PX)).toBe(0);
  });

  test("実測構成 (1280px + sidebar) ではパネル幅ぶん丸ごと空く = 重なりゼロ", () => {
    // TL 列 530 / パネル 365。本文に 165 残り、最低幅 160 を割らない。
    expect(sidePanelReserveWidth(true, 365, 530, TL_SIDE_PANEL_MIN_CONTENT_PX)).toBe(365);
  });

  test("広い列でもパネル幅で頭打ち (無駄に空けない)", () => {
    expect(sidePanelReserveWidth(true, 365, 1100, 160)).toBe(365);
  });

  test("本文の最低幅は削らない (パネルが列より広い狭幅ビューポート)", () => {
    // ここは元から何も収まらない領域。重なりは残るが現状より悪くはしない。
    expect(sidePanelReserveWidth(true, 400, 300, 160)).toBe(140);
  });

  test("最低幅すら取れない列では譲らない (負の padding を作らない)", () => {
    expect(sidePanelReserveWidth(true, 400, 160, 160)).toBe(0);
    expect(sidePanelReserveWidth(true, 400, 100, 160)).toBe(0);
  });

  test("列幅が未確定 (0) でも 0 を返す", () => {
    // 初回 measure が hidden なタブで走る場合。
    expect(sidePanelReserveWidth(true, 365, 0, 160)).toBe(0);
  });
});
