import { describe, expect, test } from "bun:test";
import {
  positionLandingKey,
  shouldLandOnPosition,
  shouldReturnToHead,
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

describe("shouldReturnToHead (kawaz r115 m4: 最下部が見えていても選択できる)", () => {
  // 本 feature の存在理由。/head 表示中に画面内のバルーンをクリックすると、
  // pin が立った直後に「最下部付近だ」と検知されて head へ戻され、実質
  // 選択できなかった。pin 直後 (= ユーザはまだスクロールしていない) は戻さない。
  test("pin 直後 (ユーザ未スクロール) は head に戻さない", () => {
    expect(shouldReturnToHead("u-1", false)).toBe(false);
  });

  // 従来の「最下部まで降りたら末尾追従に復帰」は残す。判定材料はユーザ自身の
  // スクロール操作 (wheel / touch / キー / スクロールバー) があったかどうか。
  test("pin 後にユーザがスクロールして最下部へ来たら head に戻す", () => {
    expect(shouldReturnToHead("u-1", true)).toBe(true);
  });

  // もともと head なら「戻す」対象の pin が無い (URL を書き換える必要もない)。
  test("既に head なら戻す対象がない", () => {
    expect(shouldReturnToHead("head", true)).toBe(false);
    expect(shouldReturnToHead("head", false)).toBe(false);
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
