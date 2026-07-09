import { describe, expect, test } from "bun:test";
import { compareVersions } from "../src/version-compare.ts";

describe("compareVersions (DR-0002 §4 newer-wins upgrade policy)", () => {
  // 等値: 同一文字列はもちろん、桁の再構成でも数値として同じなら 0。
  test("等値は 0", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  // major/minor/patch の各桁差がそれぞれ検出できる (輪郭: 3 軸独立)。
  test("major 差", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.9.9", "2.0.0")).toBeLessThan(0);
  });
  test("minor 差", () => {
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.9", "1.3.0")).toBeLessThan(0);
  });
  test("patch 差", () => {
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  // suffix (pre-release 的なもの) は「同じ3数字なら suffix 無しの方が新しい」。
  // これは daemon が正式リリース版、client が dev/override 版のような場面で、
  // 正式版側を降格させない側に倒すための規約 (issue の (a) 案の最小実装)。
  test("同じ3数字で片方だけ suffix: suffix 無しが新しい", () => {
    expect(compareVersions("1.2.3", "1.2.3-old-for-test")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-old-for-test", "1.2.3")).toBeLessThan(0);
  });

  // 両方 suffix 付きで3数字が同じ場合は優劣を主張しない (最小実装の割り切り)。
  test("同じ3数字で両方 suffix: 0 (優劣なし)", () => {
    expect(compareVersions("1.2.3-a", "1.2.3-b")).toBe(0);
  });
});
