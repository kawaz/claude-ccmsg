// 本文を書く欄の貼り付けのボタン (📋、DR-0065 §8、kawaz 2026-11-25)。
// 何を保証するか:
//   - クリップボードが読めない (拒否・失敗) か空なら、並びを出さず、何も入れず、何も添付しない
//   - 中身で分ける: markdown に直す HTML なら [plain | markdown | attachment (size)]、text/plain
//     (HTML が無い・色付けだけの HTML) なら [plain | markdown | quote | block | attachment (size)]、
//     文字でないもの (画像) だけなら選ばせずに添付にする
//   - 選ぶと、その入れ方の文字を今の選択の位置に入れて閉じる。attachment は text/plain を
//     pasted.txt の添付にする
//   - 📋 と並びの押し始めは textarea のフォーカスを動かさない。選んだ後もフォーカスは textarea
//   - 並びの外を押す・Esc・欄への入力で、何も入れずに閉じる。Esc は並びだけを閉じ、外 (フォームや
//     ダイアログの Esc) へ届かない
//   - md の間は押せない。添付を持たない欄は attachment を出さず、文字でない中身を入れない
//
// happy-dom は execCommand を持たないので、選択を置き換えて input を出す偽物
// (stubInsertText) にする。⌘Z で戻ること・並びの置き場は実ブラウザの e2e
// (paste-button.e2e.ts) が見る。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { useComposeView } from "../src/client/components/ComposePreview.tsx";
import { PasteButton } from "../src/client/components/PasteButton.tsx";
import { withDom } from "./dom.ts";
import { instanceOf, LINK_HTML, LINK_MARKDOWN, stubInsertText, stubProperty } from "./helpers.ts";

withDom();

let insertText: ReturnType<typeof stubInsertText>;
const restores: Array<() => void> = [];
const roots: HTMLElement[] = [];

beforeEach(() => {
  insertText = stubInsertText();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(() => render(null, root));
    root.remove();
  }
  for (const restore of restores.splice(0).reverse()) restore();
  insertText.restore();
});

/** `navigator.clipboard.read()` が `items` を返す (Error なら拒否する) ようにする。 */
function clipboardHolds(items: ClipboardItem[] | Error): void {
  restores.push(
    stubProperty(navigator.clipboard, "read", {
      configurable: true,
      value: () => (items instanceof Error ? Promise.reject(items) : Promise.resolve(items)),
    }),
  );
}

function textItem(data: Record<string, string>): ClipboardItem {
  return new ClipboardItem(
    Object.fromEntries(
      Object.entries(data).map(([type, value]) => [type, new Blob([value], { type })]),
    ),
  );
}

interface Mounted {
  root: HTMLElement;
  textarea: HTMLTextAreaElement;
  files: File[][];
  /** md | source を md にする。 */
  showMarkdown: () => Promise<void>;
}

/** 欄 (md | source の箱の中の textarea) と 📋。`attachments` の無い欄は添付を持たない。 */
async function mount({ attachments = true } = {}): Promise<Mounted> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const files: File[][] = [];
  let select: (source: boolean) => void = () => {};
  function Field() {
    const view = useComposeView();
    select = view.select;
    return h(
      "div",
      null,
      h("div", { class: "compose-frame", ref: view.frameRef }, h("textarea", null)),
      h(PasteButton, {
        view,
        disabled: false,
        ...(attachments ? { onFiles: (chosen: readonly File[]) => files.push([...chosen]) } : {}),
      }),
    );
  }
  await act(() => render(h(Field, null), root));
  return {
    root,
    textarea: instanceOf(root.querySelector("textarea"), HTMLTextAreaElement, "the textarea"),
    files,
    showMarkdown: () => act(() => select(false)),
  };
}

function pasteButton(root: HTMLElement): HTMLButtonElement {
  return instanceOf(
    root.querySelector('button[aria-label="貼り付け方を選ぶ"]'),
    HTMLButtonElement,
    "the paste button",
  );
}

function ways(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(".compose-paste-way"), (el) => el.textContent ?? "");
}

function way(root: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll(".compose-paste-way")).find(
    (el) => el.textContent === label,
  );
  return instanceOf(found, HTMLButtonElement, `the way ${label}`);
}

