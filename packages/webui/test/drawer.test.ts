// スマホ幅の overlay ドロワーの寸法と、外側タップの判定 (drawer.ts)。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  DRAWER_DEFAULT_MAX_PX,
  DRAWER_WIDTH_KEY,
  SIDEBAR_LIST_DEFAULT_PX,
  SIDEBAR_LIST_HEIGHT_KEY,
  clampDrawerWidth,
  clampSidebarListHeight,
  defaultDrawerWidth,
  loadDrawerWidth,
  loadSidebarListHeight,
  saveDrawerWidth,
  saveSidebarListHeight,
} from "../src/client/drawer.ts";
import { PANE_MIN_PX } from "../src/client/utils.ts";

// files-view-store.test.ts と同じ最小 localStorage shim。
class MemStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});

describe("defaultDrawerWidth", () => {
  test("スマホでは画面のほとんどを覆う", () => {
    expect(defaultDrawerWidth(390)).toBeCloseTo(331.5);
  });

  // タブレット幅 (720px 以下だが広い) で端から端まで伸びないための上限。
  test("広い画面では上限で頭打ち", () => {
    expect(defaultDrawerWidth(720)).toBe(DRAWER_DEFAULT_MAX_PX);
  });
});

describe("clampDrawerWidth", () => {
  // 右に main が残らないと「本文を見ながら検索結果を選ぶ」ができない。
  test("上限は画面幅 − PANE_MIN_PX", () => {
    expect(clampDrawerWidth(9999, 390)).toBe(390 - PANE_MIN_PX);
  });

  test("下限まで潰せる", () => {
    expect(clampDrawerWidth(0, 390)).toBe(PANE_MIN_PX);
  });

  test("範囲内はそのまま", () => {
    expect(clampDrawerWidth(200, 390)).toBe(200);
  });
});

describe("loadDrawerWidth / saveDrawerWidth", () => {
  test("保存値があればそれを使う", () => {
    saveDrawerWidth(210);
    expect(loadDrawerWidth(390)).toBe(210);
  });

  test("未保存なら画面幅から決まる既定", () => {
    expect(loadDrawerWidth(390)).toBeCloseTo(defaultDrawerWidth(390));
  });

  test("数値でない保存値は既定", () => {
    localStorage.setItem(DRAWER_WIDTH_KEY, "nonsense");
    expect(loadDrawerWidth(390)).toBeCloseTo(defaultDrawerWidth(390));
  });

  // 画面を一時的に狭くしただけで記憶している幅を書き換えない (復元は下限のみ)。
  test("復元では画面幅で上限を掛けない", () => {
    saveDrawerWidth(380);
    expect(loadDrawerWidth(100)).toBe(380);
  });
});

describe("clampSidebarListHeight / loadSidebarListHeight", () => {
  // kawaz r273 m26: ドロワーはフォームが上・一覧が下の縦分割。一覧は「今どの
  // セッションを見ているか」が分かる行数だけ残す。実測 (390x844) で一覧の
  // 上端から 1 行目までが 75px、行ピッチが 59px。
  test("既定は行が 2〜3 本見える高さ", () => {
    expect(loadSidebarListHeight()).toBe(SIDEBAR_LIST_DEFAULT_PX);
    const rows = (SIDEBAR_LIST_DEFAULT_PX - 75) / 59;
    expect(rows).toBeGreaterThanOrEqual(2);
    expect(rows).toBeLessThanOrEqual(3);
  });

  // 「フォームが隠れるまで下げられる」= 上限はドロワーの高さ (PANE_MIN_PX を残す)。
  test("上限はドロワーの高さ、下限は PANE_MIN_PX", () => {
    expect(clampSidebarListHeight(9999, 800)).toBe(800 - PANE_MIN_PX);
    expect(clampSidebarListHeight(-10, 800)).toBe(PANE_MIN_PX);
  });

  test("保存値を復元する", () => {
    saveSidebarListHeight(320);
    expect(loadSidebarListHeight()).toBe(320);
  });

  // #form-pane の幅とは別のキー。測っているものが違う (フォームの幅 / その下の
  // 一覧の高さ) ので、片方を動かしてもう片方が動く結び付きは意図しない。
  test("form-pane の幅とはキーを分ける", () => {
    expect(SIDEBAR_LIST_HEIGHT_KEY).not.toBe("ccmsg.formPaneWidth");
  });
});
