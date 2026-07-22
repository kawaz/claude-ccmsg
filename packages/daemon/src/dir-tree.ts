// Session-launcher cwd tree (DR-0018): bounded directory-only traversal with
// realpath containment, dot-directory exclusion, and lazy-fetch boundaries.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ErrorCode,
  type DirTreeEntry,
  type DirTreeResponse,
  type SessionLauncherConfig,
} from "@ccmsg/protocol";
import type { FsAccessResult } from "./fs-access.ts";
import { containedInRoots } from "./launcher-paths.ts";

// Design rationale: dir_tree uses synchronous filesystem APIs in the daemon's
// request handler, so a client-controlled unbounded depth could stall every
// connection. Five levels covers configured depth=2 plus several lazy-expansion
// levels while keeping one request's walk finite; deeper navigation stays lazy.
const MAX_DIR_TREE_DEPTH = 5;

/** Splits a filter string into non-empty, trimmed tokens on whitespace runs
 * (half-width and full-width `　` alike — JS `\s` covers both). An
 * empty/whitespace-only filter yields zero tokens, which `matchesAllTokens`
 * treats as "match everything" (kawaz r46m31: cwd search should stay a no-op
 * filter until the user types something). */
export function tokenizeFilter(filter: string): string[] {
  return filter
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** True when `haystack` contains every token (AND match, case-sensitive —
 * matching the prior single-token `includes` behavior this replaces). Zero
 * tokens always matches, so an empty filter keeps the "show everything"
 * behavior callers already relied on. */
export function matchesAllTokens(haystack: string, tokens: string[]): boolean {
  return tokens.every((token) => haystack.includes(token));
}

function compareEntries(a: DirTreeEntry, b: DirTreeEntry): number {
  // Plain codepoint order is deterministic across daemon/test/user locales,
  // matching fs-access.ts's stable name-order contract.
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function effectiveDepth(
  configured: number,
  requested: number | undefined,
): FsAccessResult<{ depth: number }> {
  const value = requested ?? configured;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "dir_tree depth must be a positive finite number",
    };
  }
  return {
    ok: true,
    data: { depth: Math.min(MAX_DIR_TREE_DEPTH, Math.max(1, Math.floor(value))) },
  };
}

function walkDirectory(
  cfg: SessionLauncherConfig,
  requestRoot: string,
  current: string,
  remainingDepth: number,
  filterTokens: string[] | undefined,
): DirTreeEntry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    // A directory can become unreadable or disappear after root validation. It
    // remains a valid tree node whose explored child set is empty.
    return [];
  }

  const entries: DirTreeEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const entryPath = path.join(current, dirent.name);

    if (dirent.isDirectory()) {
      // Normal directories inherit the already-validated contained parent.
    } else if (dirent.isSymbolicLink()) {
      // A link is displayed as a directory only when its resolved target is a
      // directory that remains inside a configured root. Escaping/broken links
      // are omitted rather than exposing an unusable cwd choice.
      const contained = containedInRoots(cfg.root_dirs, entryPath, "dir_tree entry");
      if (!contained.ok) continue;
    } else {
      continue;
    }

    const entry: DirTreeEntry = { path: entryPath, is_dir: true };
    if (remainingDepth > 1) {
      entry.children = walkDirectory(cfg, requestRoot, entryPath, remainingDepth - 1, filterTokens);
    }

    if (filterTokens !== undefined) {
      const relativePath = path.relative(requestRoot, entryPath);
      const matches = matchesAllTokens(relativePath, filterTokens);
      const descendantMatches = entry.children !== undefined && entry.children.length > 0;
      if (!matches && !descendantMatches) continue;
    }
    entries.push(entry);
  }

  entries.sort(compareEntries);
  return entries;
}

export function dirTree(
  cfg: SessionLauncherConfig | undefined,
  roots: string[],
  depth: number | undefined,
  filter: string | undefined,
): FsAccessResult<Omit<DirTreeResponse, "ok">> {
  if (!cfg) {
    return {
      ok: false,
      code: ErrorCode.launcher_not_configured,
      msg: "session launcher is not configured",
    };
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "dir_tree roots must be a non-empty array",
    };
  }
  if (filter !== undefined && typeof filter !== "string") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "dir_tree filter must be a string" };
  }
  const boundedDepth = effectiveDepth(cfg.dir_tree_depth, depth);
  if (!boundedDepth.ok) return boundedDepth;

  const filterTokens = filter === undefined ? undefined : tokenizeFilter(filter);
  const effectiveFilterTokens =
    filterTokens !== undefined && filterTokens.length === 0 ? undefined : filterTokens;

  const entries: DirTreeEntry[] = [];
  for (const root of roots) {
    const contained = containedInRoots(cfg.root_dirs, root, "dir_tree root");
    if (!contained.ok) return contained;
    entries.push(
      ...walkDirectory(
        cfg,
        contained.data.realPath,
        contained.data.realPath,
        boundedDepth.data.depth,
        effectiveFilterTokens,
      ),
    );
  }
  entries.sort(compareEntries);
  return { ok: true, data: { entries } };
}
