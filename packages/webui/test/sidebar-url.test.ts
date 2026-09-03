// サイドバーのフォームパネルを URL に載せる文法 (sidebar-url.ts)。
// 表は docs/design/webui-url-grammar.md。
import { describe, expect, test } from "bun:test";
import {
  CLOSED_SIDEBAR,
  isPeerSortKey,
  parseSidebarUrl,
  sameSidebarState,
  toggleSidebarPanel,
  withSidebarState,
  type SidebarUrlState,
} from "../src/client/sidebar-url.ts";

describe("parseSidebarUrl", () => {
  test("sb.panel の語彙が開いている panel を決める", () => {
    expect(parseSidebarUrl("?sb.panel=new").panel).toBe("session-creator");
    expect(parseSidebarUrl("?sb.panel=search").panel).toBe("session-search");
    expect(parseSidebarUrl("?sb.panel=room").panel).toBe("room-creator");
  });

  // 未知の語彙は「そんな panel は無い」= 閉じている。将来 panel が増えた URL を
  // 古い webui が開いても、知らないフォームの値だけが宙に浮くことはない。
  test("未知の sb.panel は閉じた状態", () => {
    expect(parseSidebarUrl("?sb.panel=nope")).toEqual(CLOSED_SIDEBAR);
  });

  // 本命: パネルが閉じている URL に、効かないフォーム値だけが残らない。
  test("sb.panel が無ければ他の sb.* は無視される", () => {
    expect(parseSidebarUrl("?sb.template=fork&sb.SESSION_ID=x&sb.search=foo")).toEqual(
      CLOSED_SIDEBAR,
    );
  });

  test("sb.<PARAM> は大文字名だけを拾い、予約キーとは混ざらない", () => {
    const state = parseSidebarUrl(
      "?sb.panel=new&sb.template=fork&sb.SESSION_ID=sid-1&sb.RESUME_AT=u-9&sb.lower=x&sb.Mixed=y",
    );
    expect(state.template).toBe("fork");
    expect(state.params).toEqual({ SESSION_ID: "sid-1", RESUME_AT: "u-9" });
  });

  // ページ固有の query (`/usage?days=`) は別の名前空間で、こちらは触らない。
  test("sb. の付かない query は params に混ざらない", () => {
    expect(parseSidebarUrl("?days=7&sb.panel=search&sb.search=foo")).toEqual({
      panel: "session-search",
      template: null,
      search: "foo",
      params: {},
    });
  });

  // 複数行 PROMPT は %0A で運ぶ (JSON 値を使わない理由でもある)。
  test("複数行の値は URL エンコードのまま往復する", () => {
    expect(parseSidebarUrl("?sb.panel=new&sb.PROMPT=a%0Ab").params.PROMPT).toBe("a\nb");
  });

  // 壊れたエスケープを含む URL でフォームを中途半端に開かない。
  test("壊れた percent エスケープは閉じた状態", () => {
    expect(parseSidebarUrl("?sb.panel=new&sb.CWD=%zz")).toEqual(CLOSED_SIDEBAR);
  });
});

describe("withSidebarState / round-trip", () => {
  const opened: SidebarUrlState = {
    panel: "session-creator",
    template: "fork",
    search: null,
    params: { SESSION_ID: "sid-1", RESUME_AT: "u-9", PROMPT: "a\nb" },
  };

  test("組み立てた URL を読み戻すと同じ状態になる", () => {
    const url = withSidebarState("/s/sid-1/timeline/head", opened);
    expect(parseSidebarUrl(new URL(url, "http://x").search)).toEqual(opened);
  });

  test("path とページ固有 query は素通しで、sb.* だけが差し替わる", () => {
    const url = withSidebarState("/usage/stats/daily?days=7&sb.panel=search", opened);
    expect(url.startsWith("/usage/stats/daily?")).toBe(true);
    expect(new URL(url, "http://x").searchParams.get("days")).toBe("7");
    expect(parseSidebarUrl(new URL(url, "http://x").search)).toEqual(opened);
  });

  test("閉じた状態を書けば sb.* が消える (ページ固有 query は残る)", () => {
    expect(withSidebarState("/usage/stats/daily?days=7&sb.panel=new", CLOSED_SIDEBAR)).toBe(
      "/usage/stats/daily?days=7",
    );
    expect(withSidebarState("/r/room-1?sb.panel=room", CLOSED_SIDEBAR)).toBe("/r/room-1");
  });

  // 同じ状態が常に同じ文字列になる (params は名前順)。
  test("params の並びは入力順に依存しない", () => {
    const a = withSidebarState("/x", { ...opened, params: { B: "2", A: "1" } });
    const b = withSidebarState("/x", { ...opened, params: { A: "1", B: "2" } });
    expect(a).toBe(b);
  });
});

describe("toggleSidebarPanel", () => {
  const search: SidebarUrlState = { ...CLOSED_SIDEBAR, panel: "session-search", search: "foo" };

  test("開いていなければ開き、同じものを押せば閉じる", () => {
    expect(toggleSidebarPanel(CLOSED_SIDEBAR, "session-search").panel).toBe("session-search");
    expect(toggleSidebarPanel(search, "session-search")).toEqual(CLOSED_SIDEBAR);
  });

  // ROOMS / SESSIONS のどちらの toggle でも、開いていた別 panel は閉じる。
  test("別の panel を押すと入れ替わる (section をまたいでも排他)", () => {
    expect(toggleSidebarPanel(search, "room-creator").panel).toBe("room-creator");
  });

  // 本命の regression: fork で開いた launcher を閉じて「+ 新規」で開き直しても
  // 前の fork 元 (と、そこから入る cwd/model/effort) を引き継がない。
  test("トグルで開く panel は前の sb.* を持たない", () => {
    const forked: SidebarUrlState = {
      panel: "session-creator",
      template: "fork",
      search: null,
      params: { SESSION_ID: "sid-1", RESUME_AT: "u-9" },
    };
    const closed = toggleSidebarPanel(forked, "session-creator");
    expect(closed).toEqual(CLOSED_SIDEBAR);
    expect(toggleSidebarPanel(closed, "session-creator")).toEqual({
      panel: "session-creator",
      template: null,
      search: null,
      params: {},
    });
  });
});

describe("sameSidebarState", () => {
  // 同値なら store が参照を据え置く = フォームの seed をやり直さない。
  test("値が同じなら true (別インスタンスでも)", () => {
    expect(
      sameSidebarState(parseSidebarUrl("?sb.panel=new&sb.CWD=/a"), {
        panel: "session-creator",
        template: null,
        search: null,
        params: { CWD: "/a" },
      }),
    ).toBe(true);
  });

  test("params が 1 つでも違えば false", () => {
    expect(
      sameSidebarState(
        parseSidebarUrl("?sb.panel=new&sb.CWD=/a"),
        parseSidebarUrl("?sb.panel=new"),
      ),
    ).toBe(false);
    expect(
      sameSidebarState(
        parseSidebarUrl("?sb.panel=new&sb.CWD=/a"),
        parseSidebarUrl("?sb.panel=new&sb.CWD=/b"),
      ),
    ).toBe(false);
  });
});

describe("isPeerSortKey", () => {
  test("保存された値が語彙外なら採用しない", () => {
    expect(isPeerSortKey("name")).toBe(true);
    expect(isPeerSortKey("bogus")).toBe(false);
    expect(isPeerSortKey(null)).toBe(false);
  });
});
