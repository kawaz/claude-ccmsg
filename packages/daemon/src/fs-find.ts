// Recursive file-name search for the Files pane (fs_find). The webui's tree is
// lazy (one fs_list per expanded directory, DR-0008), so the client only ever
// holds the directories the user happened to open — it cannot answer "which
// paths contain these words" on its own. This module does the walk on the
// daemon, where the whole subtree is one request away, and reuses the exact
// authorization surfaces the list ops already established: fs_list's
// containment root for kind="contained", the DR-0026 workspace-folder
// allowlist for kind="workspace". No new trust boundary is introduced — every
// path this returns is one the client could already have reached by expanding
// the tree by hand.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ErrorCode,
  FS_FIND_RESULT_MAX,
  FS_FIND_VISIT_MAX,
  fileSearchQueryIsEmpty,
  type FsFindHit,
  type FsFindResponse,
  matchesFileSearchQuery,
  parseFileSearchQuery,
  type ParsedFileSearchQuery,
} from "@ccmsg/protocol";
import type { FsAccessOptions, FsAccessResult, SessionLookup } from "./fs-access.ts";
import { resolveFindRoot } from "./fs-access.ts";
import { type IgnoreLayer, isIgnored, readIgnoreLayer } from "./gitignore.ts";
import type { SessionStatusStore } from "./session-status.ts";

/** Entry types fs_find reports. Directories are matchable targets in their own
 * right (searching "components" should surface the directory too), and
 * symlinks are reported as-is — the same as fs_list, whose FsEntry contract
 * deliberately doesn't resolve what a link points at. */
function findableType(dirent: fs.Dirent): FsFindHit["type"] | null {
  if (dirent.isDirectory()) return "dir";
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isFile()) return "file";
  return null;
}

/**
 * Breadth-first walk of `absRoot`, collecting paths matching every token.
 *
 * Design rationale (breadth-first, not the more obvious recursive depth-first
 * walk dir_tree uses): the result cap is what a user actually hits, and BFS
 * decides *which* matches survive it. In this repo `node_modules` holds ~95% of
 * all entries (11.5k of 12k), all of it deep; a depth-first walk that happens to
 * enter it early spends the whole budget there and returns vendored noise, while
 * BFS returns the user's own shallow files first and only reaches vendored
 * depths if budget remains. Ordering the results by depth is also what the user
 * wants to read first, so the traversal order doubles as the display order and
 * no sort pass is needed.
 *
 * Symlinked directories are matched but never descended into: that is what
 * bounds the walk against cycles (`a/link -> a`), and it also keeps every
 * returned path lexically inside the authorized root, so no containment
 * re-check per entry is required. `visited` bounds the cost against a tree
 * that is merely enormous rather than cyclic.
 */
function walkFind(
  absRoot: string,
  containmentRoot: string,
  toDisplay: (abs: string) => string,
  parsed: ParsedFileSearchQuery,
  respectGitignore: boolean,
) {
  const hits: FsFindHit[] = [];
  let visited = 0;
  let truncated = false;
  // Each queued directory carries the ignore layers in force there. Layers are
  // per-directory rather than looked up per-entry because a `.gitignore` is
  // read once when its directory is dequeued and then shared by everything
  // below it — the BFS queue is already the natural place to thread that
  // inherited state through.
  const rootLayers = respectGitignore ? collectLayers(absRoot, containmentRoot) : [];
  const queue: { dir: string; layers: readonly IgnoreLayer[] }[] = [
    { dir: absRoot, layers: rootLayers },
  ];

  while (queue.length > 0) {
    const { dir, layers } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable/vanished directory (permissions, or a race with external
      // mutation). Skipping it is the same posture fs_list takes per-entry:
      // report what is reachable rather than failing the whole request.
      continue;
    }
    // A `.gitignore` in this directory joins the inherited layers for its own
    // entries and everything below, per gitignore(5)'s "rules apply to the
    // directory containing the file and its subdirectories".
    let effectiveLayers = layers;
    if (respectGitignore) {
      const own = readIgnoreLayer(dir);
      if (own) effectiveLayers = [...layers, own];
    }
    for (const dirent of dirents) {
      if (visited >= FS_FIND_VISIT_MAX) {
        truncated = true;
        return { hits, truncated };
      }
      visited++;
      const type = findableType(dirent);
      if (type === null) continue;
      const abs = path.join(dir, dirent.name);
      // Ignored entries are skipped *and*, for directories, never queued —
      // pruning is where the real win is. Excluding `node_modules` after
      // walking it would still spend the whole visit budget inside it.
      if (respectGitignore && shouldSkip(abs, dirent.name, type === "dir", effectiveLayers)) {
        continue;
      }
      // ディレクトリはヒットに含めない (kawaz r55m76): FileViewer で開けない
      // ので結果に出ても選べず、件数上限だけを消費する邪魔な行になる。走査
      // 対象としては引き続き queue に積む (配下のファイルを探すため)。
      if (type !== "dir" && matchesFileSearchQuery(toDisplay(abs), parsed)) {
        if (hits.length >= FS_FIND_RESULT_MAX) {
          truncated = true;
          return { hits, truncated };
        }
        hits.push({ path: toDisplay(abs), type });
      }
      if (type === "dir") queue.push({ dir: abs, layers: effectiveLayers });
    }
  }
  return { hits, truncated };
}

