// ```mermaid のコードブロックを SVG の文字にする (DR-0010 §13)。mermaid は
// webui の本体の bundle に入れず、daemon が配る配布物 (mermaid-asset.ts) を、
// 最初に描く時に dynamic import で読む。読み込みはページで 1 回で、失敗した
// 時は次に描く時にもう一度読む。
//
// 図は mermaid の theme `default` と `dark` の 2 通りで描く (配色の切り替えは
// 表示の側が CSS で選ぶ)。theme は mermaid の全体の設定 (`initialize`) なので
// 描くたびに設定してから `render` し、描画は 1 本の列に並べて、別の図の描画が
// 間に入って theme が変わらないようにする。図の中の `%%{init}%%` や front matter
// の theme はこちらの設定より勝つので、その図は 2 通りとも同じ見た目になる。
import { createContext } from "preact";
import * as v from "valibot";
import { MERMAID_ENTRY_PATH } from "./mermaid-asset.ts";

const MermaidSchema = v.object({ initialize: v.function(), render: v.function() });
const MermaidModuleSchema = v.object({ default: MermaidSchema });
const RenderResultSchema = v.object({ svg: v.string() });

type Mermaid = v.InferOutput<typeof MermaidSchema>;

/** 2 通りの配色で描いた SVG の文字。 */
export interface MermaidSvgs {
  light: string;
  dark: string;
}

/** 描いた結果。描けなかった時は人に見せる理由を持つ。 */
export type MermaidResult = { ok: true; svg: MermaidSvgs } | { ok: false; reason: string };

/** img で同じに描けるよう、ラベルは foreignObject を使わない SVG の文字にし
 * (`htmlLabels: false`)、図の大きさを明示する (`useMaxWidth: false`)。
 * `securityLevel: "strict"` は記法の中の HTML とクリックの動作を止める。 */
const CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: false },
  sequence: { useMaxWidth: false },
  class: { useMaxWidth: false },
  state: { useMaxWidth: false },
  er: { useMaxWidth: false },
  gantt: { useMaxWidth: false },
} as const;

const UNLOADABLE = "図を描画できない (mermaid を読み込めない)";

let loading: Promise<Mermaid | null> | null = null;

async function loadMermaid(): Promise<Mermaid | null> {
  try {
    // Design rationale: 入口の URL を変数で渡し、Bun.build にこの import を
    // 解決させない。mermaid は本体の bundle に入れず、daemon が配る。
    const url: string = MERMAID_ENTRY_PATH;
    const loaded: unknown = await import(url);
    const parsed = v.safeParse(MermaidModuleSchema, loaded);
    if (!parsed.success) return null;
    const mermaid = parsed.output.default;
    Reflect.apply(mermaid.initialize, mermaid, [CONFIG]);
    return mermaid;
  } catch {
    return null;
  }
}

function mermaidOnce(): Promise<Mermaid | null> {
  loading ??= loadMermaid().then((mermaid) => {
    // 読み込めなかった時は覚えず、次に描く時にもう一度読む。
    if (mermaid === null) loading = null;
    return mermaid;
  });
  return loading;
}

let nextId = 1;

type MermaidTheme = "default" | "dark";

async function drawIn(mermaid: Mermaid, code: string, theme: MermaidTheme): Promise<string> {
  Reflect.apply(mermaid.initialize, mermaid, [{ ...CONFIG, theme }]);
  const out: unknown = await Reflect.apply(mermaid.render, mermaid, [
    `ccmsg-mermaid-${nextId++}`,
    code,
  ]);
  const parsed = v.safeParse(RenderResultSchema, out);
  if (!parsed.success) throw new UnexpectedResult();
  return parsed.output.svg;
}

class UnexpectedResult extends Error {}

let queue: Promise<void> = Promise.resolve();

/** `task` を、先に並んだ描画が全部終わってから走らせる。 */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** `code` (mermaid の記法) を 2 通りの配色の SVG の文字にする。 */
export async function renderMermaid(code: string): Promise<MermaidResult> {
  const mermaid = await mermaidOnce();
  if (mermaid === null) return { ok: false, reason: UNLOADABLE };
  return serial(async (): Promise<MermaidResult> => {
    try {
      const light = await drawIn(mermaid, code, "default");
      const dark = await drawIn(mermaid, code, "dark");
      return { ok: true, svg: { light, dark } };
    } catch (err) {
      if (err instanceof UnexpectedResult) {
        return { ok: false, reason: "図を描画できない (mermaid の結果が想定と違う)" };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `図を描画できない: ${message}` };
    }
  });
}

/** 描く関数。既定は上の renderMermaid で、テストが差し替える。 */
export const MermaidRendererContext =
  createContext<(code: string) => Promise<MermaidResult>>(renderMermaid);
