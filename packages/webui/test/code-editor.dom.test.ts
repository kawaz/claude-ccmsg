// 編集モードのコード編集領域 (CodeEditor、DR-0051): 開くと閲覧側と同じ Shiki の
// 色を CSS Custom Highlight API に登録し、入力・スクロールのたびに表示中の行の
// 範囲を登録し直す。本文は textContent から末尾の番兵を落として渡す。
//
// happy-dom には Highlight / StaticRange / CSS.highlights が無いので、登録された
// 範囲を読める最小の偽物を window に置く。
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createRef, h, render } from "preact";
import { act } from "preact/test-utils";
import { CodeEditor } from "../src/client/components/CodeEditor.tsx";
import { loadBlockTokenizer, type HighlightLang } from "../src/client/highlight.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf, stubProperty } from "./helpers.ts";

withDom();

class FakeStaticRange {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
  constructor(init: {
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
  }) {
    this.startContainer = init.startContainer;
    this.startOffset = init.startOffset;
    this.endContainer = init.endContainer;
    this.endOffset = init.endOffset;
  }
}

class FakeHighlight {
  readonly ranges: FakeStaticRange[];
  constructor(...ranges: FakeStaticRange[]) {
    this.ranges = ranges;
  }
}

const registry = new Map<string, FakeHighlight>();
const restores: (() => void)[] = [];
beforeAll(async () => {
  const win = defined(document.defaultView, "the window");
  restores.push(
    stubProperty(win, "Highlight", { value: FakeHighlight, configurable: true, writable: true }),
    stubProperty(win, "StaticRange", {
      value: FakeStaticRange,
      configurable: true,
      writable: true,
    }),
    // happy-dom の window.CSS は読むたびに別の object を返すので、CSS ごと置く
    stubProperty(win, "CSS", {
      value: { highlights: registry },
      configurable: true,
      writable: true,
    }),
  );
  // 文法を先に読み込んでおく (編集領域の読み込みは同じ memo を待つだけになる)
  await loadBlockTokenizer("tsx");
});
afterAll(() => {
  for (const restore of restores.reverse()) restore();
});

let roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  registry.clear();
});