/** ポインタで押す: pointerdown (既定が止められたか) と click。 */
async function press(el: HTMLElement): Promise<boolean> {
  const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  el.dispatchEvent(down);
  await act(() => el.click());
  return down.defaultPrevented;
}

/** 📋 を押して、クリップボードの読みが済むまで待つ。 */
async function pressPaste(root: HTMLElement): Promise<boolean> {
  const prevented = await press(pasteButton(root));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return prevented;
}

/** 書きかけの欄にフォーカスとカーソルを置く。 */
function focusAt(textarea: HTMLTextAreaElement, value: string, start: number, end = start): void {
  textarea.value = value;
  textarea.focus();
  textarea.setSelectionRange(start, end);
}

describe("nothing happens", () => {
  // クリップボードの中身は試験の中で作る (ClipboardItem は withDom が入れる DOM のもの)。
  test.each([
    ["the read is refused", (): ClipboardItem[] | Error => new Error("NotAllowedError")],
    ["the clipboard is empty", (): ClipboardItem[] | Error => []],
    [
      "the clipboard holds an empty text",
      (): ClipboardItem[] | Error => [textItem({ "text/plain": "" })],
    ],
  ])("when %s", async (_, items) => {
    clipboardHolds(items());
    const { root, textarea, files } = await mount();
    focusAt(textarea, "abc", 1);
    await pressPaste(root);
    expect(ways(root)).toEqual([]);
    expect(textarea.value).toBe("abc");
    expect(files).toEqual([]);
  });
});

describe("what the ways offered are", () => {
  test("HTML to make markdown of: plain, markdown, attachment", async () => {
    clipboardHolds([textItem({ "text/plain": "see the doc", "text/html": LINK_HTML })]);
    const { root, textarea } = await mount();
    focusAt(textarea, "", 0);
    await pressPaste(root);
    expect(ways(root)).toEqual(["plain", "markdown", "attachment (11)"]);
    expect(pasteButton(root).getAttribute("aria-expanded")).toBe("true");
  });

  test.each([
    ["text/plain alone", { "text/plain": "a b" }],
    [
      "HTML with no markdown structure (an editor's colouring)",
      { "text/plain": "a b", "text/html": '<div><span style="color:red">a</span> b</div>' },
    ],
  ])("%s: plain, markdown, quote, block, attachment", async (_, data) => {
    clipboardHolds([textItem(data)]);
    const { root, textarea } = await mount();
    focusAt(textarea, "", 0);
    await pressPaste(root);
    expect(ways(root)).toEqual(["plain", "markdown", "quote", "block", "attachment (3)"]);
  });

  test("an image alone: no ways, it is attached at once", async () => {
    clipboardHolds([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      }),
    ]);
    const { root, textarea, files } = await mount();
    focusAt(textarea, "abc", 1);
    await pressPaste(root);
    expect(ways(root)).toEqual([]);
    expect(files.map((chosen) => chosen.map((file) => [file.name, file.type, file.size]))).toEqual([
      [["pasted.png", "image/png", 3]],
    ]);
  });

  test("a box with no attachments: no attachment way", async () => {
    clipboardHolds([textItem({ "text/plain": "a b" })]);
    const { root, textarea } = await mount({ attachments: false });
    focusAt(textarea, "", 0);
    await pressPaste(root);
    expect(ways(root)).toEqual(["plain", "markdown", "quote", "block"]);
  });

  test("a box with no attachments: an image is not put in", async () => {
    clipboardHolds([
      new ClipboardItem({ "image/png": new Blob([new Uint8Array([1])], { type: "image/png" }) }),
    ]);
    const { root, textarea } = await mount({ attachments: false });
    focusAt(textarea, "abc", 1);
    await pressPaste(root);
    expect(ways(root)).toEqual([]);
    expect(textarea.value).toBe("abc");
  });

  test("while md is shown, the button cannot be pressed", async () => {
    const { root, showMarkdown } = await mount();
    expect(pasteButton(root).disabled).toBe(false);
    await showMarkdown();
    expect(pasteButton(root).disabled).toBe(true);
  });
});

