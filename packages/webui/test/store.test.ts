// Reducer unit tests (DR-0005 §1): the reducer is the single place both
// WS-delivered protocol events and UI actions are folded into AppState. These
// tests exercise that fold directly (no WS, no DOM) — the whole point of
// making the reducer pure is that its contract is testable this way.
import { describe, expect, test } from "bun:test";
import type { DeliveredEvent, MemberEvent, RoomSummary } from "@ccmsg/protocol";
import {
  ADMIN_ID,
  type Action,
  type AppState,
  initialState,
  reducer,
} from "../src/client/store.ts";

function dispatch(state: AppState, action: Action): AppState {
  return reducer(state, action);
}

const member: MemberEvent = {
  type: "member",
  id: "a1",
  sid: "sid-abcdefgh",
  repo: "kawaz/claude-ccmsg",
  ws: "main",
  cwd: "/repo",
  joined_at: "2026-07-09T00:00:00.000Z",
};

describe("reducer / rooms/loaded", () => {
  // "rooms" op response seeds rooms + their member rosters in one shot
  // (initial page load / reconnect resync), independent of the live event
  // stream that follows via subscribe.
  test("creates rooms with members from RoomSummary[]", () => {
    const summaries: RoomSummary[] = [
      {
        id: "r1",
        title: "hello",
        members: [member],
        last_mid: 3,
        last_ts: "2026-07-09T00:01:00.000Z",
      },
    ];
    const state = dispatch(initialState(), { type: "rooms/loaded", rooms: summaries });
    const room = state.rooms.get("r1");
    expect(room).toBeDefined();
    expect(room?.title).toBe("hello");
    expect(room?.lastMid).toBe(3);
    expect(room?.membersById.get("a1")?.repo).toBe("kawaz/claude-ccmsg");
    expect(room?.membersById.get("a1")?.left).toBe(false);
    expect(room?.memberOrder).toEqual(["a1"]);
  });

  test("does not mutate the previous state (reducer purity)", () => {
    const before = initialState();
    const summaries: RoomSummary[] = [{ id: "r1", members: [], last_mid: 0, last_ts: null }];
    const after = dispatch(before, { type: "rooms/loaded", rooms: summaries });
    expect(before.rooms.size).toBe(0);
    expect(after.rooms.size).toBe(1);
    expect(after).not.toBe(before);
  });
});

describe("reducer / protocol-event msg", () => {
  // msg 追記: 輪郭 — 新規 mid は timeline + msgs 両方に、既知 mid (post 直後の
  // optimistic echo と subscribe backlog の重複配信) は timeline に二重追加され
  // ない (dedup by mid, DR-0003 §5 backlog replay と整合)。
  test("appends a new message to timeline and msgs", () => {
    const ev: DeliveredEvent = {
      type: "msg",
      mid: 1,
      from: ADMIN_ID,
      ts: "2026-07-09T00:00:00.000Z",
      msg: "hi",
      r: "r1",
    };
    const state = dispatch(initialState(), { type: "protocol-event", event: ev });
    const room = state.rooms.get("r1");
    expect(room?.msgs.get(1)?.msg).toBe("hi");
    expect(room?.timeline).toHaveLength(1);
    expect(room?.lastMid).toBe(1);
    expect(room?.lastTs).toBe(ev.ts);
  });

  test("ignores a duplicate mid (already-known message replayed)", () => {
    const ev: DeliveredEvent = {
      type: "msg",
      mid: 1,
      from: ADMIN_ID,
      ts: "2026-07-09T00:00:00.000Z",
      msg: "hi",
      r: "r1",
    };
    const once = dispatch(initialState(), { type: "protocol-event", event: ev });
    const twice = dispatch(once, { type: "protocol-event", event: ev });
    expect(twice.rooms.get("r1")?.timeline).toHaveLength(1);
  });

  test("lastMid tracks the max seen mid even out of order", () => {
    const first = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "msg", mid: 5, from: ADMIN_ID, ts: "t1", msg: "a", r: "r1" },
    });
    const second = dispatch(first, {
      type: "protocol-event",
      event: { type: "msg", mid: 2, from: ADMIN_ID, ts: "t2", msg: "b", r: "r1" },
    });
    expect(second.rooms.get("r1")?.lastMid).toBe(5);
  });
});

