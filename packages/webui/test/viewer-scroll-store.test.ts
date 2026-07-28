import { describe, expect, test, beforeEach } from "bun:test";
import {
  VIEWER_SCROLL_MAX_ENTRIES,
  clearViewerScrolls,
  readViewerScroll,
  rememberViewerScroll,
  resolveViewerScrollTop,
} from "../src/client/viewer-scroll-store.ts";

beforeEach(() => {
  clearViewerScrolls();
});

describe("rememberViewerScroll / readViewerScroll", () => {
  test("history entry key ごとに位置を持つ", () => {
    rememberViewerScroll("k1", { path: "docs/a.md", top: 120 });
    rememberViewerScroll("k2", { path: "docs/b.md", top: 40 });
    expect(readViewerScroll("k1")).toEqual({ path: "docs/a.md", top: 120 });
    expect(readViewerScroll("k2")).toEqual({ path: "docs/b.md", top: 40 });
  });

  test("未知の key は null", () => {
    expect(readViewerScroll("nope")).toBeNull();
  });

  test("同じ key の再記録は上書き (= 最後に離れた時の位置が残る)", () => {
    rememberViewerScroll("k1", { path: "docs/a.md", top: 120 });
    rememberViewerScroll("k1", { path: "docs/a.md", top: 300 });
    expect(readViewerScroll("k1")?.top).toBe(300);
  });

  test("上限を超えると古い記録から捨てる", () => {
    for (let i = 0; i < VIEWER_SCROLL_MAX_ENTRIES + 3; i += 1) {
      rememberViewerScroll(`k${i}`, { path: "docs/a.md", top: i + 1 });
    }
    expect(readViewerScroll("k0")).toBeNull();
    expect(readViewerScroll("k2")).toBeNull();
    expect(readViewerScroll("k3")).not.toBeNull();
    expect(readViewerScroll(`k${VIEWER_SCROLL_MAX_ENTRIES + 2}`)).not.toBeNull();
  });

  test("再記録した key は新しい扱いになり、追い出されない", () => {
    rememberViewerScroll("old", { path: "docs/a.md", top: 10 });
    for (let i = 0; i < VIEWER_SCROLL_MAX_ENTRIES - 1; i += 1) {
      rememberViewerScroll(`k${i}`, { path: "docs/a.md", top: i + 1 });
    }
    rememberViewerScroll("old", { path: "docs/a.md", top: 11 });
    rememberViewerScroll("fresh", { path: "docs/a.md", top: 12 });
    expect(readViewerScroll("old")?.top).toBe(11);
    expect(readViewerScroll("k0")).toBeNull();
  });
});

describe("resolveViewerScrollTop", () => {
  test("記録が無ければ復元しない (= 新規遷移は先頭から)", () => {
    expect(resolveViewerScrollTop(null, "docs/a.md", false)).toBeNull();
  });

  test("記録があれば その位置を返す", () => {
    expect(resolveViewerScrollTop({ path: "docs/a.md", top: 250 }, "docs/a.md", false)).toBe(250);
  });

  test("path が違う記録は使わない", () => {
    expect(resolveViewerScrollTop({ path: "docs/b.md", top: 250 }, "docs/a.md", false)).toBeNull();
  });

  test("行範囲指定つきで開かれたら記録より指定行を優先する", () => {
    expect(resolveViewerScrollTop({ path: "docs/a.md", top: 250 }, "docs/a.md", true)).toBeNull();
  });

  test("先頭 (0) の記録は復元対象にしない", () => {
    expect(resolveViewerScrollTop({ path: "docs/a.md", top: 0 }, "docs/a.md", false)).toBeNull();
  });

  test("壊れた負値の記録は無視する", () => {
    expect(resolveViewerScrollTop({ path: "docs/a.md", top: -5 }, "docs/a.md", false)).toBeNull();
  });
});
