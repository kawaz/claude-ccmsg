export type FoldSummaryDecoration =
  | { kind: "thinking" }
  // agent-communication 系 3 タイプ (SendMessage / peer-message / Agent spawn)
  // 共通の閉サマリ decoration。prefix (e.g. "SendMessage" / "peer-message" /
  // "Agent") と direction (Agent spawn は送信方向として "outbound") で
  // 「prefix → name / prefix ← name」の 1 行を identicon + 名前で表す。
  // TL リンクや model / agentType 等の付帯 chip は閉サマリには出さず (kawaz
  // r46m15: 「fold 時点で TL やモデルが出てるのはおかしい」)、カード側に寄せる。
  | {
      kind: "agent";
      prefix: string;
      name: string;
      direction?: "outbound" | "inbound";
    }
  | { kind: "bash" }
  | { kind: "task-notification" };

export function foldSummaryView(
  label: string,
  open: boolean,
  decoration?: FoldSummaryDecoration,
): { label: string; decoration?: FoldSummaryDecoration } {
  return open ? { label } : { label, decoration };
}
