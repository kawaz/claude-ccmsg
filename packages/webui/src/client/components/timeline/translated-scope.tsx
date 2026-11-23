import type { ComponentChildren } from "preact";
import type { TranslationTab } from "./translation.ts";

/** 翻訳タブの訳文を描く要素を包む。訳タブの間だけ `tl-translated` が付き、
 * CSS の `text-autospace` が英数字と和文の間に空きを入れる (DR-0049 §8)。
 * 原文には付けない。タブを切り替えても子の木は同じ位置に残る (class が
 * 変わるだけ)。 */
export function TranslatedScope({
  tab,
  commentText = false,
  children,
}: {
  tab: TranslationTab;
  /** Its text is what a comment's quote is chosen from (DR-0062 §2,
   * comment-quotes.tsx): the drawn markdown, in either tab. */
  commentText?: boolean;
  children: ComponentChildren;
}) {
  return (
    <span
      class={tab === "original" ? "tl-scope" : "tl-scope tl-translated"}
      data-comment-text={commentText ? "" : undefined}
    >
      {children}
    </span>
  );
}
