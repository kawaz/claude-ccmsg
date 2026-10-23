// コードに添えるコピーボタン (CodeCopyFrame.tsx)。押すとコードの文字列が
// そのままクリップボードへ入り、成功した時だけ印が付く。ボタンの文字は DOM に
// 置かない — コードは Timeline の検索単位と本文の選択範囲の中にあるため。
// ボタンはコードのクリック (タップ) と押下で出し (.revealed)、包みの外を押すと
// 消す。
import { afterEach, describe, expect, test } from "bun:test";
import { h, render, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import { CodeCopyFrame, CopyablePreText } from "../src/client/components/CodeCopyFrame.tsx";
import { CodeBlock } from "../src/client/components/CodeBlock.tsx";
import { withDom } from "./dom.ts";
import { defined, stubProperty } from "./helpers.ts";

withDom();

let roots: HTMLElement[] = [];
let restores: Array<() => void> = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  for (const restore of restores.reverse()) restore();
  restores = [];
});

/** navigator.clipboard の writeText を差し替える。 */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  restores.push(stubProperty(navigator, "clipboard", { value: { writeText }, configurable: true }));
}

async function mount(vnode: ComponentChild): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() => render(vnode, root));
  return root;
}

function buttonIn(root: HTMLElement): HTMLButtonElement {
  return defined(root.querySelector<HTMLButtonElement>("button.code-copy-btn"), "copy button");
}

describe("CodeCopyFrame", () => {
  test("押すと pre の文字列がそのまま入り、成功の印が付く", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const text = "line 1\n  line 2\n";
    const root = await mount(h(CopyablePreText, { class: "tl-fold-body", text }));
    const button = buttonIn(root);
    await act(async () => {
      button.click();
    });
    expect(written).toEqual([text]);
    expect(button.classList.contains("copied")).toBe(true);
    expect(defined(root.querySelector("pre.tl-fold-body"), "pre").textContent).toBe(text);
  });

  test("書けなかった時は成功の印を付けない", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    const root = await mount(h(CopyablePreText, { text: "x" }));
    const button = buttonIn(root);
    await act(async () => {
      button.click();
    });
    expect(button.classList.contains("copied")).toBe(false);
  });

  // 文字を DOM に置くと、Timeline の検索で「コピー」が当たり、本文を選択して
  // コピーした文字列にも混ざる。名前は読み上げ用の aria-label だけが持つ。
  test("ボタンは DOM の文字を持たず、塊の textContent は pre の中身だけ", async () => {
    const root = await mount(h(CopyablePreText, { text: "body" }));
    const button = buttonIn(root);
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-label")).toBe("内容をコピー");
    expect(root.textContent).toBe("body");
  });

  // 「(出力なし)」等は中身の代わりに出している文字で、写す中身が無い。
  test("中身が空なら代わりの文字を出し、コピーボタンは付けない", async () => {
    const root = await mount(h(CopyablePreText, { text: "", placeholder: "(出力なし)" }));
    expect(defined(root.querySelector("pre"), "pre").textContent).toBe("(出力なし)");
    expect(root.querySelector("button.code-copy-btn")).toBeNull();
  });

  test("空の fence (CodeBlock) も代わりの文字だけで、コピーボタンは付けない", async () => {
    const root = await mount(
      h(CodeBlock, { code: "", lang: "bash", placeholder: "(空のコマンド)" }),
    );
    expect(defined(root.querySelector("pre"), "pre").textContent).toBe("(空のコマンド)");
    expect(root.querySelector("button.code-copy-btn")).toBeNull();
  });

  test("markdown の fence (CodeBlock) にも付き、fence の中身を書く", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const root = await mount(h(CodeBlock, { code: "echo hi", lang: "sh" }));
    await act(async () => {
      buttonIn(root).click();
    });
    expect(written).toEqual(["echo hi"]);
  });
});

describe("CodeCopyFrame: inline code", () => {
  test("包みは span で、文の textContent は code の文字だけ", async () => {
    const root = await mount(
      h(
        "p",
        null,
        "run ",
        h(CodeCopyFrame, { text: "ls -l", inline: true, children: h("code", null, "ls -l") }),
        " now",
      ),
    );
    const frame = defined(root.querySelector(".code-copy-frame"), "frame");
    expect(frame.tagName).toBe("SPAN");
    expect(frame.classList.contains("code-copy-frame-inline")).toBe(true);
    expect(buttonIn(root).textContent).toBe("");
    expect(root.textContent).toBe("run ls -l now");
  });
});

describe("CodeCopyFrame: クリック (タップ) で出し、外を押すと消す", () => {
  afterEach(() => document.getSelection()?.removeAllRanges());

  function frameIn(root: HTMLElement): HTMLElement {
    return defined(root.querySelector<HTMLElement>(".code-copy-frame"), "frame");
  }
  function revealed(root: HTMLElement): boolean {
    return frameIn(root).classList.contains("revealed");
  }
  async function pointerDown(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
  }
  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  async function mountBlock(): Promise<HTMLElement> {
    const root = await mount(
      h("div", null, h(CopyablePreText, { text: "body" }), h("p", { id: "outside" }, "outside")),
    );
    return root;
  }

  test("選択の無いクリックで出て、包みの外を押すと消える", async () => {
    const root = await mountBlock();
    const pre = defined(root.querySelector("pre"), "pre");
    expect(revealed(root)).toBe(false);
    await click(pre);
    expect(revealed(root)).toBe(true);
    // 包みの中 (コード・ボタン) を押しても消えない。
    await pointerDown(pre);
    await pointerDown(buttonIn(root));
    expect(revealed(root)).toBe(true);
    await pointerDown(defined(root.querySelector("#outside"), "outside"));
    expect(revealed(root)).toBe(false);
  });

  // drag で文字を選んだ後の click は選択操作の終わりで、ボタンを出さない
  // (出ていたら消し、選んだ文字に重ねない)。
  test("選択が残っている click では出さず、出ていたら消す", async () => {
    const root = await mountBlock();
    const pre = defined(root.querySelector("pre"), "pre");
    await click(pre);
    expect(revealed(root)).toBe(true);
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = defined(document.getSelection(), "selection");
    selection.removeAllRanges();
    selection.addRange(range);
    await click(pre);
    expect(revealed(root)).toBe(false);
  });

  test("ボタンを押すとコピーし、成功の印を見せる間も外を押すまで残る", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    const root = await mountBlock();
    await act(async () => {
      buttonIn(root).click();
    });
    expect(written).toEqual(["body"]);
    expect(revealed(root)).toBe(true);
    await pointerDown(defined(root.querySelector("#outside"), "outside"));
    expect(revealed(root)).toBe(false);
  });

  // inline code の URL・ファイルのリンクのクリックは遷移で、ボタンを出す操作ではない。
  test("包んだリンクのクリックでは出さない", async () => {
    const root = await mount(
      h(CodeCopyFrame, {
        text: "https://example.com/",
        inline: true,
        children: h("a", { href: "#x" }, h("code", null, "https://example.com/")),
      }),
    );
    await click(defined(root.querySelector("code"), "code"));
    expect(revealed(root)).toBe(false);
  });
});
