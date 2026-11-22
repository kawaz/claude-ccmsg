// mermaid の図の見せ方の選択 (DR-0010 §13)。どの図で選んでも、ページ上の全部の
// mermaid の図に効き、localStorage に残る。
//
// - 描画 / ソース (`view`): 既定は描画。ソースの間は mermaid で描かない
// - 配色 (`theme`): ライト / ダーク / システム。既定はシステム
//   (prefers-color-scheme に従い、OS の切り替えにも追う)。図はライトとダークの
//   2 通りで描いておき、どちらを見せるかは CSS だけで決める (描き直さない)
//
// ページ全体の好みなので、図ごとの state でなくモジュールに置く
// (raw-view-mode.ts と同じ形の最小の store)。
import * as v from "valibot";
import { readStorage, writeStorage } from "./storage.ts";
import { useStoreState, type ReadableStore } from "./useStore.ts";

export const MermaidViewSchema = v.picklist(["render", "source"]);
export type MermaidView = v.InferOutput<typeof MermaidViewSchema>;
export const MermaidThemeSchema = v.picklist(["light", "dark", "system"]);
export type MermaidTheme = v.InferOutput<typeof MermaidThemeSchema>;

export interface MermaidPrefs {
  view: MermaidView;
  theme: MermaidTheme;
}

export const MERMAID_VIEW_KEY = "ccmsg.mermaid.view";
export const MERMAID_THEME_KEY = "ccmsg.mermaid.theme";

const DEFAULT_PREFS: MermaidPrefs = { view: "render", theme: "system" };

/** 保存された値を読む。無い・読めない値は既定にする (例外にしない)。 */
export function parseMermaidPrefs(view: string | null, theme: string | null): MermaidPrefs {
  const readView = v.safeParse(MermaidViewSchema, view);
  const readTheme = v.safeParse(MermaidThemeSchema, theme);
  return {
    view: readView.success ? readView.output : DEFAULT_PREFS.view,
    theme: readTheme.success ? readTheme.output : DEFAULT_PREFS.theme,
  };
}

let prefs: MermaidPrefs | null = null;
const listeners = new Set<() => void>();

/** 今の選択。最初の 1 回だけ localStorage から読んで覚える。 */
export function getMermaidPrefs(): MermaidPrefs {
  prefs ??= parseMermaidPrefs(readStorage(MERMAID_VIEW_KEY), readStorage(MERMAID_THEME_KEY));
  return prefs;
}

function update(next: MermaidPrefs): void {
  prefs = next;
  for (const listener of listeners) listener();
}

export function setMermaidView(view: MermaidView): void {
  const now = getMermaidPrefs();
  if (now.view === view) return;
  writeStorage(MERMAID_VIEW_KEY, view);
  update({ ...now, view });
}

export function setMermaidTheme(theme: MermaidTheme): void {
  const now = getMermaidPrefs();
  if (now.theme === theme) return;
  writeStorage(MERMAID_THEME_KEY, theme);
  update({ ...now, theme });
}

const mermaidPrefsStore: ReadableStore<MermaidPrefs> = {
  getState: getMermaidPrefs,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const wholePrefs = (value: MermaidPrefs): MermaidPrefs => value;

/** 呼び出し元を選択の変化で描き直させる。 */
export function useMermaidPrefs(): MermaidPrefs {
  return useStoreState(mermaidPrefsStore, wholePrefs);
}
