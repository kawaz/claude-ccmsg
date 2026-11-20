// 浮いている層 (FAB の入力パネル、modal dialog) で始まったスワイプがページへ
// 渡らないこと、と、ページ自体がスクロールしないことを固定する
// (docs/findings/2026-11-21-ios-floating-input-scroll-chaining.md)。
// - 判定 (boxTakesPan / panStaysInLayer): 層の中にその向きへ動ける箱があれば
//   ブラウザに任せ、無ければ止める。止める側だけでなく、任せる側 (中が
//   スクロールできる textarea、層の外のタッチ、2 本指) も固定する
// - 配線: 入力パネルと ModalDialog の上の受け手の無いスワイプの touchmove が
//   既定動作を止められる
// - CSS: 文書はスクロールせず跳ねない、層の子孫は overscroll-behavior: contain
// iOS の実機でキーボードを出した時にページが動かないことは、headless では
// 再現できない (キーボードが出ない) ので findings の手順で人が見る。
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { ModalDialog } from "../src/client/components/ModalDialog.tsx";
import { SessionInputComposer } from "../src/client/components/SessionInputComposer.tsx";
import { resetSessionInputPageState } from "../src/client/components/session-input-store.ts";
import { initialState } from "../src/client/store.ts";
import {
  boxTakesPan,
  type PanBox,
  panStaysInLayer,
  useContainTouchPan,
} from "../src/client/useContainTouchPan.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { Mounted, SID } from "./timeline-harness.ts";

withDom();

/** 縦に 100px の窓、中身 300px の箱を `scrollTop` だけ動かしたもの。 */
function tallBox(scrollTop: number): PanBox {
  return {
    scrollTop,
    scrollLeft: 0,
    scrollHeight: 300,
    scrollWidth: 100,
    clientHeight: 100,
    clientWidth: 100,
  };
}

describe("boxTakesPan", () => {
  test("a finger moving up scrolls toward the end, down toward the start", () => {
    expect(boxTakesPan(tallBox(0), true, "y", -10)).toBe(true);
    expect(boxTakesPan(tallBox(0), true, "y", 10)).toBe(false);
    expect(boxTakesPan(tallBox(200), true, "y", -10)).toBe(false);
    expect(boxTakesPan(tallBox(200), true, "y", 10)).toBe(true);
    expect(boxTakesPan(tallBox(100), true, "y", -10)).toBe(true);
    expect(boxTakesPan(tallBox(100), true, "y", 10)).toBe(true);
  });

  test("a box whose content fits takes no pan either way", () => {
    const fits = { ...tallBox(0), scrollHeight: 100 };
    expect(boxTakesPan(fits, true, "y", -10)).toBe(false);
    expect(boxTakesPan(fits, true, "y", 10)).toBe(false);
  });

  test("less than 1px left to the edge counts as at the edge", () => {
    expect(boxTakesPan(tallBox(199.5), true, "y", -10)).toBe(false);
    expect(boxTakesPan(tallBox(0.5), true, "y", 10)).toBe(false);
  });

  test("a box the person may not scroll (overflow hidden / visible) takes none", () => {
    expect(boxTakesPan(tallBox(100), false, "y", -10)).toBe(false);
  });

  test("the x axis reads the horizontal sizes", () => {
    const wide = { ...tallBox(0), scrollWidth: 300, scrollLeft: 0 };
    expect(boxTakesPan(wide, true, "x", -10)).toBe(true);
    expect(boxTakesPan(wide, true, "x", 10)).toBe(false);
  });
});

/** happy-dom does no layout: give an element the sizes a browser would. */
function setSizes(el: HTMLElement, box: PanBox): void {
  for (const [name, value] of Object.entries(box)) {
    Object.defineProperty(el, name, { configurable: true, value });
  }
}