describe("a way chosen goes in, and the ways close", () => {
  test("markdown of HTML: the converted markdown, at the caret mid-line", async () => {
    clipboardHolds([textItem({ "text/plain": "see the doc", "text/html": LINK_HTML })]);
    const { root, textarea } = await mount();
    focusAt(textarea, "ab", 2);
    await pressPaste(root);
    const inserted = insertText.next();
    expect(await press(way(root, "markdown"))).toBe(true);
    expect(await inserted).toBe(`\n${LINK_MARKDOWN}\n`);
    expect(textarea.value).toBe(`ab\n${LINK_MARKDOWN}\n`);
    expect(ways(root)).toEqual([]);
    expect(document.activeElement).toBe(textarea);
  });

  test("plain of HTML: the text/plain", async () => {
    clipboardHolds([textItem({ "text/plain": "see the doc", "text/html": LINK_HTML })]);
    const { root, textarea } = await mount();
    focusAt(textarea, "", 0);
    await pressPaste(root);
    await press(way(root, "plain"));
    expect(textarea.value).toBe("see the doc");
  });

  test.each([
    ["plain", "a XX b", "a x\ny b"],
    ["markdown", "a XX b", "a \nx\ny\n b"],
    ["quote", "a XX b", "a \n\n> x\n> y\n\n b"],
    ["block", "a XX b", "a \n```\nx\ny\n```\n b"],
  ])("%s takes the place of the selection", async (chosen, before, after) => {
    clipboardHolds([textItem({ "text/plain": "x\ny" })]);
    const { root, textarea } = await mount();
    focusAt(textarea, before, 2, 4);
    await pressPaste(root);
    await press(way(root, chosen));
    expect(textarea.value).toBe(after);
    expect(ways(root)).toEqual([]);
    expect(document.activeElement).toBe(textarea);
  });

  test("attachment: the text/plain as pasted.txt, also for HTML", async () => {
    clipboardHolds([textItem({ "text/plain": "see the doc", "text/html": LINK_HTML })]);
    const { root, textarea, files } = await mount();
    focusAt(textarea, "", 0);
    await pressPaste(root);
    await press(way(root, "attachment (11)"));
    const [file] = files.flat();
    expect(files.flat().length).toBe(1);
    expect([file?.name, file?.type, await file?.text()]).toEqual([
      "pasted.txt",
      "text/plain",
      "see the doc",
    ]);
    expect(textarea.value).toBe("");
    expect(ways(root)).toEqual([]);
  });
});

describe("the focus stays in the textarea", () => {
  test("pressing 📋 and a way takes no default", async () => {
    clipboardHolds([textItem({ "text/plain": "x" })]);
    const { root, textarea } = await mount();
    focusAt(textarea, "", 0);
    expect(await pressPaste(root)).toBe(true);
    expect(document.activeElement).toBe(textarea);
    expect(await press(way(root, "plain"))).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });
});

describe("the ways close with nothing put in", () => {
  async function opened(): Promise<Mounted> {
    clipboardHolds([textItem({ "text/plain": "x" })]);
    const mounted = await mount();
    focusAt(mounted.textarea, "abc", 3);
    await pressPaste(mounted.root);
    expect(ways(mounted.root).length).toBe(5);
    return mounted;
  }

  test("a press outside", async () => {
    const { root, textarea } = await opened();
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(() => {
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    expect(ways(root)).toEqual([]);
    expect(textarea.value).toBe("abc");
    outside.remove();
  });

  test("Esc, which goes no further (the form's Esc does not run)", async () => {
    const { root, textarea } = await opened();
    let outerEsc = 0;
    const onOuter = () => outerEsc++;
    root.addEventListener("keydown", onOuter);
    await act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    root.removeEventListener("keydown", onOuter);
    expect(ways(root)).toEqual([]);
    expect(outerEsc).toBe(0);
    expect(textarea.value).toBe("abc");
  });

  test("an input in the box", async () => {
    const { root, textarea } = await opened();
    await act(() => {
      textarea.value = "abcd";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ways(root)).toEqual([]);
    expect(textarea.value).toBe("abcd");
  });

  test("📋 pressed again", async () => {
    const { root } = await opened();
    await press(pasteButton(root));
    expect(ways(root)).toEqual([]);
  });
});
