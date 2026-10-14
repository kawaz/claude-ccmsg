// この Timeline の fold の開閉 (FoldOpenStore) と、nav が閉じた fold の中へ
// 飛ぶための「行を囲む fold を開く」操作。
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { FoldOpenStore } from "../../fold-open-store.ts";
import { foldPathsByOffset } from "../../fold-tree.ts";
import type { TimelineGroup } from "../../transcript-model.ts";

/** `autoOpenRevision` が進むと、読み手が開け閉めした状態を捨てて各 fold の
 * 既定値 (auto open 設定) に戻す。 */
export function useTimelineFolds(
  autoOpenRevision: number,
  groups: readonly TimelineGroup[],
): {
  store: FoldOpenStore;
  /** どこかの fold の本文が初めて描かれるたびに進む。閉じていた fold の中の
   * 要素を待つ nav (検索の ↑/↓) がこれで再開する。 */
  mountRevision: number;
  /** `offset` の行を囲む fold をすべて開く。 */
  openFoldsAt: (offset: number | undefined) => void;
} {
  // One store per Timeline instance, and an instance shows one session
  // (callers key it by sid): the offsets its keys are built from mean nothing
  // in another transcript. An auto-open settings change only drops the
  // overrides, so every fold falls back to the new default.
  const [store] = useState(() => new FoldOpenStore());
  useEffect(() => store.reset(), [store, autoOpenRevision]);
  const [mountRevision, setMountRevision] = useState(0);
  useEffect(() => store.subscribeMounted(() => setMountRevision((n) => n + 1)), [store]);
  // Which folds enclose each line, so that nav can open them by key. Only the
  // fold side has entries here; a boundary bubble is always mounted.
  const foldPaths = useMemo(() => foldPathsByOffset(groups), [groups]);
  const openFoldsAt = useCallback(
    (offset: number | undefined) => {
      if (offset === undefined) return;
      for (const key of foldPaths.get(offset) ?? []) store.set(key, true);
    },
    [foldPaths, store],
  );
  return { store, mountRevision, openFoldsAt };
}
