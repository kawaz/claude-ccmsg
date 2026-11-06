/** One name in a directory listing, with whether it is a directory. */
export interface TreeOrderEntry {
  name: string;
  isDir: boolean;
}

/** The order of siblings in a file tree: directories first, then by name in
 * plain codepoint order (deliberately not locale-aware, so the order is
 * identical across test/CI/user locales). The daemon's listings and the
 * webui's Files sections both sort with this one function, so a path is in the
 * same place wherever it is shown. */
export function compareTreeOrder(a: TreeOrderEntry, b: TreeOrderEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}
