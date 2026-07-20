import type { SystemMessageRich } from "./transcript-model.ts";

export type AgentCommunicationDirection = "outbound" | "inbound";

export function agentDirectionMarker(direction: "outbound"): "🤖→";
export function agentDirectionMarker(direction: "inbound"): "🤖←";
export function agentDirectionMarker(direction: AgentCommunicationDirection): "🤖→" | "🤖←";
export function agentDirectionMarker(direction: AgentCommunicationDirection): "🤖→" | "🤖←" {
  return direction === "outbound" ? "🤖→" : "🤖←";
}

type PeerMessage = Extract<SystemMessageRich, { display: "peer" }>;

export type PeerMessagePresentation =
  | { kind: "idle"; marker: "🤖←"; text: string }
  | { kind: "card"; marker: "🤖←"; badge: string };

export function peerMessagePresentation(peer: PeerMessage): PeerMessagePresentation {
  const marker = agentDirectionMarker("inbound");
  switch (peer.category) {
    case "idle":
      return { kind: "idle", marker, text: peer.body };
    case "task-assignment":
      return { kind: "card", marker, badge: "タスク指示" };
    case "lifecycle":
      return { kind: "card", marker, badge: "状態変更" };
    case "unknown":
      return { kind: "card", marker, badge: "未知" };
    case "message":
      return { kind: "card", marker, badge: "受信" };
  }
}
