// errorMessage is the shared formatter FileTree/FileViewer/Timeline's
// fsList/fsRead/transcriptRead .catch() handlers use to fold a rejected
// ws.ts send() (e.g. Error("ws not open"), see ws.test.ts) into the same
// plain-string shape as ErrorResponse["error"]["msg"].
import { describe, expect, test } from "bun:test";
import type { AgentInfo, MemberEvent, PeerInfo, SessionSearchHit } from "@ccmsg/protocol";
import type { MemberInfo, RoomState } from "../src/client/store.ts";
import type { AppState } from "../src/client/store.ts";
import { ADMIN_ID, initialState } from "../src/client/store.ts";
import {
  badgeLabel,
  buildSessionSearchRequest,
  canonicalViewerPath,
  clampPaneRatio,
  DEFAULT_SESSION_SEARCH_FORM,
  errorMessage,
  expandPathsForSelection,
  fileAncestorDirectories,
  favoritesStorageKey,
  formatBytes,
  formatDuration,
  formatRelativeAge,
  groupSessionsBySection,
  inboxAutoFilename,
  indexAgentsBySid,
  isExternalFilePath,
  isWorkspaceFilePath,
  isMarkdownPath,
  isMemberConnected,
  lastPathSegment,
  matchRoleBadge,
  memberLabel,
  nextPeerSortKey,
  offlineAgentRows,
  paneRatioFromPointer,
  parseFavorites,
  parsePinnedSessions,
  peerSortButtonLabel,
  resolveInboxFilename,
  documentTitleFor,
  resolveSessionTopbar,
  sessionBadges,
  sessionLabel,
  sessionRowTitle,
  sessionSearchFormToTimelineSearch,
  sessionSearchHitLabel,
  sessionStatus,
  SESSION_PANE_MAX_RATIO,
  SESSION_PANE_MIN_RATIO,
  shortSid,
  groupExternalFiles,
  sortExternalFiles,
  sortFavorites,
  sortPeers,
  treeRootPath,
  sortPinnedSessions,
  splitRoomsByArchived,
  splitRoomsByKind,
  splitRoomsByLiveness,
  liveAgentCount,
  toggleFavorite,
  toSessionRow,
  type PeerSortKey,
  type SessionRow,
  type SessionSearchForm,
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
    history: "loaded",
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
    history: "loaded",
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

// mid=61: 1on1 rooms fold into a collapsed "1on1 (N)" group, same pattern as
// splitRoomsByArchived's アーカイブ group — this split runs on whatever
// splitRoomsByArchived left in `active`.
describe("splitRoomsByKind", () => {
  test("buckets kind:1on1 rooms separately, preserving each bucket's relative input order", () => {
    const rooms = [
      makeRoom({ id: "r1", kind: "normal" }),
      makeRoom({ id: "r2", kind: "1on1" }),
      makeRoom({ id: "r3", kind: "broadcast" }),
      makeRoom({ id: "r4", kind: "1on1" }),
    ];
    const { flat, oneOnOne } = splitRoomsByKind(rooms);
    expect(flat.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(oneOnOne.map((r) => r.id)).toEqual(["r2", "r4"]);
  });

  test("a room with no 1on1 rooms present leaves oneOnOne empty", () => {
    const { flat, oneOnOne } = splitRoomsByKind([makeRoom({ id: "r1", kind: "normal" })]);
    expect(flat.map((r) => r.id)).toEqual(["r1"]);
    expect(oneOnOne).toEqual([]);
  });

  test("empty input yields two empty buckets", () => {
    expect(splitRoomsByKind([])).toEqual({ flat: [], oneOnOne: [] });
  });
});

// kawaz r76m51: 通常 room は「生存中の参加エージェントが 2 名以上」で Active、
// それ未満で Inactive。生存判定は peers 由来なので、member 行の sid が peers
// に居るかだけで決まる。
function roomWithMembers(
  id: string,
  members: Array<{ id: string; sid: string; left?: boolean }>,
): RoomState {
  const membersById = new Map<string, MemberInfo>();
  for (const m of members) {
    membersById.set(m.id, {
      type: "member",
      id: m.id,
      sid: m.sid,
      repo: "claude-ccmsg",
      ws: "main",
      cwd: "/repo",
      joined_at: "2026-07-28T00:00:00.000Z",
      left: m.left ?? false,
    });
  }
  return makeRoom({ id, membersById, memberOrder: members.map((m) => m.id) });
}

describe("liveAgentCount", () => {
  const peers: PeerInfo[] = [peer({ sid: "s1" }), peer({ sid: "s2" })];

  test("counts active members whose session is in peers", () => {
    const room = roomWithMembers("r1", [
      { id: "a1", sid: "s1" },
      { id: "a2", sid: "s2" },
    ]);
    expect(liveAgentCount(room, peers)).toBe(2);
  });

  test("excludes members whose session has disconnected", () => {
    const room = roomWithMembers("r1", [
      { id: "a1", sid: "s1" },
      { id: "a2", sid: "gone" },
    ]);
    expect(liveAgentCount(room, peers)).toBe(1);
  });

  test("excludes members that left the room even while their session lives", () => {
    const room = roomWithMembers("r1", [
      { id: "a1", sid: "s1" },
      { id: "a2", sid: "s2", left: true },
    ]);
    expect(liveAgentCount(room, peers)).toBe(1);
  });

  // The User (u1) is an implicit member of every room and has no peers row;
  // counting it would make a room with a single agent look like a live pair.
  test("never counts the User (u1)", () => {
    const room = roomWithMembers("r1", [
      { id: ADMIN_ID, sid: "s1" },
      { id: "a1", sid: "s2" },
    ]);
    expect(liveAgentCount(room, peers)).toBe(1);
  });
});

describe("splitRoomsByLiveness", () => {
  const peers: PeerInfo[] = [peer({ sid: "s1" }), peer({ sid: "s2" })];

  test("two or more live agents is Active, fewer is Inactive", () => {
    const rooms = [
      roomWithMembers("two-live", [
        { id: "a1", sid: "s1" },
        { id: "a2", sid: "s2" },
      ]),
      roomWithMembers("one-live", [
        { id: "a1", sid: "s1" },
        { id: "a2", sid: "gone" },
      ]),
      roomWithMembers("none-live", [{ id: "a1", sid: "gone" }]),
    ];
    const { active, inactive } = splitRoomsByLiveness(rooms, peers);
    expect(active.map((r) => r.id)).toEqual(["two-live"]);
    expect(inactive.map((r) => r.id)).toEqual(["one-live", "none-live"]);
  });

  test("preserves each bucket's relative input order", () => {
    const live = (id: string) =>
      roomWithMembers(id, [
        { id: "a1", sid: "s1" },
        { id: "a2", sid: "s2" },
      ]);
    const rooms = [live("r1"), roomWithMembers("r2", []), live("r3"), roomWithMembers("r4", [])];
    const { active, inactive } = splitRoomsByLiveness(rooms, peers);
    expect(active.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(inactive.map((r) => r.id)).toEqual(["r2", "r4"]);
  });

  // Every room is Inactive with nobody connected — the ws roster being empty
  // (daemon restart,初回ロード前) must not throw or promote anything.
  test("an empty peers roster puts every room in Inactive", () => {
    const rooms = [
      roomWithMembers("r1", [
        { id: "a1", sid: "s1" },
        { id: "a2", sid: "s2" },
      ]),
    ];
    expect(splitRoomsByLiveness(rooms, []).inactive.map((r) => r.id)).toEqual(["r1"]);
  });

  test("empty input yields two empty buckets", () => {
    expect(splitRoomsByLiveness([], peers)).toEqual({ active: [], inactive: [] });
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

describe("treeRootPath", () => {
  // kawaz r55 m97: the tree browses from the session's own cwd, expressed in
  // the containment-root-relative space fs_list/fs_read/fs_find path keys use.
  // Under a jj worktree layout that is the workspace directory name, so the
  // tree opens on the session's own files instead of a `main/` node wrapping
  // them. The daemon's containment root stays the wider repo container.
  test("returns cwd relative to repo_root", () => {
    expect(
      treeRootPath({ repo_root: "/repos/claude-ccmsg", cwd: "/repos/claude-ccmsg/main" }),
    ).toBe("main");
  });

  test("keeps every segment when cwd sits deeper than one level below repo_root", () => {
    expect(
      treeRootPath({
        repo_root: "/repos/claude-ccmsg",
        cwd: "/repos/claude-ccmsg/main/packages/webui",
      }),
    ).toBe("main/packages/webui");
  });

  // No accepted repo_root means the daemon's containment root already *is*
  // cwd, so the relative root is the empty string (fs_list's own default).
  test("returns '' when the peer has no repo_root", () => {
    expect(treeRootPath({ repo_root: undefined, cwd: "/repos/claude-ccmsg/main" })).toBe("");
  });

  test("returns '' when cwd is unexpectedly outside repo_root (defensive)", () => {
    expect(treeRootPath({ repo_root: "/other/root", cwd: "/repos/claude-ccmsg/main" })).toBe("");
  });

  test("tolerates a trailing slash on either end", () => {
    expect(
      treeRootPath({ repo_root: "/repos/claude-ccmsg/", cwd: "/repos/claude-ccmsg/main/" }),
    ).toBe("main");
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

describe("formatRelativeAge", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");

  test("uses minute precision below one hour", () => {
    expect(formatRelativeAge("2026-07-20T11:59:30.000Z", now)).toBe("<1m");
    expect(formatRelativeAge("2026-07-20T11:55:00.000Z", now)).toBe("5m");
  });

  test("keeps two units for hours and days", () => {
    expect(formatRelativeAge("2026-07-20T08:30:00.000Z", now)).toBe("3h30m");
    expect(formatRelativeAge("2026-07-19T10:00:00.000Z", now)).toBe("1d2h");
  });

  test("handles missing, invalid, and future timestamps", () => {
    expect(formatRelativeAge(null, now)).toBe("");
    expect(formatRelativeAge("invalid", now)).toBe("");
    expect(formatRelativeAge("2026-07-20T12:05:00.000Z", now)).toBe("<1m");
  });
});

describe("nextPeerSortKey", () => {
  // Cycle order matches the button-label progression kawaz asked for
  // (2026-07-16: name/created/recent), not the PeerSortKey union's own
  // declaration order. "prompt" (2026-08-31) leads because it is the default.
  test("cycles prompt -> name -> connected -> idle -> prompt", () => {
    const seq: PeerSortKey[] = [];
    let k: PeerSortKey = "prompt";
    for (let i = 0; i < 5; i++) {
      seq.push(k);
      k = nextPeerSortKey(k);
    }
    expect(seq).toEqual(["prompt", "name", "connected", "idle", "prompt"]);
  });
});

describe("peerSortButtonLabel", () => {
  // kawaz 2026-07-16: "わかりづらい。name/created/recent にして" — replaces
  // the prior abc/idle/new labels, which described the internal key rather
  // than what the list is actually ordered by.
  test("maps each PeerSortKey to its name/created/recent label", () => {
    expect(peerSortButtonLabel("name")).toBe("name");
    expect(peerSortButtonLabel("connected")).toBe("created");
    expect(peerSortButtonLabel("idle")).toBe("recent");
    expect(peerSortButtonLabel("prompt")).toBe("prompt");
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

  // kawaz 2026-08-31: the sidebar's default ordering. Reads
  // last_user_input_at, not last_activity_at — see PeerSortKey's doc comment
  // for why the two are separate keys.
  test("prompt key: most recent user input (last_user_input_at) first", () => {
    const peers = [
      peer({ sid: "old", last_user_input_at: "2026-08-31T00:00:00.000Z" }),
      peer({ sid: "new", last_user_input_at: "2026-08-31T00:05:00.000Z" }),
      peer({ sid: "mid", last_user_input_at: "2026-08-31T00:02:00.000Z" }),
    ];
    expect(sortPeers(peers, "prompt").map((p) => p.sid)).toEqual(["new", "mid", "old"]);
  });

  // A busy agent re-stamps last_activity_at constantly; the point of the key
  // is that this must not move it up past a session the user just spoke to.
  test("prompt key: ignores last_activity_at entirely", () => {
    const peers = [
      peer({
        sid: "busy-agent",
        last_activity_at: "2026-08-31T09:00:00.000Z",
        last_user_input_at: "2026-08-31T01:00:00.000Z",
      }),
      peer({
        sid: "just-prompted",
        last_activity_at: "2026-08-31T02:00:00.000Z",
        last_user_input_at: "2026-08-31T08:00:00.000Z",
      }),
    ];
    expect(sortPeers(peers, "prompt").map((p) => p.sid)).toEqual(["just-prompted", "busy-agent"]);
  });

  // Absent means "the daemon folded no user input" (old transcript, no
  // readable transcript, nothing typed yet) — not epoch, so these go last
  // instead of displacing sessions with a real timestamp.
  test("prompt key: peers missing last_user_input_at sort after every peer that has one", () => {
    const peers = [
      peer({ sid: "no-input", last_user_input_at: undefined }),
      peer({ sid: "has-input", last_user_input_at: "2026-08-31T00:00:00.000Z" }),
    ];
    expect(sortPeers(peers, "prompt").map((p) => p.sid)).toEqual(["has-input", "no-input"]);
  });

  test("prompt key: peers with no timestamp at all fall back to name order", () => {
    const peers = [
      peer({ sid: "b", repo: "b-repo", last_user_input_at: undefined }),
      peer({ sid: "a", repo: "a-repo", last_user_input_at: undefined }),
    ];
    expect(sortPeers(peers, "prompt").map((p) => p.sid)).toEqual(["a", "b"]);
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
    const row = toSessionRow(peer({ sid: "s1" }), idx, new Map());
    expect(row.connected).toBe(true);
    expect(row.agent?.status).toBe("busy");
  });

  test("toSessionRow leaves agent undefined when claude agents hasn't reported this sid", () => {
    const idx = indexAgentsBySid([agent({ sessionId: "other" })]);
    const row = toSessionRow(peer({ sid: "s1" }), idx, new Map());
    expect(row.connected).toBe(true);
    expect(row.agent).toBeUndefined();
  });

  // The error map is the row's only source of api_error — this is the seam
  // that makes `sessionStatus(row)` able to report "error" from the row alone
  // (see SessionRow.api_error's doc comment).
  test("toSessionRow attaches the matching session error", () => {
    const err = { text: "API Error: 500", timestamp: "2026-07-27T00:00:00Z" };
    const row = toSessionRow(peer({ sid: "s1" }), indexAgentsBySid([]), new Map([["s1", err]]));
    expect(row.api_error).toEqual(err);
  });

  test("toSessionRow leaves api_error undefined for a session with no reported error", () => {
    const err = { text: "API Error: 500", timestamp: "2026-07-27T00:00:00Z" };
    const row = toSessionRow(peer({ sid: "s1" }), indexAgentsBySid([]), new Map([["other", err]]));
    expect(row.api_error).toBeUndefined();
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

describe("resolveSessionTopbar", () => {
  // Live peer path: the session announced repo/ws via hello and it comes
  // straight through — the sidebar's SessionList row for the same sid uses
  // the same PeerInfo, so the topbar can't disagree with it.
  test("uses the live peer's repo/ws/cwd when a peer exists for the sid", () => {
    const state: AppState = {
      ...initialState(),
      peers: [peer({ sid: "s1", repo: "kawaz/claude-ccmsg", ws: "main", cwd: "/repos/main" })],
    };
    expect(resolveSessionTopbar(state, "s1")).toEqual({
      repo: "kawaz/claude-ccmsg",
      ws: "main",
      cwd: "/repos/main",
    });
  });

  // DR-0021 pinned/virtual: a session with no live peer still keeps its
  // SessionSearchHit in state.pinnedSessions — before this helper the topbar
  // fell straight through to `sid.slice(0,8)` and lost the worktree name for
  // pinned rows entirely (kawaz r38 mid=9).
  test("falls back to a pinned session's SessionSearchHit when no peer is connected", () => {
    const state: AppState = {
      ...initialState(),
      pinnedSessions: new Map<string, SessionSearchHit>([
        [
          "s1",
          {
            sid: "s1",
            config_dir: "/home/kawaz/.claude",
            file: "/transcripts/s1.jsonl",
            cwd: "/repos/pinned/main",
            repo: "kawaz/pinned",
            ws: "main",
            created_at: "2026-07-19T00:00:00Z",
            updated_at: "2026-07-19T00:00:00Z",
            size: 0,
            matches: [],
            title: null,
          },
        ],
      ]),
    };
    expect(resolveSessionTopbar(state, "s1")).toEqual({
      repo: "kawaz/pinned",
      ws: "main",
      cwd: "/repos/pinned/main",
    });
  });

  // Agent-only row (`claude agents --json` matched, no ccmsg hello): no VCS
  // metadata to surface, so agent.name stands in for ws in the topbar (the
  // sidebar row shows that same name as its title instead).
  test("falls back to agent.name as ws when only an agent row matches the sid", () => {
    const state: AppState = {
      ...initialState(),
      agents: [agent({ sessionId: "s1", name: "my-agent", cwd: "/repos/x/y" })],
    };
    expect(resolveSessionTopbar(state, "s1")).toEqual({
      repo: "",
      ws: "my-agent",
      cwd: "/repos/x/y",
    });
  });

  // Truly unknown sid: nothing in peers / pinnedSessions / agents. The caller
  // (TopbarTitle) will lastPathSegment(null) → "" and drop to sid.slice(0,8),
  // which is the existing behavior. This test locks in that resolve returns
  // cwd:null instead of throwing or fabricating a path.
  test("returns empty repo/ws and cwd:null when the sid is unknown", () => {
    expect(resolveSessionTopbar(initialState(), "unknown")).toEqual({
      repo: "",
      ws: "",
      cwd: null,
    });
  });
});

describe("documentTitleFor", () => {
  // Nothing selected: keeps the plain app name (matches index.html's
  // <title> and TopbarTitle's own "何も選択していない" fallback).
  test("falls back to the bare app name when nothing is selected", () => {
    expect(documentTitleFor(initialState())).toBe("ccmsg");
  });

  // Identifying label leads, app name trails (kawaz r99 mid=39) — a browser
  // tab only shows the leading characters, so the session identity has to
  // come first to tell tabs apart at a glance.
  test("puts '<repo> ▸ <ws>' before the app name for a selected session", () => {
    const state: AppState = {
      ...initialState(),
      view: "session",
      currentSid: "s1",
      peers: [peer({ sid: "s1", repo: "kawaz/claude-ccmsg", ws: "main" })],
    };
    expect(documentTitleFor(state)).toBe("kawaz/claude-ccmsg ▸ main - ccmsg");
  });

  // Same label derivation as resolveSessionTopbar/TopbarTitle's fallback
  // chain, so the tab title never disagrees with the topbar itself.
  test("falls back to sid short form when a selected session has no repo/ws/cwd", () => {
    const state: AppState = {
      ...initialState(),
      view: "session",
      currentSid: "0123456789abcdef",
    };
    expect(documentTitleFor(state)).toBe("01234567 - ccmsg");
  });

  test("uses the room's title for a selected room", () => {
    const state: AppState = {
      ...initialState(),
      view: "room",
      currentRoomId: "r1",
      rooms: new Map([["r1", makeRoom({ id: "r1", title: "planning" })]]),
    };
    expect(documentTitleFor(state)).toBe("planning - ccmsg");
  });

  // Non-session views (usage, or a 404 detour) have no single identifying
  // label to promote, so the tab reverts to the plain app name.
  test("falls back to the bare app name on the usage view", () => {
    const state: AppState = { ...initialState(), view: "usage" };
    expect(documentTitleFor(state)).toBe("ccmsg");
  });

  test("falls back to the bare app name when unknownPath is set even with a currentSid", () => {
    const state: AppState = {
      ...initialState(),
      view: "session",
      currentSid: "s1",
      peers: [peer({ sid: "s1", repo: "kawaz/claude-ccmsg", ws: "main" })],
      unknownPath: "/bogus",
    };
    expect(documentTitleFor(state)).toBe("ccmsg");
  });
});

describe("sessionRowTitle", () => {
  // The session's own name (what /rename sets, reported as claude agents'
  // `name`) is the headline — it is the only identifier a human chose.
  test("uses the agent's name when there is one", () => {
    const row = sessionRow({
      repo: "claude-ccmsg",
      ws: "main",
      agent: agent({ name: "claude-ccmsg@main 20260812T0215" }),
    });
    expect(sessionRowTitle(row)).toBe("claude-ccmsg@main 20260812T0215");
  });

  // Deliberately NOT repo/ws: the row's second line already prints those, and
  // a headline repeating the line below it reads as a rendering bug.
  test("falls back to the cwd's last segment rather than repeating repo/ws", () => {
    const row = sessionRow({ repo: "claude-ccmsg", ws: "main", cwd: "/repos/claude-ccmsg/main" });
    expect(sessionRowTitle(row)).toBe("main");
  });

  test("falls back to a short sid when there is no name and no cwd", () => {
    const row = sessionRow({ sid: "s1234567890abcdef", repo: "", ws: "", cwd: "" });
    expect(sessionRowTitle(row)).toBe(shortSid("s1234567890abcdef"));
  });
});

describe("offlineAgentRows repo/ws honesty", () => {
  // `claude agents --json` has no VCS metadata, so an agent-only row carries
  // none either. It used to borrow the agent's name for `ws`, which the
  // Sessions row now shows as its title — leaving both would print the same
  // string on two consecutive lines.
  test("agent-only rows carry empty repo/ws rather than the agent's name", () => {
    const rows = offlineAgentRows(
      [],
      [agent({ sessionId: "s2", name: "my-agent", cwd: "/repos/x/y" })],
    );
    expect(rows[0]?.repo).toBe("");
    expect(rows[0]?.ws).toBe("");
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

/** A harness API-error row as the daemon reports it (text is deliberately the
 * long one-line JSON shape real "API Error: 500 ..." rows have). */
const apiError = {
  text: 'API Error: 500 {"type":"error","error":{"message":"overloaded"}}',
  timestamp: "2026-07-27T09:00:00Z",
};

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

  // Regression (kawaz 2026-07-16: "busy と ccmsg 未起動しかない。カテゴリ作っ
  // て"): `claude agents --json` reports status:"inactive" on some rows, and
  // the pre-fix sessionStatus silently collapsed every non-"busy" status into
  // "idle" — this connected+inactive row must come back as "inactive", not
  // "idle".
  test("connected + agent status 'inactive' -> 'inactive' (not silently folded into idle)", () => {
    expect(
      sessionStatus(sessionRow({ connected: true, agent: agent({ status: "inactive" }) })),
    ).toBe("inactive");
  });

  // SessionStatus is an open set (mirrors AgentInfo.status's own doc comment
  // in protocol/src/index.ts): an upstream status this code has never seen
  // before must still pass through verbatim, not get coerced to a known
  // value.
  test("unrecognized status passes through unchanged", () => {
    expect(sessionStatus(sessionRow({ connected: true, agent: agent({ status: "paused" }) }))).toBe(
      "paused",
    );
  });

  // A session stopped on a harness API error is waiting for the user, not
  // working — it must not be reported as anything else.
  test("connected row with api_error -> 'error'", () => {
    expect(sessionStatus(sessionRow({ connected: true, api_error: apiError }))).toBe("error");
  });

  // The whole point of the "error" status: `claude agents` still reports such
  // a session as busy (its process is alive), which is exactly the misleading
  // signal this overrides.
  test("api_error takes priority over agent status 'busy'", () => {
    expect(
      sessionStatus(
        sessionRow({ connected: true, agent: agent({ status: "busy" }), api_error: apiError }),
      ),
    ).toBe("error");
  });

  test("api_error takes priority over agent.state 'done'", () => {
    expect(
      sessionStatus(
        sessionRow({ connected: true, agent: agent({ state: "done" }), api_error: apiError }),
      ),
    ).toBe("error");
  });

  // "disconnected ⇒ offline" stays the outermost invariant (see
  // sessionStatus's doc comment): an offline row belongs in the offline
  // section even if a stale error is still attached to it.
  test("disconnected row with api_error is still 'offline' (offline check comes first)", () => {
    expect(sessionStatus(sessionRow({ connected: false, api_error: apiError }))).toBe("offline");
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

  // Section order for the known statuses is fixed (busy, idle, inactive,
  // done), offline always last, regardless of the input array's row order —
  // this is a *section* ordering, independent of the name/created/recent
  // row-level sort the input already carries.
  test("section order is fixed: busy, idle, inactive, done, offline", () => {
    const rows = [
      sessionRow({ sid: "off", connected: false, agent: agent({}) }),
      sessionRow({ sid: "done", connected: true, agent: agent({ state: "done" }) }),
      sessionRow({ sid: "inactive", connected: true, agent: agent({ status: "inactive" }) }),
      sessionRow({ sid: "busy", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "idle", connected: true, agent: agent({ status: undefined }) }),
    ];
    expect(groupSessionsBySection(rows).map((s) => s.key)).toEqual([
      "busy",
      "idle",
      "inactive",
      "done",
      "offline",
    ]);
  });

  // "error" leads every other section: an API-error-stopped session is the
  // only one where nothing at all will happen until the user acts, so it must
  // outrank even "waiting" (where Claude is actively asking).
  test("'error' section comes first, ahead of waiting/busy", () => {
    const rows = [
      sessionRow({ sid: "busy", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "waiting", connected: true, agent: agent({ status: "waiting" }) }),
      sessionRow({ sid: "err", connected: true, api_error: apiError }),
    ];
    expect(groupSessionsBySection(rows).map((s) => s.key)).toEqual(["error", "waiting", "busy"]);
  });

  test("'error' section label is 'Error'", () => {
    const rows = [sessionRow({ sid: "err", connected: true, api_error: apiError })];
    expect(groupSessionsBySection(rows)[0]?.label).toBe("Error");
  });

  // Regression (kawaz 2026-07-16): an unrecognized status must still get its
  // own section — never dropped — placed after every known status and before
  // "offline" (which is always last regardless of what unknown statuses
  // exist).
  test("unrecognized status gets its own section, after known statuses and before offline", () => {
    const rows = [
      sessionRow({ sid: "off", connected: false, agent: agent({}) }),
      sessionRow({ sid: "paused", connected: true, agent: agent({ status: "paused" }) }),
      sessionRow({ sid: "done", connected: true, agent: agent({ state: "done" }) }),
    ];
    expect(groupSessionsBySection(rows).map((s) => s.key)).toEqual(["done", "paused", "offline"]);
  });

  // Multiple unrecognized statuses sort alphabetically among themselves —
  // there's no "worth noticing more" signal available for statuses this code
  // has never seen before, so alphabetical is the only deterministic order.
  test("multiple unrecognized statuses sort alphabetically", () => {
    const rows = [
      sessionRow({ sid: "z", connected: true, agent: agent({ status: "zzz-status" }) }),
      sessionRow({ sid: "a", connected: true, agent: agent({ status: "aaa-status" }) }),
    ];
    expect(groupSessionsBySection(rows).map((s) => s.key)).toEqual(["aaa-status", "zzz-status"]);
  });

  // Row order *within* a section must be preserved from the input — the
  // Sidebar's name/created/recent sort already ran before rows reach this
  // function (see SessionList.tsx), and grouping must not reshuffle it.
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
  test("labels: Busy / Idle / Inactive / Done / ccmsg未起動", () => {
    const rows = [
      sessionRow({ sid: "busy", connected: true, agent: agent({ status: "busy" }) }),
      sessionRow({ sid: "idle", connected: true, agent: agent({ status: undefined }) }),
      sessionRow({ sid: "inactive", connected: true, agent: agent({ status: "inactive" }) }),
      sessionRow({ sid: "done", connected: true, agent: agent({ state: "done" }) }),
      sessionRow({ sid: "off", connected: false, agent: agent({}) }),
    ];
    const labels = Object.fromEntries(groupSessionsBySection(rows).map((s) => [s.key, s.label]));
    expect(labels).toEqual({
      busy: "Busy",
      idle: "Idle",
      inactive: "Inactive",
      done: "Done",
      offline: "ccmsg未起動",
    });
  });

  // Unknown status labels are capitalized rather than left lowercase or
  // rendered as a generic fallback (e.g. "Unknown") — see
  // groupSessionsBySection's / capitalizeStatus's doc comment.
  test("unrecognized status label is capitalized", () => {
    const rows = [sessionRow({ sid: "p", connected: true, agent: agent({ status: "paused" }) })];
    const sections = groupSessionsBySection(rows);
    expect(sections[0]?.label).toBe("Paused");
  });
});

describe("toSessionRow: transcript_path passthrough (U3)", () => {
  test("carries transcript_path through when the peer announced one", () => {
    const idx = indexAgentsBySid([]);
    const row = toSessionRow(peer({ sid: "s1", transcript_path: "/tmp/t.jsonl" }), idx, new Map());
    expect(row.transcript_path).toBe("/tmp/t.jsonl");
  });

  test("leaves transcript_path undefined when the peer didn't announce one", () => {
    const idx = indexAgentsBySid([]);
    const row = toSessionRow(peer({ sid: "s1", transcript_path: undefined }), idx, new Map());
    expect(row.transcript_path).toBeUndefined();
  });
});

describe("favoritesStorageKey", () => {
  // Guarantees favorites never leak across two different project roots
  // (or two unrelated cwds when neither has a repo_root) sharing the same
  // browser's localStorage — each root gets its own namespaced key.
  test("keys are namespaced per root, distinct roots never collide", () => {
    const a = favoritesStorageKey("/Users/kawaz/repos/proj-a");
    const b = favoritesStorageKey("/Users/kawaz/repos/proj-b");
    expect(a).not.toBe(b);
    expect(a).toContain("proj-a");
    expect(b).toContain("proj-b");
  });

  test("the same root always resolves to the same key", () => {
    const root = "/Users/kawaz/repos/proj-a";
    expect(favoritesStorageKey(root)).toBe(favoritesStorageKey(root));
  });
});

describe("parseFavorites", () => {
  // Absent key (never favorited anything yet) is the common case, not an
  // error — resolves to an empty list, not a thrown exception.
  test("null (key absent) resolves to an empty list", () => {
    expect(parseFavorites(null)).toEqual([]);
  });

  test("valid JSON array of strings round-trips as-is", () => {
    expect(parseFavorites('["docs/inbox","docs/QUESTIONS.md"]')).toEqual([
      "docs/inbox",
      "docs/QUESTIONS.md",
    ]);
  });

  test("absolute external favorites coexist with relative project paths", () => {
    // DR-0024 keeps one flat string list: `/` prefix is a disjoint namespace,
    // so persistence needs no schema split or path rewriting.
    expect(parseFavorites('["docs/inbox","/Users/example/shared.md"]')).toEqual([
      "docs/inbox",
      "/Users/example/shared.md",
    ]);
  });

  // Garbage matrix: non-JSON text, JSON that parses but isn't an array, and
  // an array whose elements aren't all strings — none of these may throw or
  // propagate a malformed value into the rendered tree.
  test("non-JSON garbage falls back to an empty list", () => {
    expect(parseFavorites("not json{{{")).toEqual([]);
  });

  test("valid JSON that isn't an array falls back to an empty list", () => {
    expect(parseFavorites('{"docs/inbox":true}')).toEqual([]);
    expect(parseFavorites("42")).toEqual([]);
    expect(parseFavorites('"docs/inbox"')).toEqual([]);
  });

  test("non-string array elements are dropped individually, not fatal to the whole array", () => {
    expect(parseFavorites('["docs/inbox",42,null,"docs/QUESTIONS.md"]')).toEqual([
      "docs/inbox",
      "docs/QUESTIONS.md",
    ]);
  });
});

describe("toggleFavorite", () => {
  // Not-yet-favorited path gets appended.
  test("adds an unregistered path", () => {
    expect(toggleFavorite(["docs/inbox"], "docs/QUESTIONS.md")).toEqual([
      "docs/inbox",
      "docs/QUESTIONS.md",
    ]);
  });

  // Already-favorited path gets removed (toggle off).
  test("removes an already-registered path", () => {
    expect(toggleFavorite(["docs/inbox", "docs/QUESTIONS.md"], "docs/inbox")).toEqual([
      "docs/QUESTIONS.md",
    ]);
  });

  test("never mutates the input array", () => {
    const favorites = ["docs/inbox"];
    toggleFavorite(favorites, "docs/QUESTIONS.md");
    expect(favorites).toEqual(["docs/inbox"]);
  });

  test("external absolute and project-relative keys toggle independently", () => {
    // Same basename cannot collide because the external key retains its leading `/`.
    const external = "/external/docs/QUESTIONS.md";
    expect(toggleFavorite(["docs/QUESTIONS.md"], external)).toEqual([
      "docs/QUESTIONS.md",
      external,
    ]);
    expect(toggleFavorite(["docs/QUESTIONS.md", external], external)).toEqual([
      "docs/QUESTIONS.md",
    ]);
  });
});

describe("sortFavorites", () => {
  // Display order is alphabetical over the full relative path, not
  // registration order — a favorite added last can still sort first.
  // Lowercase-only fixtures to keep the assertion independent of any
  // locale's case-collation rules (localeCompare's case ordering isn't
  // guaranteed ASCII-simple across environments).
  test("orders alphabetically regardless of registration order", () => {
    expect(sortFavorites(["docs/questions.md", "docs/inbox", "app.ts"])).toEqual([
      "app.ts",
      "docs/inbox",
      "docs/questions.md",
    ]);
  });

  test("never mutates the input array", () => {
    const favorites = ["b", "a"];
    sortFavorites(favorites);
    expect(favorites).toEqual(["b", "a"]);
  });
});

describe("external file view helpers (DR-0024)", () => {
  test("only slash-prefixed absolute paths use the external read rail", () => {
    // Project-tree relpaths remain on fs_read; external_files use fs_read_external.
    expect(isExternalFilePath("src/index.ts")).toBe(false);
    expect(isExternalFilePath("/external/shared.md")).toBe(true);
  });

  test("empty external list stays empty; entries are filtered, deduplicated, and sorted", () => {
    // FileTree hides the section for [], while locally-constructed snapshots are
    // normalized deterministically even if they contain duplicates/relpaths.
    expect(sortExternalFiles([])).toEqual([]);
    expect(
      sortExternalFiles([
        { path: "/z.md", origin: "tool" },
        { path: "project.md", origin: "tool" },
        { path: "/a.md", origin: "attachment" },
        { path: "/z.md", origin: "tool" },
      ]),
    ).toEqual(["/a.md", "/z.md"]);
  });

  // kawaz r99 m35: プロジェクト外セクションは由来別に 2 グループへ分かれる。
  test("由来別グループ: tool / attachment に分かれ、各グループ内はパス順", () => {
    expect(
      groupExternalFiles([
        { path: "/z-attach.md", origin: "attachment" },
        { path: "/b-tool.md", origin: "tool" },
        { path: "/a-attach.md", origin: "attachment" },
        { path: "/a-tool.md", origin: "tool" },
      ]),
    ).toEqual({
      tool: ["/a-tool.md", "/b-tool.md"],
      attachment: ["/a-attach.md", "/z-attach.md"],
    });
  });

  test("由来別グループ: 両方が名指したパスは tool 側にだけ出る (順序不問)", () => {
    // 1 つのファイルが 2 つの見出しに出ると、★ を付けた時にどちらの行の状態
    // なのかが読めなくなる。
    const both = { tool: ["/both.md"], attachment: [] };
    expect(
      groupExternalFiles([
        { path: "/both.md", origin: "attachment" },
        { path: "/both.md", origin: "tool" },
      ]),
    ).toEqual(both);
    expect(
      groupExternalFiles([
        { path: "/both.md", origin: "tool" },
        { path: "/both.md", origin: "attachment" },
      ]),
    ).toEqual(both);
  });

  test("由来別グループ: 相対パスは弾かれ、空リストは両グループ空", () => {
    expect(groupExternalFiles([])).toEqual({ tool: [], attachment: [] });
    expect(groupExternalFiles([{ path: "project.md", origin: "tool" }])).toEqual({
      tool: [],
      attachment: [],
    });
  });
});

describe("workspace file view helpers (DR-0026)", () => {
  // A `.code-workspace` folder root gates fs_list_workspace / fs_read_workspace.
  // The client-side helper mirrors the daemon's insideAny check: exact equality
  // or startsWith(folder + "/"), so `/a` never matches `/ab...`.
  test("relative paths are never workspace paths", () => {
    // Relative project-tree paths route through fs_read as before — the DR
    // client convention keeps absolute paths as the sole workspace/external
    // rail.
    expect(isWorkspaceFilePath("src/index.ts", [{ path: "/repo/src" }])).toBe(false);
  });

  test("absolute path equal to a folder root matches", () => {
    // Clicking the folder-root DirNode itself must succeed (fs_list_workspace
    // needs to serve the root listing).
    expect(isWorkspaceFilePath("/repo/sibling", [{ path: "/repo/sibling" }])).toBe(true);
  });

  test("descendant of a folder root matches", () => {
    expect(isWorkspaceFilePath("/repo/sibling/sub/file.txt", [{ path: "/repo/sibling" }])).toBe(
      true,
    );
  });

  test("prefix collision (folder /a vs path /ab...) is rejected", () => {
    // Without the trailing-slash suffix check, `/abc` would spuriously match
    // `/a` — that would let the client route a truly external absolute path
    // through fs_list_workspace and hit the daemon's stricter allowlist.
    expect(isWorkspaceFilePath("/abc", [{ path: "/a" }])).toBe(false);
    expect(isWorkspaceFilePath("/abc/file.txt", [{ path: "/a" }])).toBe(false);
  });

  test("empty workspace_folders lets no path through", () => {
    expect(isWorkspaceFilePath("/anywhere", [])).toBe(false);
  });

  test("multi-folder allowlist: match any", () => {
    // A workspace with multiple folder entries: a path matching either root
    // should pass, non-matching should fail — order-independent.
    const folders = [{ path: "/repo/one" }, { path: "/repo/two" }];
    expect(isWorkspaceFilePath("/repo/one/x", folders)).toBe(true);
    expect(isWorkspaceFilePath("/repo/two/y", folders)).toBe(true);
    expect(isWorkspaceFilePath("/repo/three", folders)).toBe(false);
  });
});

describe("canonicalViewerPath", () => {
  // kawaz r99 m8: opening a project file by its full path answered 403 — the
  // absolute spelling routed to fs_read_external, whose DR-0024 allowlist only
  // holds files the session actually read. Rebasing it to the root-relative
  // form is what makes "open by full path" reach fs_read from any context.
  const ROOT = "/repo/container";

  test("in-project absolute path is rebased to the containment-relative form", () => {
    expect(canonicalViewerPath(`${ROOT}/main/docs/dr.md`, ROOT, [])).toBe("main/docs/dr.md");
  });

  test("relative paths pass through untouched", () => {
    expect(canonicalViewerPath("main/docs/dr.md", ROOT, [])).toBe("main/docs/dr.md");
  });

  test("absolute path outside the containment root stays external", () => {
    // Still authorized by the exact-file allowlist — rebasing must not widen
    // what the viewer can reach, only pick the op for paths already browsable.
    expect(canonicalViewerPath("/etc/hosts", ROOT, [])).toBe("/etc/hosts");
  });

  test("prefix collision does not count as in-project", () => {
    expect(canonicalViewerPath("/repo/container-other/x.md", ROOT, [])).toBe(
      "/repo/container-other/x.md",
    );
  });

  test("workspace path keeps its absolute form even inside the containment root", () => {
    // DR-0026 folders are addressed absolutely by the tree's ワークスペース
    // section; rebasing one would desync the selection from that listing.
    const folders = [{ path: `${ROOT}/sibling` }];
    expect(canonicalViewerPath(`${ROOT}/sibling/x.md`, ROOT, folders)).toBe(`${ROOT}/sibling/x.md`);
  });

  test("no containment root (peer row not delivered) leaves the path alone", () => {
    expect(canonicalViewerPath(`${ROOT}/main/docs/dr.md`, undefined, [])).toBe(
      `${ROOT}/main/docs/dr.md`,
    );
  });

  test("the containment root itself is not rebased to an empty path", () => {
    expect(canonicalViewerPath(ROOT, ROOT, [])).toBe(ROOT);
  });
});

describe("fileAncestorDirectories", () => {
  // A created file below a repo-container workspace can introduce any missing
  // directory in the chain. Reloading root plus every parent makes the path
  // discoverable even when the tree cached an empty workspace before fs_write.
  test("returns root and every parent of a nested root-relative file", () => {
    expect(fileAncestorDirectories("main/docs/inbox/memo.md")).toEqual([
      "",
      "main",
      "main/docs",
      "main/docs/inbox",
    ]);
  });

  // A cwd-rooted session returns docs/inbox/memo.md; root must still reload so
  // a newly-created docs directory appears in a previously empty tree.
  test("includes root for a cwd-rooted inbox path", () => {
    expect(fileAncestorDirectories("docs/inbox/memo.md")).toEqual(["", "docs", "docs/inbox"]);
  });

  // Root-level files have no named parent, but the root listing is exactly the
  // directory whose entries changed.
  test("root-level file reloads only the root listing", () => {
    expect(fileAncestorDirectories("memo.md")).toEqual([""]);
  });
});

describe("expandPathsForSelection", () => {
  const folders = [{ path: "/repo/one", name: "one" }];

  // The project section renders rootPath's listing already expanded, so the
  // chain to open starts one level below it and the root never appears.
  test("returns each directory between the tree root and the file", () => {
    expect(expandPathsForSelection("main/packages/webui/src/app.ts", "main", [])).toEqual([
      "main/packages",
      "main/packages/webui",
      "main/packages/webui/src",
    ]);
  });

  test("a containment-rooted session starts the chain at the first segment", () => {
    expect(expandPathsForSelection("docs/inbox/memo.md", "", [])).toEqual(["docs", "docs/inbox"]);
  });

  // Already visible in the root listing — nothing to open.
  test("a file directly in the root needs no expansion", () => {
    expect(expandPathsForSelection("main/README.md", "main", [])).toEqual([]);
  });

  // A sibling worktree is inside the daemon's containment but outside the
  // browsed root, so no row for it exists in the project section to reveal.
  test("a path outside the tree root expands nothing", () => {
    expect(expandPathsForSelection("other/pkg/x.ts", "main", [])).toEqual([]);
  });

  // Unlike the project root, a workspace folder root is a collapsible DirNode,
  // so it has to open too.
  test("a workspace file opens its folder root and everything below it", () => {
    expect(expandPathsForSelection("/repo/one/src/deep/x.ts", "main", folders)).toEqual([
      "/repo/one",
      "/repo/one/src",
      "/repo/one/src/deep",
    ]);
  });

  test("a file directly in a workspace folder opens just that folder", () => {
    expect(expandPathsForSelection("/repo/one/x.ts", "main", folders)).toEqual(["/repo/one"]);
  });

  // DR-0024 external files render flat at depth 0 in プロジェクト外.
  test("an absolute path under no workspace folder expands nothing", () => {
    expect(expandPathsForSelection("/elsewhere/deep/x.ts", "main", folders)).toEqual([]);
  });

  test("no selection expands nothing", () => {
    expect(expandPathsForSelection("", "main", folders)).toEqual([]);
  });
});

describe("inboxAutoFilename", () => {
  // DR-0019 §2.2's exact format: YYYYMMDD-HHmm.md, zero-padded, from the
  // Date's local-time getters (not UTC — see the function's doc comment on
  // why: inbox is "this moment", not a UTC-normalized moment).
  test("formats as zero-padded YYYYMMDD-HHmm.md", () => {
    expect(inboxAutoFilename(new Date(2026, 6, 16, 9, 5))).toBe("20260716-0905.md");
  });

  // Every zero-padded field independently, not just the ones that happen to
  // need it in the fixture above (month/day/hour/minute all share the same
  // pad2 call, but a single fixture with only one single-digit field
  // wouldn't catch a copy-paste bug that padded the wrong field).
  test("zero-pads month, day, hour, and minute independently", () => {
    expect(inboxAutoFilename(new Date(2026, 0, 1, 0, 0))).toBe("20260101-0000.md");
  });

  test("does not zero-pad already-two-digit fields", () => {
    expect(inboxAutoFilename(new Date(2026, 11, 31, 23, 59))).toBe("20261231-2359.md");
  });
});

describe("resolveInboxFilename", () => {
  const now = new Date(2026, 6, 16, 9, 5); // fixed instant, see inboxAutoFilename tests above

  // Blank input (the placeholder's promise: "leave it empty and I'll name
  // it for you") falls back to the auto-generated name.
  test("blank input falls back to the auto-generated name", () => {
    expect(resolveInboxFilename("", now)).toEqual({ name: "20260716-0905.md" });
  });

  // Whitespace-only input is "effectively blank", same fallback — a user
  // who taps the field and hits space by accident shouldn't get a literal
  // " .md" filename.
  test("whitespace-only input falls back to the auto-generated name", () => {
    expect(resolveInboxFilename("   ", now)).toEqual({ name: "20260716-0905.md" });
  });

  // DR-0019 §2.3: subdirectory carving is out of Phase W2's scope, so any
  // "/" in the (trimmed) input is rejected client-side rather than round-
  // tripping to the daemon only to get path_not_writable back.
  test("rejects a name containing a slash", () => {
    const result = resolveInboxFilename("sub/dir/note.md", now);
    expect("error" in result).toBe(true);
  });

  test("leading/trailing whitespace around a slash-bearing name is still rejected", () => {
    const result = resolveInboxFilename("  a/b  ", now);
    expect("error" in result).toBe(true);
  });

  // .md extension is appended when absent...
  test("appends .md when the name has no extension", () => {
    expect(resolveInboxFilename("shopping-list", now)).toEqual({ name: "shopping-list.md" });
  });

  // ...but not duplicated when the user already typed it, case-insensitively
  // (a user typing "NOTE.MD" on a phone keyboard shouldn't get "NOTE.MD.md").
  test("does not duplicate an existing .md extension", () => {
    expect(resolveInboxFilename("note.md", now)).toEqual({ name: "note.md" });
  });

  test("does not duplicate an existing .MD extension (case-insensitive)", () => {
    expect(resolveInboxFilename("NOTE.MD", now)).toEqual({ name: "NOTE.MD" });
  });

  // Whitespace around an otherwise-valid name is trimmed before the
  // extension check/append, same as the blank-input case above.
  test("trims surrounding whitespace before resolving", () => {
    expect(resolveInboxFilename("  todo  ", now)).toEqual({ name: "todo.md" });
  });

  // A dot elsewhere in the name (a non-.md extension, or a dotted word) is
  // left alone apart from the .md suffix appended on top — resolveInboxFilename
  // only special-cases the literal .md suffix, not "has some extension".
  test("appends .md alongside an unrelated extension rather than replacing it", () => {
    expect(resolveInboxFilename("archive.tar.gz", now)).toEqual({ name: "archive.tar.gz.md" });
  });
});

// --- Session search (DR-0021 Phase 2) --- //

describe("formatBytes", () => {
  test("renders sub-KB sizes as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("renders KB with one fractional digit", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  test("renders MB once the KB value would itself reach 1024", () => {
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});

describe("buildSessionSearchRequest", () => {
  // The unmodified default form should serialize to "nothing but defaults" —
  // every field at its DEFAULT_SESSION_SEARCH_FORM value is omitted from the
  // wire body, matching the server's own documented defaults
  // (SessionSearchRequest's doc comment in @ccmsg/protocol).
  test("omits every field when the form is untouched", () => {
    expect(buildSessionSearchRequest(DEFAULT_SESSION_SEARCH_FORM)).toEqual({});
  });

  test("trims and includes free-text fields only when non-blank", () => {
    const form: SessionSearchForm = {
      ...DEFAULT_SESSION_SEARCH_FORM,
      query: "  foo bar  ",
      cwd: "  claude-ccmsg  ",
      sid: "  abcd1234  ",
    };
    expect(buildSessionSearchRequest(form)).toEqual({
      query: "foo bar",
      cwd: "claude-ccmsg",
      sid: "abcd1234",
    });
  });

  test("whitespace-only free-text fields are omitted, not sent as empty strings", () => {
    const form: SessionSearchForm = { ...DEFAULT_SESSION_SEARCH_FORM, query: "   " };
    expect(buildSessionSearchRequest(form)).toEqual({});
  });

  // Both toggles default true server-side, so only an OFF flip needs wire
  // representation — an unflipped toggle (still true) stays absent.
  // Aa and .* default off on both client and daemon, so only active toggles
  // need explicit wire fields.
  test("sends case_sensitive/regex only when enabled", () => {
    expect(
      buildSessionSearchRequest({ ...DEFAULT_SESSION_SEARCH_FORM, caseSensitive: true }),
    ).toEqual({ case_sensitive: true });
    expect(buildSessionSearchRequest({ ...DEFAULT_SESSION_SEARCH_FORM, regex: true })).toEqual({
      regex: true,
    });
  });

  test("sends target_user/target_agent only when flipped false", () => {
    expect(
      buildSessionSearchRequest({ ...DEFAULT_SESSION_SEARCH_FORM, targetUser: false }),
    ).toEqual({ target_user: false });
    expect(
      buildSessionSearchRequest({ ...DEFAULT_SESSION_SEARCH_FORM, targetAgent: false }),
    ).toEqual({ target_agent: false });
    expect(
      buildSessionSearchRequest({
        ...DEFAULT_SESSION_SEARCH_FORM,
        targetUser: true,
        targetAgent: true,
      }),
    ).toEqual({});
  });

  test("includes config_dirs only when a non-empty subset is selected", () => {
    expect(buildSessionSearchRequest(DEFAULT_SESSION_SEARCH_FORM)).toEqual({});
    expect(
      buildSessionSearchRequest({
        ...DEFAULT_SESSION_SEARCH_FORM,
        configDirs: ["/home/.claude", "/home/.claude-work"],
      }),
    ).toEqual({ config_dirs: ["/home/.claude", "/home/.claude-work"] });
  });

  test("sends mtime_within only when it differs from the 5d default", () => {
    expect(
      buildSessionSearchRequest({ ...DEFAULT_SESSION_SEARCH_FORM, mtimeWithin: "5d" }),
    ).toEqual({});
    expect(
      buildSessionSearchRequest({ ...DEFAULT_SESSION_SEARCH_FORM, mtimeWithin: "  2h  " }),
    ).toEqual({ mtime_within: "2h" });
    expect(
      buildSessionSearchRequest({ ...DEFAULT_SESSION_SEARCH_FORM, mtimeWithin: "  " }),
    ).toEqual({});
  });
});

describe("sessionSearchFormToTimelineSearch", () => {
  // The result navigation handoff preserves the exact submitted Aa/.* modes
  // and trims only the outer query whitespace; internal newlines remain the
  // Timeline parser's AND separators.
  test("converts submitted search controls into Timeline search state", () => {
    expect(
      sessionSearchFormToTimelineSearch({
        ...DEFAULT_SESSION_SEARCH_FORM,
        query: "  alpha\nbeta  ",
        caseSensitive: true,
        regex: true,
      }),
    ).toEqual({ queryText: "alpha\nbeta", caseSensitive: true, regex: true });
  });
});

function searchHit(overrides: Partial<SessionSearchHit>): SessionSearchHit {
  return {
    sid: "11111111-2222-3333-4444-555555555555",
    config_dir: "/home/.claude",
    file: "/home/.claude/projects/x/11111111-2222-3333-4444-555555555555.jsonl",
    cwd: "/repos/claude-ccmsg/main",
    repo: "kawaz/claude-ccmsg",
    ws: "main",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    size: 2048,
    matches: [{ role: "user", text: "hello world" }],
    title: null,
    ...overrides,
  };
}

describe("sessionSearchHitLabel", () => {
  test("uses repo/ws when present", () => {
    expect(sessionSearchHitLabel(searchHit({}))).toEqual({
      repo: "kawaz/claude-ccmsg",
      ws: "main",
    });
  });

  test("falls back to cwd's last path segment when repo/ws are both absent", () => {
    expect(
      sessionSearchHitLabel(searchHit({ repo: null, ws: null, cwd: "/some/random/dir" })),
    ).toEqual({ repo: "", ws: "dir" });
  });

  test("falls back to the short sid when even cwd is null", () => {
    const hit = searchHit({ repo: null, ws: null, cwd: null });
    expect(sessionSearchHitLabel(hit)).toEqual({ repo: "", ws: shortSid(hit.sid) });
  });
});

describe("matchRoleBadge", () => {
  test("maps user/agent roles to their one-letter markers", () => {
    expect(matchRoleBadge("user")).toBe("U");
    expect(matchRoleBadge("agent")).toBe("A");
  });
});

// --- Pinned sessions (DR-0021 §2.4/§3.2) --- //

describe("parsePinnedSessions", () => {
  test("returns an empty list for a missing key", () => {
    expect(parsePinnedSessions(null)).toEqual([]);
  });

  test("returns an empty list for malformed JSON", () => {
    expect(parsePinnedSessions("{not json")).toEqual([]);
  });

  test("returns an empty list for JSON that isn't an array", () => {
    expect(parsePinnedSessions(JSON.stringify({ sid: "x" }))).toEqual([]);
  });

  test("parses a valid list of hits", () => {
    const hit = searchHit({});
    expect(parsePinnedSessions(JSON.stringify([hit]))).toEqual([hit]);
  });

  // One malformed entry (missing required fields — a prior schema version, a
  // hand edit, or storage corruption) is dropped individually rather than
  // invalidating every other legitimately-pinned session in the array.
  test("drops individually malformed entries without discarding the rest", () => {
    const good = searchHit({});
    const garbage = [good, { sid: "only-a-sid" }, "not even an object", 42, null];
    expect(parsePinnedSessions(JSON.stringify(garbage))).toEqual([good]);
  });
});

describe("sortPinnedSessions", () => {
  test("orders most-recently-updated first, without mutating the input", () => {
    const older = searchHit({ sid: "a", updated_at: "2026-07-01T00:00:00.000Z" });
    const newer = searchHit({ sid: "b", updated_at: "2026-07-15T00:00:00.000Z" });
    const input = [older, newer];
    expect(sortPinnedSessions(input)).toEqual([newer, older]);
    expect(input).toEqual([older, newer]); // unmutated
  });
});
