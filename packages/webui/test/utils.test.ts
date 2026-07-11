// errorMessage is the shared formatter FileTree/FileViewer/Timeline's
// fsList/fsRead/transcriptRead .catch() handlers use to fold a rejected
// ws.ts send() (e.g. Error("ws not open"), see ws.test.ts) into the same
// plain-string shape as ErrorResponse["error"]["msg"].
import { describe, expect, test } from "bun:test";
import type { PeerInfo } from "@ccmsg/protocol";
import {
  errorMessage,
  formatDuration,
  nextPeerSortKey,
  ownWorkspaceSegment,
  repoRootLabel,
  sessionLabel,
  sortPeers,
  type PeerSortKey,
} from "../src/client/utils.ts";

describe("errorMessage", () => {
  test("extracts .message from an Error instance", () => {
    expect(errorMessage(new Error("ws not open"))).toBe("ws not open");
  });

  test("stringifies a non-Error rejection reason", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });
});

function peer(overrides: Partial<PeerInfo>): PeerInfo {
  return {
    sid: "s1",
    repo: "claude-ccmsg",
    ws: "main",
    cwd: "/repos/claude-ccmsg/main",
    ...overrides,
  };
}

describe("sessionLabel", () => {
  // Common case: workspace name and checked-out branch happen to match
  // (a named jj workspace checked out at its own bookmark) — showing both
  // would just repeat the same word, so `branch` collapses into `ws`.
  test("collapses branch into ws when they're equal", () => {
    expect(sessionLabel(peer({ repo: "claude-ccmsg", ws: "main", branch: "main" }))).toBe(
      "claude-ccmsg · main",
    );
  });

  // ws (workspace/worktree name) and branch (the actual checkout) can
  // genuinely differ — e.g. a workspace named after an issue number, or a
  // detached/rebased checkout. Both carry distinct information, so both show.
  test("shows repo, ws, and branch as three distinct segments when they differ", () => {
    expect(
      sessionLabel(peer({ repo: "claude-ccmsg", ws: "review-42", branch: "fix/webui-label" })),
    ).toBe("claude-ccmsg · review-42 · fix/webui-label");
  });

  // repo === ws is NOT collapsed (unlike ws/branch) — a plain non-worktree
  // checkout legitimately has ws set equal to repo, and that repetition is
  // still meaningful (distinguishes "has a workspace layer" from "doesn't").
  test("does not collapse repo and ws even when equal", () => {
    expect(sessionLabel(peer({ repo: "claude-ccmsg", ws: "claude-ccmsg", branch: "main" }))).toBe(
      "claude-ccmsg · claude-ccmsg · main",
    );
  });

  // Missing segments are skipped outright, not shown as "?" placeholders —
  // only the segments that are actually known appear.
  test("skips an empty ws segment rather than showing a placeholder", () => {
    expect(sessionLabel(peer({ repo: "claude-ccmsg", ws: "", branch: "main" }))).toBe(
      "claude-ccmsg · main",
    );
  });

  test("skips an empty branch segment rather than showing a placeholder", () => {
    expect(sessionLabel(peer({ repo: "claude-ccmsg", ws: "main", branch: "" }))).toBe(
      "claude-ccmsg · main",
    );
  });

  test("shows repo alone when ws and branch are both empty", () => {
    expect(sessionLabel(peer({ repo: "claude-ccmsg", ws: "", branch: "" }))).toBe("claude-ccmsg");
  });

  // No VCS metadata announced at all: falling back to "?" (or an empty
  // string) would make every such session indistinguishable in the list, so
  // the first 8 chars of sid — always present, always unique — stand in.
  test("falls back to the first 8 chars of sid when repo/ws/branch are all empty", () => {
    expect(sessionLabel(peer({ sid: "s1234567890abcdef", repo: "", ws: "", branch: "" }))).toBe(
      "s1234567",
    );
  });
});

describe("ownWorkspaceSegment", () => {
  test("returns the first cwd segment past repo_root", () => {
    expect(
      ownWorkspaceSegment(
        peer({ repo_root: "/repos/claude-ccmsg", cwd: "/repos/claude-ccmsg/main" }),
      ),
    ).toBe("main");
  });

  test("returns the first segment even when cwd is deeper inside the workspace", () => {
    expect(
      ownWorkspaceSegment(
        peer({ repo_root: "/repos/claude-ccmsg", cwd: "/repos/claude-ccmsg/main/packages/webui" }),
      ),
    ).toBe("main");
  });

  test("returns null when the peer has no repo_root (fs root is still cwd)", () => {
    expect(
      ownWorkspaceSegment(peer({ repo_root: undefined, cwd: "/repos/claude-ccmsg/main" })),
    ).toBeNull();
  });

  test("returns null when cwd is unexpectedly outside repo_root (defensive)", () => {
    expect(
      ownWorkspaceSegment(peer({ repo_root: "/other/root", cwd: "/repos/claude-ccmsg/main" })),
    ).toBeNull();
  });

  test("tolerates a trailing slash on repo_root", () => {
    expect(
      ownWorkspaceSegment(
        peer({ repo_root: "/repos/claude-ccmsg/", cwd: "/repos/claude-ccmsg/main" }),
      ),
    ).toBe("main");
  });
});

