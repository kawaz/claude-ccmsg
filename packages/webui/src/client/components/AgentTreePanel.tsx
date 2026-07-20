// r46 m5: Timeline タブ内左ペイン (TimelinePanes) の中身として置くセッション
// ツリー。Files タブが FilesPanes (左ツリー + 右ビューア) でそのセッション
// スコープを表現しているのに合わせ (kawaz「Files を参考に」)、セッションツリー
// も同一セッションのスコープを担う左カラムとして配置する。
//
// 表示要素は 1 ノード = 1 ラベル に統一 (teammate は teammate_name、subagent は
// name があれば name、無ければ agent_id をそのまま出す)。description /
// agent_type バッジ / TL リンク併記は廃止 — kawaz「条件によって出るものが
// 違う方がよほどキモい」。
//
// クリック挙動:
//   - ノードのラベル (<a>) 全体が TL リンク (agentTimelineHref)。
//   - 子を持つノードは左端に ▶︎/▽ の折りたたみマーカー (<button>) を出し、
//     ラベルクリックとは独立させる。子なしノードは同じ幅の spacer を置いて
//     インデントを揃える。details/summary は summary クリックが全体で
//     折りたたみに食われる仕様なので採用せず、useState + button で自前制御。
import type { AgentTreeNode } from "@ccmsg/protocol";
import { useState } from "preact/hooks";
import { agentTimelineHref } from "../locator.ts";

/** teammate は teammate_name、subagent は teammate_name (無ければ agent_id)
 * を 1 要素で出す。description / agent_type は表示しない (kawaz r46m3)。 */
function displayLabel(node: AgentTreeNode): string {
  return node.teammate_name ?? node.agent_id;
}

/** state → dot の CSS class 名。StatusPanel の teammate dot と同じ語彙を
 * daemon 側 readAgentTree が橋渡し済み。 */
function dotClass(state: string): string {
  return `status-teammate-dot status-teammate-dot-${state}`;
}

function AgentTreeNodeRow({ sid, node }: { sid: string; node: AgentTreeNode }) {
  const [open, setOpen] = useState(true);
  const label = displayLabel(node);
  const href = node.teammate_name
    ? agentTimelineHref(sid, { teammate: node.teammate_name })
    : agentTimelineHref(sid, { agentId: node.agent_id });
  const hasChildren = node.children.length > 0;
  return (
    <li class="agent-tree-node">
      <div class="agent-tree-row">
        {hasChildren ? (
          <button
            type="button"
            class="agent-tree-caret"
            aria-expanded={open}
            aria-label={open ? "折りたたむ" : "展開する"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▽" : "▶"}
          </button>
        ) : (
          <span class="agent-tree-caret agent-tree-caret-empty" aria-hidden="true" />
        )}
        <span class={dotClass(node.state)} aria-hidden="true">
          ●
        </span>
        <a class="agent-tree-label" href={href} title={label}>
          {label}
        </a>
      </div>
      {hasChildren && open ? (
        <ul class="agent-tree-children">
          {node.children.map((child) => (
            <AgentTreeNodeRow key={child.agent_id} sid={sid} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function AgentTreePanel({
  sid,
  tree,
}: {
  sid: string;
  /** SessionStatusSnapshot.agent_tree — 空の場合は呼び出し側 (SessionView) で
   * TimelinePanes 自体を描画せず Timeline 単独に倒す (無駄な空カラムを出さない)。 */
  tree: AgentTreeNode[];
}) {
  return (
    <ul class="agent-tree-root">
      {tree.map((child) => (
        <AgentTreeNodeRow key={child.agent_id} sid={sid} node={child} />
      ))}
    </ul>
  );
}
