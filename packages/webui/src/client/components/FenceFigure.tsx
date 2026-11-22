/** @jsxImportSource preact */
// コードブロックを描いて見せる箱 (DR-0010 §12)。図にする種類 (svg / mermaid /
// 数式) が共通に使う: 罫で囲んだ 1 つの箱に、上から「描画 / ソース」のタブ、
// 知らせの文、描いたものかソースを置く。
//
// - 描いたもの (`view`) がまだ無い・作れない時は、描画のタブを押せなくし、
//   ソースを出す
// - タブの状態はブロックごとで、保存しない。既定は描画
// - コピーボタンは箱に 1 つで、写すのはソース
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { HighlightedCode } from "./CodeBlock.tsx";
import { CodeCopyFrame } from "./CodeCopyFrame.tsx";
import { Tabs } from "./Tabs.tsx";

type FigureView = "render" | "source";

/** 箱に出す知らせ。`error` は描けなかった理由、`info` は描いている途中。 */
export interface FigureNote {
  tone: "info" | "error";
  text: string;
}

/** タブの文字は CSS の `content` で出し、DOM のテキストにしない (DR-0010 §10
 * のコピーボタンと同じ理由: 本文の中にあるので、DOM の文字は画面内検索に
 * 当たり、本文を選んでコピーした文字にも混ざる)。 */
function tabLabel(text: string) {
  return <span class="md-figure-tab-label" data-label={text} />;
}

export function FenceFigure({
  source,
  sourceLang,
  view,
  note,
}: {
  /** ソースのタブに出す文字 (コードブロックの中身)。 */
  source: string;
  /** ソースのハイライトの言語 (fence の言語名と同じ綴り)。 */
  sourceLang: string;
  /** 描いたもの。null の間は描画のタブを押せず、ソースを出す。 */
  view: ComponentChildren | null;
  note: FigureNote | null;
}) {
  const [selected, setSelected] = useState<FigureView>("render");
  const viewable = view !== null;
  const shown: FigureView = viewable ? selected : "source";
  return (
    <CodeCopyFrame text={source}>
      <div class="md-figure">
        <Tabs
          class="tl-thinking-tabs md-figure-tabs"
          tabClass="tl-thinking-tab"
          label="描画 / ソースの切り替え"
          selected={shown}
          onSelect={setSelected}
          items={[
            {
              id: "render",
              label: tabLabel("描画"),
              title: viewable ? "描画" : (note?.text ?? "描画"),
              disabled: !viewable,
            },
            { id: "source", label: tabLabel("ソース"), title: "ソース" },
          ]}
        />
        {note === null ? null : (
          <p class={`md-figure-note md-figure-note-${note.tone}`} role="status">
            {note.text}
          </p>
        )}
        {shown === "render" ? (
          <div class="md-figure-view">{view}</div>
        ) : (
          <HighlightedCode code={source} lang={sourceLang} />
        )}
      </div>
    </CodeCopyFrame>
  );
}
