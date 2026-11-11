// say バブルの既読 (DR-0045 §7)。
//
// バブル自体は transcript の `say` の tool_use から描く (classifyBoundaryLine の
// `"say"`)。ここが持つのは、どれが未読か (daemon の ev:"say_unread") と、既読
// ボタン (バブルの「既読」と、🔔 のフィルタの「全て既読」) が送るものだけ。
import { useCallback, useMemo, useState } from "preact/hooks";
import { useApp } from "../../context.ts";
import { type SayReadState, shownUnreadSays } from "../../say-read.ts";
import type { BoundaryKind } from "../../transcript-model.ts";
import { useStoreState } from "../../useStore.ts";

/** `agentTimeline` の間は say を既読の管理の外に置く: subagent の say は
 * 未読に入らない (DR-0045 §7) ので、その TL の say は 🔕 で既読ボタンを持たない。 */
export function useSayRead({
  sid,
  agentTimeline,
  boundaries,
  mergedSayIds,
}: {
  sid: string;
  agentTimeline: boolean;
  /** TL の groups と同じ index の境界の分類 (useTranscriptModel)。 */
  boundaries: ReadonlyArray<BoundaryKind | null>;
  /** この TL に時刻で合流させて出す say の id (subagent / teammate の say
   * (DR-0050 §10) と、🔔 のフィルタ中の窓の外の say (§5))。「全て既読」は
   * これも含めて既読にする。 */
  mergedSayIds: readonly string[];
}): {
  /** tool_use の id が `id` の say の既読の状態。未読ならその say だけを
   * 既読にする。 */
  readState: (id: string) => SayReadState;
  /** TL に出ている未読の say の id (窓の中の行と合流させた say)。🔔 の
   * フィルタの「全て既読」が既読にするもの。 */
  shownUnread: readonly string[];
  /** `ids` の say を既読にする。 */
  markRead: (ids: readonly string[]) => void;
  /** 既読にできなかった理由。次に成功するまで残す。 */
  readError: string | null;
} {
  const { store, ws } = useApp();
  const unreadSays = useStoreState(store, (s) => s.unreadSays);
  const unread = useMemo(
    () => new Set(unreadSays.filter((say) => say.session_id === sid).map((say) => say.tool_use_id)),
    [unreadSays, sid],
  );
  const shownUnread = useMemo(
    () =>
      agentTimeline
        ? []
        : [...shownUnreadSays(boundaries, unread), ...mergedSayIds.filter((id) => unread.has(id))],
    [agentTimeline, boundaries, unread, mergedSayIds],
  );
  // 既読は非楽観 — 成功すると daemon が更新後の ev:"say_unread" を全タブに
  // 送り、store がそれで置き換える。失敗を黙って捨てると「押しても何も起きない」
  // に見えるので、TL でも 1 行のエラーとして出して次の試行まで残す。
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
  const readState = useCallback(
    (id: string): SayReadState => {
      if (agentTimeline) return { kind: "untracked" };
      if (!unread.has(id)) return { kind: "read" };
      return { kind: "unread", onRead: () => markRead([id]) };
    },
    [agentTimeline, unread, markRead],
  );
  return { readState, shownUnread, markRead, readError };
}
