// Timeline の auto open 設定 (どのカテゴリの fold を最初から開くか)。セッション
// (agent TL なら agent ごと) に localStorage へ保存し、開き直した時に読み戻す。
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { readStorage, writeStorage } from "../../storage.ts";
import {
  parseTimelineAutoOpenSettings,
  timelineAutoOpenStorageKey,
  toggleTimelineAutoOpen,
  type TimelineAutoOpenSettings,
} from "../../timeline-auto-open.ts";

/** fold が読む設定と、設定が変わった回数。`revision` が進むたびに、各 fold は
 * 読み手が開け閉めした状態を捨てて新しい既定値へ戻る。 */
export interface TimelineAutoOpenContextValue {
  settings: TimelineAutoOpenSettings;
  revision: number;
}

/** `agentKey` は agent TL の保存先を分ける識別子 (agentId、無ければ runId /
 * teammate)。`agentActive` は agent TL か (既定値が親 TL と逆になる)。 */
export function useAutoOpenSettings({
  sid,
  agentKey,
  agentActive,
}: {
  sid: string;
  agentKey: string | undefined;
  agentActive: boolean;
}): {
  settings: TimelineAutoOpenSettings;
  revision: number;
  context: TimelineAutoOpenContextValue;
  toggle: (key: keyof TimelineAutoOpenSettings) => void;
} {
  const [settings, setSettings] = useState(() =>
    parseTimelineAutoOpenSettings(
      readStorage(timelineAutoOpenStorageKey(sid, agentKey)),
      agentActive,
    ),
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setSettings(
      parseTimelineAutoOpenSettings(
        readStorage(timelineAutoOpenStorageKey(sid, agentKey)),
        agentActive,
      ),
    );
    setRevision((current) => current + 1);
  }, [sid, agentKey, agentActive]);
  const toggle = useCallback(
    (key: keyof TimelineAutoOpenSettings) => {
      setSettings((current) => {
        const next = toggleTimelineAutoOpen(current, key);
        writeStorage(timelineAutoOpenStorageKey(sid, agentKey), JSON.stringify(next));
        return next;
      });
      setRevision((current) => current + 1);
    },
    [sid, agentKey],
  );
  const context = useMemo<TimelineAutoOpenContextValue>(
    () => ({ settings, revision }),
    [settings, revision],
  );
  return { settings, revision, context, toggle };
}
