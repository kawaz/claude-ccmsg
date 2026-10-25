// サイドバーのフォームパネルを URL に載せる文法 (sidebar-url.ts)。
// 表は docs/design/webui-url-grammar.md。
import { describe, expect, test } from "bun:test";
import {
  CLOSED_SIDEBAR,
  LAUNCH_FORM_FIELDS,
  parsePeerSortKey,
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
  });

  // 未知の語彙は「そんな panel は無い」= 閉じている。将来 panel が増えた URL を
  // 古い webui が開いても、知らないフォームの値だけが宙に浮くことはない。
  test("未知の sb.panel は閉じた状態", () => {
    expect(parseSidebarUrl("?sb.panel=nope")).toEqual(CLOSED_SIDEBAR);
  });

  // 本命: パネルが閉じている URL に、効かないフォーム値だけが残らない。
  test("sb.panel が無ければ他の sb.* は無視される", () => {
    expect(parseSidebarUrl("?sb.type=fork&sb.resume_session_id=x&sb.search=foo")).toEqual(
      CLOSED_SIDEBAR,
    );
  });

  // 欄の名前は起動の入力の field 名だけ。それ以外の名前 (大文字の旧来の
  // 書き方も含む) は、見えない入力として紛れ込まない。
  test("sb.<field> は起動フォームの欄の名前だけを拾う", () => {
    const state = parseSidebarUrl(
      "?sb.panel=new&sb.type=fork&sb.resume_session_id=sid-1&sb.resume_at=u-9&sb.SESSION_ID=x&sb.command=y",
    );
    expect(state.launch).toEqual({ type: "fork", resume_session_id: "sid-1", resume_at: "u-9" });
  });

  test("8 つの欄はどれも URL から読める", () => {
    const query = LAUNCH_FORM_FIELDS.map((field) => `sb.${field}=v-${field}`).join("&");
    const state = parseSidebarUrl(`?sb.panel=new&${query}`);
    expect(Object.keys(state.launch)).toEqual([...LAUNCH_FORM_FIELDS]);
  });

  // ページ固有の query (`/usage?days=`) は別の名前空間で、こちらは触らない。
  test("sb. の付かない query は起動フォームの欄に混ざらない", () => {
    expect(parseSidebarUrl("?days=7&sb.panel=search&sb.search=foo")).toEqual({
      panel: "session-search",
      search: "foo",
      launch: {},
    });
  });

  // 複数行の prompt は %0A で運ぶ (JSON 値を使わない理由でもある)。
  test("複数行の値は URL エンコードのまま往復する", () => {
    expect(parseSidebarUrl("?sb.panel=new&sb.prompt=a%0Ab").launch.prompt).toBe("a\nb");
  });

  // 壊れたエスケープを含む URL でフォームを中途半端に開かない。
  test("壊れた percent エスケープは閉じた状態", () => {
    expect(parseSidebarUrl("?sb.panel=new&sb.cwd=%zz")).toEqual(CLOSED_SIDEBAR);
  });
});

describe("withSidebarState / round-trip", () => {
  const opened: SidebarUrlState = {
    panel: "session-creator",
    search: null,
    launch: { type: "fork", resume_session_id: "sid-1", resume_at: "u-9", prompt: "a\nb" },
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
    expect(withSidebarState("/r/room-1?sb.panel=search", CLOSED_SIDEBAR)).toBe("/r/room-1");
  });

  // 同じ状態が常に同じ文字列になる (欄は LAUNCH_FORM_FIELDS の順)。
  test("欄の並びは入力順に依存しない", () => {
    const a = withSidebarState("/x", { ...opened, launch: { prompt: "p", type: "new" } });
    const b = withSidebarState("/x", { ...opened, launch: { type: "new", prompt: "p" } });
    expect(a).toBe(b);
    expect(a).toBe("/x?sb.panel=new&sb.type=new&sb.prompt=p");
  });
});

describe("toggleSidebarPanel", () => {
  const search: SidebarUrlState = { ...CLOSED_SIDEBAR, panel: "session-search", search: "foo" };

  test("開いていなければ開き、同じものを押せば閉じる", () => {
    expect(toggleSidebarPanel(CLOSED_SIDEBAR, "session-search").panel).toBe("session-search");
    expect(toggleSidebarPanel(search, "session-search")).toEqual(CLOSED_SIDEBAR);
  });

  test("別の panel を押すと入れ替わる (排他)", () => {
    expect(toggleSidebarPanel(search, "session-creator").panel).toBe("session-creator");
  });

  // 本命の regression: fork で開いた launcher を閉じて「+ 新規」で開き直しても
  // 前の fork 元 (と、そこから入る cwd/model/effort) を引き継がない。
  test("トグルで開く panel は前の sb.* を持たない", () => {
    const forked: SidebarUrlState = {
      panel: "session-creator",
      search: null,
      launch: { type: "fork", resume_session_id: "sid-1", resume_at: "u-9" },
    };
    const closed = toggleSidebarPanel(forked, "session-creator");
    expect(closed).toEqual(CLOSED_SIDEBAR);
    expect(toggleSidebarPanel(closed, "session-creator")).toEqual({
      panel: "session-creator",
      search: null,
      launch: {},
    });
  });
});

describe("sameSidebarState", () => {
  // 同値なら store が参照を据え置く = フォームの seed をやり直さない。
  test("値が同じなら true (別インスタンスでも)", () => {
    expect(
      sameSidebarState(parseSidebarUrl("?sb.panel=new&sb.cwd=/a"), {
        panel: "session-creator",
        search: null,
        launch: { cwd: "/a" },
      }),
    ).toBe(true);
  });

  test("欄が 1 つでも違えば false", () => {
    expect(
      sameSidebarState(
        parseSidebarUrl("?sb.panel=new&sb.cwd=/a"),
        parseSidebarUrl("?sb.panel=new"),
      ),
    ).toBe(false);
    expect(
      sameSidebarState(
        parseSidebarUrl("?sb.panel=new&sb.cwd=/a"),
        parseSidebarUrl("?sb.panel=new&sb.cwd=/b"),
      ),
    ).toBe(false);
  });
});

describe("parsePeerSortKey", () => {
  test("保存された値が語彙外・未保存なら既定の prompt", () => {
    expect(parsePeerSortKey("name")).toBe("name");
    expect(parsePeerSortKey("bogus")).toBe("prompt");
    expect(parsePeerSortKey(null)).toBe("prompt");
  });
});
