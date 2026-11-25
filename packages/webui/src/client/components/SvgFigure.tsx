/** @jsxImportSource preact */
// ```svg のコードブロックを図として見せる (DR-0010 §12)。
//
// - 図は `<img>` の data URL で描き、SVG を DOM に入れない (script・イベント
//   属性・外部参照が動かない)
// - 描画できない SVG は img の error の event でソースに切り替え、理由を出す
// - 図は白い下地に置く (CSS)。dark でも透明な地の黒い線が見える。中身は任意の
//   画像なので、mermaid の図のような配色の切り替えは付けない
// - 「実行」(DR-0067 §3): 押した時だけ `sandbox_grant_svg` で図にする中身
//   (`xmlns` を補った後の文字) を daemon に預け、preview と同じ sandbox
//   origin の URL を別のタブで開く。スクリプトが動くのはそのタブの中だけ。
//   sandbox origin の無い環境では区画を出さない。描画できない SVG と、
//   FS_READ_MAX_BYTES を超える中身は押せない
import { FS_READ_MAX_BYTES } from "@ccmsg/protocol";
import { useContext, useMemo, useState } from "preact/hooks";
import { AppContext, useSandboxAvailable } from "../context.ts";
import { openSandboxTab } from "../sandbox-open.ts";
import { svgFigure, svgText } from "../svg-figure.ts";
import { FenceFigure, type FigureRun } from "./FenceFigure.tsx";

/** 「実行」の区画の title (.svg のファイルのビューアと共通)。 */
export const SVG_RUN_TITLE = "別 origin の新しいタブで SVG として実行する";
/** 描画できない SVG の「実行」を押せない理由。 */
export const SVG_RUN_UNRENDERABLE = "この SVG は描画できないので実行できない";
const RUN_TOO_LARGE = `この SVG は ${Math.floor(FS_READ_MAX_BYTES / 1024)}KB を超えるので実行できない`;

export function SvgFigure({ code }: { code: string }) {
  const figure = useMemo(() => svgFigure(code, "SVG"), [code]);
  // 読み込みに失敗した src。中身が替われば (src が替われば) また描画を試す。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === figure.src;
  // 実行で開けなかった理由。その src の間だけ出す。
  const [runError, setRunError] = useState<{ src: string; text: string } | null>(null);
  const app = useContext(AppContext);
  const sandboxAvailable = useSandboxAvailable();
  // 実行で渡す文字 (img が描くのと同じ) と、それが大きすぎて渡せないか。
  const { runText, tooLarge } = useMemo(() => {
    const text = svgText(code);
    return {
      runText: text,
      tooLarge: new TextEncoder().encode(text).byteLength > FS_READ_MAX_BYTES,
    };
  }, [code]);
  const run: FigureRun | undefined =
    app === null || !sandboxAvailable
      ? undefined
      : {
          title: SVG_RUN_TITLE,
          unavailable: failed ? SVG_RUN_UNRENDERABLE : tooLarge ? RUN_TOO_LARGE : null,
          start: () => {
            const src = figure.src;
            setRunError(null);
            openSandboxTab(
              () => app.ws.sandboxGrantSvg(runText),
              (granted) => granted.url,
              (text) => setRunError({ src, text }),
            );
          },
        };
  return (
    <FenceFigure
      source={code}
      // ハイライトは html の文法で読む (xml の文法を持たないため)。
      sourceLang="html"
      note={
        failed
          ? { tone: "error", text: "この SVG は描画できないのでソースを表示している" }
          : runError !== null && runError.src === figure.src
            ? { tone: "error", text: runError.text }
            : null
      }
      run={run}
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
