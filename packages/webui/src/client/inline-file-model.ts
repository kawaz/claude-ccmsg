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
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      out.push({ kind: "same", text: before[i]! });
      i += 1;
      j += 1;
    } else if (j >= after.length || (i < before.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      out.push({ kind: "delete", text: before[i++]! });
    } else {
      out.push({ kind: "add", text: after[j++]! });
    }
  }
  return out;
}
