// ```mermaid のコードブロックを SVG の文字にする (DR-0010 §13)。mermaid は
// webui の本体の bundle に入れず、daemon が配る配布物 (mermaid-asset.ts) を、
// 最初に描く時に dynamic import で読む。読み込みはページで 1 回で、失敗した
// 時は次に描く時にもう一度読む。描く順は mermaid 自身の render の待ち行列が
// 決める。
import { createContext } from "preact";
import * as v from "valibot";
import { MERMAID_ENTRY_PATH } from "./mermaid-asset.ts";

const MermaidSchema = v.object({ initialize: v.function(), render: v.function() });
const MermaidModuleSchema = v.object({ default: MermaidSchema });
const RenderResultSchema = v.object({ svg: v.string() });

type Mermaid = v.InferOutput<typeof MermaidSchema>;

/** 描いた結果。描けなかった時は人に見せる理由を持つ。 */
export type MermaidResult = { ok: true; svg: string } | { ok: false; reason: string };

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

/** `code` (mermaid の記法) を SVG の文字にする。 */
export async function renderMermaid(code: string): Promise<MermaidResult> {
  const mermaid = await mermaidOnce();
  if (mermaid === null) return { ok: false, reason: UNLOADABLE };
  try {
    const out: unknown = await Reflect.apply(mermaid.render, mermaid, [
      `ccmsg-mermaid-${nextId++}`,
      code,
    ]);
    const parsed = v.safeParse(RenderResultSchema, out);
    return parsed.success
      ? { ok: true, svg: parsed.output.svg }
      : { ok: false, reason: "図を描画できない (mermaid の結果が想定と違う)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `図を描画できない: ${message}` };
  }
}

/** 描く関数。既定は上の renderMermaid で、テストが差し替える。 */
export const MermaidRendererContext =
  createContext<(code: string) => Promise<MermaidResult>>(renderMermaid);
