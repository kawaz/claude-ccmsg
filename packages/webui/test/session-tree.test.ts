// The owner → repo → session tree of a SESSIONS status section (DR-0043 §10):
// how rows group, and that each level takes the sort key's order (a repo sits
// where its front-most session would, an owner where its front-most repo
// would), and the stored closed folds.
import { afterEach, describe, expect, test } from "bun:test";
import type { PeerInfo } from "@ccmsg/protocol";
import {
  loadClosedSessionFolds,
  OTHERS_LABEL,
  repoPrefix,
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

/** The tree as text: `owner (count)` / `  group` / `    sid`, a prefix
 * group's name marked `*` (`  claude*`), and the group with no repository as
 * `others` / `  sid`. */
function outline(nodes: readonly SessionTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "others"
      ? [OTHERS_LABEL, ...node.rows.map((row) => `  ${row.sid}`)]
      : [
          `${node.owner} (${node.rows.length})`,
          ...node.groups.flatMap((group) => [
            `  ${group.name}${group.kind === "prefix" ? "*" : ""}`,
            ...group.rows.map((row) => `    ${row.sid}`),
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
      OTHERS_LABEL,
      "  bare",
    ]);
  });

  // name: owners and repos alphabetically, sessions by workspace. The row
  // with no repository sorts first by name (an empty slug), yet its group,
  // others, stays last: it comes after every owner whatever the sort.
  test("name orders every level by name, and others stays last", () => {
    expect(treeOf(PEERS, "name")).toEqual([
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
      OTHERS_LABEL,
      "  bare",
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
});

// The level under an owner: repositories sharing a prefix (`^(\w+)(-|$)`) with
// another repository of the same owner gather into one prefix group named by
// the prefix, with their sessions flat and no repository group of their own;
// a repository sharing its prefix with none is a repository group.
describe("prefix groups", () => {
  test("a repository name's prefix is the word before the first -, or the whole one-word name", () => {
    expect(repoPrefix("sockat")).toBe("sockat");
    expect(repoPrefix("sockat-go")).toBe("sockat");
    expect(repoPrefix("claude-rules-personal")).toBe("claude");
    expect(repoPrefix("kuu_mbt-x")).toBe("kuu_mbt");
    expect(repoPrefix("ab")).toBe("ab");
    expect(repoPrefix("abc")).toBe("abc");
    expect(repoPrefix(".github")).toBeNull();
    expect(repoPrefix("foo.bar")).toBeNull();
    expect(repoPrefix("kuu.mbt")).toBeNull();
  });

  test("sockat, sockat-go, sockat-py and sockat-rs are one group sockat", () => {
    const tree = treeOf(
      [
        peer("s1", "kawaz/sockat", "main", 1),
        peer("s2", "kawaz/sockat-go", "main", 2),
        peer("s3", "kawaz/sockat-py", "main", 3),
        peer("s4", "kawaz/sockat-rs", "main", 4),
      ],
      "idle",
    );
    expect(tree).toEqual(["kawaz (4)", "  sockat*", "    s1", "    s2", "    s3", "    s4"]);
  });

  // claude-ccmsg has two sessions: they go into the prefix group, and no
  // claude-ccmsg group is made. hyoui shares its prefix with nothing.
  test("claude-ccmsg and claude-rules-personal are one group claude, hyoui alone is hyoui", () => {
    const tree = treeOf(
      [
        peer("c1", "kawaz/claude-ccmsg", "main", 1),
        peer("h1", "kawaz/hyoui", "main", 2),
        peer("r1", "kawaz/claude-rules-personal", "main", 3),
        peer("c2", "kawaz/claude-ccmsg", "fix", 4),
      ],
      "idle",
    );
    expect(tree).toEqual([
      "kawaz (4)",
      "  claude*",
      "    c1",
      "    r1",
      "    c2",
      "  hyoui",
      "    h1",
    ]);
  });

  test("ab and abc are not grouped", () => {
    const tree = treeOf(
      [peer("ab", "kawaz/ab", "main", 1), peer("abc", "kawaz/abc", "main", 2)],
      "idle",
    );
    expect(tree).toEqual(["kawaz (2)", "  ab", "    ab", "  abc", "    abc"]);
  });

  // One repository with several sessions does not make a prefix group.
  test("a prefix held by one repository only is that repository's group", () => {
    const tree = treeOf(
      [peer("x1", "kawaz/sockat-go", "main", 1), peer("x2", "kawaz/sockat-go", "fix", 2)],
      "idle",
    );
    expect(tree).toEqual(["kawaz (2)", "  sockat-go", "    x1", "    x2"]);
  });

  // The prefix is shared within one owner only.
  test("the same prefix under two owners makes no group", () => {
    const tree = treeOf(
      [peer("a", "alice/claude-x", "main", 1), peer("b", "bob/claude-y", "main", 2)],
      "idle",
    );
    expect(tree).toEqual(["alice (1)", "  claude-x", "    a", "bob (1)", "  claude-y", "    b"]);
  });

  test("a prefix group's key carries the owner and the prefix", () => {
    expect(sessionTreeFoldKey("active", { kind: "prefix", owner: "kawaz", prefix: "claude" })).toBe(
      "prefix:active:kawaz/claude",
    );
  });

  test("a prefix group sits where its front-most session does", () => {
    const tree = treeOf(
      [
        peer("h", "kawaz/hyoui", "main", 1),
        peer("c", "kawaz/claude-ccmsg", "main", 2),
        peer("d", "kawaz/die", "main", 3),
        peer("r", "kawaz/claude-rules", "main", 4),
      ],
      "idle",
    );
    expect(tree).toEqual([
      "kawaz (4)",
      "  hyoui",
      "    h",
      "  claude*",
      "    c",
      "    r",
      "  die",
      "    d",
    ]);
  });
});

describe("fold keys", () => {
  // Keys carry the section, so one owner in two sections is two folds, and
  // the kind, so an owner key never equals a repo key.
  test("fold keys carry the section and the kind", () => {
    expect(sessionTreeFoldKey("active", { kind: "owner", owner: "a/b" })).toBe("owner:active:a/b");
    expect(sessionTreeFoldKey("active", { kind: "repo", slug: "a/b" })).toBe("repo:active:a/b");
    expect(sessionTreeFoldKey("waiting", { kind: "owner", owner: "a/b" })).toBe(
      "owner:waiting:a/b",
    );
    expect(sessionTreeFoldKey("active", { kind: "others" })).toBe("others:active");
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
