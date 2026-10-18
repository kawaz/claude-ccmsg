export interface DiffLine {
  kind: "same" | "delete" | "add";
  text: string;
}

export function splitFileLines(text: string): string[] {
  if (text === "") return [];
  const out = text.split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const before = splitFileLines(oldText);
  const after = splitFileLines(newText);
  if (before.length * after.length > 400_000) {
    return [
      ...before.map((text): DiffLine => ({ kind: "delete", text })),
      ...after.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }
  // The length of the longest common subsequence of before[i..] and
  // after[j..]. A cell past either end is an empty suffix, whose LCS is 0.
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  const lcs = (i: number, j: number): number => table[i * width + j] ?? 0;
  const afterFromEnd = [...after.entries()].reverse();
  for (const [i, removed] of [...before.entries()].reverse()) {
    for (const [j, added] of afterFromEnd) {
      table[i * width + j] =
        removed === added ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const removed = before[i];
    const added = after[j];
    if (removed !== undefined && removed === added) {
      out.push({ kind: "same", text: removed });
      i += 1;
      j += 1;
    } else if (removed !== undefined && (added === undefined || lcs(i + 1, j) >= lcs(i, j + 1))) {
      out.push({ kind: "delete", text: removed });
      i += 1;
    } else if (added !== undefined) {
      out.push({ kind: "add", text: added });
      j += 1;
    } else break;
  }
  return out;
}
