/** @jsxImportSource preact */
// SVG の文字を図として見せる (DR-0010 §12)。```svg のコードブロックと、
// mermaid が描いた結果が使う。
//
// - 図は `<img>` の data URL で描き、SVG を DOM に入れない (script・イベント
//   属性・外部参照が動かない)
// - 描画できない SVG は img の error の event でソースに切り替え、理由を出す
// - 図は白い下地に置く (CSS)。dark でも透明な地の黒い線が見える
import { useMemo, useState } from "preact/hooks";
import { svgFigure } from "../svg-figure.ts";
import { FenceFigure } from "./FenceFigure.tsx";

export function SvgFigure({
  svg,
  source,
  sourceLang,
  label,
}: {
  /** 図にする SVG の文字。 */
  svg: string;
  /** ソースのタブに出す文字 (```svg なら `svg` と同じ)。 */
  source: string;
  sourceLang: string;
  /** 何の図か (「SVG」「図」)。理由の文と、alt の代わりの文に入る。 */
  label: string;
}) {
  const figure = useMemo(() => svgFigure(svg, label), [svg, label]);
  // 読み込みに失敗した src。中身が替われば (src が替われば) また描画を試す。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === figure.src;
  return (
    <FenceFigure
      source={source}
      sourceLang={sourceLang}
      note={
        failed
          ? { tone: "error", text: `この ${label} は描画できないのでソースを表示している` }
          : null
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