/** 層 (div) の中に textarea を 1 つ置いたもの。textarea は overflow-y: auto。 */
function layerWithTextarea(): { layer: HTMLDivElement; area: HTMLTextAreaElement } {
  const layer = document.createElement("div");
  const area = document.createElement("textarea");
  area.style.overflowY = "auto";
  layer.append(area);
  document.body.append(layer);
  return { layer, area };
}

describe("panStaysInLayer", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("a textarea whose content fits leaves the swipe to nothing in the layer", () => {
    const { layer, area } = layerWithTextarea();
    setSizes(area, { ...tallBox(0), scrollHeight: 100 });
    expect(panStaysInLayer(area, layer, 0, -30)).toBe(false);
    expect(panStaysInLayer(area, layer, 0, 30)).toBe(false);
  });

  test("a textarea that can scroll that way takes the swipe", () => {
    const { layer, area } = layerWithTextarea();
    setSizes(area, tallBox(100));
    expect(panStaysInLayer(area, layer, 0, -30)).toBe(true);
    expect(panStaysInLayer(area, layer, 0, 30)).toBe(true);
  });

  test("a textarea at its end does not take a swipe further toward the end", () => {
    const { layer, area } = layerWithTextarea();
    setSizes(area, tallBox(200));
    expect(panStaysInLayer(area, layer, 0, -30)).toBe(false);
    expect(panStaysInLayer(area, layer, 0, 30)).toBe(true);
  });

  test("a box between the target and the layer that can scroll takes it", () => {
    const { layer, area } = layerWithTextarea();
    setSizes(area, { ...tallBox(0), scrollHeight: 100 });
    const body = document.createElement("div");
    body.style.overflowY = "auto";
    layer.append(body);
    body.append(area);
    setSizes(body, tallBox(0));
    expect(panStaysInLayer(area, layer, 0, -30)).toBe(true);
  });

  test("a box above the layer is not asked: the page is what is kept still", () => {
    const { layer, area } = layerWithTextarea();
    setSizes(area, { ...tallBox(0), scrollHeight: 100 });
    const page = document.createElement("div");
    page.style.overflowY = "auto";
    document.body.append(page);
    page.append(layer);
    setSizes(page, tallBox(100));
    expect(panStaysInLayer(area, layer, 0, -30)).toBe(false);
  });

  test("the main axis of the move decides which way is asked", () => {
    const { layer, area } = layerWithTextarea();
    area.style.overflowX = "auto";
    setSizes(area, { ...tallBox(0), scrollHeight: 100, scrollWidth: 300 });
    expect(panStaysInLayer(area, layer, -30, -5)).toBe(true);
    expect(panStaysInLayer(area, layer, -5, -30)).toBe(false);
  });
});

function touchAt(target: EventTarget, x: number, y: number): Touch {
  return new Touch({ identifier: 1, target, clientX: x, clientY: y });
}

/** `target` の上で 1 本指を (0, 100) に置き、(0, 100 + dy) へ動かす。最初の
 * touchmove が既定動作を止められたかを返す。 */
function swipe(target: EventTarget, dy: number, fingers = 1): boolean {
  const at = (y: number): Touch[] =>
    Array.from(
      { length: fingers },
      (_, i) => new Touch({ identifier: i + 1, target, clientX: i * 40, clientY: y }),
    );
  target.dispatchEvent(
    new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: at(100) }),
  );
  const move = new TouchEvent("touchmove", {
    bubbles: true,
    cancelable: true,
    touches: at(100 + dy),
  });
  target.dispatchEvent(move);
  target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true }));
  return move.defaultPrevented;
}

