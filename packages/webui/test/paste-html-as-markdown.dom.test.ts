// 入力欄の paste の handler (DR-0065): text/html に markdown に直す意味のある要素が
// あれば、ブラウザの貼り付けを止めて、直した markdown を貼った時の選択の位置に
// execCommand("insertText") で入れる。それ以外はブラウザの貼り付けのまま。
//
// happy-dom は execCommand を持たないので、document の execCommand を、呼ばれた
// 時の選択を記録して textarea の選択を置き換える (input を出す) 偽物にする。
// ⌘Z で戻ることは実ブラウザの e2e (paste-html.e2e.ts) が見る。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pasteHtmlAsMarkdown } from "../src/client/paste-html-as-markdown.ts";
import { stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

interface Inserted {
  command: string;
  text: string;
  start: number;
  end: number;
  focused: boolean;
}

let textarea: HTMLTextAreaElement;
let inserted: Inserted[];
let nextInsert: Promise<Inserted>;
let restores: Array<() => void> = [];

beforeEach(() => {
  textarea = document.createElement("textarea");
  textarea.addEventListener("paste", pasteHtmlAsMarkdown);
  document.body.append(textarea);
  inserted = [];
  let resolve: (value: Inserted) => void = () => {};
  nextInsert = new Promise((r) => {
    resolve = r;
  });
  restores = [
    stubProperty(document, "execCommand", {
      configurable: true,
      value: (command: string, _ui: boolean, text: string): boolean => {
        const call = {
          command,
          text,
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
          focused: document.activeElement === textarea,
        };
        inserted.push(call);
        textarea.setRangeText(text, call.start, call.end, "end");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        resolve(call);
        return true;
      },
    }),
  ];
});

afterEach(() => {
  for (const restore of restores.reverse()) restore();
  textarea.remove();
});

/** `data` (形式 → 中身) を持つクリップボードの paste を textarea に送る。 */
function paste(data: Record<string, string>): ClipboardEvent {
  const clipboard = new DataTransfer();
  for (const [type, value] of Object.entries(data)) clipboard.setData(type, value);
  const event = new ClipboardEvent("paste", {
    clipboardData: clipboard,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(event);
  return event;
}

const LINK_HTML = '<p>see <a href="https://example.com/doc">the doc</a></p>';

describe("an HTML paste with markdown structure", () => {
  test("goes in as markdown at the caret, by the browser's insertText", async () => {
    textarea.value = "before  after";
    textarea.focus();
    textarea.setSelectionRange(7, 7);
    const event = paste({ "text/plain": "see the doc", "text/html": LINK_HTML });
    expect(event.defaultPrevented).toBe(true);
    const call = await nextInsert;
    expect(call).toEqual({
      command: "insertText",
      text: "see [the doc](https://example.com/doc)",
      start: 7,
      end: 7,
      focused: true,
    });
    expect(textarea.value).toBe("before see [the doc](https://example.com/doc) after");
  });

  test("replaces the selection", async () => {
    textarea.value = "a XX b";
    textarea.focus();
    textarea.setSelectionRange(2, 4);
    paste({ "text/plain": "see the doc", "text/html": LINK_HTML });
    await nextInsert;
    expect(textarea.value).toBe("a see [the doc](https://example.com/doc) b");
  });

  // 部品の読み込みを待つ間にフォーカスが外れても、貼った欄の貼った時の選択に入れる。
  test("goes where it was pasted when the focus moved away meanwhile", async () => {
    const other = document.createElement("input");
    document.body.append(other);
    textarea.value = "a XX b";
    textarea.focus();
    textarea.setSelectionRange(2, 4);
    paste({ "text/plain": "see the doc", "text/html": LINK_HTML });
    other.focus();
    textarea.setSelectionRange(0, 0);
    const call = await nextInsert;
    expect(call.focused).toBe(true);
    expect(textarea.value).toBe("a see [the doc](https://example.com/doc) b");
    other.remove();
  });
});

describe("left to the browser's own paste", () => {
  // 何も入らないことは、続けて送る変換のある paste が入るのを待って確かめる (変換は
  // 貼った順に入るので、先の paste が入るならその前に入っている)。
  async function onlyTheNextConverts(): Promise<void> {
    textarea.readOnly = false;
    textarea.focus();
    paste({ "text/plain": "see the doc", "text/html": LINK_HTML });
    await nextInsert;
    expect(inserted.map((call) => call.text)).toEqual(["see [the doc](https://example.com/doc)"]);
  }

  // ⌘⇧V (スタイルを合わせて貼り付け) は text/html の無い paste で届く (DR-0065 §1)。
  test("no text/html", async () => {
    const event = paste({ "text/plain": "<b>plain</b>" });
    expect(event.defaultPrevented).toBe(false);
    await onlyTheNextConverts();
  });

  test("HTML with no markdown structure (an editor's colouring)", async () => {
    const event = paste({
      "text/plain": "  a\tb",
      "text/html": '<div style="white-space: pre"><span style="color:red">  a</span>\tb</div>',
    });
    expect(event.defaultPrevented).toBe(false);
    await onlyTheNextConverts();
  });

  test("a read-only box", async () => {
    textarea.readOnly = true;
    expect(paste({ "text/plain": "x", "text/html": LINK_HTML }).defaultPrevented).toBe(false);
    await onlyTheNextConverts();
  });

  // 先に貼り付けを引き受けた handler (添付) がある時。
  test("a paste another handler already took", async () => {
    document.addEventListener("paste", (e) => e.preventDefault(), { capture: true, once: true });
    const event = paste({ "text/plain": "x", "text/html": LINK_HTML });
    expect(event.defaultPrevented).toBe(true);
    await onlyTheNextConverts();
  });
});
