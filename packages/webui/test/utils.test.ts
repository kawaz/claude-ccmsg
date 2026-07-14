// errorMessage is the shared formatter FileTree/FileViewer/Timeline's
// fsList/fsRead/transcriptRead .catch() handlers use to fold a rejected
// ws.ts send() (e.g. Error("ws not open"), see ws.test.ts) into the same
// plain-string shape as ErrorResponse["error"]["msg"].
import { describe, expect, test } from "bun:test";
import type { AgentInfo, FsEntry, MemberEvent, PeerInfo } from "@ccmsg/protocol";
import type { RoomState } from "../src/client/store.ts";
import { ADMIN_ID } from "../src/client/store.ts";
import {
  badgeLabel,
  clampPaneRatio,
  errorMessage,
  formatDuration,
  groupSessionsBySection,
  indexAgentsBySid,
  isMarkdownPath,
  isMemberConnected,
  lastPathSegment,
  memberLabel,
  nextPeerSortKey,
  offlineAgentRows,
  ownWorkspaceSegment,
  paneRatioFromPointer,
  repoRootLabel,
  sessionBadges,
  sessionLabel,
  sessionRowRepoWs,
  sessionStatus,
  SESSION_PANE_MAX_RATIO,
  SESSION_PANE_MIN_RATIO,
  shortSid,
  sortPeers,
  splitRoomsByArchived,
  toSessionRow,
  workspaceRootEntries,
  type PeerSortKey,
  type SessionRow,
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

// --- ROOM member chip / from-display label (U2) --- //

function member(overrides: Partial<MemberEvent>): MemberEvent {
  return {
    type: "member",
    id: "m1",
    sid: "s1234567890abcdef",
    repo: "kawaz/claude-ccmsg",
    ws: "main",
    cwd: "/repos/claude-ccmsg/main",
    joined_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function roomWithMember(m: MemberEvent): RoomState {
  return {
    id: "r1",
    membersById: new Map([[m.id, { ...m, left: false }]]),
    memberOrder: [m.id],
    msgs: new Map(),
    timeline: [],
    lastMid: 0,
    lastTs: null,
    kind: "normal",
  };
}

describe("memberLabel", () => {
  test("ADMIN_ID always renders as 'User', regardless of room state", () => {
    expect(memberLabel(ADMIN_ID, undefined)).toBe("User");
  });

  // Core U2 behavior: repo's owner/org segment (`kawaz/`) is cut, and ws is
  // appended after a "/" — e.g. repo:"kawaz/claude-ccmsg", ws:"main" reads as
  // "claude-ccmsg/main". This is deliberately different from sessionLabel
  // (Sidebar Sessions list keeps the owner-qualified repo, per kawaz's
  // explicit "SESSIONS 側は今のまま" instruction) — see memberLabel's doc
  // comment for the rationale.
  test("strips the owner/org segment from repo and appends ws", () => {
    const room = roomWithMember(member({ id: "m1", repo: "kawaz/claude-ccmsg", ws: "main" }));
    expect(memberLabel("m1", room)).toBe("claude-ccmsg/main");
  });

  // A repo with more than one leading segment (nested org path) still
  // collapses to just its final segment — only the last "/"-separated part
  // is the repo's own name, everything before it is ownership/grouping.
  test("collapses a multi-segment repo path to its final segment", () => {
    const room = roomWithMember(member({ id: "m1", repo: "org/team/claude-ccmsg", ws: "main" }));
    expect(memberLabel("m1", room)).toBe("claude-ccmsg/main");
  });

  // ws empty: shows the repo name alone, no trailing "/" — an empty ws
  // segment must not leave a dangling separator.
  test("shows repo name alone when ws is empty", () => {
    const room = roomWithMember(member({ id: "m1", repo: "kawaz/claude-ccmsg", ws: "" }));
    expect(memberLabel("m1", room)).toBe("claude-ccmsg");
  });

  // repo empty: falls back to the pre-existing behavior (first 8 chars of
  // sid) — a session that hasn't announced VCS metadata is still
  // distinguishable in the chip list, same fallback as before this change.
  test("falls back to the first 8 chars of sid when repo is empty", () => {
    const room = roomWithMember(
      member({ id: "m1", sid: "s1234567890abcdef", repo: "", ws: "main" }),
    );
    expect(memberLabel("m1", room)).toBe("s1234567");
  });

  // Unknown member id (not in membersById, e.g. a stale mention target) or
  // no room at all: falls back to the raw id so callers never render "".
  test("falls back to the raw id when the member isn't found in the room", () => {
    const room = roomWithMember(member({ id: "other" }));
    expect(memberLabel("missing", room)).toBe("missing");
    expect(memberLabel("missing", undefined)).toBe("missing");
  });
});

// --- DR-0012: room archive folding + member connectivity --- //

function makeRoom(overrides: Partial<RoomState> = {}): RoomState {
  return {
    id: "r1",
    membersById: new Map(),
    memberOrder: [],
    msgs: new Map(),
    timeline: [],
    lastMid: 0,
    lastTs: null,
    kind: "normal",
    ...overrides,
  };
}

describe("splitRoomsByArchived", () => {
  test("buckets by the archived flag, preserving each bucket's relative input order", () => {
    const rooms = [
      makeRoom({ id: "r1", archived: false }),
      makeRoom({ id: "r2", archived: true }),
      makeRoom({ id: "r3", archived: false }),
      makeRoom({ id: "r4", archived: true }),
    ];
    const { active, archived } = splitRoomsByArchived(rooms);
    expect(active.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(archived.map((r) => r.id)).toEqual(["r2", "r4"]);
  });

  // absent `archived` (never toggled, or an older daemon's RoomSummary) is
  // treated as not-archived — same "falsy = active" rule the reducer's
  // `room.archived ? ... : ...` ternary in RoomView/RoomList relies on.
  test("a room with archived left undefined lands in the active bucket", () => {
    const { active, archived } = splitRoomsByArchived([makeRoom({ id: "r1" })]);
    expect(active.map((r) => r.id)).toEqual(["r1"]);
    expect(archived).toEqual([]);
  });

  test("empty input yields two empty buckets", () => {
    expect(splitRoomsByArchived([])).toEqual({ active: [], archived: [] });
  });
});

describe("isMemberConnected", () => {
  test("true when a peer with the member's sid is present", () => {
    const peers: PeerInfo[] = [peer({ sid: "s1" }), peer({ sid: "s2" })];
    expect(isMemberConnected({ sid: "s1" }, peers)).toBe(true);
  });

  test("false when no peer matches the member's sid (session disconnected)", () => {
    const peers: PeerInfo[] = [peer({ sid: "s2" })];
    expect(isMemberConnected({ sid: "s1" }, peers)).toBe(false);
  });

  test("false against an empty peers list", () => {
    expect(isMemberConnected({ sid: "s1" }, [])).toBe(false);
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

describe("clampPaneRatio", () => {
  // In-window values pass through unchanged — a persisted 40/60 split
  // reloads to exactly 0.4, not "close to 0.4".
  test("passes an in-range ratio through unchanged", () => {
    expect(clampPaneRatio(0.4)).toBe(0.4);
    expect(clampPaneRatio(0.5)).toBe(0.5);
  });

  // Boundary values are inclusive — dragging the splitter all the way to
  // one edge should land on the constant the caller sees, not one epsilon
  // inside, otherwise "dragged to min" and "one pixel past min" would
  // persist differently after a reload.
  test("keeps boundary values (min, max) as-is", () => {
    expect(clampPaneRatio(SESSION_PANE_MIN_RATIO)).toBe(SESSION_PANE_MIN_RATIO);
    expect(clampPaneRatio(SESSION_PANE_MAX_RATIO)).toBe(SESSION_PANE_MAX_RATIO);
  });

  // Below-min / above-max clamp to the boundary — the splitter never lets
  // the pointer push a pane past the usability floor/ceiling, and the
  // localStorage loader uses the same clamp so a stale value from an old
  // build with wider bounds shrinks to today's window without discarding
  // it outright.
  test("clamps below-min up and above-max down", () => {
    expect(clampPaneRatio(0)).toBe(SESSION_PANE_MIN_RATIO);
    expect(clampPaneRatio(-0.5)).toBe(SESSION_PANE_MIN_RATIO);
    expect(clampPaneRatio(1)).toBe(SESSION_PANE_MAX_RATIO);
    expect(clampPaneRatio(1.5)).toBe(SESSION_PANE_MAX_RATIO);
  });

  // Non-finite falls to min (see the doc comment on clampPaneRatio for
  // why min rather than default): the caller feeds this parseFloat's
  // result on a garbage/missing storage read, and picking either edge is
  // less surprising than silently substituting the default and hiding
  // the corruption.
  test("returns min for non-finite input (NaN / Infinity)", () => {
    expect(clampPaneRatio(Number.NaN)).toBe(SESSION_PANE_MIN_RATIO);
    expect(clampPaneRatio(Number.POSITIVE_INFINITY)).toBe(SESSION_PANE_MIN_RATIO);
    expect(clampPaneRatio(Number.NEGATIVE_INFINITY)).toBe(SESSION_PANE_MIN_RATIO);
  });

  // Caller-supplied custom bounds override the module defaults — used in
  // tests, and in case a future callsite wants a different window (e.g. a
  // narrower "tree hidden" mode). Verifies the arg plumbing, not just the
  // default constants.
  test("honors custom min/max bounds", () => {
    expect(clampPaneRatio(0.5, 0.2, 0.8)).toBe(0.5);
    expect(clampPaneRatio(0.1, 0.2, 0.8)).toBe(0.2);
    expect(clampPaneRatio(0.9, 0.2, 0.8)).toBe(0.8);
  });
});

describe("paneRatioFromPointer", () => {
  // Straightforward midpoint case: pointer sits exactly halfway across a
  // 1000px container starting at x=0, so the tree pane should occupy 50%.
  test("midpoint of the container gives ratio 0.5", () => {
    expect(paneRatioFromPointer(500, 0, 1000)).toBe(0.5);
  });

  // Container start offset (container isn't flush with viewport 0) — the
  // pointer is at clientX 300 but the container starts at 100, so the
  // split is at (300-100)/800 = 0.25 of the container's own width.
  test("subtracts containerStart from pointer before dividing", () => {
    expect(paneRatioFromPointer(300, 100, 800)).toBe(0.25);
  });

  // Pointer past either edge — the drag handler doesn't stop pointermove
  // events at the container's edges (pointer capture keeps them coming
  // even after leaving the element), so this function has to clamp the
  // out-of-container drag to the usability window itself.
  test("clamps a pointer past the container's edges", () => {
    expect(paneRatioFromPointer(-100, 0, 1000)).toBe(SESSION_PANE_MIN_RATIO);
    expect(paneRatioFromPointer(2000, 0, 1000)).toBe(SESSION_PANE_MAX_RATIO);
  });

  // Zero / negative container size — a tab hidden mid-resize, or a
  // display:none race — must not divide by zero. Falls back to min (see
  // doc comment) so the caller gets a defined value it can still write
  // to state without an NaN propagating into React style props.
  test("returns min for zero or negative container size", () => {
    expect(paneRatioFromPointer(500, 0, 0)).toBe(SESSION_PANE_MIN_RATIO);
    expect(paneRatioFromPointer(500, 0, -100)).toBe(SESSION_PANE_MIN_RATIO);
  });

  // Axis-agnosticism check: the same function drives both horizontal
  // (clientX / .left / .width) and vertical (clientY / .top / .height)
  // splits — the CSS `flex-direction` swap at ≤720px is the only thing
  // that changes. A vertical-style call with a 300px-tall container
  // should compute the same fraction as an equivalent horizontal one.
  test("axis-agnostic: works for vertical (Y) inputs the same way", () => {
    expect(paneRatioFromPointer(150, 0, 300)).toBe(0.5);
    expect(paneRatioFromPointer(90, 30, 300)).toBe(0.2);
  });
});

describe("isMarkdownPath", () => {
  // Canonical extensions — both DR-0010's rendering path and casual
  // ".markdown"-suffix repos should trigger the preview toggle.
  test("accepts .md and .markdown as canonical markdown extensions", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/DESIGN.markdown")).toBe(true);
    expect(isMarkdownPath("packages/webui/README.md")).toBe(true);
  });

  // Case-insensitive because case-insensitive filesystems (macOS default,
  // Windows) commonly ship "README.MD" — surprising the viewer with "not
  // markdown here" because of casing would be a bug, not a feature.
  test("accepts uppercase / mixed-case extensions", () => {
    expect(isMarkdownPath("README.MD")).toBe(true);
    expect(isMarkdownPath("NOTES.Md")).toBe(true);
    expect(isMarkdownPath("README.MARKDOWN")).toBe(true);
  });

  // Similar-looking extensions must be rejected: .mdx is JSX-embedded and
  // the safe walker in markdown-view.tsx doesn't render its JSX blocks
  // correctly; .txt is plain text (renders as pre already); .md.bak is a
  // backup file, not markdown itself.
  test("rejects mdx / txt / backup / no-extension files", () => {
    expect(isMarkdownPath("README.mdx")).toBe(false);
    expect(isMarkdownPath("NOTES.txt")).toBe(false);
    expect(isMarkdownPath("README.md.bak")).toBe(false);
    expect(isMarkdownPath("Makefile")).toBe(false);
    expect(isMarkdownPath("")).toBe(false);
  });

  // Dotfile edge: a bare ".md" (no name-part) is technically a hidden
  // file whose whole name is the extension. Treating it as markdown is
  // fine — no realistic dotfile is named exactly ".md", and if one is,
  // rendering it as markdown does no harm (the toggle is opt-in from the
  // viewer's default code mode).
  test("bare .md filename is treated as markdown", () => {
    expect(isMarkdownPath(".md")).toBe(true);
  });
});

// --- U1: Sidebar Sessions-list peers x agents merge --- //

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    pid: 1234,
    cwd: "/repos/claude-ccmsg/main",
    kind: "interactive",
    startedAt: 1_700_000_000_000,
    sessionId: "s1",
    config_dir: "/home/kawaz/.claude",
    ...overrides,
  };
}

describe("shortSid / lastPathSegment", () => {
  test("shortSid truncates to 8 chars, leaves shorter sids untouched", () => {
    expect(shortSid("s1234567890abcdef")).toBe("s1234567");
    expect(shortSid("s1")).toBe("s1");
  });

  test("lastPathSegment returns the final non-empty / segment", () => {
    expect(lastPathSegment("/repos/claude-ccmsg/main")).toBe("main");
    expect(lastPathSegment("/repos/claude-ccmsg/main/")).toBe("main"); // trailing slash ignored
  });

  test("lastPathSegment falls back to the input for a path with no segments", () => {
    expect(lastPathSegment("/")).toBe("/");
    expect(lastPathSegment("")).toBe("");
  });
});

describe("indexAgentsBySid / toSessionRow", () => {
  test("indexAgentsBySid keys agents by sessionId", () => {
    const idx = indexAgentsBySid([agent({ sessionId: "s1" }), agent({ sessionId: "s2" })]);
    expect(idx.size).toBe(2);
    expect(idx.get("s1")?.sessionId).toBe("s1");
  });

  test("toSessionRow attaches the matching agent and marks connected: true", () => {
    const idx = indexAgentsBySid([agent({ sessionId: "s1", status: "busy" })]);
    const row = toSessionRow(peer({ sid: "s1" }), idx);
    expect(row.connected).toBe(true);
    expect(row.agent?.status).toBe("busy");
  });

  test("toSessionRow leaves agent undefined when claude agents hasn't reported this sid", () => {
    const idx = indexAgentsBySid([agent({ sessionId: "other" })]);
    const row = toSessionRow(peer({ sid: "s1" }), idx);
    expect(row.connected).toBe(true);
    expect(row.agent).toBeUndefined();
  });
});

describe("offlineAgentRows", () => {
  test("returns only agents with no matching peer sid, connected: false", () => {
    const peers = [peer({ sid: "s1" })];
    const agents = [agent({ sessionId: "s1" }), agent({ sessionId: "s2", cwd: "/repos/other" })];
    const rows = offlineAgentRows(peers, agents);
    expect(rows.map((r) => r.sid)).toEqual(["s2"]);
    expect(rows[0]?.connected).toBe(false);
    expect(rows[0]?.agent?.sessionId).toBe("s2");
  });

  test("returns an empty array when every agent has a matching peer", () => {
    const peers = [peer({ sid: "s1" })];
    const agents = [agent({ sessionId: "s1" })];
    expect(offlineAgentRows(peers, agents)).toEqual([]);
  });

  test("sorts newest-started (startedAt desc) first", () => {
    const agents = [
      agent({ sessionId: "old", startedAt: 1_000 }),
      agent({ sessionId: "new", startedAt: 3_000 }),
      agent({ sessionId: "mid", startedAt: 2_000 }),
    ];
    expect(offlineAgentRows([], agents).map((r) => r.sid)).toEqual(["new", "mid", "old"]);
  });

  // Regression (adversarial review nit finding): the same sessionId reported
  // from more than one config_dir (theoretically possible per
  // indexAgentsBySid's doc comment — a copied config dir, say) must produce
  // exactly one row, not two rows sharing the same `sid` (SessionList's
  // `key={row.sid}` needs uniqueness). Last-wins, matching indexAgentsBySid's
  // Map.set policy.
  test("duplicate sessionId across config dirs collapses to one row (last-wins)", () => {
    const rows = offlineAgentRows(
      [],
      [
        agent({ sessionId: "dup", config_dir: "/home/.claude-a", cwd: "/a" }),
        agent({ sessionId: "dup", config_dir: "/home/.claude-b", cwd: "/b" }),
      ],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.agent?.config_dir).toBe("/home/.claude-b");
  });

  test("ws falls back to agent.name, then to cwd's last segment", () => {
    const withName = offlineAgentRows(
      [],
      [agent({ sessionId: "s1", name: "my-agent", cwd: "/repos/x/y" })],
    );
    expect(withName[0]?.ws).toBe("my-agent");

    const withoutName = offlineAgentRows(
      [],
      [agent({ sessionId: "s1", name: undefined, cwd: "/repos/x/y" })],
    );
    expect(withoutName[0]?.ws).toBe("y");
  });
});

function sessionRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    sid: "s1",
    repo: "claude-ccmsg",
    ws: "main",
    cwd: "/repos/claude-ccmsg/main",
    connected: true,
    ...overrides,
  };
}

describe("sessionRowRepoWs", () => {
  test("uses repo/ws as-is when the row has either", () => {
    expect(sessionRowRepoWs(sessionRow({ repo: "claude-ccmsg", ws: "main" }))).toEqual({
      repo: "claude-ccmsg",
      ws: "main",
    });
  });

  // agents-only rows never carry repo/ws (claude agents --json has no VCS
  // metadata) — falls back to the matched agent's name.
  test("falls back to agent.name when repo and ws are both empty", () => {
    const row = sessionRow({
      repo: "",
      ws: "",
      cwd: "/repos/x/y",
      connected: false,
      agent: agent({ name: "my-agent" }),
    });
    expect(sessionRowRepoWs(row)).toEqual({ repo: "", ws: "my-agent" });
  });

  test("falls back to cwd's last segment when repo/ws/agent.name are all absent", () => {
    const row = sessionRow({ repo: "", ws: "", cwd: "/repos/x/y", connected: false });
    expect(sessionRowRepoWs(row)).toEqual({ repo: "", ws: "y" });
  });
});

function fsEntry(overrides: Partial<FsEntry>): FsEntry {
  return { name: "x", type: "dir", ...overrides };
}

describe("workspaceRootEntries", () => {
  // FileTree's repo-container-root ws list (kawaz 2026-07-12): only
  // non-dotfile directories qualify as a workspace — files (README.md) and
  // dot-entries (.git, .envrc) never show at this level, even though a plain
  // fs_list("") against the container root would report them all.
  test("keeps only non-dotfile directories, dropping files and dot-entries", () => {
    const entries = [
      fsEntry({ name: "main", type: "dir" }),
      fsEntry({ name: "README.md", type: "file" }),
      fsEntry({ name: ".git", type: "dir" }),
      fsEntry({ name: ".envrc", type: "file" }),
    ];
    expect(workspaceRootEntries(entries, null).map((e) => e.name)).toEqual(["main"]);
  });

  // "そのセッションの wt/ws は常に一番上の位置": own workspace sorts first
  // regardless of its name, ahead of every alphabetically-earlier sibling —
  // FileTree relies on this ordering (plus its own auto-expand effect) to
  // default-open the row a session actually cares about.
  test("pins the own workspace first even when it doesn't sort first alphabetically", () => {
    const entries = [
      fsEntry({ name: "aaa-review", type: "dir" }),
      fsEntry({ name: "main", type: "dir" }),
      fsEntry({ name: "zzz-wip", type: "dir" }),
    ];
    expect(workspaceRootEntries(entries, "main").map((e) => e.name)).toEqual([
      "main",
      "aaa-review",
      "zzz-wip",
    ]);
  });

  // No workspace to pin (ownWsPath null, or not among the entries — e.g. a
  // stale/mismatched cwd segment) falls back to plain alphabetical, same as
  // any other directory listing.
  test("sorts the rest alphabetically when there's no own workspace to pin", () => {
    const entries = [
      fsEntry({ name: "zzz-wip", type: "dir" }),
      fsEntry({ name: "aaa-review", type: "dir" }),
    ];
    expect(workspaceRootEntries(entries, null).map((e) => e.name)).toEqual([
      "aaa-review",
      "zzz-wip",
    ]);
    expect(workspaceRootEntries(entries, "not-present").map((e) => e.name)).toEqual([
      "aaa-review",
      "zzz-wip",
    ]);
  });

  // adversarial review nit: a dot-prefixed own workspace (e.g. a jj/git
  // workspace literally named with a leading dot) must still be pinned —
  // the dotfile filter is meant to hide *other* dotfiles (.git, .jj) from
  // this level, not the session's own workspace regardless of its name.
  // Checking `ownWsPath` before the dotfile filter (rather than filtering
  // dotfiles first, which would drop a dot-named own ws before the pin
  // check ever sees it) is what makes this hold.
  test("pins a dot-prefixed own workspace instead of dropping it as a dotfile", () => {
    const entries = [
      fsEntry({ name: ".hidden-ws", type: "dir" }),
      fsEntry({ name: "main", type: "dir" }),
      fsEntry({ name: ".git", type: "dir" }),
    ];
    expect(workspaceRootEntries(entries, ".hidden-ws").map((e) => e.name)).toEqual([
      ".hidden-ws",
      "main",
    ]);
  });
});

describe("sessionBadges / badgeLabel", () => {
  test("agent-only (disconnected) row gets exactly one 'offline' badge, no busy/idle/done", () => {
    const row = sessionRow({ connected: false, agent: agent({ status: "busy" }) });
    expect(sessionBadges(row)).toEqual(["offline"]);
  });

  test("connected row with no matched agent gets no badges (従来通り)", () => {
    const row = sessionRow({ connected: true, agent: undefined });
    expect(sessionBadges(row)).toEqual([]);
  });

  test("connected + agent busy -> ['busy']", () => {
    const row = sessionRow({ connected: true, agent: agent({ status: "busy" }) });
    expect(sessionBadges(row)).toEqual(["busy"]);
  });

  test("connected + agent with no status -> ['idle'] (upstream omits status when idle)", () => {
    const row = sessionRow({ connected: true, agent: agent({ status: undefined }) });
    expect(sessionBadges(row)).toEqual(["idle"]);
  });

  // state:"done" takes priority over status:"busy" — a background agent
  // that finished shouldn't still read as busy.
  test("agent.state 'done' takes priority over status 'busy'", () => {
    const row = sessionRow({
      connected: true,
      agent: agent({ status: "busy", state: "done", kind: "background" }),
    });
    expect(sessionBadges(row)).toEqual(["done", "bg"]);
  });

  test("kind:'background' adds an additive 'bg' badge alongside busy/idle/done", () => {
    const row = sessionRow({
      connected: true,
      agent: agent({ status: "busy", kind: "background" }),
    });
    expect(sessionBadges(row)).toEqual(["busy", "bg"]);
  });

  test("badgeLabel renders 'offline' as the Japanese ccmsg未起動 string, others as-is", () => {
    expect(badgeLabel("offline")).toBe("ccmsg未起動");
    expect(badgeLabel("busy")).toBe("busy");
    expect(badgeLabel("idle")).toBe("idle");
    expect(badgeLabel("done")).toBe("done");
    expect(badgeLabel("bg")).toBe("bg");
  });
});

// --- U3: Sessions-list status sections --- //

describe("sessionStatus", () => {
  test("disconnected (agent-only) row is always 'offline', regardless of agent status/state", () => {
    expect(sessionStatus(sessionRow({ connected: false, agent: agent({ status: "busy" }) }))).toBe(
      "offline",
    );
    expect(sessionStatus(sessionRow({ connected: false, agent: agent({ state: "done" }) }))).toBe(
      "offline",
    );
  });

  // Connected + no matched agent: no distinct signal from `claude agents` —
  // falls into "idle" (see sessionStatus's doc comment for why "idle" and
  // not a fifth section) rather than the "no badges" of pre-U3 sessionBadges.
  test("connected row with no matched agent -> 'idle'", () => {
    expect(sessionStatus(sessionRow({ connected: true, agent: undefined }))).toBe("idle");
  });

  test("connected + agent busy -> 'busy'", () => {
    expect(sessionStatus(sessionRow({ connected: true, agent: agent({ status: "busy" }) }))).toBe(
      "busy",
    );
  });

  test("connected + agent with no status -> 'idle' (upstream omits status when idle)", () => {
    expect(
      sessionStatus(sessionRow({ connected: true, agent: agent({ status: undefined }) })),
    ).toBe("idle");
  });

  // state:"done" takes priority over status:"busy" — same precedence as
  // sessionBadges (both read this off the same underlying computation).
  test("agent.state 'done' takes priority over status 'busy'", () => {
    expect(
      sessionStatus(
        sessionRow({ connected: true, agent: agent({ status: "busy", state: "done" }) }),
      ),
    ).toBe("done");
  });
});

describe("groupSessionsBySection", () => {
  // Core U3 behavior (kawaz: "リスト側に busy とかのやつでセクション切って"):
  // rows land in the section matching sessionStatus(row).
  test("partitions rows into their sessionStatus section", () => {
    const rows = [
      sessionRow({ sid: "a", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "b", connected: true, agent: agent({ status: undefined }) }),
      sessionRow({ sid: "c", connected: true, agent: agent({ state: "done" }) }),
      sessionRow({ sid: "d", connected: false, agent: agent({}) }),
    ];
    const sections = groupSessionsBySection(rows);
    expect(sections.map((s) => s.key)).toEqual(["busy", "idle", "done", "offline"]);
    expect(sections.map((s) => s.rows.map((r) => r.sid))).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  // "実データに存在するセクションだけ表示" (task spec): a section with zero
  // rows must not appear at all — no empty "Done (0)" heading.
  test("omits a section with no rows", () => {
    const rows = [sessionRow({ sid: "a", connected: true, agent: agent({ status: "busy" }) })];
    const sections = groupSessionsBySection(rows);
    expect(sections.map((s) => s.key)).toEqual(["busy"]);
  });

  test("empty input yields no sections", () => {
    expect(groupSessionsBySection([])).toEqual([]);
  });

  // Section order is fixed (busy, idle, done, offline) regardless of the
  // input array's row order — this is a *section* ordering, independent of
  // the abc/idle/new row-level sort the input already carries.
  test("section order is fixed: busy, idle, done, offline", () => {
    const rows = [
      sessionRow({ sid: "off", connected: false, agent: agent({}) }),
      sessionRow({ sid: "done", connected: true, agent: agent({ state: "done" }) }),
      sessionRow({ sid: "busy", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "idle", connected: true, agent: agent({ status: undefined }) }),
    ];
    expect(groupSessionsBySection(rows).map((s) => s.key)).toEqual([
      "busy",
      "idle",
      "done",
      "offline",
    ]);
  });

  // Row order *within* a section must be preserved from the input — the
  // Sidebar's abc/idle/new sort already ran before rows reach this function
  // (see SessionList.tsx), and grouping must not reshuffle it.
  test("preserves input row order within a section", () => {
    const rows = [
      sessionRow({ sid: "z", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "a", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "m", connected: true, agent: agent({ status: "busy" }) }),
    ];
    const sections = groupSessionsBySection(rows);
    expect(sections[0]?.rows.map((r) => r.sid)).toEqual(["z", "a", "m"]);
  });

  // Section label text, used verbatim by SessionList.tsx's <summary>.
  test("labels: Busy / Idle / Done / ccmsg未起動", () => {
    const rows = [
      sessionRow({ sid: "busy", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "idle", connected: true, agent: agent({ status: undefined }) }),
      sessionRow({ sid: "done", connected: true, agent: agent({ state: "done" }) }),
      sessionRow({ sid: "off", connected: false, agent: agent({}) }),
    ];
    const labels = Object.fromEntries(groupSessionsBySection(rows).map((s) => [s.key, s.label]));
    expect(labels).toEqual({
      busy: "Busy",
      idle: "Idle",
      done: "Done",
      offline: "ccmsg未起動",
    });
  });
});

describe("toSessionRow: transcript_path passthrough (U3)", () => {
  test("carries transcript_path through when the peer announced one", () => {
    const idx = indexAgentsBySid([]);
    const row = toSessionRow(peer({ sid: "s1", transcript_path: "/tmp/t.jsonl" }), idx);
    expect(row.transcript_path).toBe("/tmp/t.jsonl");
  });

  test("leaves transcript_path undefined when the peer didn't announce one", () => {
    const idx = indexAgentsBySid([]);
    const row = toSessionRow(peer({ sid: "s1", transcript_path: undefined }), idx);
    expect(row.transcript_path).toBeUndefined();
  });
});
