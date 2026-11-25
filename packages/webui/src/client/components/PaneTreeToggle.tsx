// セッションのタブの左ペイン (Timeline のエージェントのリスト、Files の
// ツリー) を消す / 出す ☰。グローバルヘッダのハンバーガー (App.tsx の
// #menu-toggle、サイドバーを消す / 出す) と同じ印・同じ「押された状態」の
// 持ち方で、置き場は右のペインのヘッダの左端 (TL のツールバー、Files の
// プレビューのヘッダ)。ペインが消えている間もここに残るので、出し直す口が
// 無くなることはない。
import { useApp } from "../context.ts";
import { savePaneTreeOpen, type PaneTree } from "../pane-trees.ts";
import { useStoreState } from "../useStore.ts";

const PANE_TREE_LABELS: Readonly<Record<PaneTree, { aria: string; name: string }>> = {
  timeline: { aria: "agent list", name: "エージェントのリスト" },
  files: { aria: "file tree", name: "ツリー" },
};

/** 左ペインが在るかと、それを逆にする操作。☰ と、TL の末尾の active agents の
 * 行 (DR-0054 §4) が同じ状態・同じ覚え方を使う。 */
export function usePaneTreeOpen(pane: PaneTree): { open: boolean; toggle: () => void } {
  const { store } = useApp();
  const open = useStoreState(store, (s) => s.paneTreesOpen[pane]);
  return {
    open,
    toggle: () => {
      store.dispatch({ type: "pane-tree/set", pane, open: !open });
      savePaneTreeOpen(pane, !open);
    },
  };
}

export function PaneTreeToggle({ pane }: { pane: PaneTree }) {
  const { open, toggle } = usePaneTreeOpen(pane);
  const label = PANE_TREE_LABELS[pane];
  return (
    <button
      type="button"
      class="pane-tree-toggle"
      aria-label={label.aria}
      aria-pressed={open}
      title={open ? `${label.name}を隠す` : `${label.name}を出す`}
      onClick={toggle}
    >
      &#9776;
    </button>
  );
}
