// The owner → repo → session tree inside each SESSIONS status section
// (DR-0043 §10), and the open/closed state of its folds. Kept out of
// SessionList.tsx so the grouping and the stored state are exercised without
// mounting the list.
import * as v from "valibot";
import { jsonText, parseWith } from "@ccmsg/protocol";
import { readStorage, writeStorage } from "./storage.ts";
import type { SessionRow } from "./utils.ts";

/** One repository of an owner, and its sessions in the list's order. */
export interface SessionRepoNode {
  /** The repository's name (the slug's part after the owner). */
  name: string;
  /** Fold key (see `sessionTreeFoldKey`). */
  key: string;
  rows: SessionRow[];
}

/** A top-level node of a section's tree: an owner holding repositories, or
 * the one group of sessions whose repository the daemon could not tell. */
export type SessionTreeNode =
  | {
      kind: "owner";
      owner: string;
      key: string;
      repos: SessionRepoNode[];
      /** Sessions under this owner, all repositories together. */
      count: number;
    }
  | { kind: "no-repo"; key: string; rows: SessionRow[] };

/** The heading of the group of sessions with no repository. */
export const NO_REPO_LABEL = "(repo なし)";

/** Fold keys. The section is part of every key: the same owner in Waiting and
 * in Active are two folds, so closing a crowded owner in Active never hides
 * the one session Waiting is there to point at. The kind is part of it too, so
 * an owner key never collides with a repo key (an owner may itself hold a
 * `/`, a GitLab group). */
export function sessionTreeFoldKey(
  section: string,
  node: { kind: "owner"; owner: string } | { kind: "repo"; slug: string } | { kind: "no-repo" },
): string {
  switch (node.kind) {
    case "owner":
      return `owner:${section}:${node.owner}`;
    case "repo":
      return `repo:${section}:${node.slug}`;
    default:
      return `no-repo:${section}`;
  }
}

/** Splits an `owner/name` slug at its last `/` (an owner may hold `/`, a
 * repository name never does). */
function splitSlug(slug: string): { owner: string; name: string } {
  const cut = slug.lastIndexOf("/");
  return cut < 0
    ? { owner: slug, name: slug }
    : { owner: slug.slice(0, cut), name: slug.slice(cut + 1) };
}

/** Builds a section's tree from its rows, which arrive already in the list's
 * sort order (Sidebar's sortPeers: prompt / name / created / recent).
 *
 * Every level takes the order of first appearance, which is the sort applied
 * per level: a repository sits where its front-most session would, and an
 * owner where its front-most repository would. With `recent`, owners go by
 * the latest session among their repositories, repositories by their latest
 * session, and sessions by their own time. Nothing is re-sorted here, so the
 * tree can never disagree with the order the sort key names. The no-repo
 * group takes the place of its own front-most session among the owners. */
export function sessionTree(section: string, rows: readonly SessionRow[]): SessionTreeNode[] {
  const nodes: SessionTreeNode[] = [];
  const owners = new Map<string, Extract<SessionTreeNode, { kind: "owner" }>>();
  const repos = new Map<string, SessionRepoNode>();
  let noRepo: Extract<SessionTreeNode, { kind: "no-repo" }> | null = null;
  for (const row of rows) {
    if (row.repo === "") {
      if (noRepo === null) {
        noRepo = {
          kind: "no-repo",
          key: sessionTreeFoldKey(section, { kind: "no-repo" }),
          rows: [],
        };
        nodes.push(noRepo);
      }
      noRepo.rows.push(row);
      continue;
    }
    const { owner, name } = splitSlug(row.repo);
    let ownerNode = owners.get(owner);
    if (ownerNode === undefined) {
      ownerNode = {
        kind: "owner",
        owner,
        key: sessionTreeFoldKey(section, { kind: "owner", owner }),
        repos: [],
        count: 0,
      };
      owners.set(owner, ownerNode);
      nodes.push(ownerNode);
    }
    ownerNode.count += 1;
    let repoNode = repos.get(row.repo);
    if (repoNode === undefined) {
      repoNode = {
        name,
        key: sessionTreeFoldKey(section, { kind: "repo", slug: row.repo }),
        rows: [],
      };
      repos.set(row.repo, repoNode);
      ownerNode.repos.push(repoNode);
    }
    repoNode.rows.push(row);
  }
  return nodes;
}

/** localStorage key of the tree's closed folds. Content, not a per-window
 * state (storage.ts's table): a fold the reader closed stays closed in the
 * next window and after a reload. */
export const SESSION_TREE_CLOSED_STORAGE_KEY = "ccmsg.sessionTree.closed";

const ClosedSchema = v.optional(v.array(v.string()), () => []);
const ClosedTextSchema = jsonText(ClosedSchema);

/** The fold keys stored as closed. Only closed ones are stored: every fold
 * opens by default, so a fold never touched needs no entry. A stored value
 * that does not read as a list of keys is ignored as a whole. */
export function loadClosedSessionFolds(): ReadonlySet<string> {
  const raw = readStorage(SESSION_TREE_CLOSED_STORAGE_KEY);
  const read = raw === null ? null : parseWith(ClosedTextSchema, raw);
  return new Set(read?.ok ? read.value : v.getDefault(ClosedSchema));
}

/** The set with `key` closed or opened, and stored. */
export function storeSessionFold(
  closed: ReadonlySet<string>,
  key: string,
  open: boolean,
): ReadonlySet<string> {
  const next = new Set(closed);
  if (open) next.delete(key);
  else next.add(key);
  writeStorage(SESSION_TREE_CLOSED_STORAGE_KEY, JSON.stringify([...next]));
  return next;
}
