/** @jsxImportSource preact */
// ```svg のコードブロックを図として見せる (DR-0010 §12)。
//
// - 図は `<img>` の data URL で描き、SVG を DOM に入れない (script・イベント
//   属性・外部参照が動かない)
// - 描画できない SVG は img の error の event でソースに切り替え、理由を出す
// - 図は白い下地に置く (CSS)。dark でも透明な地の黒い線が見える。中身は任意の
//   画像なので、mermaid の図のような配色の切り替えは付けない
import { useMemo, useState } from "preact/hooks";
import { svgFigure } from "../svg-figure.ts";
import { FenceFigure } from "./FenceFigure.tsx";

export function SvgFigure({ code }: { code: string }) {
  const figure = useMemo(() => svgFigure(code, "SVG"), [code]);
  // 読み込みに失敗した src。中身が替われば (src が替われば) また描画を試す。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === figure.src;
  return (
    <FenceFigure
      source={code}
      // ハイライトは html の文法で読む (xml の文法を持たないため)。
      sourceLang="html"
      note={
        failed ? { tone: "error", text: "この SVG は描画できないのでソースを表示している" } : null
      }
      view={
        failed ? null : (
          <img
            class={"md-figure-img" + (figure.sized ? "" : " md-figure-img-unsized")}
            src={figure.src}
            alt={figure.alt}
            onError={() => setFailedSrc(figure.src)}
          />
        )
      }
    />
  );
}
