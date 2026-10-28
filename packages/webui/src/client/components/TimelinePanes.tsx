// SessionView Timeline-tab body: AgentTreePanel + resizable Splitter + Timeline.
// Mirrors FilesPanes.tsx's structure (kawaz r46m5: 「Files を参考に」— セッション
// ツリーは Timeline タブ内の左ペインに置き、スコープをそのセッションに揃える)。
// レイアウト用 CSS class (.session-panes / .session-pane / .session-splitter) は
// FilesPanes と共有 — 見た目・drag 挙動・レスポンシブ (≤720px で column に倒れる
// mobile 分岐) を一本の CSS で維持するため。ratio 永続キーは Timeline 用に別で
// 持つ (Files タブの split とは独立に記憶される)。
//
// agent_tree が空 (undefined / 0 件) の場合は左ペインと splitter を出さず、
// Timeline だけを描く。Timeline は agent_tree の有無に関わらず同じ位置に置く:
// status の snapshot は Timeline の mount より後に届き、セッションを離れると
// 消えるので、木の有無で Timeline の置き場を変えると、木が現れるたびに
// Timeline が作り直され、到着時の読みと live tail の購読が重なり、スクロール
// や畳みの状態も失われる。
import { useRef, useState } from "preact/hooks";
import type { AgentTreeGroups, SessionStatusSnapshot } from "@ccmsg/protocol";
import type { AgentRef } from "../locator.ts";
import type { TimelineState } from "../store.ts";
import { paneRatioFromPointer, parsePaneRatio } from "../utils.ts";
import { AgentTreePanel } from "./AgentTreePanel.tsx";
import { paneAxisMetrics, readPaneAxis } from "../pane-axis.ts";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { Timeline } from "./timeline/Timeline.tsx";
import { readLayoutStorage, writeLayoutStorage } from "../storage.ts";

// Files タブの ccmsg.sessionPaneRatio とは別に持つ — Timeline 側の split を Files
// 側に引きずられないため。default は共有 (0.28)。
const PANE_RATIO_STORAGE = "ccmsg.timelinePaneRatio";

function loadPaneRatio(): number {
  return parsePaneRatio(readLayoutStorage(PANE_RATIO_STORAGE));
}

function savePaneRatio(ratio: number): void {
  writeLayoutStorage(PANE_RATIO_STORAGE, String(ratio));
}

export function TimelinePanes({
  sid,
  agentTree,
  timeline,
  search,
  sessionStatus,
  agent,
  active,
  visible,
}: {
  sid: string;
  /** r46 m8: 3 種グループ (teammates / agents / workflows) に統合。
   * undefined または 3 つとも空なら左ペインを出さない。 */
  agentTree: AgentTreeGroups | undefined;
  timeline: TimelineState;
  search: { queryText: string; caseSensitive: boolean; regex: boolean };
  sessionStatus: SessionStatusSnapshot | undefined;
  agent?: AgentRef | null;
  active: boolean;
  /** Timeline タブの可視状態 — そのまま Timeline へ渡すだけ。 */
  visible: boolean;
}) {
  const [ratio, setRatio] = useState<number>(loadPaneRatio);
  const containerRef = useRef<HTMLDivElement>(null);

  // FilesPanes と同じ解釈 (pane-axis.ts): container の flex-direction から軸を
  // 読むので、CSS @media (≤720px) の column 切替に自動追従する。
  const onSplitterDrag = (e: PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const m = paneAxisMetrics(readPaneAxis(container), container.getBoundingClientRect(), e);
    const next = paneRatioFromPointer(m.pointer, m.start, m.size);
    setRatio(next);
    // 書くのは人がスプリッターを動かした時だけ (storage.ts の「レイアウト寸法」:
    // 動かしていない窓は何も書かず、最後にどこかの窓で使った値か既定を引き続ける)。
    savePaneRatio(next);
  };

  const treeStyle = { flex: `0 0 ${(ratio * 100).toFixed(4)}%` };

  const hasTree =
    agentTree !== undefined &&
    (agentTree.teammates.length > 0 ||
      agentTree.agents.length > 0 ||
      agentTree.workflows.length > 0);

  return (
    <div class="session-panes" ref={containerRef}>
      {hasTree ? (
        <div class="session-pane session-pane-tree timeline-pane-tree" style={treeStyle}>
          <AgentTreePanel
            sid={sid}
            tree={agentTree}
            workflows={sessionStatus?.workflows}
            currentAgent={agent}
          />
        </div>
      ) : null}
      {hasTree ? (
        <PaneSplitter class="session-splitter" ariaOrientation="vertical" onDrag={onSplitterDrag} />
      ) : null}
      <div class="session-pane session-pane-viewer" style={{ flex: "1 1 auto" }}>
        <Timeline
          key={sid}
          sid={sid}
          timeline={timeline}
          search={search}
          sessionStatus={sessionStatus}
          agent={agent}
          active={active}
          visible={visible}
        />
      </div>
    </div>
  );
}
