// ⭐ のフィルタに出す、セッションのブックマークの行 (DR-0058 §5)。
//
// 読み込み済みの範囲 (窓) の外のブックマークは TL に transcript の行が無いので、
// daemon にそのセッションのブックマークの行 (op bookmark_rows) を聞いて、窓の
// 外の分を時刻の位置に合流させる (🔔 / 🔐 の notification_list と同じ形、
// DR-0050 §5)。聞くのはフィルタに入るたびと、フィルタの間にそのセッションの
// ブックマークが変わった時 (別のタブが窓の外の項目に付けた時も出るように)。
import { useEffect } from "preact/hooks";
import type { BookmarkRow } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import type { TimelineFilter } from "../../locator.ts";
import { useStoreState } from "../../useStore.ts";

/** ⭐ のフィルタの間に `sid` のブックマークの行を聞き、store に持つ。答えが
 * まだ無いセッションは undefined。 */
export function useBookmarkRows({
  sid,
  filter,
  uuids,
}: {
  sid: string;
  /** URL のフィルタ (agent の TL では常に null)。 */
  filter: TimelineFilter | null;
  /** そのセッションのブックマーク (store の `bookmarks`)。変わったら聞き直す。 */
  uuids: readonly string[] | undefined;
}): readonly BookmarkRow[] | undefined {
  const { store, ws } = useApp();
  const connected = useStoreState(store, (s) => s.connStatus === "connected");
  const rows = useStoreState(store, (s) => s.bookmarkRows.get(sid));
  const asking = filter === "bookmark" && connected;
  useEffect(() => {
    if (!asking) return;
    void ws
      .bookmarkRows(sid)
      .then((res) => {
        if (res.ok) store.dispatch({ type: "bookmark-rows/loaded", sid, rows: res.rows });
      })
      // 聞けなければ窓の中のブックマークだけが出る。次にフィルタに入った時に
      // 聞き直す。
      .catch(() => {});
  }, [asking, sid, uuids, store, ws]);
  return rows;
}
