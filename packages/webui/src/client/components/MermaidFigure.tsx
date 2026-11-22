/** @jsxImportSource preact */
// ```mermaid のコードブロック (DR-0010 §13)。§12 と同じ箱に、描画 / ソースの
// タブと、描けた図にはライト / ダーク / システムの配色のタブを置く。どちらの
// 選択もページ全体で共通 (mermaid-prefs.ts)。
//
// - 描画を選んでいる時だけ mermaid で描く。描けるまではソースを出して「描画中」
//   を知らせ、記法の誤りや読み込めない時は、ソースのまま理由を出す
// - 図はライトとダークの 2 通りで描き、2 つの img として置く。どちらを見せるかは
//   CSS だけで決める (配色を変えても描き直さない)
// - 描いた図は画像を decode してから差し込み、差し込みで変わる位置を 1 回で
//   保つ (keep-scroll.ts の holdAround)。decode できない図は、ソースのまま理由を
//   出す
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { holdAround } from "../keep-scroll.ts";
import {
  setMermaidTheme,
  setMermaidView,
  useMermaidPrefs,
  type MermaidTheme,
} from "../mermaid-prefs.ts";
import { MermaidRendererContext, type MermaidResult } from "../mermaid-render.ts";
import { svgFigure, type SvgFigure } from "../svg-figure.ts";
import { FenceFigure, tabLabel, type FigureNote } from "./FenceFigure.tsx";
import { Tabs } from "./Tabs.tsx";

const BROKEN = "この mermaid は描画できないのでソースを表示している";

/** 描けた図 (2 通りの配色の img の材料) か、描けなかった理由。 */
type Drawn = { ok: true; light: SvgFigure; dark: SvgFigure } | { ok: false; reason: string };

/** 画像として読めるかを、文書に入れる前に確かめる。同じ文書で読み終えた画像は
 * 同じ src の img に差し込んだ時点で大きさを持つ (HTML の list of available
 * images) ので、差し込みで変わる位置を 1 回で保てる。 */
async function decodes(figure: SvgFigure): Promise<boolean> {
  const img = new Image();
  img.src = figure.src;
  try {
    await img.decode();
    return true;
  } catch {
    return false;
  }
}

async function prepare(result: MermaidResult): Promise<Drawn> {
  if (!result.ok) return result;
  const light = svgFigure(result.svg.light, "mermaid");
  const dark = svgFigure(result.svg.dark, "mermaid");
  const ok = (await Promise.all([decodes(light), decodes(dark)])).every(Boolean);
  return ok ? { ok: true, light, dark } : { ok: false, reason: BROKEN };
}

const THEMES: readonly (readonly [MermaidTheme, string])[] = [
  ["light", "ライト"],
  ["dark", "ダーク"],
  ["system", "システム"],
];

function ThemeTabs({ theme }: { theme: MermaidTheme }) {
  return (
    <Tabs
      class="tl-thinking-tabs md-figure-tabs"
      tabClass="tl-thinking-tab"
      label="図の配色"
      selected={theme}
      onSelect={setMermaidTheme}
      items={THEMES.map(([id, text]) => ({ id, label: tabLabel(text), title: `${text}の配色` }))}
    />
  );
}

export function MermaidFigure({ code }: { code: string }) {
  const render = useContext(MermaidRendererContext);
  const prefs = useMermaidPrefs();
  const box = useRef<HTMLDivElement | null>(null);
  // 結果は描いた元の文字と組で持つ。中身が替わったら古い結果を出さない。
  const [drawn, setDrawn] = useState<{ code: string; result: Drawn } | null>(null);
  // 読み込みに失敗した img の src。中身が替われば (src が替われば) また試す。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const current = drawn !== null && drawn.code === code ? drawn.result : null;
  const wanted = prefs.view === "render" && current === null;
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void render(code)
      .then(prepare)
      .then((result) => {
        if (cancelled) return;
        const keep = box.current === null ? null : holdAround(box.current);
        setDrawn({ code, result });
        if (keep !== null) requestAnimationFrame(keep);
      });
    return () => {
      cancelled = true;
    };
  }, [code, render, wanted]);

  const result: Drawn | null =
    current?.ok === true && (failedSrc === current.light.src || failedSrc === current.dark.src)
      ? { ok: false, reason: BROKEN }
      : current;
  let note: FigureNote | null = null;
  if (result?.ok === false) note = { tone: "error", text: result.reason };
  else if (result === null && prefs.view === "render") {
    note = { tone: "info", text: "mermaid で描画中…" };
  }
  const view =
    result?.ok === true ? (
      <>
        {[
          { figure: result.light, cls: "md-mermaid-img-light" },
          { figure: result.dark, cls: "md-mermaid-img-dark" },
        ].map(({ figure, cls }) => (
          <img
            key={cls}
            class={
              `md-figure-img md-mermaid-img ${cls}` + (figure.sized ? "" : " md-figure-img-unsized")
            }
            data-mermaid-theme={prefs.theme}
            src={figure.src}
            alt={figure.alt}
            onError={() => setFailedSrc(figure.src)}
          />
        ))}
      </>
    ) : null;
  return (
    <FenceFigure
      boxRef={box}
      source={code}
      sourceLang="mermaid"
      view={view}
      note={note}
      choice={{ selected: prefs.view, select: setMermaidView }}
      unavailable={result?.ok === false ? result.reason : null}
      tools={
        result?.ok === true && prefs.view === "render" ? <ThemeTabs theme={prefs.theme} /> : null
      }
    />
  );
}
