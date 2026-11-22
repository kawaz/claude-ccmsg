// セッションの 2 つのタブの左ペイン (Timeline のエージェントのリスト、Files の
// ツリー) が在るか。サイドバーの在り / 無し (store.ts の sidebarOpen) と同じ
// 扱いにする: 既定は「在る」、切り替え口は各ヘッダの ☰ だけ (PaneTreeToggle)、
// 覚えるのはその窓の中だけ (sessionStorage、storage.ts の表の「窓ごとの状態」)。
// 1 つの窓で消したことが別の窓や次に開くタブに伝染しない。
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

const PaneTreeOpenSchema = v.optional(v.boolean(), true);
const PaneTreeOpenTextSchema = flagText(PaneTreeOpenSchema);

function initialPaneTreeOpen(pane: PaneTree): boolean {
  const raw = readSessionStorage(PANE_TREE_OPEN_KEYS[pane]);
  const read = raw === null ? null : parseWith(PaneTreeOpenTextSchema, raw);
  return read?.ok ? read.value : v.getDefault(PaneTreeOpenSchema);
}

export function initialPaneTreesOpen(): PaneTreesOpen {
  return { timeline: initialPaneTreeOpen("timeline"), files: initialPaneTreeOpen("files") };
}

/** 書くのは人が ☰ を押した時だけ (reducer は純粋なまま、DR-0005 §1)。 */
export function savePaneTreeOpen(pane: PaneTree, open: boolean): void {
  writeSessionStorage(PANE_TREE_OPEN_KEYS[pane], open ? "1" : "0");
}