describe("reducer / protocol-event member & leave", () => {
  test("member event adds to membersById and memberOrder, in-order timeline entry", () => {
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: { ...member, r: "r1" },
    });
    const room = state.rooms.get("r1");
    expect(room?.membersById.get("a1")?.left).toBe(false);
    expect(room?.memberOrder).toEqual(["a1"]);
    expect(room?.timeline).toHaveLength(1);
  });

  test("leave event flips left=true without removing the member (history preserved)", () => {
    const joined = dispatch(initialState(), {
      type: "protocol-event",
      event: { ...member, r: "r1" },
    });
    const left = dispatch(joined, {
      type: "protocol-event",
      event: { type: "leave", id: "a1", ts: "2026-07-09T00:02:00.000Z", r: "r1" },
    });
    const room = left.rooms.get("r1");
    expect(room?.membersById.get("a1")?.left).toBe(true);
    expect(room?.memberOrder).toEqual(["a1"]); // still listed, just marked left
    expect(room?.timeline).toHaveLength(2);
  });

  test("leave for an unknown id is a no-op on membersById but still recorded in timeline", () => {
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "leave", id: "a99", ts: "t", r: "r1" },
    });
    expect(state.rooms.get("r1")?.membersById.has("a99")).toBe(false);
    expect(state.rooms.get("r1")?.timeline).toHaveLength(1);
  });
});

describe("reducer / protocol-event title, next, prev", () => {
  test("title event updates room.title and appends to timeline", () => {
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "title", title: "renamed", ts: "t", r: "r1" },
    });
    expect(state.rooms.get("r1")?.title).toBe("renamed");
    expect(state.rooms.get("r1")?.timeline).toHaveLength(1);
  });

  test("next/prev events only append to timeline (no other room-state change)", () => {
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "next", room: "r2", ts: "t", r: "r1" },
    });
    const room = state.rooms.get("r1");
    expect(room?.timeline).toHaveLength(1);
    expect(room?.lastMid).toBe(0);
  });
});

describe("reducer / conn/status", () => {
  // restarting → 再接続状態: daemon 再起動中の ev frame は WS effect 層が
  // 直接この action に正規化する (ws.ts)。reducer 側は connStatus を素通しで
  // 反映するだけの輪郭を担保する。
  test("transitions connStatus for every known status value", () => {
    for (const status of ["connecting", "connected", "disconnected", "restarting"] as const) {
      const state = dispatch(initialState(), { type: "conn/status", status });
      expect(state.connStatus).toBe(status);
    }
  });
});

describe("reducer / locator/changed", () => {
  test("sets currentRoomId + currentMid and resets mentionTo + closes mobile sidebar", () => {
    const withMention = dispatch(initialState(), { type: "mention/toggle", id: "a1" });
    const withSidebar = dispatch(withMention, { type: "sidebar/set", open: true });
    const state = dispatch(withSidebar, { type: "locator/changed", room: "r1", mid: 4 });
    expect(state.currentRoomId).toBe("r1");
    expect(state.currentMid).toBe(4);
    expect(state.mentionTo.size).toBe(0);
    expect(state.sidebarOpen).toBe(false);
  });

  test("room-only locator (#rXXXX, no message anchor) leaves currentMid null", () => {
    const state = dispatch(initialState(), { type: "locator/changed", room: "r1", mid: null });
    expect(state.currentMid).toBeNull();
  });
});

describe("reducer / mention/toggle", () => {
  test("toggles an id in and out of mentionTo", () => {
    const added = dispatch(initialState(), { type: "mention/toggle", id: "a1" });
    expect(added.mentionTo.has("a1")).toBe(true);
    const removed = dispatch(added, { type: "mention/toggle", id: "a1" });
    expect(removed.mentionTo.has("a1")).toBe(false);
  });
});

describe("reducer / peers/loaded and sidebar/set", () => {
  test("peers/loaded replaces the peers list", () => {
    const state = dispatch(initialState(), {
      type: "peers/loaded",
      peers: [{ sid: "s1", repo: "r", ws: "w", cwd: "/c" }],
    });
    expect(state.peers).toHaveLength(1);
  });

  test("sidebar/set toggles sidebarOpen independent of locator changes", () => {
    const opened = dispatch(initialState(), { type: "sidebar/set", open: true });
    expect(opened.sidebarOpen).toBe(true);
  });
});
