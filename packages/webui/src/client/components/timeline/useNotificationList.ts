// 🔔 / 🔐 のフィルタに出す、セッションの全 say と全許可依頼 (DR-0050 §5)。
//
// 読み込み済みの範囲 (窓) の外の say と許可依頼は TL に transcript の行が
// 無いので、daemon が持つそのセッションの全部 (op notification_list、main と
// subagent / teammate の、既読も含む) を聞いて、窓の外の分を時刻の位置に
// 合流させる。聞くのはフィルタに入るたび。窓の中のものは transcript の行から、
// フィルタに入った後の新しいものは live の行と ev:"agent_says" から描かれる
// ので、答えを追って更新する必要は無い。
import { useEffect } from "preact/hooks";
import type { SessionPermit, SessionSay } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import type { TimelineFilter } from "../../locator.ts";
import { useStoreState } from "../../useStore.ts";

/** `filter` が付いている間に `sid` の全 say と全許可依頼を聞き、store に
 * 持つ。答えがまだ無いセッションは undefined。 */
export function useNotificationList({
  sid,
  filter,
}: {
  sid: string;
  /** URL のフィルタ (agent の TL では常に null)。 */
  filter: TimelineFilter | null;
}): { says: readonly SessionSay[]; permits: readonly SessionPermit[] } | undefined {
  const { store, ws } = useApp();
  const connected = useStoreState(store, (s) => s.connStatus === "connected");
  const list = useStoreState(store, (s) => s.notificationLists.get(sid));
  const asking = filter !== null && connected;
  useEffect(() => {
    if (!asking) return;
    void ws
      .notificationList(sid)
      .then((res) => {
        if (res.ok) {
          store.dispatch({
            type: "notification-list/loaded",
            sid,
            says: res.says,
            permits: res.permits,
          });
        }
      })
      // 聞けなければ窓の中 (と worker の say) だけが出る。次にフィルタに入った
      // 時に聞き直す。
      .catch(() => {});
  }, [asking, filter, sid, store, ws]);
  return list;
}
