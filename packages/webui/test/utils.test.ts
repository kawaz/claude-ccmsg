// errorMessage is the shared formatter FileTree/FileViewer/Timeline's
// fsList/fsRead/transcriptRead .catch() handlers use to fold a rejected
// ws.ts send() (e.g. Error("ws not open"), see ws.test.ts) into the same
// plain-string shape as ErrorResponse["error"]["msg"].
import { describe, expect, test } from "bun:test";
import type { PeerInfo } from "@ccmsg/protocol";
import {
  errorMessage,
  ownWorkspaceSegment,
  repoRootLabel,
  sessionLabel,
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
  // DR-0008 addendum: cwd IS the workspace root here (tail "main" === ws
  // "main") — the third segment would just repeat `ws`, so it's dropped.
  test("drops the cwd-tail segment when cwd is the workspace root", () => {
    expect(
      sessionLabel(peer({ repo: "claude-ccmsg", ws: "main", cwd: "/repos/claude-ccmsg/main" })),
    ).toBe("claude-ccmsg · main");
  });

  // Plain (non-worktree) checkout: ws is often set equal to repo. cwd tail
  // then equals `repo`, not `ws` — still redundant, still dropped.
  test("drops the cwd-tail segment when cwd tail equals repo (non-worktree checkout)", () => {
    expect(
      sessionLabel(peer({ repo: "claude-ccmsg", ws: "claude-ccmsg", cwd: "/repos/claude-ccmsg" })),
    ).toBe("claude-ccmsg · claude-ccmsg");
  });

  // cwd is a subdirectory *within* the workspace — the tail carries real
  // information (which subdir the session is in), so it's kept.
  test("keeps the cwd-tail segment when cwd is a subdirectory of the workspace", () => {
    expect(
      sessionLabel(
        peer({ repo: "claude-ccmsg", ws: "main", cwd: "/repos/claude-ccmsg/main/packages/webui" }),
      ),
    ).toBe("claude-ccmsg · main · webui");
  });

  test('falls back to "?" for missing repo/ws', () => {
    expect(sessionLabel(peer({ repo: "", ws: "", cwd: "/x/y/z" }))).toBe("? · ? · z");
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