/** 登録された範囲を、編集領域の文字列の中の位置と、塗られている文字列に直す */
function paintedTexts(editor: HTMLElement): { start: number; text: string }[] {
  const starts = new Map<Node, number>();
  let offset = 0;
  for (const node of editor.childNodes) {
    starts.set(node, offset);
    offset += node.textContent?.length ?? 0;
  }
  const whole = editor.textContent ?? "";
  const out: { start: number; text: string }[] = [];
  for (const [name, highlight] of registry) {
    if (!name.startsWith("ccmsg-syntax-")) continue;
    for (const range of highlight.ranges) {
      const start =
        defined(starts.get(range.startContainer), "the range's start node") + range.startOffset;
      const end = defined(starts.get(range.endContainer), "the range's end node") + range.endOffset;
      out.push({ start, text: whole.slice(start, end) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

async function mount(
  initialText: string,
  lang: HighlightLang | null = "tsx",
): Promise<{ editor: HTMLDivElement; changes: string[]; root: HTMLElement }> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const editorRef = createRef<HTMLDivElement>();
  const changes: string[] = [];
  await act(() => {
    render(
      h(CodeEditor, {
        editorRef,
        initialText,
        lang,
        ariaLabel: "ファイル本文",
        onChange: (text: string) => changes.push(text),
      }),
      root,
    );
  });
  await grammarLoaded();
  return { editor: instanceOf(editorRef.current, HTMLDivElement, "the editor"), changes, root };
}

/** マウントの effect が始めた文法の読み込み (memo 済み) が届いて塗り終わるまで
 * 流す。同じ memo を後から待つので、編集領域の続きが先に走る。 */
async function grammarLoaded(): Promise<void> {
  await act(async () => {
    await loadBlockTokenizer("tsx");
  });
}

/** 編集領域の文字列をブラウザの打鍵の代わりに書き換えて input を送る */
async function typeInto(editor: HTMLElement, text: string): Promise<void> {
  await act(() => {
    editor.replaceChildren(document.createTextNode(text));
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("開いた時", () => {
  test("本文の後ろに番兵の改行を足して置き、行番号は本文の行数", async () => {
    const { editor, root } = await mount("const a = 1;\n");
    expect(editor.textContent).toBe("const a = 1;\n\n");
    expect(editor.getAttribute("contenteditable")).toBe("plaintext-only");
    // textarea と同じく、末尾改行の後ろの空行まで数える
    expect(root.querySelector(".memo-editor-lineno")?.children.length).toBe(2);
  });

  test("長い本文は 200 行ごとのテキストノードに分けて置く", async () => {
    const text = Array.from({ length: 450 }, (_, i) => `let v${i} = ${i};`).join("\n");
    const { editor } = await mount(text, null);
    expect(editor.childNodes.length).toBe(3);
    expect(editor.textContent).toBe(`${text}\n`);
  });

  test("閲覧側と同じ色でトークンを登録する", async () => {
    const { editor } = await mount('const a = "x";\n');
    const painted = paintedTexts(editor).map((p) => p.text);
    expect(painted).toContain("const");
    expect(painted).toContain("a");
  });

  test("言語が無ければ何も登録しない", async () => {
    await mount("const a = 1;\n", null);
    expect([...registry.keys()].filter((name) => name.startsWith("ccmsg-syntax-"))).toEqual([]);
  });
});

describe("入力", () => {
  test("番兵を落とした本文を onChange に渡し、登録をし直す", async () => {
    const { editor, changes } = await mount("const a = 1;\n");
    await typeInto(editor, "const a = 1;\nlet b = 2;\n");
    expect(changes).toEqual(["const a = 1;\nlet b = 2;"]);
    expect(paintedTexts(editor).map((p) => p.text)).toContain("let");
  });

  test("ブラウザが番兵を置き換えた時 (最終行への入力) も本文はそのまま", async () => {
    const { editor, changes } = await mount("abc\n", null);
    await typeInto(editor, "abc\nd");
    expect(changes).toEqual(["abc\nd"]);
  });

  test("言語が無くても onChange は届く", async () => {
    const { editor, changes } = await mount("x\n", null);
    await typeInto(editor, "xy\n\n");
    expect(changes).toEqual(["xy\n"]);
  });
});

describe("表示中の行だけを登録する", () => {
  test("表示中の行 ±20 行の範囲を登録し、スクロールで登録し直す", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `let v${i} = ${i};`);
    const restoreHeight = stubProperty(HTMLElement.prototype, "clientHeight", {
      get: () => 200,
      configurable: true,
    });
    try {
      const root = document.createElement("div");
      document.body.append(root);
      roots.push(root);
      const editorRef = createRef<HTMLDivElement>();
      await act(() => {
        render(
          h(CodeEditor, {
            editorRef,
            initialText: lines.join("\n"),
            lang: "tsx",
            ariaLabel: "本文",
            onChange: () => {},
          }),
          root,
        );
      });
      await grammarLoaded();
      const editor = instanceOf(editorRef.current, HTMLDivElement, "the editor");
      editor.style.lineHeight = "20px";
      editor.style.paddingTop = "0px";
      // 行の高さを読めるようにしたので、表示中の 10 行 + 後ろ 20 行の 3 片を登録し直す
      await act(() => {
        editor.dispatchEvent(new Event("scroll"));
      });
      const lineOf = (start: number) =>
        (editor.textContent ?? "").slice(0, start).split("\n").length - 1;
      const top = paintedTexts(editor).map((p) => lineOf(p.start));
      expect(Math.max(...top)).toBeLessThan(30);
      expect(top).toContain(0);

      // 100 行目までスクロールすると 80〜129 行目 (片の境目で 80〜129)
      await act(async () => {
        editor.scrollTop = 2000;
        editor.dispatchEvent(new Event("scroll"));
        // 時間の上限で残った行は次のフレームで進む
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      const scrolled = paintedTexts(editor).map((p) => lineOf(p.start));
      expect(Math.min(...scrolled)).toBeGreaterThanOrEqual(80);
      expect(Math.max(...scrolled)).toBeLessThan(130);
    } finally {
      restoreHeight();
    }
  });
});

describe("閉じた時", () => {
  test("登録を外す", async () => {
    const { root } = await mount("const a = 1;\n");
    expect(registry.size).toBeGreaterThan(0);
    await act(() => render(null, root));
    expect([...registry.keys()].filter((name) => name.startsWith("ccmsg-syntax-"))).toEqual([]);
  });
});

describe("Tab", () => {
  test("フォーカスを移さずにタブ文字を入れる (undo に積む execCommand で)", async () => {
    const { editor } = await mount("x\n", null);
    const inserted: [string, boolean | undefined, string | undefined][] = [];
    const restore = stubProperty(document, "execCommand", {
      value: (command: string, showUi?: boolean, value?: string) => {
        inserted.push([command, showUi, value]);
        return true;
      },
      configurable: true,
      writable: true,
    });
    try {
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      await act(() => {
        editor.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(inserted).toEqual([["insertText", false, "\t"]]);
      // 変換中・修飾キー付きの Tab は奪わない
      for (const init of [{ isComposing: true }, { shiftKey: true }]) {
        const other = new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
          ...init,
        });
        await act(() => {
          editor.dispatchEvent(other);
        });
        expect(other.defaultPrevented).toBe(false);
      }
      expect(inserted.length).toBe(1);
    } finally {
      restore();
    }
  });
});
