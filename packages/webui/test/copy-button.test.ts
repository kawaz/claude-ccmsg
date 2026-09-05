// CopyButton.tsx のラベル。同じボタンが 2 つの場所 (StatusPanel のメタ情報と
// SESSIONS の行) に出るので、どちらの文字を出すかは 1 箇所で決まっている。
// 成功時も ✓ を重ねるだけでラベルは place を持ち続ける (kawaz r259 m4) ため、
// ここが実質ボタンの幅を決める。
import { describe, expect, test } from "bun:test";
import { copyButtonLabel } from "../src/client/components/CopyButton.tsx";

describe("copyButtonLabel", () => {
  // SESSIONS の行では sid の表示幅が主役なので、3 文字のラベルは記号に譲る
  // (kawaz r273 m29)。
  test("狭い行 (compact) は 1 文字の記号", () => {
    const label = copyButtonLabel(true);
    // 1 コード単位 = BMP の記号。絵文字 (サロゲートペア) を選ぶと 2 になる。
    expect(label).toHaveLength(1);
    expect(label.codePointAt(0)).toBe(0x29c9);
  });

  // 記号を選んだ基準が「単色で出る」こと (WebKit / Chromium で実測)。絵文字
  // 表示に倒れる符号位置を選ぶと、弱い文字色で揃えた行の中でそこだけ色が浮く。
  test("compact の記号は絵文字ブロックから採らない", () => {
    expect(copyButtonLabel(true).codePointAt(0) ?? 0).toBeLessThan(0x1f000);
  });

  test("StatusPanel 側 (非 compact) は文字ラベルのまま", () => {
    expect(copyButtonLabel(false)).toBe("コピー");
  });
});
