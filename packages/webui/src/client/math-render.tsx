/** @jsxImportSource preact */
// TeX の数式を描く (DR-0010 §14)。描く部品 (math-typeset.ts: Temml・
// DOMPurify・Temml の stylesheet) は webui の本体の bundle に入れず、数式の
// ある markdown が描かれた時に dynamic import で読む。読み込みはページで
// 1 回で、読めなかった時は次に数式を描く時にもう一度読む。
//
// Temml の MathML はタグ・属性・文字の木で受け取り、ここで Preact の節点に
// する (MathML の名前空間は Preact が `math` の下で付ける)。式番号は 1 つの
// markdown の文書の頭から数えて文字で入れる: Temml の stylesheet は CSS の
// counter で数えるが、counter は吹き出しや折りたたみの containment で閉じ、
// 全部 (1) になる。
import { createContext, h, type ComponentChild, type ComponentChildren } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { setBounded } from "./bounded-map.ts";
import type { MathTree, TypesetResult } from "./math-typeset.ts";

export type MathTypeset = (tex: string, display: boolean) => TypesetResult;

/** 描く部品の状態。 */
export type MathEngine =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; typeset: MathTypeset };

let loaded: MathTypeset | null = null;
let loading: Promise<MathTypeset | null> | null = null;

async function load(): Promise<MathTypeset | null> {
  try {
    const mod = await import("./math-typeset.ts");
    mod.installMathStyles();
    return mod.typesetMath;
  } catch {
    return null;
  }
}

/** 描く部品を読む。読めなければ null (次に呼んだ時にもう一度読む)。 */
export function loadMathTypeset(): Promise<MathTypeset | null> {
  if (loaded !== null) return Promise.resolve(loaded);
  loading ??= load().then((typeset) => {
    loaded = typeset;
    loading = null;
    return typeset;
  });
  return loading;
}

/** 描く部品を読む関数。既定は上の loadMathTypeset で、テストが差し替える
 * (happy-dom の MathML の要素は DOMPurify の in-place のサニタイズを通らない
 * ので、Temml と DOMPurify の実物は e2e が確かめる)。 */
export const MathTypesetLoaderContext =
  createContext<() => Promise<MathTypeset | null>>(loadMathTypeset);

/** `needed` の間、描く部品を読んで返す。既に読んであれば最初の描画から使う。 */
export function useMathEngine(needed: boolean): MathEngine {
  const loader = useContext(MathTypesetLoaderContext);
  const [engine, setEngine] = useState<MathEngine>(() =>
    loader === loadMathTypeset && loaded !== null
      ? { state: "ready", typeset: loaded }
      : { state: "loading" },
  );
  useEffect(() => {
    if (!needed || engine.state === "ready") return;
    let alive = true;
    void loader().then((typeset) => {
      if (!alive) return;
      setEngine(typeset === null ? { state: "failed" } : { state: "ready", typeset });
    });
    return () => {
      alive = false;
    };
  }, [needed, engine.state, loader]);
  return engine;
}

/** 1 つの markdown の文書の中で、描いた式番号を数える。 */
export interface EquationCounter {
  count: number;
}

const EQUATION_NUMBER_CLASS = "tml-eqn";

function hasClass(attrs: readonly [string, string][], name: string): boolean {
  return attrs.some(([key, value]) => key === "class" && value.split(/\s+/).includes(name));
}

/** Temml の木を Preact の節点にする。式番号の要素 (`mtext` の中の
 * `span.tml-eqn`) は、数えた番号の文字そのものにする (HTML の `span` を
 * MathML の中に作らない)。 */
export function mathTreeToVNode(
  tree: MathTree,
  counter: EquationCounter,
  key?: string,
): ComponentChild {
  if (hasClass(tree.attrs, EQUATION_NUMBER_CLASS)) {
    counter.count += 1;
    return `(${counter.count})`;
  }
  const props: Record<string, string> = {};
  for (const [name, value] of tree.attrs) props[name] = value;
  if (key !== undefined) props["key"] = key;
  const children: ComponentChildren[] = tree.children.map((child, i) =>
    typeof child === "string" ? child : mathTreeToVNode(child, counter, String(i)),
  );
  return h(tree.tag, props, ...children);
}

/** 前後の空白を除いた TeX (末尾の制御空白 `\ ` は残す)。 */
export function trimTex(tex: string): string {
  const trimmed = tex.trim();
  const slashes = /\\*$/.exec(trimmed)?.[0].length ?? 0;
  return slashes % 2 === 1 && trimmed.length < tex.trimStart().length ? `${trimmed} ` : trimmed;
}

/** 1 つの数式を描いた結果。 */
export type MathOutcome =
  | { kind: "math"; node: ComponentChild }
  | { kind: "pending" }
  | { kind: "error"; message: string };

/** 描く部品の読み込みに失敗した時の理由。 */
const UNLOADABLE = "数式の描画の部品を読み込めない";

/** 描いた結果を覚える (同じ数式は同じ結果)。式番号は描くたびに数え直すので、
 * 覚えるのは Temml の木まで。 */
const caches = new WeakMap<MathTypeset, Map<string, TypesetResult>>();
const CACHE_LIMIT = 500;

function typesetCached(typeset: MathTypeset, tex: string, display: boolean): TypesetResult {
  let cache = caches.get(typeset);
  if (cache === undefined) {
    cache = new Map();
    caches.set(typeset, cache);
  }
  const key = `${display ? "D" : "I"}${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const result = typeset(tex, display);
  setBounded(cache, key, result, CACHE_LIMIT);
  return result;
}

export function renderMath(
  tex: string,
  display: boolean,
  engine: MathEngine,
  counter: EquationCounter,
): MathOutcome {
  if (engine.state === "loading") return { kind: "pending" };
  if (engine.state === "failed") return { kind: "error", message: UNLOADABLE };
  const result = typesetCached(engine.typeset, tex, display);
  if (!result.ok) return { kind: "error", message: result.message };
  return { kind: "math", node: mathTreeToVNode(result.tree, counter) };
}
