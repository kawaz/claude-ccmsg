// Pure derivations for the Files pane's name search (FileSearchPanel). The
// daemon owns the matching itself (fs_find walks the tree and applies the
// whitespace-AND filter); what's left on the client is deciding which roots to
// ask and how to present several roots' replies as one list. Kept out of
// utils.ts as its own module — same convention as cwd-tree.ts / rooms-filter.ts
// — so it is exercised without mounting the component or a fake WsHandle.
import {
  type FsFindHit,
  matchesFileSearchQuery,
  parseFileSearchQuery,
  type WorkspaceFolder,
} from "@ccmsg/protocol";

/** One fs_find call the panel needs to make for a single submitted query. */
export interface FileSearchTarget {
  kind: "contained" | "workspace";
  /** Walk root. For `contained`, a path relative to the session's containment
   * root; `""` means the containment root itself (fs_find's own default). */
  root: string | undefined;
  /** Section heading for this target's hits; null for the project root,
   * whose hits are the unlabeled default group. */
  label: string | null;
  /** For `workspace` targets, the folder whose absolute path prefixes every
   * hit — what `workspaceHitDisplayPath` strips back down to `{name}/…`.
   * null for the contained target, whose hits are already root-relative. */
  folder: WorkspaceFolder | null;
}

/** Every browsable root a search should cover: the tree's own project root
 * plus each DR-0026 workspace folder. Searching only the project root would
 * silently miss the ワークスペース section the tree renders right above it —
 * the user has no reason to expect the search box to cover less than the tree
 * does. The reverse matters just as much (kawaz r55 m97): `treeRoot` is the
 * session's cwd, not the daemon's wider containment root, so the search covers
 * exactly the subtree shown rather than every sibling worktree the daemon
 * would still authorize. Hits stay containment-relative either way, which is
 * the same space the tree's own path keys live in. DR-0024 external files are
 * deliberately absent: that allowlist is per-file with no directory to walk,
 * and the tree shows all of them at once anyway (they are filtered client-side
 * instead, see filterExternalFiles). */
export function fileSearchTargets(
  workspaceFolders: readonly WorkspaceFolder[],
  treeRoot: string,
): FileSearchTarget[] {
  return [
    { kind: "contained", root: treeRoot, label: null, folder: null },
    ...workspaceFolders.map((folder) => ({
      kind: "workspace" as const,
      root: folder.path,
      label: folder.name,
      folder,
    })),
  ];
}

/** One target's answered hits, in the order `fileSearchTargets` produced. */
export interface FileSearchGroup {
  label: string | null;
  /** Same meaning as `FileSearchTarget.folder` — carried through so a row can
   * shorten its own path without the renderer having to re-pair groups with
   * the folder list they came from. */
  folder: WorkspaceFolder | null;
  hits: FsFindHit[];
  /** This group's walk was cut short (daemon result cap / visit budget). */
  truncated: boolean;
  /** This target failed outright; its hits are unknown, not empty. Rendered
   * as an error line for that group rather than failing the whole search —
   * one unreachable workspace folder shouldn't blank the containment-root
   * results the user actually wanted. */
  error: string | null;
}

/** True when any group was cut short or failed, i.e. the displayed list is not
 * the complete match set and the UI must say so. */
export function fileSearchIncomplete(groups: readonly FileSearchGroup[]): boolean {
  return groups.some((group) => group.truncated || group.error !== null);
}

export function fileSearchHitCount(groups: readonly FileSearchGroup[]): number {
  return groups.reduce((total, group) => total + group.hits.length, 0);
}

/** Client-side equivalent of the daemon's fs_find matcher, for the one path
 * set that has no directory to walk: DR-0024 external files, which the client
 * already holds in full. Runs the *same* protocol-level parser and matcher the
 * daemon does (not a reimplementation of them), so one query in one box cannot
 * mean two different things depending on which section a path lives in.
 * `.gitignore` filtering has no counterpart here: these are individually
 * allowlisted files observed in a transcript, not a tree that could hide
 * anything. */
export function filterExternalFiles(externalFiles: readonly string[], query: string): string[] {
  const parsed = parseFileSearchQuery(query);
  return externalFiles.filter((filePath) => matchesFileSearchQuery(filePath, parsed));
}

/** Display form of a hit inside a workspace folder: `{folder name}/{path
 * relative to that folder}` (kawaz r55m127). The daemon returns these as
 * absolute paths — that is the shape fs_read_workspace authorizes against, so
 * it is what the row must *link* to — but a `/Users/…/repos/host/owner/repo/`
 * prefix repeated down the list is prefix noise that pushes the part telling
 * the folders apart off the right edge. The folder name reintroduces exactly
 * the distinction the prefix was carrying, in one short token.
 *
 * A path that isn't under `folderPath` is returned unchanged rather than
 * forced into a `../..` relative form: the fallback should degrade to the
 * honest absolute path, not to something that looks relative but isn't. */
export function workspaceHitDisplayPath(
  hitPath: string,
  folderPath: string,
  folderName: string,
): string {
  const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  if (!hitPath.startsWith(prefix)) return hitPath;
  return `${folderName}/${hitPath.slice(prefix.length)}`;
}
