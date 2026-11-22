/** @jsxImportSource preact */
// markdown のコードブロック (fence) を、言語で描き分ける (DR-0010 §4, §12)。
// 図として見せる言語はここに 1 行ずつ足す。それ以外はコードの塊。
import type { VNode } from "preact";
import { CodeBlock } from "./CodeBlock.tsx";
import { SvgFigure } from "./SvgFigure.tsx";

export function renderCodeFence(code: string, lang: string | null, key: string): VNode {
  // `svg` と明示された時だけ図にする (`xml` / `html` はコードのまま)。
  switch (lang?.toLowerCase()) {
    case "svg":
      // ソースのハイライトは html の文法で読む (xml の文法を持たないため)。
      return <SvgFigure key={key} svg={code} source={code} sourceLang="html" label="SVG" />;
    default:
      return <CodeBlock key={key} code={code} lang={lang} />;
  }
}
