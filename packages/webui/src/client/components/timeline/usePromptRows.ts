// 👤 のフィルタに出す、セッションのユーザの発言になりうる行 (DR-0058 §11)。
//
// 読み込み済みの範囲 (窓) の外の発言は TL に transcript の行が無いので、daemon
// にそのセッションの transcript の発言になりうる行 (op prompt_rows) を聞いて、
// 窓の外の発言を時刻の位置に合流させる (⭐ の bookmark_rows と同じ形、DR-0058
// §5)。聞くのはフィルタに入るたび。フィルタに入った後の新しい発言は live の
// 行で窓に入るので、答えを追って更新する必要は無い。
import { useEffect } from "preact/hooks";
import type { BookmarkRow } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import type { TimelineFilter } from "../../locator.ts";
import { useStoreState } from "../../useStore.ts";

/** 👤 のフィルタの間に `sid` の発言になりうる行を聞き、store に持つ。答えが
 * まだ無いセッションは undefined。 */
export function usePromptRows({
  sid,
  filter,
}: {
  sid: string;
  /** URL のフィルタ (agent の TL では常に null)。 */
  filter: TimelineFilter | null;
}): readonly BookmarkRow[] | undefined {
  const { store, ws } = useApp();
  const connected = useStoreState(store, (s) => s.connStatus === "connected");
  const rows = useStoreState(store, (s) => s.promptRows.get(sid));
  const asking = filter === "prompt" && connected;
  useEffect(() => {
    if (!asking) return;
    void ws
      .promptRows(sid)
      .then((res) => {
        if (res.ok) store.dispatch({ type: "prompt-rows/loaded", sid, rows: res.rows });
      })
      // 聞けなければ窓の中の発言だけが出る。次にフィルタに入った時に聞き直す。
      .catch(() => {});
  }, [asking, sid, store, ws]);
  return rows;
}
