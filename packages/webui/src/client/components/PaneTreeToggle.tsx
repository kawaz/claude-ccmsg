// セッションのタブの左ペイン (Timeline のエージェントのリスト、Files の
// ツリー) を消す / 出す ☰。グローバルヘッダのハンバーガー (App.tsx の
// #menu-toggle、サイドバーを消す / 出す) と同じ印・同じ「押された状態」の
// 持ち方で、置き場はセッションのヘッダ (タブの並び) の左端 (kawaz 2026-11-26:
// 右のペインのヘッダの左端では位置が動いて触りにくい)。ペインが消えている間も
// ここに残るので、出し直す口が無くなることはない。
import { useApp } from "../context.ts";
import type { SessionTab } from "../locator.ts";
import { savePaneTreeOpen, type PaneTree } from "../pane-trees.ts";
import { useStoreState } from "../useStore.ts";

const PANE_TREE_LABELS: Readonly<Record<PaneTree, { aria: string; name: string }>> = {
  timeline: { aria: "agent list", name: "エージェントのリスト" },
  files: { aria: "file tree", name: "ツリー" },
};

/** 左ペインが在るかと、それを逆にする操作・隠す操作。☰ と、ペインの下の隠す
 * ボタンと、TL の末尾の active agents の行 (DR-0054 §4) が同じ状態・同じ覚え方
 * を使う。 */
export function usePaneTreeOpen(pane: PaneTree): {
  open: boolean;
  toggle: () => void;
  hide: () => void;
} {
  const { store } = useApp();
  const open = useStoreState(store, (s) => s.paneTreesOpen[pane]);
  const set = (next: boolean) => {
    store.dispatch({ type: "pane-tree/set", pane, open: next });
    savePaneTreeOpen(pane, next);
  };
  return { open, toggle: () => set(!open), hide: () => set(false) };
}

/** 左ペインの中身の下に置く隠すボタン (DR-0025 §6)。中身の下に空きがあれば
 * その真ん中に、無ければペインの下端に幅いっぱいの 1 行で出る (どちらになるかは
 * app.css の `.pane-hide` のレイアウトが決める)。出す操作は持たない。 */
export function PaneHideButton({ pane }: { pane: PaneTree }) {
  const { hide } = usePaneTreeOpen(pane);
  return (
    <div class="pane-hide">
      <button
        type="button"
        class="pane-hide-button"
        aria-label={`${PANE_TREE_LABELS[pane].name}を隠す`}
        onClick={hide}
      >
        {"<< 隠す <<"}
      </button>
    </div>
  );
}

/** セッションのヘッダの左端の ☰: 今見ているタブの左ペインを出し入れする。
 * 左ペインを持たないタブ (Status、Terminal) では同じ位置に押せない ☰ を出す
 * (位置を動かさない)。 */
export function SessionPaneToggle({ tab }: { tab: SessionTab }) {
  if (tab === "timeline" || tab === "files") return <PaneTreeToggle pane={tab} />;
  return (
    <button type="button" class="pane-tree-toggle" aria-label="left pane" disabled>
      &#9776;
    </button>
  );
}

function PaneTreeToggle({ pane }: { pane: PaneTree }) {
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
