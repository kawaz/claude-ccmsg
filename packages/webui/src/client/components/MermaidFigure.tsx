/** @jsxImportSource preact */
// ```mermaid のコードブロック (DR-0010 §13)。描けるまではソースを出して
// 「描画中」を知らせ、描けたら結果の SVG を ```svg と同じ箱で図にする。
// 記法の誤りや読み込めない時は、ソースのまま理由を出す。
import { useContext, useEffect, useState } from "preact/hooks";
import { MermaidRendererContext, type MermaidResult } from "../mermaid-render.ts";
import { FenceFigure } from "./FenceFigure.tsx";
import { SvgFigure } from "./SvgFigure.tsx";

export function MermaidFigure({ code }: { code: string }) {
  const render = useContext(MermaidRendererContext);
  // 結果は描いた元の文字と組で持つ。中身が替わったら古い結果を出さない。
  const [drawn, setDrawn] = useState<{ code: string; result: MermaidResult } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void render(code).then((result) => {
      if (!cancelled) setDrawn({ code, result });
    });
    return () => {
      cancelled = true;
    };
  }, [code, render]);
  const result = drawn !== null && drawn.code === code ? drawn.result : null;
  if (result?.ok === true) {
    return <SvgFigure svg={result.svg} source={code} sourceLang="mermaid" label="mermaid" />;
  }
  return (
    <FenceFigure
      source={code}
      sourceLang="mermaid"
      view={null}
      note={
        result === null
          ? { tone: "info", text: "mermaid で描画中…" }
          : { tone: "error", text: result.reason }
      }
    />
  );
}
