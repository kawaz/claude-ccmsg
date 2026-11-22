/** @jsxImportSource preact */
// markdown のコードブロック (fence) を、言語で描き分ける (DR-0010 §4, §12, §13,
// §14)。描いて見せる言語はここに 1 つずつ足す (描いたものは FenceFigure の箱に
// 入れる)。それ以外はコードの塊。
import type { VNode } from "preact";
import { CodeBlock } from "./CodeBlock.tsx";
import { FenceFigure, type FigureNote } from "./FenceFigure.tsx";
import { MermaidFigure } from "./MermaidFigure.tsx";
import { SvgFigure } from "./SvgFigure.tsx";

/** ```math を描いたもの。描けていなければ view は null で、note が理由か
 * 描いている途中を知らせる。 */
export interface FenceMath {
  view: VNode | null;
  note: FigureNote | null;
}

/** 文書の側が持つもの。数式は式番号を文書の頭から数えるので、描くのは文書の
 * 側 (markdown-view の描画の文脈) に任せる。 */
export interface FenceContext {
  mathFigure: (tex: string) => FenceMath;
}

export function renderCodeFence(
  code: string,
  lang: string | null,
  key: string,
  context: FenceContext,
): VNode {
  // `svg` と明示された時だけ図にする (`xml` / `html` はコードのまま)。
  switch (lang?.toLowerCase()) {
    case "svg":
      return <SvgFigure key={key} code={code} />;
    case "mermaid":
      return <MermaidFigure key={key} code={code} />;
    case "math": {
      const math = context.mathFigure(code);
      return (
        <FenceFigure key={key} source={code} sourceLang="tex" view={math.view} note={math.note} />
      );
    }
    default:
      return <CodeBlock key={key} code={code} lang={lang} />;
  }
}
