// Timeline の項目の中で始まった選択を、その項目の外へ広げないための状態
// (useSelectionContainment.ts)。選択の端をどこに置けるかはブラウザが
// user-select で決めるので、ここで固定するのは「どの項目を選択可能に残すか」
// と「いつ閉じ込めを外すか」:
// - 始点からの項目の決め方 (コード (塊・inline code) > 吹き出しの本文 > thinking >
//   吹き出しの外の発言)
// - 項目の外を押す / 押していない間に選択が畳まれると外れる
// - drag 中 (押している間) の一時的な畳み込みでは外れない
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CONTAINED_ATTR,
  HOST_ATTR,
  installSelectionContainment,
  selectionHostOf,
  useSelectionContainment,
} from "../src/client/components/timeline/useSelectionContainment.ts";
import { withDom } from "./dom.ts";
import { defined } from "./helpers.ts";
import { renderHook } from "./render-hook.ts";

withDom();

let tl: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <p id="outside">outside text</p>
    <div class="timeline-view">
      <details open class="tl-fold"><summary id="summary">thinking</summary>
        <div class="tl-thinking-body"><p id="thinking">thought</p></div>
      </details>
      <div class="tl-text tl-text-assistant"><p id="fold-text">fold text</p></div>
      <div class="tl-bubble tl-bubble-left">
        <div class="tl-bubble-body">
          <div class="tl-text tl-text-assistant">
            <p id="prose">prose <code class="md-inline-code" id="inline">x = 1</code> tail</p>
            <pre id="code"><code id="code-inner">let x = 1;</code></pre>
          </div>
          <div class="tl-text tl-text-assistant"><p id="prose2">second</p></div>
        </div>
      </div>
    </div>`;
  tl = defined(document.querySelector<HTMLElement>(".timeline-view"), "timeline root");
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

function byId(id: string): HTMLElement {
  return defined(document.getElementById(id), `#${id}`);
}

function textOf(id: string): Text {
  const node = byId(id).firstChild;
  if (!(node instanceof Text)) throw new Error(`#${id} has no text`);
  return node;
}

describe("selectionHostOf: 始点から閉じ込める項目", () => {
  test("コードの中で始まればそのコード (吹き出しの中でも)", () => {
    expect(selectionHostOf(textOf("code-inner"))).toBe(byId("code"));
  });

  // inline code の中から始めた選択はその code に閉じ込め、code の外 (同じ段落)
  // から始めた選択は code を含めて本文を選べる。
  test("inline code の中で始まればその code、外で始まれば本文", () => {
    expect(selectionHostOf(textOf("inline"))).toBe(byId("inline"));
    const body = defined(tl.querySelector(".tl-bubble-body"), "bubble body");
    expect(selectionHostOf(textOf("prose"))).toBe(body);
  });

  test("吹き出しの本文で始まれば本文全体 (segment をまたいで選べる)", () => {
    const body = defined(tl.querySelector(".tl-bubble-body"), "bubble body");
    expect(selectionHostOf(textOf("prose"))).toBe(body);
    expect(selectionHostOf(textOf("prose2"))).toBe(body);
  });

  test("thinking の本文", () => {
    const body = defined(tl.querySelector(".tl-thinking-body"), "thinking body");
    expect(selectionHostOf(textOf("thinking"))).toBe(body);
  });

  test("吹き出しの外の発言はその発言", () => {
    expect(selectionHostOf(textOf("fold-text"))).toBe(byId("fold-text").parentElement);
  });

  test("項目でない場所 (fold の見出し) と Timeline の外は閉じ込めない", () => {
    expect(selectionHostOf(textOf("summary"))).toBeNull();
    expect(selectionHostOf(textOf("outside"))).toBeNull();
  });
});

