// 🔔 のフィルタに出す、セッションの全 say (DR-0050 §5)。
//
// 読み込み済みの範囲 (窓) の外の say は transcript の行が無いので、daemon が
// 持つそのセッションの全 say (op say_list、main と subagent / teammate の
// 既読も含む) を聞いて、窓の外の分を時刻の位置に合流させる。聞くのはフィルタに
// 入るたび。窓の中の say は transcript の行から、フィルタに入った後の新しい
// say は live の行と ev:"agent_says" から描かれるので、答えを追って更新する
// 必要は無い。
import { useEffect } from "preact/hooks";
import type { SessionSay } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import type { TimelineFilter } from "../../locator.ts";
import { useStoreState } from "../../useStore.ts";

/** `filter` が `say` の間に `sid` の全 say を聞き、store に持つ。答えがまだ
 * 無いセッションは undefined。 */
export function useSayList({
  sid,
  filter,
}: {
  sid: string;
  /** URL のフィルタ (agent の TL では常に null)。 */
  filter: TimelineFilter | null;
}): readonly SessionSay[] | undefined {
  const { store, ws } = useApp();
  const connected = useStoreState(store, (s) => s.connStatus === "connected");
  const says = useStoreState(store, (s) => s.sayLists.get(sid));
  const asking = filter === "say" && connected;
  useEffect(() => {
    if (!asking) return;
    void ws
      .sayList(sid)
      .then((res) => {
        if (res.ok) store.dispatch({ type: "say-list/loaded", sid, says: res.says });
      })
      // 聞けなければ窓の中と worker の say だけが出る。次にフィルタに入った時に
      // 聞き直す。
      .catch(() => {});
  }, [asking, sid, store, ws]);
  return says;
}
