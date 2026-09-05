// splitter の位置を軸に沿った寸法へ読み替える純関数 (pane-axis.ts)。
// 分割を持つ 3 か所 (Sidebar / FilesPanes / TimelinePanes) が同じ関数を通す。
import { describe, expect, test } from "bun:test";
import { paneAxis, paneAxisMetrics, type PaneAxis } from "../src/client/pane-axis.ts";

/** getBoundingClientRect() の返り値のうち、この関数が読む分だけ。 */
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("paneAxis", () => {
  test("row / column をそのまま軸にする", () => {
    expect(paneAxis("row")).toBe("row");
    expect(paneAxis("column")).toBe("column");
  });

  // 語彙は 2 値だけ。並びを逆にしたいときは `*-reverse` ではなく子の `order`
  // で表す約束 (app.css) なので、reverse はここに入ってこない。入ってきたら
  // 横並び扱いになる = 縦積みの解釈を勝手に当てない。
  test("reverse は語彙に無い", () => {
    expect(paneAxis("row-reverse")).toBe("row");
    expect(paneAxis("column-reverse")).toBe("row");
  });

  // レイアウト前・display:none で getComputedStyle が空文字を返す場面。
  test("読めない値は横並び扱い", () => {
    expect(paneAxis("")).toBe("row");
  });
});

describe("paneAxisMetrics", () => {
  const box = rect(100, 40, 800, 600);

  test("横並びは X を見る", () => {
    const m = paneAxisMetrics("row", box, { clientX: 300, clientY: 500 });
    expect(m).toEqual({ start: 100, end: 900, size: 800, pointer: 300 });
  });

  test("縦積みは Y を見る", () => {
    const m = paneAxisMetrics("column", box, { clientX: 300, clientY: 500 });
    expect(m).toEqual({ start: 40, end: 640, size: 600, pointer: 500 });
  });

  // 呼び出し側が決めるのは「一覧側がどちらの端にあるか」だけ。Sidebar は
  // 横並びで手前 (左) = 一覧、縦積みでは `order` でフォームが前に出るので
  // 奥 (下) = 一覧、という対で使う。
  test("手前からの距離と奥からの距離は軸の長さで足し合う", () => {
    for (const axis of ["row", "column"] as PaneAxis[]) {
      const m = paneAxisMetrics(axis, box, { clientX: 300, clientY: 500 });
      expect(m.pointer - m.start + (m.end - m.pointer)).toBe(m.size);
    }
  });

  // FilesPanes / TimelinePanes はどちらの軸でもツリーが手前側なので、
  // 比率はいつも `pointer - start` を軸の長さで割った値になる。
  test("ツリー側の比率は軸によらず同じ式で出る", () => {
    const half = paneAxisMetrics("row", box, { clientX: 500, clientY: 340 });
    const halfY = paneAxisMetrics("column", box, { clientX: 500, clientY: 340 });
    expect((half.pointer - half.start) / half.size).toBeCloseTo(0.5);
    expect((halfY.pointer - halfY.start) / halfY.size).toBeCloseTo(0.5);
  });
});
