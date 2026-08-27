import type { PeerRelay } from "./transcript-model.ts";

export type AgentCommunicationDirection = "outbound" | "inbound";

export function agentDirectionMarker(direction: "outbound"): "🤖→";
export function agentDirectionMarker(direction: "inbound"): "🤖←";
export function agentDirectionMarker(direction: AgentCommunicationDirection): "🤖→" | "🤖←";
export function agentDirectionMarker(direction: AgentCommunicationDirection): "🤖→" | "🤖←" {
  return direction === "outbound" ? "🤖→" : "🤖←";
}

export type PeerMessagePresentation =
  | { kind: "idle"; marker: "🤖←"; text: string; channelLabel: string | null }
  | { kind: "card"; marker: "🤖←"; badge: string; channelLabel: string | null };

/** Label naming the transport a relay arrived over, or `null` for the
 * in-process teammate relay that is the unmarked default. Cross-session
 * traffic is the same conversation from the reader's side, so it is marked
 * rather than styled apart: one quiet chip keeps "who is this from" answerable
 * without turning a second bubble family loose in the Timeline. */
export function peerChannelLabel(channel: PeerRelay["channel"]): string | null {
  return channel === "cross-session" ? "cross-session" : null;
}

export function peerMessagePresentation(peer: PeerRelay): PeerMessagePresentation {
  const marker = agentDirectionMarker("inbound");
  const channelLabel = peerChannelLabel(peer.channel);
  switch (peer.category) {
    case "idle":
      return { kind: "idle", marker, text: peer.body, channelLabel };
    case "task-assignment":
      return { kind: "card", marker, badge: "タスク指示", channelLabel };
    case "lifecycle":
      return { kind: "card", marker, badge: "状態変更", channelLabel };
    case "unknown":
      return { kind: "card", marker, badge: "未知", channelLabel };
    case "message":
      return { kind: "card", marker, badge: "受信", channelLabel };
  }
}
