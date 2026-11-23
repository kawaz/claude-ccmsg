// SessionView Timeline-tab body: AgentTreePanel + resizable Splitter + Timeline.
// Mirrors FilesPanes.tsx's structure (kawaz r46m5: 「Files を参考に」— セッション
// ツリーは Timeline タブ内の左ペインに置き、スコープをそのセッションに揃える)。
// レイアウト用 CSS class (.session-panes / .session-pane / .session-splitter) は
// FilesPanes と共有 — 見た目・drag 挙動 (幅に依らず左右の並び) を一本の CSS で
// 維持するため。ratio 永続キーは Timeline 用に別で
// 持つ (Files タブの split とは独立に記憶される)。
//
// 左ペインは agent_tree の有無に関わらず常に出す (kawaz 2026-11-22: agent を
// 1 回でも使うと現れる、という出方の違いをやめる)。agent_tree が無い間は
// 先頭の main の行だけになる。消す / 出すのはツールバーの ☰ (PaneTreeToggle)
// で、消すのは hidden だけで要素は残す — サイドバーの .off と同じく、出し
// 直した時にスクロール位置や開いた群がそのままであるように。
import { useRef, useState } from "preact/hooks";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import type { AgentTreeGroups, SessionStatusSnapshot } from "@ccmsg/protocol";
import type { AgentRef } from "../locator.ts";
import type { TimelineState } from "../store.ts";
import { paneRatioFromPointer, parsePaneRatio } from "../utils.ts";
import { AgentTreePanel } from "./AgentTreePanel.tsx";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { Timeline } from "./timeline/Timeline.tsx";
import { readLayoutStorage, writeLayoutStorage } from "../storage.ts";

/** agent_tree がまだ届いていない・無いセッションの木: main の行だけになる。 */
const NO_AGENT_TREE: AgentTreeGroups = { teammates: [], agents: [], workflows: [] };

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
   * undefined なら群の無い木 (main の行だけ) を描く。 */
  agentTree: AgentTreeGroups | undefined;
  timeline: TimelineState;
  search: { queryText: string; caseSensitive: boolean; regex: boolean };
  sessionStatus: SessionStatusSnapshot | undefined;
  agent?: AgentRef | null;
  active: boolean;
  /** Timeline タブの可視状態 — そのまま Timeline へ渡すだけ。 */
  visible: boolean;
}) {
  const { store } = useApp();
  const treeOpen = useStoreState(store, (s) => s.paneTreesOpen.timeline);
  const [ratio, setRatio] = useState<number>(loadPaneRatio);
  const containerRef = useRef<HTMLDivElement>(null);

  // FilesPanes と同じ解釈: 左ペインはコンテナの左端にあるので、比率は左端から測る。
  const onSplitterDrag = (e: PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const next = paneRatioFromPointer(e.clientX, rect.left, rect.width);
    setRatio(next);
    // 書くのは人がスプリッターを動かした時だけ (storage.ts の「レイアウト寸法」:
    // 動かしていない窓は何も書かず、最後にどこかの窓で使った値か既定を引き続ける)。
    savePaneRatio(next);
  };

  const treeStyle = { flex: `0 0 ${(ratio * 100).toFixed(4)}%` };

  return (
    <div class="session-panes" ref={containerRef}>
      <div
        class="session-pane session-pane-tree timeline-pane-tree"
        style={treeStyle}
        hidden={!treeOpen}
      >
        <AgentTreePanel
          sid={sid}
          tree={agentTree ?? NO_AGENT_TREE}
          workflows={sessionStatus?.workflows}
          currentAgent={agent}
        />
      </div>
      {treeOpen ? (
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
