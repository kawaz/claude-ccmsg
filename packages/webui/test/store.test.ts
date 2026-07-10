// Reducer unit tests (DR-0005 §1): the reducer is the single place both
// WS-delivered protocol events and UI actions are folded into AppState. These
// tests exercise that fold directly (no WS, no DOM) — the whole point of
// making the reducer pure is that its contract is testable this way.
import { describe, expect, test } from "bun:test";
import type {
  DeliveredEvent,
  MemberEvent,
  RoomSummary,
  TranscriptReadResponse,
} from "@ccmsg/protocol";
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

describe("reducer / locator/changed (room view, DR-0004 §5)", () => {
  test("sets currentRoomId + currentMid and resets mentionTo + closes mobile sidebar", () => {
    const withMention = dispatch(initialState(), { type: "mention/toggle", id: "a1" });
    const withSidebar = dispatch(withMention, { type: "sidebar/set", open: true });
    const state = dispatch(withSidebar, {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: 4 },
    });
    expect(state.view).toBe("room");
    expect(state.currentRoomId).toBe("r1");
    expect(state.currentMid).toBe(4);
    expect(state.mentionTo.size).toBe(0);
    expect(state.sidebarOpen).toBe(false);
  });

  test("room-only locator (#rXXXX, no message anchor) leaves currentMid null", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
    });
    expect(state.currentMid).toBeNull();
  });
});

describe("reducer / locator/changed (session view, DR-0008)", () => {
  // Bare `#s<sid>`: switches to the session view and creates a fresh
  // per-session tree state on first visit — no fetch happens here (that's
  // FileTree's job), the reducer only records what's selected.
  test("#s<sid> switches view to 'session', sets currentSid, creates an empty tree", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: null },
    });
    expect(state.view).toBe("session");
    expect(state.currentSid).toBe("sess-1");
    const tree = state.sessionTrees.get("sess-1");
    expect(tree).toBeDefined();
    expect(tree?.selectedPath).toBeNull();
    expect(tree?.dirs.size).toBe(0);
  });

  // `#s<sid>:<path>` additionally records the selected file path on that
  // session's tree, distinct from any other session's tree in the Map.
  test("#s<sid>:<path> records selectedPath on that session's tree only", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: "src/index.ts" },
    });
    expect(state.sessionTrees.get("sess-1")?.selectedPath).toBe("src/index.ts");
    expect(state.sessionTrees.has("sess-2")).toBe(false);
  });

  // Revisiting a session (locator fires again with the same sid/path, e.g. a
  // duplicate hashchange) must not discard tree state already loaded for it —
  // this is the whole point of keying sessionTrees by sid instead of holding
  // one global tree.
  test("navigating back to a previously-visited session preserves its loaded dirs", () => {
    const visited = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: null },
    });
    const loaded = dispatch(visited, {
      type: "fs/dir-loaded",
      sid: "sess-1",
      path: "",
      entries: [{ name: "src", type: "dir" }],
    });
    const awayAndBack = dispatch(
      dispatch(loaded, {
        type: "locator/changed",
        locator: { view: "room", room: "r1", mid: null },
      }),
      { type: "locator/changed", locator: { view: "session", sid: "sess-1", path: null } },
    );
    expect(awayAndBack.sessionTrees.get("sess-1")?.dirs.get("")).toEqual([
      { name: "src", type: "dir" },
    ]);
  });
});

describe("reducer / fs/dir-toggled and fs/dir-loaded (DR-0008)", () => {
  test("fs/dir-toggled flips a path in and out of the expanded set", () => {
    const opened = dispatch(initialState(), {
      type: "fs/dir-toggled",
      sid: "sess-1",
      path: "src",
    });
    expect(opened.sessionTrees.get("sess-1")?.expanded.has("src")).toBe(true);
    const closed = dispatch(opened, { type: "fs/dir-toggled", sid: "sess-1", path: "src" });
    expect(closed.sessionTrees.get("sess-1")?.expanded.has("src")).toBe(false);
  });

  test("fs/dir-loaded stores entries for the path and clears any prior error there", () => {
    const failed = dispatch(initialState(), {
      type: "fs/dir-loaded",
      sid: "sess-1",
      path: "src",
      error: "path_forbidden",
    });
    expect(failed.sessionTrees.get("sess-1")?.dirErrors.get("src")).toBe("path_forbidden");
    const retried = dispatch(failed, {
      type: "fs/dir-loaded",
      sid: "sess-1",
      path: "src",
      entries: [{ name: "index.ts", type: "file", size: 10 }],
    });
    expect(retried.sessionTrees.get("sess-1")?.dirs.get("src")).toEqual([
      { name: "index.ts", type: "file", size: 10 },
    ]);
    expect(retried.sessionTrees.get("sess-1")?.dirErrors.has("src")).toBe(false);
  });

  test("fs/dir-loaded with an error does not touch dirs for that path", () => {
    const state = dispatch(initialState(), {
      type: "fs/dir-loaded",
      sid: "sess-1",
      path: "secret",
      error: "path_forbidden",
    });
    expect(state.sessionTrees.get("sess-1")?.dirs.has("secret")).toBe(false);
  });
});