describe("useContainTouchPan", () => {
  let root: HTMLElement | null = null;
  afterEach(async () => {
    if (root !== null) {
      const r = root;
      await act(() => render(null, r));
      r.remove();
      root = null;
    }
  });

  function Layer({ active }: { active: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useContainTouchPan(ref, active);
    return h("div", { ref, class: "layer" }, h("textarea", { style: "overflow-y: auto" }));
  }

  async function mount(active: boolean): Promise<{ layer: HTMLElement; area: HTMLElement }> {
    const r = document.createElement("div");
    document.body.append(r);
    root = r;
    await act(() => render(h(Layer, { active }), r));
    return {
      layer: instanceOf(r.querySelector(".layer"), HTMLElement, "the layer"),
      area: instanceOf(r.querySelector("textarea"), HTMLTextAreaElement, "the textarea"),
    };
  }

  test("a swipe no box in the layer takes is stopped", async () => {
    const { area } = await mount(true);
    setSizes(area, { ...tallBox(0), scrollHeight: 100 });
    expect(swipe(area, -30)).toBe(true);
    expect(swipe(area, 30)).toBe(true);
  });

  test("a swipe the textarea takes is left to the browser", async () => {
    const { area } = await mount(true);
    setSizes(area, tallBox(100));
    expect(swipe(area, -30)).toBe(false);
  });

  test("the decision on the first move holds to the end of the gesture", async () => {
    const { area } = await mount(true);
    setSizes(area, tallBox(0));
    area.dispatchEvent(
      new TouchEvent("touchstart", { bubbles: true, touches: [touchAt(area, 0, 100)] }),
    );
    const first = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [touchAt(area, 0, 90)],
    });
    area.dispatchEvent(first);
    // the textarea reached its end while the browser scrolled it
    setSizes(area, tallBox(200));
    const later = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [touchAt(area, 0, 60)],
    });
    area.dispatchEvent(later);
    expect(first.defaultPrevented).toBe(false);
    expect(later.defaultPrevented).toBe(false);
  });

  test("two fingers (a pinch) are never stopped", async () => {
    const { area } = await mount(true);
    setSizes(area, { ...tallBox(0), scrollHeight: 100 });
    expect(swipe(area, -30, 2)).toBe(false);
  });

  test("while not active, nothing is stopped", async () => {
    const { area } = await mount(false);
    setSizes(area, { ...tallBox(0), scrollHeight: 100 });
    expect(swipe(area, -30)).toBe(false);
  });

  test("a touch outside the layer is not looked at", async () => {
    await mount(true);
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(swipe(outside, -30)).toBe(false);
    outside.remove();
  });
});

describe("the floating layers stop a swipe nothing in them takes", () => {
  const mounted = new Mounted();
  let restores: Array<() => void> = [];
  afterEach(async () => {
    await mounted.unmount();
    for (const restore of restores.reverse()) restore();
    restores = [];
  });

  test("the session input panel", async () => {
    resetSessionInputPageState();
    restores = [stubGlobal("localStorage", new MemStorage())];
    const store = createStore(initialState());
    const ws = createWsClient((action) => store.dispatch(action));
    const r = await mounted.mount(store, ws, h(SessionInputComposer, { sid: SID }));
    const fab = instanceOf(r.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
    await act(() => fab.click());
    const area = instanceOf(
      r.querySelector(".session-input-panel textarea"),
      HTMLTextAreaElement,
      "the panel's textarea",
    );
    setSizes(area, { ...tallBox(0), scrollHeight: 100 });
    expect(swipe(area, -30)).toBe(true);
    // app.css gives it overflow-y: auto; this describe does not load app.css
    area.style.overflowY = "auto";
    setSizes(area, tallBox(100));
    expect(swipe(area, -30)).toBe(false);
  });

  test("a modal dialog", async () => {
    const r = document.createElement("div");
    document.body.append(r);
    await act(() =>
      render(
        h(ModalDialog, {
          title: "t",
          closable: true,
          onClose: () => {},
          children: h("textarea", {}),
        }),
        r,
      ),
    );
    const area = defined(r.querySelector("dialog textarea"), "the dialog's textarea");
    expect(swipe(area, -30)).toBe(true);
    await act(() => render(null, r));
    r.remove();
  });
});

describe("app.css: the page does not scroll, the floating layers contain theirs", () => {
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
