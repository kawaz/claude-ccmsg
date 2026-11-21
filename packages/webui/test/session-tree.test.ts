// The owner → repo → session tree of a SESSIONS status section (DR-0043 §10):
// how rows group, and that each level takes the sort key's order (a repo sits
// where its front-most session would, an owner where its front-most repo
// would), and the stored closed folds.
import { afterEach, describe, expect, test } from "bun:test";
import type { PeerInfo } from "@ccmsg/protocol";
import {
  loadClosedSessionFolds,
  NO_REPO_LABEL,
  SESSION_TREE_CLOSED_STORAGE_KEY,
  sessionTree,
  sessionTreeFoldKey,
  type SessionTreeNode,
  storeSessionFold,
} from "../src/client/session-tree.ts";
import { sortPeers, toSessionRow, type PeerSortKey } from "../src/client/utils.ts";
import { withDom } from "./dom.ts";
import { peerLocation } from "./helpers.ts";

withDom();

afterEach(() => {
  localStorage.clear();
});

/** A peer of `repo` in workspace `ws` whose last activity is `minutesAgo`. */
function peer(sid: string, repo: string, ws: string, minutesAgo: number): PeerInfo {
  return {
    sid,
    ...peerLocation(repo, ws),
    cwd: `/w/${sid}`,
    connected_at: "2026-11-21T00:00:00.000Z",
    last_activity_at: new Date(Date.UTC(2026, 10, 21, 12) - minutesAgo * 60_000).toISOString(),
  };
}

/** The tree as text: `owner (count)` / `  repo` / `    sid`, and the no-repo
 * group as `(repo なし)` / `  sid`. */
function outline(nodes: readonly SessionTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "no-repo"
      ? [NO_REPO_LABEL, ...node.rows.map((row) => `  ${row.sid}`)]
      : [
          `${node.owner} (${node.count})`,
          ...node.repos.flatMap((repo) => [
            `  ${repo.name}`,
            ...repo.rows.map((row) => `    ${row.sid}`),
          ]),
        ],
  );
}

function treeOf(peers: PeerInfo[], key: PeerSortKey): string[] {
  const rows = sortPeers(peers, key).map((p) => toSessionRow(p, new Map(), new Map()));
  return outline(sessionTree("active", rows));
}

const PEERS = [
  peer("a-main", "alice/app", "main", 30),
  peer("a-fix", "alice/app", "fix", 5),
  peer("a-lib", "alice/lib", "main", 1),
  peer("b-tool", "bob/tool", "main", 10),
  peer("b-docs", "bob/docs", "main", 60),
  peer("bare", "", "", 20),
];

describe("sessionTree", () => {
  // recent: owners by the latest session among their repos, repos by their
  // latest session, sessions newest first.
  test("recent orders every level by its newest session", () => {
    expect(treeOf(PEERS, "idle")).toEqual([
      "alice (3)",
      "  lib",
      "    a-lib",
      "  app",
      "    a-fix",
      "    a-main",
      "bob (2)",
      "  tool",
      "    b-tool",
      "  docs",
      "    b-docs",
      NO_REPO_LABEL,
      "  bare",
    ]);
  });

  // name: owners and repos alphabetically, sessions by workspace. The row
  // with no repository sorts first by name (an empty slug), and its group
  // takes that place.
  test("name orders every level by name", () => {
    expect(treeOf(PEERS, "name")).toEqual([
      NO_REPO_LABEL,
      "  bare",
      "alice (3)",
      "  app",
      "    a-fix",
      "    a-main",
      "  lib",
      "    a-lib",
      "bob (2)",
      "  docs",
      "    b-docs",
      "  tool",
      "    b-tool",
    ]);
  });

  test("an owner holding a / is split at the last /", () => {
    const tree = sessionTree(
      "active",
      [peer("g", "group/sub/repo", "main", 1)].map((p) => toSessionRow(p, new Map(), new Map())),
    );
    expect(outline(tree)).toEqual(["group/sub (1)", "  repo", "    g"]);
  });

  test("no rows, no nodes", () => {
    expect(sessionTree("active", [])).toEqual([]);
  });

  // Keys carry the section, so one owner in two sections is two folds, and
  // the kind, so an owner key never equals a repo key.
  test("fold keys carry the section and the kind", () => {
    expect(sessionTreeFoldKey("active", { kind: "owner", owner: "a/b" })).toBe("owner:active:a/b");
    expect(sessionTreeFoldKey("active", { kind: "repo", slug: "a/b" })).toBe("repo:active:a/b");
    expect(sessionTreeFoldKey("waiting", { kind: "owner", owner: "a/b" })).toBe(
      "owner:waiting:a/b",
    );
    expect(sessionTreeFoldKey("active", { kind: "no-repo" })).toBe("no-repo:active");
  });
});

describe("the stored closed folds", () => {
  test("nothing stored is nothing closed", () => {
    expect([...loadClosedSessionFolds()]).toEqual([]);
  });

  test("closing stores the key, opening removes it", () => {
    const closed = storeSessionFold(new Set(), "owner:active:alice", false);
    expect([...loadClosedSessionFolds()]).toEqual(["owner:active:alice"]);
    storeSessionFold(closed, "owner:active:alice", true);
    expect([...loadClosedSessionFolds()]).toEqual([]);
  });

  test("a stored value that is not a list of keys is ignored", () => {
    localStorage.setItem(SESSION_TREE_CLOSED_STORAGE_KEY, '{"x":1}');
    expect([...loadClosedSessionFolds()]).toEqual([]);
    localStorage.setItem(SESSION_TREE_CLOSED_STORAGE_KEY, "not json");
    expect([...loadClosedSessionFolds()]).toEqual([]);
  });
});