describe("reducer / fs/file-loading and fs/file-loaded (DR-0008)", () => {
  test("fs/file-loading sets a loading placeholder for the path", () => {
    const state = dispatch(initialState(), {
      type: "fs/file-loading",
      sid: "sess-1",
      path: "README.md",
    });
    const file = state.sessionTrees.get("sess-1")?.file;
    expect(file?.status).toBe("loading");
    expect(file?.path).toBe("README.md");
  });

  test("fs/file-loaded (success) stores the FsReadResponse and flips status to loaded", () => {
    const loading = dispatch(initialState(), {
      type: "fs/file-loading",
      sid: "sess-1",
      path: "README.md",
    });
    const state = dispatch(loading, {
      type: "fs/file-loaded",
      sid: "sess-1",
      path: "README.md",
      response: {
        ok: true,
        sid: "sess-1",
        path: "README.md",
        size: 5,
        truncated: false,
        binary: false,
        content: "hello",
      },
    });
    const file = state.sessionTrees.get("sess-1")?.file;
    expect(file?.status).toBe("loaded");
    expect(file?.response?.content).toBe("hello");
  });

  test("fs/file-loaded (error) flips status to error and records the message, no stale response", () => {
    const state = dispatch(initialState(), {
      type: "fs/file-loaded",
      sid: "sess-1",
      path: "secret.env",
      error: "path_forbidden",
    });
    const file = state.sessionTrees.get("sess-1")?.file;
    expect(file?.status).toBe("error");
    expect(file?.error).toBe("path_forbidden");
    expect(file?.response).toBeUndefined();
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

describe("reducer / locator/changed (timeline view, DR-0009)", () => {
  // Bare `#t<sid>`: switches to the timeline view and creates a fresh
  // per-session tree (with an idle TimelineState) on first visit — no fetch
  // happens here (that's Timeline.tsx's job), the reducer only records
  // what's selected, same division of labor as the session/Files form.
  test("#t<sid> switches view to 'timeline', sets currentSid, creates an idle timeline cache", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
    });
    expect(state.view).toBe("timeline");
    expect(state.currentSid).toBe("sess-1");
    const tree = state.sessionTrees.get("sess-1");
    expect(tree).toBeDefined();
    expect(tree?.timeline.status).toBe("idle");
    expect(tree?.timeline.lines).toEqual([]);
  });

  // Revisiting a session's timeline (e.g. Files -> Timeline -> Files ->
  // Timeline) must not discard already-loaded lines — same non-refetch
  // guarantee store.test.ts already pins for the Files tree above.
  test("navigating away and back to a session's timeline preserves its loaded lines", () => {
    const visited = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
    });
    const res: TranscriptReadResponse = {
      ok: true,
      sid: "sess-1",
      lines: ['{"type":"user"}'],
      start: 0,
      end: 20,
      size: 20,
    };
    const loaded = dispatch(visited, {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      response: res,
    });
    const awayAndBack = dispatch(
      dispatch(loaded, {
        type: "locator/changed",
        locator: { view: "room", room: "r1", mid: null },
      }),
      { type: "locator/changed", locator: { view: "timeline", sid: "sess-1" } },
    );
    expect(awayAndBack.sessionTrees.get("sess-1")?.timeline.lines).toEqual(['{"type":"user"}']);
  });

  // The Files (`#s<sid>`) and Timeline (`#t<sid>`) locators share one
  // per-sid tree: loading the Files tab's directory listing must not be
  // clobbered by later switching to Timeline for the same sid.
  test("Files tree state survives switching to that session's Timeline tab", () => {
    const filesLoaded = dispatch(
      dispatch(initialState(), {
        type: "locator/changed",
        locator: { view: "session", sid: "sess-1", path: null },
      }),
      { type: "fs/dir-loaded", sid: "sess-1", path: "", entries: [{ name: "src", type: "dir" }] },
    );
    const toTimeline = dispatch(filesLoaded, {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
    });
    expect(toTimeline.sessionTrees.get("sess-1")?.dirs.get("")).toEqual([
      { name: "src", type: "dir" },
    ]);
  });
});

