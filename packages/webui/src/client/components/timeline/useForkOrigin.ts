// セッションの fork 元の履歴がどこで終わるか (fork 地点の区切り線の位置)。
import { useEffect } from "preact/hooks";
import type { ForkOrigin } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { useStoreState } from "../../useStore.ts";

/** Ask once per session where its copied fork history ends. An agent
 * transcript is never a fork of anything (only whole sessions fork), and the
 * seam cannot move as the session appends, so there is nothing to refresh:
 * the store keeping the answer (incl. `null` = no seam) is what stops this
 * from re-asking on every visit. undefined = not known yet. */
export function useForkOrigin({
  sid,
  active,
  agentActive,
}: {
  sid: string;
  active: boolean;
  agentActive: boolean;
}): ForkOrigin | null | undefined {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store, (s) => s.connStatus);
  const forkOrigin = useStoreState(store, (s) => s.sessionTrees.get(sid)?.forkOrigin);
  const forkOriginKnown = forkOrigin !== undefined;
  useEffect(() => {
    if (!active || agentActive) return;
    if (connStatus !== "connected") return;
    if (forkOriginKnown) return;
    void ws
      .forkOrigin(sid)
      .then((res) => {
        if (!res.ok) return;
        store.dispatch({ type: "timeline/fork-origin", sid, origin: res.origin });
      })
      // A seam is decoration: a failed resolve leaves the Timeline as it was,
      // and the next visit retries.
      .catch(() => {});
  }, [active, agentActive, sid, connStatus, forkOriginKnown, store, ws]);
  return forkOrigin;
}
