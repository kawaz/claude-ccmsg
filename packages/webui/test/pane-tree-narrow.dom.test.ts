// 何を保証するか (DR-0025、kawaz 2026-11-24): スマホの幅 (app.css の 720px の境の
// 内側) で開いた窓では、Timeline のエージェントのリストは既定で無い。Files の
// ツリーは「在る」のまま。覚えた値 (☰ で書いた sessionStorage) があればそれに
// 従い、読めない値は覚えた値が無いのと同じ。境は app.css の @media が持つので、
// app.css をそのまま読み込み、窓を 390×844 で開く (広い幅の既定は
// pane-tree-toggle.dom.test.ts)。
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { initialState } from "../src/client/store.ts";
import { withDom } from "./dom.ts";

withDom({ width: 390, height: 844 });

const TIMELINE_KEY = "ccmsg.timelineTreeOpen";
const FILES_KEY = "ccmsg.filesTreeOpen";
let style: HTMLStyleElement | null = null;

beforeAll(async () => {
  style = document.createElement("style");
  style.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
  document.head.append(style);
});
afterAll(() => {
  style?.remove();
  style = null;
});
beforeEach(() => {
  sessionStorage.removeItem(TIMELINE_KEY);
  sessionStorage.removeItem(FILES_KEY);
});

test("with nothing stored, the agent list is hidden and the Files tree is there", () => {
  expect(window.innerWidth).toBe(390);
  expect(initialState().paneTreesOpen).toEqual({ timeline: false, files: true });
});

test("what this window stored wins over the width", () => {
  sessionStorage.setItem(TIMELINE_KEY, "1");
  expect(initialState().paneTreesOpen.timeline).toBe(true);
  sessionStorage.setItem(TIMELINE_KEY, "0");
  expect(initialState().paneTreesOpen.timeline).toBe(false);
});

test("a value that does not read is as if nothing were stored", () => {
  sessionStorage.setItem(TIMELINE_KEY, "garbage");
  expect(initialState().paneTreesOpen.timeline).toBe(false);
});
