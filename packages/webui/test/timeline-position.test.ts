import { describe, expect, test } from "bun:test";
import {
  positionLandingKey,
  shouldLandOnPosition,
  togglePosition,
} from "../src/client/components/timeline-position.ts";

describe("shouldLandOnPosition (kawaz r76 m71: pin 位置への着地は遷移時の 1 回だけ)", () => {
  // pin 付き URL を開いた直後 / 別の位置へ遷移した直後は着地する。ここが
  // false になると `/timeline/<uuid>` 直リンクが「開いても目的の位置に居ない」
  // ただのハイライトになってしまう。
  test("未着地 (null) なら着地する", () => {
    expect(shouldLandOnPosition(null, positionLandingKey("s1", "u-1"))).toBe(true);
  });

  // 本 feature の存在理由。tail 追記 / markdown・highlight の差し替えで
  // effect が再実行されても、同じキーである限り再スクロールしない
  // (= pin したまま上を読んでいる最中に pin 位置へ引き戻されない)。
  test("同じキーで再実行されても着地しない", () => {
    const key = positionLandingKey("s1", "u-1");
    expect(shouldLandOnPosition(key, key)).toBe(false);
  });

  // 別の msg をクリックした = 遷移なので、改めて着地する。
  test("同じ TL でも位置が変われば着地する", () => {
    expect(
      shouldLandOnPosition(positionLandingKey("s1", "u-1"), positionLandingKey("s1", "u-2")),
    ).toBe(true);
  });

  // sid が違えば別 TL。uuid が偶然同じでも着地し直す。
  test("uuid が同じでも sid が変われば着地する", () => {
    expect(
      shouldLandOnPosition(positionLandingKey("s1", "u-1"), positionLandingKey("s2", "u-1")),
    ).toBe(true);
  });

  // キーは sid と position の連結。区切りが無いと ("s1"+"1u-1") のような
  // 組み合わせで別 TL のキーが衝突しうるので、境界を保つことを固定する。
  test("キーは sid と position の境界を保つ", () => {
    expect(positionLandingKey("s1", "u-1")).not.toBe(positionLandingKey("s1 u", "-1"));
  });
});

describe("togglePosition (kawaz r76 m71: 選択中バルーンの再クリックで選択解除)", () => {
  // 未選択 / 別 msg 選択中のクリックは、そのバルーンを選択する (従来挙動)。
  test("選択されていない uuid をクリックしたら選択する", () => {
    expect(togglePosition("head", "u-1")).toBe("u-1");
    expect(togglePosition("u-2", "u-1")).toBe("u-1");
  });

  // msgid を外す唯一の手段。head に戻すことで URL から位置が消え、装飾も外れる。
  test("選択中の uuid を再クリックしたら head に戻す", () => {
    expect(togglePosition("u-1", "u-1")).toBe("head");
  });
});