describe("installSelectionContainment", () => {
  let uninstall: () => void = () => {};
  afterEach(() => uninstall());

  function contained(): boolean {
    return document.documentElement.hasAttribute(CONTAINED_ATTR);
  }
  function selectStart(target: Node): void {
    target.dispatchEvent(new Event("selectstart", { bubbles: true, cancelable: true }));
  }
  function pointer(type: "pointerdown" | "pointerup", target: Element): void {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true }));
  }
  /** 項目の中を実際に選んだ状態にする (畳まれていない選択)。 */
  function selectInside(id: string): void {
    const range = document.createRange();
    range.selectNodeContents(byId(id));
    const selection = defined(document.getSelection(), "selection");
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function selectionChange(): void {
    document.dispatchEvent(new Event("selectionchange"));
  }

  test("項目の中で始まった選択はその項目だけを選択可能に残す", () => {
    uninstall = installSelectionContainment(document);
    pointer("pointerdown", byId("code-inner"));
    selectStart(textOf("code-inner"));
    expect(contained()).toBe(true);
    expect(byId("code").hasAttribute(HOST_ATTR)).toBe(true);
    expect(tl.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });

  test("drag 中に選択が一度畳まれても外れず、選択を残して離せば保つ", () => {
    uninstall = installSelectionContainment(document);
    pointer("pointerdown", byId("code-inner"));
    selectStart(textOf("code-inner"));
    // 押した瞬間はキャレット (畳まれた選択) になる。
    document.getSelection()?.removeAllRanges();
    selectionChange();
    expect(contained()).toBe(true);
    selectInside("code-inner");
    pointer("pointerup", byId("code-inner"));
    expect(contained()).toBe(true);
  });

  test("選択を残して離した後、ハンドル等で項目の中を押し直しても保つ", () => {
    uninstall = installSelectionContainment(document);
    pointer("pointerdown", byId("code-inner"));
    selectStart(textOf("code-inner"));
    selectInside("code-inner");
    pointer("pointerup", byId("code-inner"));
    pointer("pointerdown", byId("code-inner"));
    expect(contained()).toBe(true);
  });

  test("項目の外を押すと外れる (別の場所から選び始められる)", () => {
    uninstall = installSelectionContainment(document);
    pointer("pointerdown", byId("code-inner"));
    selectStart(textOf("code-inner"));
    selectInside("code-inner");
    pointer("pointerup", byId("code-inner"));
    pointer("pointerdown", byId("prose"));
    expect(contained()).toBe(false);
    expect(byId("code").hasAttribute(HOST_ATTR)).toBe(false);
  });

  test("何も選ばずに離すと外れる (クリックだけ)", () => {
    uninstall = installSelectionContainment(document);
    pointer("pointerdown", byId("code-inner"));
    selectStart(textOf("code-inner"));
    pointer("pointerup", byId("code-inner"));
    expect(contained()).toBe(false);
  });

  test("押していない間に選択が畳まれると外れる (キー操作・別の入力欄へ移った等)", () => {
    uninstall = installSelectionContainment(document);
    selectStart(textOf("code-inner"));
    selectInside("code-inner");
    selectionChange();
    expect(contained()).toBe(true);
    document.getSelection()?.removeAllRanges();
    selectionChange();
    expect(contained()).toBe(false);
  });

  test("別の項目で始まった選択は閉じ込め先を移し、項目の外で始まった選択は閉じ込めない", () => {
    uninstall = installSelectionContainment(document);
    selectStart(textOf("code-inner"));
    selectStart(textOf("thinking"));
    expect(byId("code").hasAttribute(HOST_ATTR)).toBe(false);
    expect(defined(tl.querySelector(".tl-thinking-body"), "thinking").hasAttribute(HOST_ATTR)).toBe(
      true,
    );
    selectStart(textOf("outside"));
    expect(contained()).toBe(false);
    expect(tl.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(0);
  });

  test("外すと属性も listener も残さない", () => {
    const off = installSelectionContainment(document);
    selectStart(textOf("code-inner"));
    off();
    expect(contained()).toBe(false);
    expect(byId("code").hasAttribute(HOST_ATTR)).toBe(false);
    selectStart(textOf("code-inner"));
    expect(contained()).toBe(false);
  });
});

describe("useSelectionContainment", () => {
  test("Timeline が複数 mount されても 1 つだけ入り、最後の 1 つが外れた時に外れる", async () => {
    const first = await renderHook(() => useSelectionContainment(), undefined);
    const second = await renderHook(() => useSelectionContainment(), undefined);
    const selectStart = () =>
      textOf("code-inner").dispatchEvent(new Event("selectstart", { bubbles: true }));

    selectStart();
    expect(byId("code").hasAttribute(HOST_ATTR)).toBe(true);
    await first.unmount();
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    selectStart();
    // 残った 1 つがまだ効いている。
    expect(document.documentElement.hasAttribute(CONTAINED_ATTR)).toBe(true);
    await second.unmount();
    expect(document.documentElement.hasAttribute(CONTAINED_ATTR)).toBe(false);
    selectStart();
    expect(document.documentElement.hasAttribute(CONTAINED_ATTR)).toBe(false);
  });
});
