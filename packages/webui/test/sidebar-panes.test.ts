// サイドバーの 2 段 (一覧 / フォーム) の寸法 (sidebar-panes.ts)。同じ 2 段が軸で並び替わるので、値は軸ごとに別のキーを
// 持つ — 横に広げた幅を、縦に積んだときの高さとして復元しても意味がない。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  DRAWER_DEFAULT_MAX_PX,
  DRAWER_WIDTH_KEY,
  FORM_DEFAULT_PX,
  FORM_WIDTH_KEY,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_LIST_DEFAULT_PX,
  SIDEBAR_LIST_HEIGHT_KEY,
  SIDEBAR_WIDTH_KEY,
  clampDrawerWidth,
  clampFormWidth,
  clampSidebarListHeight,
  clampSidebarWidth,
  defaultDrawerWidth,
  loadDrawerWidth,
  loadFormWidth,
  loadSidebarListHeight,
  loadSidebarWidth,
  saveDrawerWidth,
  saveFormWidth,
  saveSidebarListHeight,
  saveSidebarWidth,
} from "../src/client/sidebar-panes.ts";
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

// 寸法は sessionStorage + localStorage の 2 段に書かれる (storage.ts) ので、
// 窓を開き直したのと同じ状態にするには両方を差し替える。
beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
  (globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage = new MemStorage();
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
  // kawaz r273 m26: 縦積みはフォームが上・一覧が下。一覧は「今どの
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
});

// 横並びのときの 2 段の幅。一覧は #sidebar-pane-splitter、フォームは
// サイドバー右端の #sidebar-splitter が動かす。
describe("clampSidebarWidth / clampFormWidth", () => {
  test("範囲内はそのまま", () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampFormWidth(500)).toBe(500);
  });

  // 快適さ由来の下限は持たず、掴み直せる太さだけ残す。
  test("潰れる手前まで狭められる", () => {
    expect(clampFormWidth(40, 1200)).toBe(40);
    expect(clampFormWidth(-200, 1200)).toBe(PANE_MIN_PX);
    expect(clampSidebarWidth(-200, 1200)).toBe(PANE_MIN_PX);
  });

  // 上限は固定 px ではなく、右のペインが潰れる手前。
  test("上限は残り幅 − PANE_MIN_PX", () => {
    expect(clampFormWidth(5000, 1200)).toBe(1200 - PANE_MIN_PX);
    expect(clampSidebarWidth(5000, 1200)).toBe(1200 - PANE_MIN_PX);
  });

  // 復元経路は残り幅を知らないので下限のみ。
  test("残り幅なしなら上限なし", () => {
    expect(clampFormWidth(5000)).toBe(5000);
  });

  // localStorage に数値でない値が入っていた / ドラッグ中に要素が消えた等。
  test("数値でなければ既定", () => {
    expect(clampFormWidth(Number.NaN)).toBe(FORM_DEFAULT_PX);
    expect(clampFormWidth(Number.POSITIVE_INFINITY)).toBe(FORM_DEFAULT_PX);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_PX);
  });

  // 既定幅は cwd 確定表示に要る 422px を満たす
  // (docs/findings/2026-08-12-form-ux-width-survey.md)。
  test("フォームの既定幅は cwd 表示の所要幅を満たす", () => {
    expect(FORM_DEFAULT_PX).toBeGreaterThanOrEqual(422);
  });

  test("保存値を復元する", () => {
    saveSidebarWidth(320);
    saveFormWidth(510);
    expect(loadSidebarWidth()).toBe(320);
    expect(loadFormWidth()).toBe(510);
  });

  test("未保存なら既定", () => {
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_PX);
    expect(loadFormWidth()).toBe(FORM_DEFAULT_PX);
  });
});

// 本命: 同じ 2 段でも軸が変われば測っているものが違う。1 本の splitter が
// 軸で別のキーを書くので、4 つが互いに衝突しないことを形として押さえる。
describe("寸法のキー", () => {
  test("4 つの寸法はすべて別のキー", () => {
    const keys = [SIDEBAR_WIDTH_KEY, FORM_WIDTH_KEY, SIDEBAR_LIST_HEIGHT_KEY, DRAWER_WIDTH_KEY];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
