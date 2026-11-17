// スクロールの動かし方の決まり (DR-0056) の、DOM に依らない所を固定する。
// - ユーザの操作の結果の移動 ("user") は、どこへどちら向きに動いたかを目で
//   追えるようブラウザ標準の smooth
// - 機械的な移動 ("machine": 追従・復元・寄せ直し・初期表示) と、どちらかを
//   渡し忘れた呼び出しは一瞬。渡し忘れを smooth にすると、高頻度の追従が遅れて
//   追いつかない (害の大きい方) ので、既定は一瞬
// - 一瞬は "auto" でなく "instant" と明示する: "auto" は要素の CSS の
//   `scroll-behavior: smooth` に従ってしまう
// - OS の「視差効果を減らす」設定の時は、ユーザの操作でも一瞬。ブラウザは
//   programmatic な smooth にこの設定を当てない (Chromium 143 / WebKit 27 で
//   実測) ので、こちらで見る
import { afterEach, describe, expect, test } from "bun:test";
import { scrollBehaviorFor } from "../src/client/scroll-motion.ts";
import { stubGlobal } from "./helpers.ts";

let restore: () => void = () => {};

function reducedMotion(on: boolean): void {
  restore = stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && on,
    media: query,
  }));
}

afterEach(() => {
  restore();
  restore = () => {};
});

describe("scrollBehaviorFor", () => {
  test("a move the user asked for is smooth", () => {
    reducedMotion(false);
    expect(scrollBehaviorFor("user")).toBe("smooth");
  });

  test("a machine move, and one with no cause given, is instant (not auto)", () => {
    reducedMotion(false);
    expect(scrollBehaviorFor("machine")).toBe("instant");
    expect(scrollBehaviorFor()).toBe("instant");
  });

  test("with reduced motion, even a move the user asked for is instant", () => {
    reducedMotion(true);
    expect(scrollBehaviorFor("user")).toBe("instant");
    expect(scrollBehaviorFor("machine")).toBe("instant");
  });
});
