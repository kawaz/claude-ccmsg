// issue 2026-07-17-rooms-sidebar-new-button.md: pure form-state helpers for
// RoomCreator.tsx (default construction, member toggling, create-button
// validity gate, wire-request projection).
import { describe, expect, test } from "bun:test";
import {
  buildCreateRoomRequest,
  initialRoomCreatorForm,
  roomCreatorFormValid,
  toggleRoomCreatorMember,
  type RoomCreatorForm,
} from "../src/client/room-creator.ts";

describe("initialRoomCreatorForm", () => {
  test("starts with an empty title and no selected members", () => {
    expect(initialRoomCreatorForm()).toEqual({ title: "", memberSids: [], kind: "normal" });
  });
});

function form(overrides: Partial<RoomCreatorForm> = {}): RoomCreatorForm {
  return { title: "", memberSids: [], kind: "normal", ...overrides };
}

describe("toggleRoomCreatorMember", () => {
  test("adds a sid not yet selected", () => {
    expect(toggleRoomCreatorMember(form(), "sid-1").memberSids).toEqual(["sid-1"]);
  });

  test("appends to existing selections, preserving order", () => {
    const f = form({ memberSids: ["sid-1"] });
    expect(toggleRoomCreatorMember(f, "sid-2").memberSids).toEqual(["sid-1", "sid-2"]);
  });

  test("removes a sid already selected (toggle off)", () => {
    const f = form({ memberSids: ["sid-1", "sid-2"] });
    expect(toggleRoomCreatorMember(f, "sid-1").memberSids).toEqual(["sid-2"]);
  });

  test("leaves the title and other array entries untouched", () => {
    const f = form({ title: "keep me", memberSids: ["sid-1"] });
    const next = toggleRoomCreatorMember(f, "sid-2");
    expect(next.title).toBe("keep me");
    expect(next.memberSids).toEqual(["sid-1", "sid-2"]);
  });
});

describe("roomCreatorFormValid", () => {
  // create_room with a user-role caller and zero members would make a room
  // with only the implicit User in it — not a useful room (room-creator.ts's
  // doc comment) — so the create button stays disabled until at least one
  // member is picked, regardless of the title field.
  test("invalid with no members selected, even with a title", () => {
    expect(roomCreatorFormValid(form({ title: "some title", memberSids: [] }))).toBe(false);
  });

  test("valid once at least one member is selected", () => {
    expect(roomCreatorFormValid(form({ memberSids: ["sid-1"] }))).toBe(true);
  });
});

describe("buildCreateRoomRequest", () => {
  test("null when the form isn't submittable (no members)", () => {
    expect(buildCreateRoomRequest(form({ memberSids: [] }))).toBeNull();
  });

  test("omits title when blank", () => {
    expect(buildCreateRoomRequest(form({ title: "", memberSids: ["sid-1"] }))).toEqual({
      members: ["sid-1"],
    });
  });

  test("omits title when whitespace-only", () => {
    expect(buildCreateRoomRequest(form({ title: "   ", memberSids: ["sid-1"] }))).toEqual({
      members: ["sid-1"],
    });
  });

  test("trims and carries a non-blank title through, with all selected members", () => {
    expect(
      buildCreateRoomRequest(form({ title: "  my room  ", memberSids: ["sid-1", "sid-2"] })),
    ).toEqual({ members: ["sid-1", "sid-2"], title: "my room" });
  });
});

describe("broadcast kind (kawaz r26 mid=118)", () => {
  // broadcast はメンバー自動 populate (DR-0013) — 選択ゼロでも valid で、
  // request は members:[] + kind:"broadcast" を送る (選択済み sid は送らない)。
  test("broadcast form is valid with zero members", () => {
    expect(roomCreatorFormValid(form({ kind: "broadcast" }))).toBe(true);
  });

  test("broadcast request carries kind and empty members even if sids were picked", () => {
    const req = buildCreateRoomRequest(form({ kind: "broadcast", memberSids: ["sid-1"] }));
    expect(req).toEqual({ members: [], kind: "broadcast" });
  });

  // normal は従来どおり kind を送らない (daemon default に任せる)
  test("normal request omits kind", () => {
    const req = buildCreateRoomRequest(form({ memberSids: ["sid-1"] }));
    expect(req).toEqual({ members: ["sid-1"] });
  });
});
