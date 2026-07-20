export type FoldSummaryDecoration =
  | { kind: "thinking" }
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
