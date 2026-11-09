// 行番号ガター付きのコード編集領域 (DR-0051)。閲覧側と同じ Shiki の着色を
// 編集中も保つ。
//
// - 編集領域は `contenteditable="plaintext-only"` の div。DOM の中身は
//   ブラウザの編集に任せ (Preact は中身を描かない)、本文は打鍵のたびに
//   `textContent` から取り出す。着色は DOM を組み替えず、CSS Custom Highlight
//   API で範囲に色を付ける (syntax-highlights.ts)
// - トークン化は片ごとの増分 (editor-syntax.ts)。表示中の行 ±20 行だけを
//   登録し、残りのトークン化は rAF ごとに時間を区切って進める
// - 末尾の番兵と改行コードは editor-text.ts
import type { JSX, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { editorLineCount } from "../utils.ts";
import { useEffectEvent } from "../useEffectEvent.ts";
import { grammarStatesEqual, loadBlockTokenizer, type HighlightLang } from "../highlight.ts";
import { fromEditorDom, splitEditorDom, toEditorDom } from "../editor-text.ts";
import { IncrementalSyntax, lineStartOffsets, visibleLineRange } from "../editor-syntax.ts";
import { clearSyntax, paintSyntax, textSegments, type PaintSpan } from "../syntax-highlights.ts";
import type { GrammarState } from "shiki/core";

/** 表示中の行の前後に余分に着色する行数 */
const VIEW_MARGIN_LINES = 20;
/** 1 回の処理 (打鍵・スクロール・1 フレーム) でトークン化に使う時間の上限。
 * 超えた分は次のフレームへ回す */
const FRAME_BUDGET_MS = 8;

function visibleLines(el: HTMLElement, lineCount: number): [number, number] {
  const style = getComputedStyle(el);
  return visibleLineRange({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    paddingTop: Number.parseFloat(style.paddingTop) || 0,
    lineHeight: Number.parseFloat(style.lineHeight),
    lineCount,
    margin: VIEW_MARGIN_LINES,
  });
}

export function CodeEditor({
  editorRef,
  initialText,
  lang,
  ariaLabel,
  disabled,
  onChange,
  onKeyDown,
}: {
  editorRef: RefObject<HTMLDivElement>;
  /** 開いた時の本文 (改行は LF)。開いている間に変わっても編集中の中身は
   * 置き換えない (textarea の初期値と同じ扱い) */
  initialText: string;
  /** 着色する言語。`null` なら着色しない */
  lang: HighlightLang | null;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (text: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
}) {
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const initialTextRef = useRef(initialText);
  const [lineCount, setLineCount] = useState(() => editorLineCount(initialText));
  const syntaxRef = useRef<IncrementalSyntax<GrammarState> | null>(null);
  const frameRef = useRef<number | null>(null);
  // syntax-highlights.ts の登録の持ち主 (この編集領域)
  const ownerRef = useRef<object>({});

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const doc = el.ownerDocument;
    el.replaceChildren(
      ...splitEditorDom(toEditorDom(initialTextRef.current)).map((part) =>
        doc.createTextNode(part),
      ),
    );
  }, [editorRef]);

  // 本文を読み直して、表示中の行まで (時間の上限まで) トークン化して塗る。
  // 残りがあれば次のフレームから続ける。打鍵・スクロール・大きさの変化・文法の
  // 読み込み完了で呼ぶ。
  function refresh(beyondView = false): void {
    const el = editorRef.current;
    const syntax = syntaxRef.current;
    if (!el || !syntax) return;
    const { segments, text } = textSegments(el);
    syntax.edit(fromEditorDom(text));
    const [first, end] = visibleLines(el, syntax.lines.length);
    const deadline = performance.now() + FRAME_BUDGET_MS;
    syntax.runUntil(end, () => performance.now() < deadline);
    // フレームから呼ばれた時は、表示中の行が済んだ後も時間の上限まで進める
    if (beyondView) syntax.runWhile(() => performance.now() < deadline);
    const starts = lineStartOffsets(syntax.lines);
    const spans: PaintSpan[] = [];
    for (const block of syntax.blocksIn(first, end)) {
      const base = starts[block.start] ?? 0;
      for (const token of block.tokens) {
        spans.push({ start: base + token.start, end: base + token.end, paint: token.paint });
      }
    }
    paintSyntax(el.ownerDocument, ownerRef.current, segments, spans);
    if (syntax.pending && frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        refresh(true);
      });
    }
  }
  const refreshFromEffect = useEffectEvent(() => refresh());

  useEffect(() => {
    const el = editorRef.current;
    if (!lang || !el) return;
    let cancelled = false;
    const owner = ownerRef.current;
    void loadBlockTokenizer(lang).then((tokenize) => {
      if (cancelled || !tokenize) return;
      const syntax = new IncrementalSyntax<GrammarState>({
        tokenize,
        statesEqual: grammarStatesEqual,
      });
      syntax.reset(fromEditorDom(el.textContent ?? ""));
      syntaxRef.current = syntax;
      refreshFromEffect();
    });
    // 表示される行の数が変わったら塗り直す
    const observer = new ResizeObserver(() => refreshFromEffect());
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      syntaxRef.current = null;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      clearSyntax(el.ownerDocument, owner);
    };
  }, [lang, editorRef]);

  const handleInput = (e: JSX.TargetedEvent<HTMLDivElement, Event>) => {
    // 取り出しは textContent (innerText は U+00A0 を空白に変える、DR-0051 §4)
    const text = fromEditorDom(e.currentTarget.textContent ?? "");
    setLineCount(editorLineCount(text));
    onChange(text);
    // 変換中 (isComposing) も塗り直す。StaticRange は DOM に追従しないので、
    // 止めると変換中の文字より後ろの色がずれる (DR-0051 §3)
    refresh();
  };

  const handleScroll = (e: JSX.TargetedEvent<HTMLDivElement, Event>) => {
    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
    refresh();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.isComposing && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // Design rationale: 非推奨の execCommand を使うのは、ブラウザの undo
      // 履歴に積んだまま文字を入れる手段がこれしか無いため (DOM を直接書き換え
      // ると undo で戻せない)。1 文字の挿入にだけ使う。複数行を入れると
      // Chromium / WebKit とも <div> を作り、textContent から改行が消える
      // (DR-0051 §4)。
      document.execCommand("insertText", false, "\t");
      return;
    }
    onKeyDown?.(e);
  };

  const items: JSX.Element[] = [];
  for (let i = 1; i <= lineCount; i += 1) items.push(<div key={i}>{i}</div>);
  return (
    <div class="memo-editor-body-wrap">
      <div ref={gutterRef} class="memo-editor-lineno" aria-hidden="true">
        {items}
      </div>
      <div
        ref={editorRef}
        class="memo-editor-body"
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-disabled={disabled ? "true" : undefined}
        contenteditable={disabled ? "false" : "plaintext-only"}
        spellcheck={false}
        onInput={handleInput}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
