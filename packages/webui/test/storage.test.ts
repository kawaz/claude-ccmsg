// 置き場の 3 分類 (storage.ts のヘッダの表)。ここで押さえるのは 2 段目の
// レイアウト寸法 — 「窓ごとに独立して動かせる」と「次に開く窓は最後に使った
// 値で始まる」を同時に満たす読み書きになっているか。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  readLayoutStorage,
  readSessionStorage,
  readStorage,
  writeLayoutStorage,
  writeSessionStorage,
  writeStorage,
} from "../src/client/storage.ts";
import { MemStorage, stubGlobal } from "./helpers.ts";

let restores: Array<() => void> = [];

/** 新しい窓を開く = sessionStorage だけが空になり、localStorage は残る。 */
function openNewWindow(): void {
  globalThis.sessionStorage = new MemStorage();
}

beforeEach(() => {
  restores = [
    stubGlobal("localStorage", new MemStorage()),
    stubGlobal("sessionStorage", new MemStorage()),
  ];
});

afterEach(() => {
  for (const restore of restores.reverse()) restore();
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
