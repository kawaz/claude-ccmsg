// SessionView Timeline-tab body: AgentTreePanel + resizable Splitter + Timeline.
// Mirrors FilesPanes.tsx's structure (kawaz r46m5: 「Files を参考に」— セッション
// ツリーは Timeline タブ内の左ペインに置き、スコープをそのセッションに揃える)。
// レイアウト用 CSS class (.session-panes / .session-pane / .session-splitter) は
// FilesPanes と共有 — 見た目・drag 挙動・レスポンシブ (≤720px で column に倒れる
// mobile 分岐) を一本の CSS で維持するため。ratio 永続キーは Timeline 用に別で
// 持つ (Files タブの split とは独立に記憶される)。
//
// agent_tree が空 (undefined / 0 件) の場合は左ペインを出さず Timeline 単独描画。
// SessionView 側で判定して本コンポーネントは agent_tree が非空の時のみ mount する。
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentTreeNode, SessionStatusSnapshot } from "@ccmsg/protocol";
import type { AgentRef } from "../locator.ts";
import type { TimelineState } from "../store.ts";
import { clampPaneRatio, paneRatioFromPointer, SESSION_PANE_DEFAULT_RATIO } from "../utils.ts";
import { AgentTreePanel } from "./AgentTreePanel.tsx";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { Timeline } from "./Timeline.tsx";
import { readStorage, writeStorage } from "../storage.ts";

// Files タブの ccmsg.sessionPaneRatio とは別に持つ — Timeline 側の split を Files
// 側に引きずられないため。default は共有 (0.28)。
const PANE_RATIO_STORAGE = "ccmsg.timelinePaneRatio";

function loadPaneRatio(): number {
  const raw = readStorage(PANE_RATIO_STORAGE);
  if (raw !== null) return clampPaneRatio(Number.parseFloat(raw));
  return SESSION_PANE_DEFAULT_RATIO;
}

function savePaneRatio(ratio: number): void {
  writeStorage(PANE_RATIO_STORAGE, String(ratio));
}

export function TimelinePanes({
  sid,
  agentTree,
  timeline,
  search,
  sessionStatus,
  onOpenStatus,
  agent,
}: {
  sid: string;
  /** 呼び出し側 (SessionView) で空でないことを確認済み前提。 */
  agentTree: AgentTreeNode[];
  timeline: TimelineState;
  search: { queryText: string; caseSensitive: boolean; regex: boolean };
  sessionStatus: SessionStatusSnapshot | undefined;
  onOpenStatus: () => void;
  agent?: AgentRef | null;
}) {
  const [ratio, setRatio] = useState<number>(loadPaneRatio);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    savePaneRatio(ratio);
  }, [ratio]);

  // FilesPanes と同じ axis-agnostic な解釈: getComputedStyle で container の
  // flex-direction を読み、CSS @media (≤720px) の column 切替に自動追従。
  const onSplitterDrag = (e: PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const isVertical = getComputedStyle(container).flexDirection === "column";
    const rect = container.getBoundingClientRect();
    const next = isVertical
      ? paneRatioFromPointer(e.clientY, rect.top, rect.height)
      : paneRatioFromPointer(e.clientX, rect.left, rect.width);
    setRatio(next);
  };

  const treeStyle = { flex: `0 0 ${(ratio * 100).toFixed(4)}%` };

  return (
    <div class="session-panes" ref={containerRef}>
      <div class="session-pane session-pane-tree timeline-pane-tree" style={treeStyle}>
        <AgentTreePanel sid={sid} tree={agentTree} />
      </div>
      <PaneSplitter class="session-splitter" ariaOrientation="vertical" onDrag={onSplitterDrag} />
      <div class="session-pane session-pane-viewer" style={{ flex: "1 1 auto" }}>
        <Timeline
          sid={sid}
          timeline={timeline}
          search={search}
          sessionStatus={sessionStatus}
          onOpenStatus={onOpenStatus}
          agent={agent}
        />
      </div>
    </div>
  );
}
