import { describe, expect, test } from "bun:test";
import { isAtBottom } from "../src/client/components/timeline-autoscroll.ts";

describe("isAtBottom (kawaz 2026-07-13: 末尾条件付き auto-scroll)", () => {
  // 末尾ぴったり (自分でスクロールバーを一番下まで下ろした状態) は真。
  // ここが真でないと、ユーザが末尾に追いつくたびに「新着が来ても追随しない」
  // という状態が生じ、意図と逆になる。
  test("scrollTop + clientHeight === scrollHeight のとき true", () => {
    expect(isAtBottom({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 })).toBe(true);
  });

  // 高 DPI display / ブラウザ zoom による 1px 未満の残差を末尾扱いする吸収域。
  // 厳密比較にすると Retina 端末で「末尾のはずなのに末尾扱いにならない」不整合が
  // 頻発するため、epsilon の既定 1px を境界に含める。
  test("1px の残差 (epsilon 内) は末尾扱い", () => {
    expect(isAtBottom({ scrollTop: 899.5, clientHeight: 100, scrollHeight: 1000 })).toBe(true);
    expect(isAtBottom({ scrollTop: 899, clientHeight: 100, scrollHeight: 1000 })).toBe(true);
  });

  // ここが false であることが本 feature の存在理由。ユーザが過去ログを遡って
  // いる (末尾から離れている) 間に新着が来ても自動スクロールしない、という
  // 挙動を保証する。
  test("末尾から離れている (epsilon 超え) と false", () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 100, scrollHeight: 1000 })).toBe(false);
    // 100px 上でも false (epsilon の甘い解釈で通してはいけない)
    expect(isAtBottom({ scrollTop: 800, clientHeight: 100, scrollHeight: 1000 })).toBe(false);
  });

  // スクロール不要な短い timeline (空 room の初回や、直近数件しか無い room)
  // は `scrollTop === 0 && scrollHeight === clientHeight` の状態。次に post
  // されたときに末尾追随してほしいので true を返す (= append 後の
  // scrollTop = scrollHeight で最新に張り付く)。
  test("scrollHeight === clientHeight (スクロール不要な短い timeline) でも末尾扱い", () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 500 })).toBe(true);
  });

  // epsilon をより緩く指定できる (呼び出し側の判断で吸収域を広げる余地)。
  // 通常は既定 1px で足りるが、独自 CSS transform 系のズームを掛ける
  // 実験レイアウトなどで 2-3px の残差が出る場合の逃げ道として document 化する。
  test("epsilon を明示的に緩められる", () => {
    expect(isAtBottom({ scrollTop: 895, clientHeight: 100, scrollHeight: 1000 }, 5)).toBe(true);
    expect(isAtBottom({ scrollTop: 894, clientHeight: 100, scrollHeight: 1000 }, 5)).toBe(false);
  });
});
