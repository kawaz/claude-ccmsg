/** @jsxImportSource preact */
// markdown の ```svg のコードブロック (DR-0010 §12)。既定は図 (`<img>` の
// data URL) で、タブでコードの表示 (他の言語と同じ CodeBlock) に切り替える。
// SVG として読めない中身は img の error の event でコードの表示に落とす。
import { useMemo, useState } from "preact/hooks";
import { svgFigure } from "../svg-figure.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import { CodeCopyFrame } from "./CodeCopyFrame.tsx";
import { Tabs } from "./Tabs.tsx";

type SvgView = "figure" | "code";

/** タブの文字は CSS の `content` で出し、DOM のテキストにしない (DR-0010 §10
 * のコピーボタンと同じ理由: 本文の中にあるので、DOM の文字は画面内検索に
 * 当たり、本文を選んでコピーした文字にも混ざる)。 */
function tabLabel(text: string) {
  return <span class="md-svg-tab-label" data-label={text} />;
}

export function SvgCodeBlock({ code }: { code: string }) {
  const figure = useMemo(() => svgFigure(code), [code]);
  const [view, setView] = useState<SvgView>("figure");
  // 読み込みに失敗した src。中身が替われば (src が替われば) また図を試す。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === figure.src;
  const shown: SvgView = failed ? "code" : view;
  return (
    <div class="md-svg">
      <Tabs
        class="tl-thinking-tabs md-svg-tabs"
        tabClass="tl-thinking-tab"
        label="SVG の表示"
        selected={shown}
        onSelect={setView}
        items={[
          {
            id: "figure",
            label: tabLabel("図"),
            title: failed ? "SVG として読めないので図にできない" : "図で表示",
            disabled: failed,
          },
          { id: "code", label: tabLabel("コード"), title: "コードで表示" },
        ]}
      />
      {shown === "figure" ? (
        <CodeCopyFrame text={code}>
          <img
            class={"md-svg-figure" + (figure.sized ? "" : " md-svg-figure-unsized")}
            src={figure.src}
            alt={figure.alt}
            onError={() => setFailedSrc(figure.src)}
          />
        </CodeCopyFrame>
      ) : (
        <CodeBlock code={code} lang="svg" />
      )}
    </div>
  );
}