describe("repoRootLabel", () => {
  test("returns the last path segment of repo_root", () => {
    expect(repoRootLabel(peer({ repo_root: "/repos/claude-ccmsg" }))).toBe("claude-ccmsg");
  });

  test("returns null when the peer has no repo_root", () => {
    expect(repoRootLabel(peer({ repo_root: undefined }))).toBeNull();
  });
});

describe("formatDuration", () => {
  // seconds-only band: no unit crossed yet, so a single unit is enough
  test("< 1 minute renders seconds only", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s"); // floors to whole seconds
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  // minutes band: keeps the trailing seconds so "just went idle" (1m0s) and
  // "idle most of the next minute" (1m59s) stay distinguishable
  test("< 1 hour renders minutes + seconds", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(80_000)).toBe("1m20s");
    expect(formatDuration(5 * 60_000 + 20_000)).toBe("5m20s");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59m59s");
  });

  // hours band
  test("< 1 day renders hours + minutes", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h0m");
    expect(formatDuration(60 * 60_000 + 10 * 60_000)).toBe("1h10m");
    expect(formatDuration(23 * 60 * 60_000 + 59 * 60_000)).toBe("23h59m");
  });

  // days band
  test(">= 1 day renders days + hours", () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe("1d0h");
    expect(formatDuration(2 * 24 * 60 * 60_000 + 3 * 60 * 60_000)).toBe("2d3h");
  });

  // negative input (clock skew / stale snapshot) shouldn't render "-5s"
  test("clamps negative input to 0s", () => {
    expect(formatDuration(-500)).toBe("0s");
  });
});

describe("nextPeerSortKey", () => {
  test("cycles name -> idle -> connected -> name", () => {
    const seq: PeerSortKey[] = [];
    let k: PeerSortKey = "name";
    for (let i = 0; i < 4; i++) {
      seq.push(k);
      k = nextPeerSortKey(k);
    }
    expect(seq).toEqual(["name", "idle", "connected", "name"]);
  });
});

describe("sortPeers", () => {
  test("name key: repo, then ws, then branch, then sid — matches sessionLabel's fields", () => {
    const peers = [
      peer({ sid: "z", repo: "b-repo", ws: "main", branch: "main" }),
      peer({ sid: "y", repo: "a-repo", ws: "main", branch: "main" }),
      peer({ sid: "x", repo: "a-repo", ws: "main", branch: "feat" }),
    ];
    expect(sortPeers(peers, "name").map((p) => p.sid)).toEqual(["x", "y", "z"]);
  });

  test("name key: ties break on sid so ordering is deterministic", () => {
    const peers = [
      peer({ sid: "b", repo: "r", ws: "w", branch: "m" }),
      peer({ sid: "a", repo: "r", ws: "w", branch: "m" }),
    ];
    expect(sortPeers(peers, "name").map((p) => p.sid)).toEqual(["a", "b"]);
  });

  test("idle key: most recently active (last_activity_at) first", () => {
    const peers = [
      peer({ sid: "old", last_activity_at: "2026-07-10T00:00:00.000Z" }),
      peer({ sid: "new", last_activity_at: "2026-07-10T00:05:00.000Z" }),
      peer({ sid: "mid", last_activity_at: "2026-07-10T00:02:00.000Z" }),
    ];
    expect(sortPeers(peers, "idle").map((p) => p.sid)).toEqual(["new", "mid", "old"]);
  });

  test("idle key: peers missing last_activity_at sort after every peer that has one", () => {
    const peers = [
      peer({ sid: "no-activity", last_activity_at: undefined }),
      peer({ sid: "has-activity", last_activity_at: "2026-07-10T00:00:00.000Z" }),
    ];
    expect(sortPeers(peers, "idle").map((p) => p.sid)).toEqual(["has-activity", "no-activity"]);
  });

  test("connected key: most recently connected (connected_at) first", () => {
    const peers = [
      peer({ sid: "old", connected_at: "2026-07-10T00:00:00.000Z" }),
      peer({ sid: "new", connected_at: "2026-07-10T00:05:00.000Z" }),
    ];
    expect(sortPeers(peers, "connected").map((p) => p.sid)).toEqual(["new", "old"]);
  });

  test("does not mutate the input array", () => {
    const peers = [peer({ sid: "b", repo: "b" }), peer({ sid: "a", repo: "a" })];
    const before = [...peers];
    sortPeers(peers, "name");
    expect(peers).toEqual(before);
  });
});
