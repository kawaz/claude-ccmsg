export type FoldSummaryDecoration =
  | { kind: "thinking" }
  | { kind: "agent"; prefix: string; name: string }
  | { kind: "bash" };

export function foldSummaryView(
  label: string,
  open: boolean,
  decoration?: FoldSummaryDecoration,
): { label: string; decoration?: FoldSummaryDecoration } {
  return open ? { label } : { label, decoration };
}
