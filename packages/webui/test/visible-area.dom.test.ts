// 画面 (#app) を、ソフトウェアキーボードを除いた見える範囲に合わせることと、
// ページ自体がスクロールしないことを固定する
// (docs/findings/2026-11-21-ios-floating-input-scroll-chaining.md)。
// - 判定 (visibleAreaOf): 合わせるのはキーボードが出ている時だけ。キーボードが
//   無い時・ピンチで拡大している時は合わせない (CSS の既定のまま)
// - 同期 (followVisibleArea): visual viewport の resize / scroll に追従して
//   :root の custom property を書き換え、止めると外す
// - CSS: #app と dialog が property に従い、無ければ今までの 100dvh / 上端 0。
//   文書はスクロールせず跳ねない、浮いた層の子孫は overscroll-behavior: contain
// 実際の配置 (#app が見える範囲に動き、浮いたパネルがその中に置かれる) は
// レイアウトを計算するエンジンで findings に記録し、キーボードそのものは
// headless で出せないので iPad の実機の手順で人が見る。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  followVisibleArea,
  VISIBLE_BOTTOM,
  VISIBLE_HEIGHT,
  VISIBLE_TOP,
  type ViewportSource,
  visibleAreaOf,
} from "../src/client/visible-area.ts";
import { withDom } from "./dom.ts";
import { defined, stubProperty } from "./helpers.ts";

withDom();

/** 初期包含ブロックの高さ (iPad 11 インチの縦)。 */
const ICB = 1194;

describe("visibleAreaOf", () => {
  test("without the keyboard the screen is left as it is", () => {
    expect(visibleAreaOf({ offsetTop: 0, height: ICB, scale: 1 }, ICB)).toBeNull();
  });

  test("the keyboard up at the top of the page: the area above it", () => {
    expect(visibleAreaOf({ offsetTop: 0, height: 790, scale: 1 }, ICB)).toEqual({
      top: 0,
      height: 790,
      bottom: 404,
    });
  });

  // iOS が入力欄を見せるために見える範囲を下へずらした後。上端は offsetTop、
  // 下端からキーボードの分 (bottom) は ICB − (offsetTop + height)。
  test("the visible area moved down to show the input: its top follows", () => {
    expect(visibleAreaOf({ offsetTop: 337, height: 377, scale: 1 }, 714)).toEqual({
      top: 337,
      height: 377,
      bottom: 0,
    });
    expect(visibleAreaOf({ offsetTop: 100, height: 790, scale: 1 }, ICB)).toEqual({
      top: 100,
      height: 790,
      bottom: 304,
    });
  });

  test("pinch-zoomed, the screen is not refitted (it would re-lay out at every zoom)", () => {
    expect(visibleAreaOf({ offsetTop: 200, height: 597, scale: 2 }, ICB)).toBeNull();
    expect(visibleAreaOf({ offsetTop: 0, height: 790, scale: 1.5 }, ICB)).toBeNull();
  });

  test("a difference under 1px is rounding, not the keyboard", () => {
    expect(visibleAreaOf({ offsetTop: 0.2, height: ICB - 0.4, scale: 1 }, ICB)).toBeNull();
  });

  test("a visible area taller than the containing block is not a keyboard", () => {
    expect(visibleAreaOf({ offsetTop: 0, height: ICB + 50, scale: 1 }, ICB)).toBeNull();
  });
});

interface FakeViewport extends ViewportSource {
  /** Moves to the given place and tells it the way the browser does. */
  move(type: "resize" | "scroll", to: { offsetTop?: number; height?: number }): void;
}

/** A visual viewport with the keyboard down. Made inside a test: its
 * EventTarget has to be the DOM's (registered by withDom), the one its events
 * come from. */
function fakeViewport(): FakeViewport {
  class Fake extends EventTarget implements FakeViewport {
    offsetTop = 0;
    height = ICB;
    scale = 1;
    move(type: "resize" | "scroll", to: { offsetTop?: number; height?: number }): void {
      this.offsetTop = to.offsetTop ?? this.offsetTop;
      this.height = to.height ?? this.height;
      this.dispatchEvent(new Event(type));
    }
  }
  return new Fake();
}

