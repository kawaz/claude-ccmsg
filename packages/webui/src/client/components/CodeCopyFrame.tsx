/** @jsxImportSource preact */
// コード (markdown の fence と inline code、Timeline の tool 入出力や raw 行の
// pre) に添える「コピー」ボタン。コードの左上の真上に置き、hover / focus の
// 間と、コードをクリック (タップ) してから外を押すまでの間だけ見せる。
import type { ComponentChildren, TargetedMouseEvent } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useClipboardCopy } from "./CopyButton.tsx";

/**
 * `children` (コード 1 つ: pre、inline code、inline code を包んだリンク) を
 * 包み、その左上の真上に `text` をコピーするボタンを添える。ボタンはコードの
 * 外に置く: pre はスクロールする箱なので中に置くと内容と一緒に流れ、コードの
 * 上に重ねると下の文字が隠れる。`inline` は文中のコードを包む時に指定する
 * (包みを span にし、行の組みを変えない)。
 *
 * ボタンの文字は CSS の `content` で出し、DOM のテキストにしない。コードは
 * Timeline の検索単位 (描画済みテキストを走査する) と、選択してコピーされる
 * 範囲の中にあり、文字を DOM に置くと「コピー」が検索に当たり、本文を選択して
 * コピーした文字列にも混ざる。読み上げる名前は aria-label が持つ。
 *
 * `text` が空ならボタンを出さない (塊に出ているのは「(出力なし)」等の
 * 代わりの文字で、写す中身が無い)。包みは残し、塊の組みを中身の有無で
 * 変えない。
 */
export function CodeCopyFrame({
  text,
  inline = false,
  children,
}: {
  text: string;
  inline?: boolean;
  children: ComponentChildren;
}) {
  const { copied, copy } = useClipboardCopy();
  const revealed = useTapReveal();
  const button =
    text === "" ? null : (
      <button
        type="button"
        class={"code-copy-btn" + (copied ? " copied" : "")}
        title="内容をコピー"
        aria-label="内容をコピー"
        onClick={(e) => {
          // 吹き出しのクリック (👤 nav の位置合わせ等) を兼ねさせない。
          e.stopPropagation();
          // 成功の印を見せている間に hover が外れても消さず、外を押すまで残す。
          revealed.reveal();
          void copy(text);
        }}
      />
    );
  const frameClass =
    "code-copy-frame" +
    (inline ? " code-copy-frame-inline" : "") +
    (revealed.shown ? " revealed" : "");
  return inline ? (
    <span class={frameClass} ref={revealed.frameRef} onClick={revealed.onClick}>
      {children}
      {button}
    </span>
  ) : (
    <div class={frameClass} ref={revealed.frameRef} onClick={revealed.onClick}>
      {children}
      {button}
    </div>
  );
}

/**
 * コードのクリック (タップ) とボタンの押下でボタンを出し、包みの外を押したら
 * 消す。hover の無いタッチ端末でボタンに届く道で、hover のある端末でも同じに
 * 効く。
 *
 * クリックか選択操作かは、ブラウザが `click` を出したかと、その時点で選択が
 * 畳まれているかで分ける。タッチのスクロールや長押しには `click` が来ず、
 * コードの中で drag して選んだ時は `click` が来ても選択が残っている (その時は
 * 出ていたボタンも消し、選んだ文字に重ねない)。リンク (inline code の
 * URL・ファイルのリンク) のクリックは遷移なので出さない。
 */
function useTapReveal(): {
  shown: boolean;
  frameRef: (el: Element | null) => void;
  onClick: (e: TargetedMouseEvent<Element>) => void;
  reveal: () => void;
} {
  const [shown, setShown] = useState(false);
  const frame = useRef<Element | null>(null);
  const frameRef = useCallback((el: Element | null) => {
    frame.current = el;
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (e: PointerEvent) => {
      const inside = e.target instanceof Node && frame.current?.contains(e.target) === true;
      if (!inside) setShown(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [shown]);

  const onClick = (e: TargetedMouseEvent<Element>) => {
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (link !== null && e.currentTarget.contains(link)) return;
    const selection = document.getSelection();
    setShown(selection === null || selection.isCollapsed);
  };

  return { shown, frameRef, onClick, reveal: () => setShown(true) };
}

/** 文字列をそのまま出す pre (tool の入出力、raw 行、markdown の原文) を
 * コピーできる形で描く。`text` が空の時は `placeholder` (「(出力なし)」等) を
 * 出し、コピーボタンは付けない。 */
export function CopyablePreText({
  class: className,
  text,
  placeholder,
}: {
  class?: string;
  text: string;
  placeholder?: string;
}) {
  return (
    <CodeCopyFrame text={text}>
      <pre class={className}>{text === "" ? placeholder : text}</pre>
    </CodeCopyFrame>
  );
}
