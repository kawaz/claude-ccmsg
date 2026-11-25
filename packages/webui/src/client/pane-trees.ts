// セッションの 2 つのタブの左ペイン (Timeline のエージェントのリスト、Files の
// ツリー) が在るか。サイドバーの在り / 無し (store.ts の sidebarOpen) と同じ
// 扱いにする: 既定は「在る」、切り替え口は各ヘッダの ☰ (PaneTreeToggle) と、
// Timeline の末尾の active agents の行 (DR-0054 §4、☰ と同じ操作)、覚えるのはその窓の中だけ (sessionStorage、storage.ts の表の「窓ごとの状態」)。
// 1 つの窓で消したことが別の窓や次に開くタブに伝染しない。
//
// Timeline のエージェントのリストは、開いた時の幅がスマホの幅 (layoutNarrow)
// なら既定を「無い」にする (DR-0025、kawaz 2026-11-24)。既定が効くのは覚えた
// 値が無い時だけで、決めるのは開いた時の 1 度 (後で幅が変わっても切り替えない)。
//
// どのセッションを見ていても同じ値を使う。消す目的 (本文を広く見る) は
// セッションごとに変わらない。
import { parseWith } from "@ccmsg/protocol";
import * as v from "valibot";
import { flagText, readSessionStorage, writeSessionStorage } from "./storage.ts";

export type PaneTree = "timeline" | "files";

export type PaneTreesOpen = Readonly<Record<PaneTree, boolean>>;

const PANE_TREE_OPEN_KEYS: Readonly<Record<PaneTree, string>> = {
  timeline: "ccmsg.timelineTreeOpen",
  files: "ccmsg.filesTreeOpen",
};

const PaneTreeOpenTextSchema = flagText(v.boolean());

function initialPaneTreeOpen(pane: PaneTree, byDefault: boolean): boolean {
  const raw = readSessionStorage(PANE_TREE_OPEN_KEYS[pane]);
  const read = raw === null ? null : parseWith(PaneTreeOpenTextSchema, raw);
  return read?.ok ? read.value : byDefault;
}

/** `narrow`: 開いた時の幅がスマホの幅か (layout-mode.ts の layoutNarrow)。 */
export function initialPaneTreesOpen(narrow: boolean): PaneTreesOpen {
  return {
    timeline: initialPaneTreeOpen("timeline", !narrow),
    files: initialPaneTreeOpen("files", true),
  };
}

/** 書くのは人が切り替え口を押した時だけ (reducer は純粋なまま、DR-0005 §1)。 */
export function savePaneTreeOpen(pane: PaneTree, open: boolean): void {
  writeSessionStorage(PANE_TREE_OPEN_KEYS[pane], open ? "1" : "0");
}
