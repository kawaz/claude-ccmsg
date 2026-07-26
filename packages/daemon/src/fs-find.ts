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
  type FsFindHit,
  type FsFindResponse,
} from "@ccmsg/protocol";
import { tokenizeFilter } from "./dir-tree.ts";
import type { FsAccessOptions, FsAccessResult, SessionLookup } from "./fs-access.ts";
import { resolveFindRoot } from "./fs-access.ts";
import type { SessionStatusStore } from "./session-status.ts";

/** Lower-cases every token once, so the per-candidate match loop doesn't
 * re-fold the query for each of the thousands of paths it visits. Empty query
 * yields zero tokens, which `matchesQuery` deliberately treats as "match
 * nothing" (see its doc comment) — the opposite of dir_tree's filter, whose
 * empty state means "no filter applied". */
export function tokenizeQuery(query: string): string[] {
  return tokenizeFilter(query).map((token) => token.toLowerCase());
}

/**
 * True when `candidatePath` contains every token, case-insensitively.
 *
 * Case-insensitive rather than dir_tree's case-sensitive `matchesAllTokens`:
 * this query is typed against half-remembered file names ("filetree", "Readme"),
 * where forcing the user to reproduce the original casing turns a navigation
 * aid into a guessing game. dir_tree's own filter keeps its existing behavior —
 * this is a deliberately separate matcher, not a change to that one.
 *
 * Zero tokens (empty/whitespace-only query) matches nothing. An empty search
 * box should cost no walk and show no results, not enumerate the entire repo.
 */
export function matchesQuery(candidatePath: string, lowerTokens: readonly string[]): boolean {
  if (lowerTokens.length === 0) return false;
  const haystack = candidatePath.toLowerCase();
  return lowerTokens.every((token) => haystack.includes(token));
}

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
function walkFind(absRoot: string, toDisplay: (abs: string) => string, lowerTokens: string[]) {
  const hits: FsFindHit[] = [];
  let visited = 0;
  let truncated = false;
  const queue: string[] = [absRoot];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable/vanished directory (permissions, or a race with external
      // mutation). Skipping it is the same posture fs_list takes per-entry:
      // report what is reachable rather than failing the whole request.
      continue;
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
      // ディレクトリはヒットに含めない (kawaz r55m76): FileViewer で開けない
      // ので結果に出ても選べず、件数上限だけを消費する邪魔な行になる。走査
      // 対象としては引き続き queue に積む (配下のファイルを探すため)。
      if (type !== "dir" && matchesQuery(toDisplay(abs), lowerTokens)) {
        if (hits.length >= FS_FIND_RESULT_MAX) {
          truncated = true;
          return { hits, truncated };
        }
        hits.push({ path: toDisplay(abs), type });
      }
      if (type === "dir") queue.push(abs);
    }
  }
  return { hits, truncated };
}

export function fsFind(
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  sid: string,
  kind: unknown,
  reqRoot: unknown,
  query: unknown,
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

  const lowerTokens = tokenizeQuery(query);
  // An empty query short-circuits before any readdir: no walk, no results.
  if (lowerTokens.length === 0) return { ok: true, data: { sid, hits: [], truncated: false } };

  // Display shape mirrors the corresponding list op so hits drop straight into
  // the client's existing locator/tree keys: root-relative for contained
  // (fs_list), absolute for workspace (fs_list_workspace).
  const containmentRoot = resolved.data.containmentRoot;
  const toDisplay =
    kind === "contained"
      ? (abs: string) => path.relative(containmentRoot, abs)
      : (abs: string) => abs;

  const { hits, truncated } = walkFind(resolved.data.realPath, toDisplay, lowerTokens);
  return { ok: true, data: { sid, hits, truncated } };
}
