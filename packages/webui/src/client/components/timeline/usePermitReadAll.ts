// 🔐 のフィルタの「全て既読」(DR-0040 §7、DR-0050 §4)。
//
// フィルタに出ている許可依頼のうち未読のもの (daemon の ev:"permit_state" の
// unread) を、許可はせずに permit_read で既読にする。バブルの「既読」と同じく
// 非楽観で、成功すると daemon が新しい ev:"permit_state" を全タブに送る。
import { useCallback, useMemo, useState } from "preact/hooks";
import { useApp } from "../../context.ts";
import { useStoreState } from "../../useStore.ts";

export function usePermitReadAll({
  shownIds,
}: {
  /** TL に出ている許可依頼の tool_use の id (窓の中の行と、フィルタ中に
   * 合流させた窓の外の依頼)。 */
  shownIds: readonly string[];
}): {
  /** `shownIds` のうち未読のもの。「全て既読」が既読にするもの。 */
  unread: readonly string[];
  /** `unread` を全部既読にする (許可済みにはしない)。 */
  markRead: () => void;
  /** 既読にできなかった理由。次に成功するまで残す。 */
  readError: string | null;
} {
  const { store, ws } = useApp();
  const permitUnread = useStoreState(store, (s) => s.permitUnread);
  const unread = useMemo(() => {
    const ids = new Set(permitUnread.map((permit) => permit.tool_use_id));
    return shownIds.filter((id) => ids.has(id));
  }, [permitUnread, shownIds]);
  const [readError, setReadError] = useState<string | null>(null);
  const markRead = useCallback((): void => {
    if (unread.length === 0) return;
    void ws
      .permitRead(unread)
      .then((res) => setReadError(res.ok ? null : res.error.msg))
      .catch(() => setReadError("接続エラーのため既読にできませんでした"));
  }, [ws, unread]);
  return { unread, markRead, readError };
}
