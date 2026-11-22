/** @jsxImportSource preact */
// SVG を図として見せる箱 (DR-0010 §12)。```svg のコードブロックが使い、図に
// なる別の種類のブロック (SVG を作って見せるもの) も同じ箱に渡す。
//
// - 図は `<img>` の data URL で描き、SVG を DOM に入れない (script・イベント
//   属性・外部参照が動かない)
// - ブロックごとに「描画 / ソース」のタブで切り替える。既定は描画
// - 描画できない SVG は img の error の event でソースに切り替え、理由を出す
// - 図は白い下地に置く (CSS)。dark でも透明な地の黒い線が見える
// - コピーボタンは箱に 1 つで、写すのはソース
import { useMemo, useState } from "preact/hooks";
import { svgFigure } from "../svg-figure.ts";
import { HighlightedCode } from "./CodeBlock.tsx";
import { CodeCopyFrame } from "./CodeCopyFrame.tsx";
import { Tabs } from "./Tabs.tsx";

type FigureView = "render" | "source";

/** タブの文字は CSS の `content` で出し、DOM のテキストにしない (DR-0010 §10
 * のコピーボタンと同じ理由: 本文の中にあるので、DOM の文字は画面内検索に
 * 当たり、本文を選んでコピーした文字にも混ざる)。 */
function tabLabel(text: string) {
  return <span class="md-svg-tab-label" data-label={text} />;
}

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
  /** ソースのハイライトの言語 (fence の言語名と同じ綴り)。 */
  sourceLang: string;
  /** 何の図か (「SVG」)。理由の文と、alt の代わりの文に入る。 */
  label: string;
}) {
  const figure = useMemo(() => svgFigure(svg, label), [svg, label]);
  const [view, setView] = useState<FigureView>("render");
  // 読み込みに失敗した src。中身が替われば (src が替われば) また描画を試す。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === figure.src;
  const shown: FigureView = failed ? "source" : view;
  return (
    <CodeCopyFrame text={source}>
      <div class={"md-svg" + (failed ? " md-svg-broken" : "")}>
        <Tabs
          class="tl-thinking-tabs md-svg-tabs"
          tabClass="tl-thinking-tab"
          label={`${label} の表示`}
          selected={shown}
          onSelect={setView}
          items={[
            {
              id: "render",
              label: tabLabel("描画"),
              title: failed ? `この ${label} は描画できない` : "描画",
              disabled: failed,
            },
            { id: "source", label: tabLabel("ソース"), title: "ソース" },
          ]}
        />
        {failed ? (
          <p class="md-svg-note">この {label} は描画できないのでソースを表示している</p>
        ) : null}
        {shown === "render" ? (
          <div class="md-svg-view">
            <img
              class={"md-svg-figure" + (figure.sized ? "" : " md-svg-figure-unsized")}
              src={figure.src}
              alt={figure.alt}
              onError={() => setFailedSrc(figure.src)}
            />
          </div>
        ) : (
          <HighlightedCode code={source} lang={sourceLang} />
        )}
      </div>
    </CodeCopyFrame>
  );
}
