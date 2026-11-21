// The owner → (prefix | repo) → session tree inside each SESSIONS status
// section (DR-0043 §10), and the open/closed state of its folds. Kept out of
// SessionList.tsx so the grouping and the stored state are exercised without
// mounting the list.
import * as v from "valibot";
import { jsonText, parseWith } from "@ccmsg/protocol";
import { readStorage, writeStorage } from "./storage.ts";
import type { SessionRow } from "./utils.ts";

/** The level under an owner: the sessions of one repository, or of every
 * repository sharing a name prefix (see `repoPrefix`). Either way the
 * sessions are listed flat, in the list's order. */
export interface SessionGroupNode {
  kind: "prefix" | "repo";
  /** The heading: the prefix, or the repository's name. */
  name: string;
  /** Fold key (see `sessionTreeFoldKey`). */
  key: string;
  rows: SessionRow[];
}

/** A top-level node of a section's tree: an owner holding groups, or the one
 * group of sessions whose repository the daemon could not tell (`others`,
 * always last). Both carry
 * every session under them (`rows`), which is what the owner's count and a
 * folded heading's 🔔🔐 sum are taken from. */
export type SessionTreeNode =
  | {
      kind: "owner";
      owner: string;
      key: string;
      groups: SessionGroupNode[];
      /** Every session under this owner, in the list's order. */
      rows: SessionRow[];
    }
  | { kind: "others"; key: string; rows: SessionRow[] };

/** The heading of the group of sessions with no repository (kawaz
 * 2026-11-21: owner が無いケースは 1 番下に others で). */
export const OTHERS_LABEL = "others";

/** Fold keys. The section is part of every key: the same owner in Waiting and
 * in Active are two folds, so closing a crowded owner in Active never hides
 * the one session Waiting is there to point at. The kind is part of it too, so
 * keys of different levels never collide (an owner may itself hold a `/`, a
 * GitLab group). */
export function sessionTreeFoldKey(
  section: string,
  node:
    | { kind: "owner"; owner: string }
    | { kind: "repo"; slug: string }
    | { kind: "prefix"; owner: string; prefix: string }
    | { kind: "others" },
): string {
  switch (node.kind) {
    case "owner":
      return `owner:${section}:${node.owner}`;
    case "repo":
      return `repo:${section}:${node.slug}`;
    case "prefix":
      return `prefix:${section}:${node.owner}/${node.prefix}`;
    default:
      return `others:${section}`;
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

/** The repository's name of an `owner/name` slug ("" for ""): what a row
 * under its owner's fold prints. */
export function repoName(slug: string): string {
  return slug === "" ? "" : splitSlug(slug).name;
}

/** A repository name's prefix: the word before its first `-`, or the whole
 * name when it is one word (`^(\w+)(-|$)`, `\w` being ASCII letters, digits
 * and `_`). `sockat`, `sockat-go` and `sockat-rs` all have `sockat`;
 * `claude-ccmsg` has `claude`; `ab` and `abc` have themselves, so they never
 * share one. null when the name does not start with such a word (`.github`,
 * `foo.bar`). */
export function repoPrefix(name: string): string | null {
  const match = /^(\w+)(?:-|$)/.exec(name);
  return match?.[1] ?? null;
}

/** Builds a section's tree from its rows, which arrive already in the list's
 * sort order (Sidebar's sortPeers: prompt / name / created / recent).
 *
 * Under an owner, the repositories that share a prefix with at least one
 * other repository of that owner (in this section) form one prefix group,
 * named by the prefix, and no group of their own — even a repository with
 * several sessions goes into the prefix group. Every other repository is a
 * repo group, named by its name.
 *
 * Every level takes the order of first appearance, which is the sort applied
 * per level: a group sits where its front-most session would, and an owner
 * where its front-most group would. With `recent`, owners go by the latest
 * session among their groups, groups by their latest session, and sessions by
 * their own time. Nothing is re-sorted here, so the tree can never disagree
 * with the order the sort key names. The sessions with no repository go into
 * `others`, which comes after every owner whatever the sort: it holds what
 * the tree cannot place, not a peer of the owners. */
export function sessionTree(section: string, rows: readonly SessionRow[]): SessionTreeNode[] {
  // Which prefixes are shared: the distinct repositories per (owner, prefix).
  const reposByPrefix = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.repo === "") continue;
    const { owner, name } = splitSlug(row.repo);
    const prefix = repoPrefix(name);
    if (prefix === null) continue;
    const id = `${owner}/${prefix}`;
    const set = reposByPrefix.get(id) ?? new Set<string>();
    set.add(name);
    reposByPrefix.set(id, set);
  }

  const nodes: SessionTreeNode[] = [];
  const owners = new Map<string, Extract<SessionTreeNode, { kind: "owner" }>>();
  const groups = new Map<string, SessionGroupNode>();
  const others: SessionRow[] = [];
  for (const row of rows) {
    if (row.repo === "") {
      others.push(row);
      continue;
    }
    const { owner, name } = splitSlug(row.repo);
    let ownerNode = owners.get(owner);
    if (ownerNode === undefined) {
      ownerNode = {
        kind: "owner",
        owner,
        key: sessionTreeFoldKey(section, { kind: "owner", owner }),
        groups: [],
        rows: [],
      };
      owners.set(owner, ownerNode);
      nodes.push(ownerNode);
    }
    ownerNode.rows.push(row);
    const prefix = repoPrefix(name);
    const shared = prefix !== null && (reposByPrefix.get(`${owner}/${prefix}`)?.size ?? 0) >= 2;
    const key = shared
      ? sessionTreeFoldKey(section, { kind: "prefix", owner, prefix })
      : sessionTreeFoldKey(section, { kind: "repo", slug: row.repo });
    let group = groups.get(key);
    if (group === undefined) {
      group = shared
        ? { kind: "prefix", name: prefix, key, rows: [] }
        : { kind: "repo", name, key, rows: [] };
      groups.set(key, group);
      ownerNode.groups.push(group);
    }
    group.rows.push(row);
  }
  if (others.length > 0) {
    nodes.push({
      kind: "others",
      key: sessionTreeFoldKey(section, { kind: "others" }),
      rows: others,
    });
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
