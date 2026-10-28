// 許可依頼バブル (DR-0040) の差し込み。
//
// 許可依頼は daemon がメモリに持つ記録 (ev:"permit_requests" /
// ev:"permit_request") で、transcript の行とは別の記録なので、TL には時刻で
// 合流させる (permit-merge.ts)。
import { useMemo } from "preact/hooks";
import type { PermitRequestRecord } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { permitSlots } from "../../permit-merge.ts";
import type { TimelineGroup } from "../../transcript-model.ts";
import { useStoreState } from "../../useStore.ts";

/** `agentTimeline` の間は何も差し込まない: agent TL は subagent の transcript
 * を見ていて、許可依頼はセッションの本体が出すもの。 */
export function usePermitBubbles({
  sid,
  agentTimeline,
  groups,
}: {
  sid: string;
  agentTimeline: boolean;
  groups: readonly TimelineGroup[];
}): {
  /** この TL に出す許可依頼。 */
  requests: readonly PermitRequestRecord[];
  /** `groups` の index ごとに、その group の前に出す許可依頼 (末尾の 1 つ
   * 多い slot は読み込み済みのどの group より新しいもの)。 */
  slots: ReadonlyArray<readonly PermitRequestRecord[]>;
} {
  const { store } = useApp();
  const all = useStoreState(store, (s) => s.permitRequests);
  const requests = useMemo(
    () => (agentTimeline ? [] : all.filter((r) => r.sid === sid)),
    [all, sid, agentTimeline],
  );
  const slots = useMemo(() => permitSlots(groups, requests), [groups, requests]);
  return { requests, slots };
}
