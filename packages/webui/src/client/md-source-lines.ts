// The lines in the source of what a file's markdown preview draws (DR-0062
// P26): the preview's blocks carry them (MarkdownView's `sourceLines`:
// `data-md-line` / `data-md-end-line` on a paragraph, a heading, a list's
// item, a table's row, a quote, a code block; a code block also its first
// line of code, `data-md-code-line`), and a point of the preview is on the
// lines of the innermost block it is in, or, in a code block drawn a line a
// line, on that one line.

/** The lines in the source of the innermost block `node` is in, below
 * `root`: the block's first and last, or a code block's one line `node` is
 * on. Null when it is in no block. */
export function mdSourceLinesOf(
  node: Node,
  root: Element,
): { line: number; endLine: number } | null {
  for (
    let at = node instanceof Element ? node : node.parentElement;
    at !== null && root.contains(at);
    at = at.parentElement
  ) {
    if (at.classList.contains("md-code-line")) {
      const block = at.closest("[data-md-code-line]");
      const first = Number(block?.getAttribute("data-md-code-line"));
      const index = Array.from(at.parentElement?.children ?? [])
        .filter((line) => line.classList.contains("md-code-line"))
        .indexOf(at);
      if (block !== null && root.contains(block) && Number.isInteger(first) && index >= 0) {
        return { line: first + index, endLine: first + index };
      }
    }
    const line = Number(at.getAttribute("data-md-line"));
    if (at.hasAttribute("data-md-line") && Number.isInteger(line) && line >= 1) {
      const end = Number(at.getAttribute("data-md-end-line"));
      return { line, endLine: Number.isInteger(end) && end >= line ? end : line };
    }
  }
  return null;
}
