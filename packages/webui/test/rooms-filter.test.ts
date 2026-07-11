// U3 (SessionView Rooms tab): unit tests for the pure sid->room filters used
// by SessionRooms.tsx. Room fixtures are built via the reducer's
// "rooms/loaded" action (same as store.test.ts) rather than hand-assembling
// RoomState, so membersById/memberOrder stay in the exact shape the reducer
// actually produces.
import { describe, expect, test } from "bun:test";
import type { MemberEvent, PeerInfo, RoomSummary } from "@ccmsg/protocol";
import { initialState, reducer } from "../src/client/store.ts";
import { roomsForSession, roomsForSids, sameCwdSids } from "../src/client/rooms-filter.ts";

function member(overrides: Partial<MemberEvent> & { id: string; sid: string }): MemberEvent {
  return {
    type: "member",
    repo: "kawaz/claude-ccmsg",
    ws: "main",
    cwd: "/repo",
    joined_at: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function peer(overrides: Partial<PeerInfo> & { sid: string; cwd: string }): PeerInfo {
  return { repo: "kawaz/claude-ccmsg", ws: "main", ...overrides };
}

describe("roomsForSession", () => {
  test("returns rooms where sid has an active member row", () => {
    const summaries: RoomSummary[] = [
      {
        id: "r1",
        members: [member({ id: "a1", sid: "sid-A" })],
        last_mid: 1,
        last_ts: null,
      },
      {
        id: "r2",
        members: [member({ id: "a1", sid: "sid-B" })],
        last_mid: 1,
        last_ts: null,
      },
    ];
    const state = reducer(initialState(), { type: "rooms/loaded", rooms: summaries });
    expect(roomsForSession(state.rooms, "sid-A").map((r) => r.id)).toEqual(["r1"]);
  });

  // A sid with no member row in any room (never joined) — must not throw,
  // must return an empty list rather than e.g. every room.
  test("returns empty for a sid with no room membership", () => {
    const summaries: RoomSummary[] = [
      { id: "r1", members: [member({ id: "a1", sid: "sid-A" })], last_mid: 1, last_ts: null },
    ];
    const state = reducer(initialState(), { type: "rooms/loaded", rooms: summaries });
    expect(roomsForSession(state.rooms, "sid-unknown")).toEqual([]);
  });

  // A sid that left the room keeps its historical member row (left: true) —
  // "参加中" must exclude it, distinguishing past membership from current.
  test("excludes a room the sid has left", () => {
    const summaries: RoomSummary[] = [
      { id: "r1", members: [member({ id: "a1", sid: "sid-A" })], last_mid: 1, last_ts: null },
    ];
    let state = reducer(initialState(), { type: "rooms/loaded", rooms: summaries });
    state = reducer(state, {
      type: "protocol-event",
      event: { type: "leave", id: "a1", ts: "2026-07-09T00:02:00.000Z", r: "r1" },
    });
    expect(roomsForSession(state.rooms, "sid-A")).toEqual([]);
  });
});

describe("sameCwdSids", () => {
  const peers: PeerInfo[] = [
    peer({ sid: "sid-A", cwd: "/repo/main" }),
    peer({ sid: "sid-B", cwd: "/repo/main" }),
    peer({ sid: "sid-C", cwd: "/repo/other" }),
  ];

  test("returns other sids sharing the same cwd, self excluded", () => {
    expect(sameCwdSids(peers, "sid-A")).toEqual(["sid-B"]);
  });

  test("returns empty when no other session shares the cwd", () => {
    expect(sameCwdSids(peers, "sid-C")).toEqual([]);
  });

  // sid not present in peers at all (disconnected) — must not throw.
  test("returns empty for an unknown sid", () => {
    expect(sameCwdSids(peers, "sid-ghost")).toEqual([]);
  });
});

describe("roomsForSids", () => {
  test("returns rooms any of the given sids participates in", () => {
    const summaries: RoomSummary[] = [
      { id: "r1", members: [member({ id: "a1", sid: "sid-B" })], last_mid: 1, last_ts: null },
      { id: "r2", members: [member({ id: "a1", sid: "sid-C" })], last_mid: 1, last_ts: null },
    ];
    const state = reducer(initialState(), { type: "rooms/loaded", rooms: summaries });
    expect(
      roomsForSids(state.rooms, ["sid-B", "sid-C"])
        .map((r) => r.id)
        .sort(),
    ).toEqual(["r1", "r2"]);
  });

  // Dedup against the session's own room list — r1 is already shown under
  // "このセッションが参加中の room", so the secondary section must not repeat it
  // even though sid-B (same cwd) is also a member.
  test("excludes rooms already present in exclude", () => {
    const summaries: RoomSummary[] = [
      {
        id: "r1",
        members: [member({ id: "a1", sid: "sid-A" }), member({ id: "a2", sid: "sid-B" })],
        last_mid: 1,
        last_ts: null,
      },
    ];
    const state = reducer(initialState(), { type: "rooms/loaded", rooms: summaries });
    const own = [state.rooms.get("r1")!];
    expect(roomsForSids(state.rooms, ["sid-B"], own)).toEqual([]);
  });
});
