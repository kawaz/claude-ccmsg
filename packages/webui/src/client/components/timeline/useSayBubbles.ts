// `ccmsg say` バブルの差し込み (kawaz r244m14)。
//
// say はセッション transcript には echo されない (喋った本人の context を
// 食うだけなので意図的に切ってある) ので、TL に出すには daemon がメモリに
// 持つ say の記録 (ev:"says"、DR-0036 §3) から時刻で合流させるしかない
// (say-merge.ts)。見た目は PushNotification と同じ 🔔 バブル。
import { useCallback, useMemo, useState } from "preact/hooks";
import type { SayRecord } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { sayReadTargets, saySlots } from "../../say-merge.ts";
import type { TimelineGroup } from "../../transcript-model.ts";
import { useStoreState } from "../../useStore.ts";

/** `agentTimeline` の間は何も差し込まない: agent TL は別セッションの
 * transcript を見ているので、このセッションの say はそこのものではない。 */
export function useSayBubbles({
  sid,
  agentTimeline,
  groups,
}: {
  sid: string;
  agentTimeline: boolean;
  groups: readonly TimelineGroup[];
}): {
  /** この TL に出す say の記録。 */
  says: readonly SayRecord[];
  /** `groups` の index ごとに、その group の前に出す say (末尾の 1 つ多い
   * slot は読み込み済みのどの group より新しいもの)。 */
  slots: ReadonlyArray<readonly SayRecord[]>;
  /** say `id` の既読ボタンが既読にする id (sayReadTargets)。 */
  readTargets: (id: string) => readonly string[];
  /** 既読にできなかった理由。次に成功するまで残す。 */
  readError: string | null;
  markRead: (ids: readonly string[]) => void;
} {
  const { store, ws } = useApp();
  const allSays = useStoreState(store, (s) => s.says);
  const says = useMemo(
    () => (agentTimeline ? [] : allSays.filter((r) => r.sid === sid)),
    [allSays, sid, agentTimeline],
  );
  const slots = useMemo(() => saySlots(groups, says), [groups, says]);
  const readTargets = useCallback((id: string) => sayReadTargets(says, id), [says]);
  // 既読は非楽観 — 成功すると daemon が更新後の ev:"says" を全タブに送り、
  // store がそれで置き換える。失敗を黙って捨てると「押しても何も起きない」に
  // 見えるので、TL でも 1 行のエラーとして出して次の試行まで残す。
  const [readError, setReadError] = useState<string | null>(null);
  const markRead = useCallback(
    (ids: readonly string[]): void => {
      void ws
        .sayRead(ids)
        .then((res) => {
          setReadError(res.ok ? null : res.error.msg);
        })
        .catch(() => {
          setReadError("接続エラーのため既読にできませんでした");
        });
    },
    [ws],
  );
  return { says, slots, readTargets, readError, markRead };
}
