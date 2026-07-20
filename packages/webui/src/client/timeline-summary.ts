export type FoldSummaryDecoration =
  | { kind: "thinking" }
  | {
      kind: "agent";
      prefix: string;
      name: string;
      direction?: "outbound" | "inbound";
    }
  // Agent tool の起動 (spawn) は SendMessage の送受信と別種のイベント。
  // "→" / "←" の方向 badge は SendMessage 用に温存し、spawn は "new" chip
  // で表す (kawaz r44 mid=5)。model は常時視認できるよう summary にも出す。
  | {
      kind: "agent-spawn";
      name: string;
      agentType: string;
      model: string;
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