describe("reducer / timeline/loading and timeline/loaded (DR-0009)", () => {
  test("timeline/loading sets status 'loading' and clears any prior error", () => {
    const errored = dispatch(initialState(), {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      error: "session_not_found",
    });
    const loading = dispatch(errored, { type: "timeline/loading", sid: "sess-1" });
    const timeline = loading.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.status).toBe("loading");
    expect(timeline?.error).toBeUndefined();
  });

  // "replace" mode (initial load / 更新 refresh, `before` omitted): the cache
  // is discarded and the response's own start/end/size/lines become the new
  // cache verbatim.
  test("timeline/loaded (replace) stores the response as the new cache", () => {
    const res: TranscriptReadResponse = {
      ok: true,
      sid: "sess-1",
      lines: ["a", "b"],
      start: 100,
      end: 150,
      size: 150,
    };
    const state = dispatch(initialState(), {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      response: res,
    });
    const timeline = state.sessionTrees.get("sess-1")?.timeline;
    expect(timeline).toEqual({
      status: "loaded",
      lines: ["a", "b"],
      start: 100,
      end: 150,
      size: 150,
      atStart: false,
    });
  });

  // "replace" with start:0 (the whole transcript fit in one tail read) must
  // flip atStart true — no "older" button should be enabled from here.
  test("timeline/loaded (replace) with start:0 sets atStart true", () => {
    const res: TranscriptReadResponse = {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 10,
      size: 10,
    };
    const state = dispatch(initialState(), {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      response: res,
    });
    expect(state.sessionTrees.get("sess-1")?.timeline.atStart).toBe(true);
  });

  // "prepend" mode ("older を読み込む", `before` = the cache's current
  // `start`): the older page's lines go in FRONT of what's cached, `start`
  // moves back to the response's `start`, but `end` deliberately keeps the
  // PREVIOUS cached value (the older page's own `end` describes where that
  // batch stops, not how far into the file the overall cache reaches — see
  // applyTimelineLoaded's doc comment in store.ts).
  test("timeline/loaded (prepend) splices older lines in front, moves start back, keeps end unchanged", () => {
    const initial: TranscriptReadResponse = {
      ok: true,
      sid: "sess-1",
      lines: ["tail-1", "tail-2"],
      start: 100,
      end: 200,
      size: 200,
    };
    const afterInitial = dispatch(initialState(), {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      response: initial,
    });
    const older: TranscriptReadResponse = {
      ok: true,
      sid: "sess-1",
      lines: ["older-1", "older-2"],
      start: 20,
      end: 100,
      size: 200,
    };
    const afterOlder = dispatch(afterInitial, {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "prepend",
      response: older,
    });
    const timeline = afterOlder.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["older-1", "older-2", "tail-1", "tail-2"]);
    expect(timeline?.start).toBe(20);
    expect(timeline?.end).toBe(200); // unchanged from the initial (tail) load
    expect(timeline?.atStart).toBe(false);
  });

  // Prepending a page whose own `start` is 0 reaches the true beginning of
  // the transcript — atStart must flip true so the "older" button disables.
  test("timeline/loaded (prepend) reaching start:0 sets atStart true", () => {
    const afterInitial = dispatch(initialState(), {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["tail"], start: 50, end: 100, size: 100 },
    });
    const afterOlder = dispatch(afterInitial, {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "prepend",
      response: { ok: true, sid: "sess-1", lines: ["first"], start: 0, end: 50, size: 100 },
    });
    expect(afterOlder.sessionTrees.get("sess-1")?.timeline.atStart).toBe(true);
  });

  test("timeline/loaded (error) flips status to error and records the message, does not touch lines", () => {
    const withLines = dispatch(initialState(), {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["a"], start: 0, end: 5, size: 5 },
    });
    const errored = dispatch(withLines, {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      error: "session_not_found",
    });
    const timeline = errored.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.status).toBe("error");
    expect(timeline?.error).toBe("session_not_found");
    expect(timeline?.lines).toEqual(["a"]); // last-good lines preserved, not cleared
  });
});