/** `.git` is pruned unconditionally (see gitignore.ts's header: no
 * `.gitignore` lists it, yet it is the biggest source of unsearchable paths).
 * Everything else goes through the compiled rules. */
function shouldSkip(
  abs: string,
  name: string,
  isDir: boolean,
  layers: readonly IgnoreLayer[],
): boolean {
  if (isDir && name === ".git") return true;
  return isIgnored(abs, isDir, layers);
}

/**
 * `.gitignore` files governing `absRoot` itself, outermost first.
 *
 * The walk often starts partway down a repo — the tree browses from the
 * session cwd, which under a worktree layout sits below the containment root —
 * so the rules hiding vendored trees inside it may live above where the walk
 * starts. A `node_modules/` line in a `.gitignore` at the containment root
 * must still prune `pkg/node_modules` when the search begins at `pkg`.
 *
 * The scan stops at `containmentRoot` and never goes above it. That is the
 * same boundary the resolver already authorized for this request, so filtering
 * reads nothing the op could not already read; walking further up would let a
 * file outside the authorized surface influence the reply, which is a wider
 * read surface than fs_find is supposed to have even when the only thing it
 * can do is remove results.
 */
function collectLayers(absRoot: string, containmentRoot: string): IgnoreLayer[] {
  const ancestors: string[] = [];
  let dir = path.dirname(absRoot);
  let prev = absRoot;
  while (dir !== prev && dir.length >= containmentRoot.length) {
    ancestors.push(dir);
    if (dir === containmentRoot) break;
    prev = dir;
    dir = path.dirname(dir);
  }
  const layers: IgnoreLayer[] = [];
  // Outermost first, so a nearer .gitignore's conflicting rule wins.
  for (const ancestor of ancestors.reverse()) {
    const layer = readIgnoreLayer(ancestor);
    if (layer) layers.push(layer);
  }
  return layers;
}

export function fsFind(
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  sid: string,
  kind: unknown,
  reqRoot: unknown,
  query: unknown,
  respectGitignore: unknown,
  opts: FsAccessOptions = {},
): FsAccessResult<Omit<FsFindResponse, "ok">> {
  if (kind !== "contained" && kind !== "workspace") {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "fs_find kind must be 'contained' or 'workspace'",
    };
  }
  if (typeof query !== "string") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_find query must be a string" };
  }
  if (reqRoot !== undefined && typeof reqRoot !== "string") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_find root must be a string" };
  }
  if (respectGitignore !== undefined && typeof respectGitignore !== "boolean") {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "fs_find respect_gitignore must be a boolean",
    };
  }
  // Absent means "apply .gitignore" — see FsFindRequest's doc comment for why
  // filtering is the default rather than the opt-in.
  const applyIgnore = respectGitignore ?? true;

  const resolved = resolveFindRoot(sessions, statusStore, sid, kind, reqRoot, opts);
  if (!resolved.ok) return resolved;

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved.data.realPath);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqRoot ?? ""}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_find root is not a directory" };
  }

  const parsed = parseFileSearchQuery(query);
  // An empty query (and an exclusion-only one) short-circuits before any
  // readdir: no walk, no results.
  if (fileSearchQueryIsEmpty(parsed))
    return { ok: true, data: { sid, hits: [], truncated: false } };

  // Display shape mirrors the corresponding list op so hits drop straight into
  // the client's existing locator/tree keys: root-relative for contained
  // (fs_list), absolute for workspace (fs_list_workspace).
  const containmentRoot = resolved.data.containmentRoot;
  const toDisplay =
    kind === "contained"
      ? (abs: string) => path.relative(containmentRoot, abs)
      : (abs: string) => abs;

  const { hits, truncated } = walkFind(
    resolved.data.realPath,
    containmentRoot,
    toDisplay,
    parsed,
    applyIgnore,
  );
  return { ok: true, data: { sid, hits, truncated } };
}
