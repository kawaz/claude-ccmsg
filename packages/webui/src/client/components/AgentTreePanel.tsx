// r44 m7: Timeline pane の隣に置くセッションツリーパネル。ルート = 現在の
// セッション、子孫 = subagents/agent-*.meta.json から組み上げた
// SessionStatusSnapshot.agent_tree の再帰描画 (最大 5 段、daemon 側で cap
// 済み)。各ノードは live dot + label + agent_type バッジ + TL リンクの構成で、
// StatusPanel の Teams/Background 行と同じ視覚言語を踏襲する。
import type { AgentTreeNode } from "@ccmsg/protocol";
import { agentTimelineHref } from "../locator.ts";

/** 表示 label 決定順: description → teammate_name → agent_type → agent_id。
 * meta.json の description が最も情報量が多い (「何を頼まれた subagent か」)
 * ため優先し、無い時に安定した識別子へフォールバックする。 */
function displayLabel(node: AgentTreeNode): string {
  return node.description ?? node.teammate_name ?? node.agent_type ?? node.agent_id;
}

/** state → dot の CSS class 名。Status タブの teammate dot と同じ語彙
 * (active/idle/spawned/stopped/unknown 等) をそのまま流す — daemon 側の
 * `readAgentTree` が state.background/teammates と mtime 推定を橋渡し済み。 */
function dotClass(state: string): string {
  return `status-teammate-dot status-teammate-dot-${state}`;
}

function AgentTreeNodeRow({ sid, node }: { sid: string; node: AgentTreeNode }) {
  const label = displayLabel(node);
  const href = node.teammate_name
    ? agentTimelineHref(sid, { teammate: node.teammate_name })
    : agentTimelineHref(sid, { agentId: node.agent_id });
  const summary = (
    <>
      <span class={dotClass(node.state)} aria-hidden="true">
        ●
      </span>
      <a class="status-wf-agent-tl agent-tree-tl" href={href}>
        TL
      </a>
      <span class="agent-tree-label" title={label}>
        {label}
      </span>
      {node.agent_type ? <span class="status-row-kind">{node.agent_type}</span> : null}
    </>
  );
  // 子が居ない時は <details> を作らず、行だけを平坦に描く (常時展開扱い)。
  if (node.children.length === 0) {
    return <li class="agent-tree-node agent-tree-leaf">{summary}</li>;
  }
  return (
    <li class="agent-tree-node">
      <details open>
        <summary>{summary}</summary>
        <ul class="agent-tree-children">
          {node.children.map((child) => (
            <AgentTreeNodeRow key={child.agent_id} sid={sid} node={child} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function AgentTreePanel({
  sid,
  tree,
}: {
  sid: string;
  /** SessionStatusSnapshot.agent_tree — undefined/空 の時は呼び出し側で
   * 非表示にする想定 (SessionView 側で早期 return)。 */
  tree: AgentTreeNode[];
}) {
  return (
    <div class="agent-tree-panel">
      <h3 class="agent-tree-title">セッションツリー</h3>
      <p class="agent-tree-note">最大 5 段、深い階層の live 状態は mtime 推定</p>
      <ul class="agent-tree-root">
        <li class="agent-tree-node agent-tree-root-node">
          <details open>
            <summary>
              <span class="status-teammate-dot status-teammate-dot-active" aria-hidden="true">
                ●
              </span>
              <span class="agent-tree-label agent-tree-self">このセッション</span>
            </summary>
            <ul class="agent-tree-children">
              {tree.map((child) => (
                <AgentTreeNodeRow key={child.agent_id} sid={sid} node={child} />
              ))}
            </ul>
          </details>
        </li>
      </ul>
    </div>
  );
}
