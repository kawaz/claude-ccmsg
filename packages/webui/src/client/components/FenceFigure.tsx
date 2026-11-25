/** @jsxImportSource preact */
// コードブロックを描いて見せる箱 (DR-0010 §12)。図にする種類 (svg / mermaid /
// 数式) が共通に使う: 罫で囲んだ 1 つの箱に、上から切り替えの列 (「描画 /
// ソース」のタブと、種類ごとの切り替え)、知らせの文、描いたものかソースを置く。
//
// - 描画 / ソースの選択は、渡されなければブロックごとで保存しない (既定は描画)。
//   mermaid はページ全体で共通の選択を渡す (mermaid-prefs.ts)
// - 描画のタブを選べない時 (描けない理由がある時) は、押せなくしてソースを出す
// - 描画を選んでいても描いたものがまだ無い間は、ソースを出す
// - 切り替えの列の中を押しても、押した列は画面上で動かない (keep-scroll.ts)。
//   押した時 (pointerdown / keydown) に位置を測り、選択を変えた click の後で戻す
// - コピーボタンは箱に 1 つで、写すのはソース
// - 実行 (svg だけ、DR-0067 §3) は切り替えでなく開く操作の区画で、押しても
//   選択は動かない。渡されなければ区画は無い
import type { ComponentChildren, Ref } from "preact";
import { useState } from "preact/hooks";
import { keepSwitch, pressSwitch } from "../keep-scroll.ts";
import { HighlightedCode } from "./CodeBlock.tsx";
import { CodeCopyFrame } from "./CodeCopyFrame.tsx";
import { Tabs } from "./Tabs.tsx";

export type FigureView = "render" | "source";

/** 箱に出す知らせ。`error` は描けなかった理由、`info` は描いている途中。 */
export interface FigureNote {
  tone: "info" | "error";
  text: string;
}

/** 「実行」の区画 (DR-0067 §3)。押すと `start` を呼び、選択は変えない。 */
export interface FigureRun {
  /** 押せる時の title (押すと何が起きるか)。 */
  title: string;
  /** 押せない理由 (null は押せる)。 */
  unavailable: string | null;
  start: () => void;
}

/** 箱の外で持つ描画 / ソースの選択。 */
export interface FigureChoice {
  selected: FigureView;
  select: (view: FigureView) => void;
}

/** タブの文字は CSS の `content` で出し、DOM のテキストにしない (DR-0010 §10
 * のコピーボタンと同じ理由: 本文の中にあるので、DOM の文字は画面内検索に
 * 当たり、本文を選んでコピーした文字にも混ざる)。 */
export function tabLabel(text: string) {
  return <span class="md-figure-tab-label" data-label={text} />;
}

export function FenceFigure({
  source,
  sourceLang,
  view,
  note,
  choice,
  unavailable,
  run,
  tools,
  boxRef,
}: {
  /** ソースのタブに出す文字 (コードブロックの中身)。 */
  source: string;
  /** ソースのハイライトの言語 (fence の言語名と同じ綴り)。 */
  sourceLang: string;
  /** 描いたもの。null の間は、描画を選んでいてもソースを出す。 */
  view: ComponentChildren | null;
  note: FigureNote | null;
  /** 箱の外で持つ選択。無ければブロックごとに持つ。 */
  choice?: FigureChoice;
  /** 描画のタブを押せない理由 (null は押せる)。渡さなければ、描いたものが
   * 無い時に知らせの文 (それも無ければ「描画」) を理由にして押せなくする。 */
  unavailable?: string | null;
  /** 「実行」の区画。無ければ区画を出さない。 */
  run?: FigureRun;
  /** 描画 / ソースのタブの横に並べる切り替え (mermaid の配色)。 */
  tools?: ComponentChildren;
  /** 箱 (`.md-figure`) の要素。 */
  boxRef?: Ref<HTMLDivElement>;
}) {
  const [local, setLocal] = useState<FigureView>("render");
  const selected = choice?.selected ?? local;
  const select = choice?.select ?? setLocal;
  const blocked =
    unavailable !== undefined ? unavailable : view === null ? (note?.text ?? "描画") : null;
  const shown: FigureView = blocked === null ? selected : "source";
  return (
    <CodeCopyFrame text={source}>
      <div class="md-figure" ref={boxRef}>
        <div
          class="md-figure-bar"
          onPointerDownCapture={(e) => pressSwitch(e.currentTarget)}
          onKeyDownCapture={(e) => pressSwitch(e.currentTarget)}
          onClick={(e) => keepSwitch(e.currentTarget)}
        >
          <Tabs
            class="tl-thinking-tabs md-figure-tabs"
            tabClass="tl-thinking-tab"
            label="描画 / ソースの切り替え"
            selected={shown}
            onSelect={(id) => (id === "run" ? run?.start() : select(id))}
            items={[
              {
                id: "render",
                label: tabLabel("描画"),
                title: blocked ?? "描画",
                disabled: blocked !== null,
              },
              { id: "source", label: tabLabel("ソース"), title: "ソース" },
              ...(run === undefined
                ? []
                : [
                    {
                      id: "run" as const,
                      label: tabLabel("実行"),
                      title: run.unavailable ?? run.title,
                      disabled: run.unavailable !== null,
                    },
                  ]),
            ]}
          />
          {tools}
        </div>
        {note === null ? null : (
          <p class={`md-figure-note md-figure-note-${note.tone}`} role="status">
            {note.text}
          </p>
        )}
        {shown === "render" && view !== null ? (
          <div class="md-figure-view">{view}</div>
        ) : (
          <HighlightedCode code={source} lang={sourceLang} />
        )}
      </div>
    </CodeCopyFrame>
  );
}
