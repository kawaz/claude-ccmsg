// useFabPopup の pure helper (`isOutsideIframeFocus`) の検証。hook 本体は
// DOM + focus 挙動が前提で bun test から回せないため、判定ロジックだけを
// 切り出して回す (use-draggable.test.ts と同じ流儀)。
//
// 実装の背景は useFabPopup.ts のコメント参照: Terminal タブでは panel の
// 外側が cross-origin iframe (hyoui embed) で、iframe 内クリックは親
// document に伝播しない。window blur + activeElement === IFRAME で
// 「iframe がクリックされた」を代替検知する。
import { describe, expect, test } from "bun:test";
import { isOutsideIframeFocus } from "../src/client/useFabPopup.ts";

/** panel の stub。`contains` の戻り値だけを制御する。 */
function panelStub(contains: boolean) {
  return { contains: () => contains };
}

describe("isOutsideIframeFocus", () => {
  test("panel 外の iframe にフォーカスが移ったら true (= 閉じる)", () => {
    // Terminal タブで hyoui iframe をクリックした瞬間の状態。
    expect(isOutsideIframeFocus({ tagName: "IFRAME" }, panelStub(false))).toBe(true);
  });

  test("iframe 以外へのフォーカス移動では false", () => {
    // 別タブ / 別ウィンドウ / 別アプリへの切替では activeElement は
    // 移動前の要素のまま (実測: Chrome Beta)。panel は開いたままにする。
    expect(isOutsideIframeFocus({ tagName: "TEXTAREA" }, panelStub(false))).toBe(false);
    expect(isOutsideIframeFocus({ tagName: "BODY" }, panelStub(false))).toBe(false);
  });

  test("activeElement が無い環境では false", () => {
    expect(isOutsideIframeFocus(null, panelStub(false))).toBe(false);
  });

  test("panel が内包する iframe は「外側」ではない", () => {
    // panel 内に iframe を置く構成になっても、他の内外判定 (click /
    // pointerdown) と同じく panel.contains を基準に外側だけを閉じる。
    expect(isOutsideIframeFocus({ tagName: "IFRAME" }, panelStub(true))).toBe(false);
  });

  test("panel ref が未設定 (null) でも iframe なら true", () => {
    // panelRef が埋まる前に blur が来る稀ケース。閉じる側に倒す
    // (開きっぱなしで閉じられないより、閉じて再オープンできる方が安全)。
    expect(isOutsideIframeFocus({ tagName: "IFRAME" }, null)).toBe(true);
  });
});
