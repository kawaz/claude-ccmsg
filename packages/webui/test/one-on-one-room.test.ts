// DR-0014 の 1on1 room の引き当て (Timeline がそのセッションの 1on1 room の
// say を TL に重ねるために使う)。
import { describe, expect, test } from "bun:test";
import { findExistingOneOnOne } from "../src/client/one-on-one-room.ts";
import type { DeliveredEvent } from "@ccmsg/protocol";
import {
  initialState,
  type AppState,
  type MemberInfo,
  type RoomState,
} from "../src/client/store.ts";

function makeRoomState(overrides: Partial<RoomState> & { id: string }): RoomState {
  return {
    id: overrides.id,
    title: overrides.title,
    membersById: overrides.membersById ?? new Map<string, MemberInfo>(),
    memberOrder: overrides.memberOrder ?? [],
    msgs: overrides.msgs ?? new Map<number, DeliveredEvent & { type: "msg" }>(),
    timeline: overrides.timeline ?? [],
    lastMid: overrides.lastMid ?? 0,
    lastTs: overrides.lastTs ?? null,
    sayUnread: overrides.sayUnread ?? new Set<number>(),
    archived: overrides.archived,
    kind: overrides.kind ?? "normal",
    history: overrides.history ?? "loaded",
  };
}

describe("DR-0014 findExistingOneOnOne (§2.2 kind-based lookup)", () => {
  // 何を保証するか (§2.2 「判別は kind フィールドで行う」): the lookup
  // matches by room.kind === "1on1" AND its single non-u1 member sid. A
  // room whose title merely contains "1on1" but has kind "normal" is NOT
  // treated as a 1on1 (§2.1 「title 文字列一致は typo に弱い」).
  test("matches only by kind:'1on1' + sole member sid, not by title", () => {
    const state: AppState = {
      ...initialState(),
      rooms: new Map<string, RoomState>([
        [
          "r1",
          makeRoomState({
            id: "r1",
            kind: "normal",
            title: "misleading 1on1 title",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "repo-a",
                  ws: "ws",
                  cwd: "/cwd",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: false,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
        [
          "r2",
          makeRoomState({
            id: "r2",
            kind: "1on1",
            title: "repo-a 1on1 sid-A",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "repo-a",
                  ws: "ws",
                  cwd: "/cwd",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: false,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
      ]),
    };
    const found = findExistingOneOnOne(state, "sid-A");
    expect(found?.id).toBe("r2");
  });

  // 何を保証するか (§2.1 dedup: 対象 sid の 1on1 が無ければ null): a broadcast
  // that happens to contain the sid as a member does NOT count, so the
  // session's says are not overlaid from it.
  test("returns null when no kind:'1on1' room has the target sid as its sole member", () => {
    const state: AppState = {
      ...initialState(),
      rooms: new Map<string, RoomState>([
        [
          "r1",
          makeRoomState({
            id: "r1",
            kind: "broadcast",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "r",
                  ws: "w",
                  cwd: "/",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: false,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
      ]),
    };
    expect(findExistingOneOnOne(state, "sid-A")).toBeNull();
  });

  // 何を保証するか (left member skip): a member who has left the 1on1 room
  // (kicked, or voluntarily left — unusual for 1on1 but possible) doesn't
  // match, so the dead room is not treated as that session's 1on1 room.
  test("skips rooms where the sole member has left", () => {
    const state: AppState = {
      ...initialState(),
      rooms: new Map<string, RoomState>([
        [
          "r1",
          makeRoomState({
            id: "r1",
            kind: "1on1",
            membersById: new Map([
              [
                "a1",
                {
                  type: "member",
                  id: "a1",
                  sid: "sid-A",
                  repo: "r",
                  ws: "w",
                  cwd: "/",
                  joined_at: "2026-07-14T00:00:00Z",
                  left: true,
                },
              ],
            ]),
            memberOrder: ["a1"],
          }),
        ],
      ]),
    };
    expect(findExistingOneOnOne(state, "sid-A")).toBeNull();
  });
});
