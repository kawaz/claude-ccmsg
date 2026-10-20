/** @jsxImportSource preact */
// コードの塊 (markdown の fence、Timeline の tool 入出力や raw 行の pre) に
// 重ねる「コピー」ボタン。塊の右上に置き、hover / focus の間だけ見せる。
import type { ComponentChildren } from "preact";
import { useClipboardCopy } from "./CopyButton.tsx";

/**
 * `children` (コードを描く pre 1 つ) を包み、右上に `text` をコピーする
 * ボタンを重ねる。ボタンは pre の外に置く: pre はスクロールする箱なので、
 * 中に置くと横・縦のスクロールで内容と一緒に流れて見えなくなる。
 *
 * ボタンの文字は CSS の `content` で出し、DOM のテキストにしない。塊は
 * Timeline の検索単位 (描画済みテキストを走査する) と、選択してコピーされる
 * 範囲の中にあり、文字を DOM に置くと「コピー」が検索に当たり、本文を選択して
 * コピーした文字列にも混ざる。読み上げる名前は aria-label が持つ。
 *
 * `text` が空ならボタンを出さない (塊に出ているのは「(出力なし)」等の
 * 代わりの文字で、写す中身が無い)。包みは残し、塊の組みを中身の有無で
 * 変えない。
 */
export function CodeCopyFrame({ text, children }: { text: string; children: ComponentChildren }) {
  const { copied, copy } = useClipboardCopy();
  return (
    <div class="code-copy-frame">
      {children}
      {text === "" ? null : (
        <button
          type="button"
          class={"code-copy-btn" + (copied ? " copied" : "")}
          title="内容をコピー"
          aria-label="内容をコピー"
          onClick={(e) => {
            // 吹き出しのクリック (👤 nav の位置合わせ等) を兼ねさせない。
            e.stopPropagation();
            void copy(text);
          }}
        />
      )}
    </div>
  );
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
