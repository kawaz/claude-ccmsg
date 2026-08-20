// Sidebar の panel 開閉 (どれが開くか / 開いた launcher が何を持つか)。
import { describe, expect, test } from "bun:test";
import {
  openPrefilledCreator,
  sessionCreatorPrefill,
  toggleSidebarPanel,
} from "../src/client/sidebar-panel.ts";

const PREFILL = { kind: "fork", resumeSid: "sid-1", resumeAt: "u-9" } as const;

describe("toggleSidebarPanel", () => {
  test("何も開いていなければ押した panel が開く", () => {
    expect(toggleSidebarPanel(null, "session-search")).toEqual({ kind: "session-search" });
    expect(toggleSidebarPanel(null, "room-creator")).toEqual({ kind: "room-creator" });
  });

  test("開いている panel をもう一度押すと閉じる", () => {
    expect(toggleSidebarPanel({ kind: "session-search" }, "session-search")).toBeNull();
    expect(
      toggleSidebarPanel({ kind: "session-creator", prefill: null }, "session-creator"),
    ).toBeNull();
  });

  // ROOMS / SESSIONS のどちらの toggle でも、開いていた別 panel は閉じる。
  test("別の panel を押すと入れ替わる (section をまたいでも排他)", () => {
    expect(toggleSidebarPanel({ kind: "session-search" }, "room-creator")).toEqual({
      kind: "room-creator",
    });
    expect(toggleSidebarPanel({ kind: "room-creator" }, "session-search")).toEqual({
      kind: "session-search",
    });
  });

  // 本命の regression: 「+ 新規」で開いた launcher は常に prefill 無し。fork
  // 直後に閉じて開き直しても、前の fork 元 (と、そこから入る
  // cwd/model/effort) を引き継がない。
  test("「+ 新規」で開いた launcher は prefill を持たない", () => {
    expect(toggleSidebarPanel(null, "session-creator")).toEqual({
      kind: "session-creator",
      prefill: null,
    });
    const afterFork = openPrefilledCreator(PREFILL);
    const closed = toggleSidebarPanel(afterFork, "session-creator");
    expect(closed).toBeNull();
    expect(sessionCreatorPrefill(toggleSidebarPanel(closed, "session-creator"))).toBeNull();
  });

  // fork 中に別 panel へ切り替えて launcher に戻る経路でも同じ。
  test("fork の後に別 panel を経由して開き直しても prefill は残らない", () => {
    const viaSearch = toggleSidebarPanel(openPrefilledCreator(PREFILL), "session-search");
    expect(sessionCreatorPrefill(toggleSidebarPanel(viaSearch, "session-creator"))).toBeNull();
  });
});

describe("openPrefilledCreator / sessionCreatorPrefill", () => {
  test("fork 要求は launcher を fork 元ごと開く", () => {
    expect(openPrefilledCreator(PREFILL)).toEqual({ kind: "session-creator", prefill: PREFILL });
    expect(sessionCreatorPrefill(openPrefilledCreator(PREFILL))).toEqual(PREFILL);
  });

  // launcher 以外が開いている / 何も開いていない時に渡すものは無い。
  test("launcher が開いていなければ prefill は null", () => {
    expect(sessionCreatorPrefill(null)).toBeNull();
    expect(sessionCreatorPrefill({ kind: "session-search" })).toBeNull();
    expect(sessionCreatorPrefill({ kind: "room-creator" })).toBeNull();
  });
});