describe("followVisibleArea", () => {
  let root: HTMLElement;
  let restore = (): void => {};
  beforeEach(() => {
    root = document.createElement("div");
    restore = stubProperty(root, "clientHeight", { configurable: true, get: () => ICB });
  });
  afterEach(() => {
    restore();
  });

  function written(): [string, string, string] {
    return [
      root.style.getPropertyValue(VISIBLE_TOP),
      root.style.getPropertyValue(VISIBLE_HEIGHT),
      root.style.getPropertyValue(VISIBLE_BOTTOM),
    ];
  }

  test("writes nothing while the keyboard is down", () => {
    const vv = fakeViewport();
    const stop = followVisibleArea(vv, root);
    expect(written()).toEqual(["", "", ""]);
    stop();
  });

  test("follows the keyboard coming up, the area moving, and the keyboard going", () => {
    const vv = fakeViewport();
    const stop = followVisibleArea(vv, root);
    vv.move("resize", { height: 790 });
    expect(written()).toEqual(["0px", "790px", "404px"]);
    vv.move("scroll", { offsetTop: 120 });
    expect(written()).toEqual(["120px", "790px", "284px"]);
    vv.move("resize", { offsetTop: 0, height: ICB });
    expect(written()).toEqual(["", "", ""]);
    stop();
  });

  test("the keyboard already up when it starts is taken at once", () => {
    const vv = fakeViewport();
    vv.height = 700;
    vv.offsetTop = 30;
    const stop = followVisibleArea(vv, root);
    expect(written()).toEqual(["30px", "700px", "464px"]);
    stop();
  });

  test("stopping takes the properties away and no longer listens", () => {
    const vv = fakeViewport();
    const stop = followVisibleArea(vv, root);
    vv.move("resize", { height: 790 });
    stop();
    expect(written()).toEqual(["", "", ""]);
    vv.move("resize", { height: 600 });
    expect(written()).toEqual(["", "", ""]);
  });
});

describe("app.css", () => {
  let sheet: HTMLStyleElement | null = null;
  beforeAll(async () => {
    sheet = document.createElement("style");
    sheet.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    document.head.append(sheet);
  });
  afterAll(() => {
    sheet?.remove();
    sheet = null;
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  /** The declared value of `prop` in the first rule whose selector is exactly
   * `selector` (happy-dom does not resolve var() fallbacks, so the rule's own
   * text is what is checked; engines that lay out are in the findings). */
  function declared(selector: string, prop: string): string {
    const s = defined(sheet?.sheet, "the stylesheet");
    for (const rule of s.cssRules) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
        const value = rule.style.getPropertyValue(prop);
        if (value !== "") return value;
      }
    }
    throw new Error(`no ${prop} on ${selector}`);
  }

  test("#app sits in the visible area, the screen's when the keyboard is down", () => {
    expect(declared("#app", "position")).toBe("fixed");
    expect(declared("#app", "top")).toBe("var(--visible-top, 0px)");
    expect(declared("#app", "height")).toBe("var(--visible-height, 100dvh)");
  });

  // 浮いているパネル・FAB 等 (position: fixed) が #app の中に置かれ、
  // キーボードが出ればその上に来るための基準。
  test("#app is what the fixed things in it are placed against", () => {
    expect(declared("#app", "contain")).toBe("layout");
  });

  test("a dialog keeps to the visible area, the UA's inset 0 when the keyboard is down", () => {
    expect(declared(".modal-dialog", "inset-block")).toBe(
      "var(--visible-top, 0px) var(--visible-bottom, 0px)",
    );
    expect(declared(".modal-dialog", "max-height")).toBe(
      "calc(var(--visible-height, 100dvh) - 4rem)",
    );
  });

  test("the document neither scrolls nor bounces", () => {
    const html = getComputedStyle(document.documentElement);
    expect(html.overflow).toBe("hidden");
    expect(html.getPropertyValue("overscroll-behavior")).toBe("none");
  });

  test("everything in the input panel and in a modal dialog contains its overscroll", () => {
    document.body.innerHTML =
      '<div class="session-input-panel"><textarea></textarea><div><pre></pre></div></div>' +
      '<dialog class="modal-dialog"><div class="modal-dialog-body"><textarea></textarea></div></dialog>';
    const inLayers = document.body.querySelectorAll(
      ".session-input-panel, .session-input-panel *, .modal-dialog, .modal-dialog *",
    );
    expect(inLayers.length).toBe(7);
    for (const el of inLayers) {
      expect(
        `${el.tagName}.${el.className}: ${getComputedStyle(el).getPropertyValue("overscroll-behavior")}`,
      ).toBe(`${el.tagName}.${el.className}: contain`);
    }
  });

  // 逆向き: 層の外の要素に縦の contain を敷いていない (ページの中のスクロール
  // 領域は端で止まるだけで、層の規則が全体に漏れていない)。
  test("an element outside the layers keeps the default", () => {
    document.body.innerHTML = '<div class="outside"><textarea></textarea></div>';
    const area = defined(document.body.querySelector(".outside textarea"), "the textarea");
    expect(getComputedStyle(area).getPropertyValue("overscroll-behavior")).not.toBe("contain");
  });
});
