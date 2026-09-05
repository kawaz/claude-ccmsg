// 置き場の 3 分類 (storage.ts のヘッダの表)。ここで押さえるのは 2 段目の
// レイアウト寸法 — 「窓ごとに独立して動かせる」と「次に開く窓は最後に使った
// 値で始まる」を同時に満たす読み書きになっているか。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  readLayoutStorage,
  readSessionStorage,
  readStorage,
  writeLayoutStorage,
  writeSessionStorage,
  writeStorage,
} from "../src/client/storage.ts";

// files-view-store.test.ts と同じ最小 storage shim を 2 面ぶん。
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

/** 新しい窓を開く = sessionStorage だけが空になり、localStorage は残る。 */
function openNewWindow(): void {
  (globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage = new MemStorage();
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
  openNewWindow();
});

describe("readLayoutStorage / writeLayoutStorage", () => {
  test("書くと両方に載る", () => {
    writeLayoutStorage("ccmsg.sidebarWidth", "360");
    expect(readSessionStorage("ccmsg.sidebarWidth")).toBe("360");
    expect(readStorage("ccmsg.sidebarWidth")).toBe("360");
  });

  // その窓で動かしていなければ、最後にどこかの窓で使った値が初期値になる。
  test("この窓で動かしていなければ localStorage の値を引く", () => {
    writeStorage("ccmsg.sidebarWidth", "500");
    expect(readLayoutStorage("ccmsg.sidebarWidth")).toBe("500");
  });

  // 動かした後はその窓の値が答える = 別の窓が後から書いても引きずられない。
  test("この窓で動かしたらそちらが勝つ", () => {
    writeLayoutStorage("ccmsg.sidebarWidth", "360");
    writeStorage("ccmsg.sidebarWidth", "500"); // 別の窓が書いた
    expect(readLayoutStorage("ccmsg.sidebarWidth")).toBe("360");
  });

  test("どちらにも無ければ null (= 呼び出し側の既定)", () => {
    expect(readLayoutStorage("ccmsg.sidebarWidth")).toBeNull();
  });

  // 2 つの要求が同時に立つことの確認: 窓 A で広げた値は窓 A の中では動かず、
  // 新しく開いた窓 B の初期値にもなる。
  test("窓ごとに独立しつつ、次の窓の初期値になる", () => {
    writeLayoutStorage("ccmsg.formPaneWidth", "600");
    openNewWindow();
    expect(readLayoutStorage("ccmsg.formPaneWidth")).toBe("600");
    writeLayoutStorage("ccmsg.formPaneWidth", "300");
    expect(readLayoutStorage("ccmsg.formPaneWidth")).toBe("300");
  });
});

// 1 段目: 窓ごとの状態。消してある状態が他の窓や次のタブに伝染しない。
describe("readSessionStorage / writeSessionStorage", () => {
  test("localStorage には載らない", () => {
    writeSessionStorage("ccmsg.sidebarOpen", "false");
    expect(readSessionStorage("ccmsg.sidebarOpen")).toBe("false");
    expect(readStorage("ccmsg.sidebarOpen")).toBeNull();
  });

  test("新しい窓では消えている", () => {
    writeSessionStorage("ccmsg.sidebarOpen", "false");
    openNewWindow();
    expect(readSessionStorage("ccmsg.sidebarOpen")).toBeNull();
  });
});
