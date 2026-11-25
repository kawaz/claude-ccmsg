/** @jsxImportSource preact */
// 本文を書く欄 (textarea) の md | source の切り替え (DR-0010 §15、kawaz
// 2026-11-25)。source は書く側 (textarea、既定)、md は今の本文を応答の吹き出しと
// 同じ markdown の描画で見る側。切り替えの部品は吹き出しの足元と同じ
// BodyViewTabs。
//
// md の間、textarea は作り直さず見えなくするだけで (visibility: hidden。箱の
// 大きさは残る)、その上に同じ大きさの箱を重ねて描く。textarea の中身・カーソル・
// 選択・スクロール・undo の履歴はそのまま残り、source に戻すと textarea に
// フォーカスを返して続きから書ける。見えない textarea はフォーカスを受けない
// ので、md の間は書けない。選んだ表示は覚えない (欄を開き直す・送ると source)。
import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";
import { MarkdownView } from "../markdown-view.tsx";
import { substitutePlaceholders, type ComposerAttachment } from "./composer-attachments.ts";
import { BodyViewTabs } from "./timeline/bubbles.tsx";

export interface ComposeView {
  /** source (書く側) を見せているか。 */
  readonly source: boolean;
  /** textarea とプレビューを重ねる入れ物 (`data-compose-view` を付ける要素)。 */
  readonly frameRef: { current: HTMLDivElement | null };
  /** タブで選ぶ。source に戻した時は textarea にフォーカスを返す。 */
  readonly select: (source: boolean) => void;
  /** source に戻す (送った後)。フォーカスは動かさない。 */
  readonly reset: () => void;
}

export function useComposeView(): ComposeView {
  const [source, setSource] = useState(true);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // タブで source に戻した時だけ、見えるようになった textarea にフォーカスを
  // 返す (見えない間は focus() が効かないので、描いた後で)。
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!source || !refocus.current) return;
    refocus.current = false;
    frameRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [source]);
  const select = useCallback((next: boolean) => {
    refocus.current = next;
    setSource(next);
  }, []);
  const reset = useCallback(() => setSource(true), []);
  return { source, frameRef, select, reset };
}

/** 書く欄の md | source のタブ。 */
export function ComposeViewTabs({ view }: { view: ComposeView }) {
  return (
    <BodyViewTabs
      source={view.source}
      onSelect={view.select}
      mdTitle="markdown として表示 (この間は書けない)"
      sourceTitle="書く"
    />
  );
}

/** md の間に textarea の上へ重ねる箱。添付の `[FILE<N>]` は送る時と同じ
 * リンクに置き換えてから描くので、吹き出しと同じに出る (アップロードの
 * 終わっていない添付は打たれた文字のまま)。 */
export function ComposePreview({
  text,
  attachments = [],
}: {
  text: string;
  /** 添付を持たない欄 (起動の prompt) では無し。 */
  attachments?: ComposerAttachment[];
}) {
  return (
    <div class="compose-preview">
      <MarkdownView source={substitutePlaceholders(text, attachments)} />
    </div>
  );
}
