// Reducer unit tests (DR-0005 §1): the reducer is the single place both
// WS-delivered protocol events and UI actions are folded into AppState. These
// tests exercise that fold directly (no WS, no DOM) — the whole point of
// making the reducer pure is that its contract is testable this way.
import { describe, expect, test } from "bun:test";
import type {
  DeliveredEvent,
  MemberEvent,
  RoomSummary,
  SessionSearchHit,
  TranscriptReadResponse,
} from "@ccmsg/protocol";
import {
  ADMIN_ID,
  type Action,
  type AppState,
  initialState,
  reducer,
  selectedRoomId,
  selectedSid,
} from "../src/client/store.ts";
import type { ProbeRecord } from "../src/client/llm-usage-view.ts";

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

// DR-0012: room archive flag. Mirrors the title event tests above ("last
// event wins", store folds the broadcast in) since ArchiveEvent follows the
// exact same last-wins convention as TitleEvent.
describe("reducer / protocol-event archive (DR-0012)", () => {
  test("archive event sets room.archived and appends to timeline", () => {
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "archive", archived: true, ts: "t", r: "r1" },
    });
    const room = state.rooms.get("r1");
    expect(room?.archived).toBe(true);
    expect(room?.timeline).toHaveLength(1);
  });

  // Last event wins (same rule as title, DR-0012 §1): a later archived:false
  // flips the room back, it doesn't merge/OR with the earlier true.
  test("a later archive:false event un-archives the room", () => {
    const archived = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "archive", archived: true, ts: "t1", r: "r1" },
    });
    const unarchived = dispatch(archived, {
      type: "protocol-event",
      event: { type: "archive", archived: false, ts: "t2", r: "r1" },
    });
    expect(unarchived.rooms.get("r1")?.archived).toBe(false);
    expect(unarchived.rooms.get("r1")?.timeline).toHaveLength(2);
  });
});

describe("reducer / rooms/loaded carries archived (DR-0012)", () => {
  test("a RoomSummary with archived:true seeds room.archived", () => {
    const summaries: RoomSummary[] = [
      { id: "r1", members: [], last_mid: 0, last_ts: null, archived: true },
    ];
    const state = dispatch(initialState(), { type: "rooms/loaded", rooms: summaries });
    expect(state.rooms.get("r1")?.archived).toBe(true);
  });

  // absent `archived` (older daemon, or a room that was never toggled) must
  // not force the field to false and shadow a value already folded in from
  // a prior rooms/loaded or protocol-event — same "if defined" merge as
  // summary.title's `if (summary.title) ...` guard just above in the reducer.
  test("a RoomSummary with no archived field leaves an already-known archived flag untouched", () => {
    const withArchive = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "archive", archived: true, ts: "t", r: "r1" },
    });
    const reloaded = dispatch(withArchive, {
      type: "rooms/loaded",
      rooms: [{ id: "r1", members: [], last_mid: 0, last_ts: null }],
    });
    expect(reloaded.rooms.get("r1")?.archived).toBe(true);
  });
});

describe("reducer / broadcast kind (DR-0013)", () => {
  // 何を保証するか (§4.4 + store.ts の applyProtocolEvent "kind" 分岐):
  // KindEvent が subscribe stream から届いたら room.kind が反映され、UI 側の
  // Composer variant / RoomList のバッジ判定が動く。timeline にも event が
  // 積まれるのは他 display-metadata event (archive / title) と同じ扱い。
  test("kind event sets room.kind to broadcast and appends to timeline", () => {
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "kind", kind: "broadcast", ts: "t", r: "r1" },
    });
    const room = state.rooms.get("r1");
    expect(room?.kind).toBe("broadcast");
    expect(room?.timeline).toHaveLength(1);
  });

  // 何を保証するか (§2.1 rooms 応答経由の初期反映): op:"rooms" 応答に
  // kind:"broadcast" が含まれていれば applyRoomsLoaded で room.kind が
  // "broadcast" になる。webui の初期 paint (ws.ts の onOpen 内の rooms fetch)
  // でここが動かないと reload 直後は kind バッジが出ない。
  test("rooms/loaded seeds room.kind from RoomSummary.kind", () => {
    const summaries: RoomSummary[] = [
      { id: "r1", members: [], last_mid: 0, last_ts: null, kind: "broadcast" },
    ];
    const state = dispatch(initialState(), { type: "rooms/loaded", rooms: summaries });
    expect(state.rooms.get("r1")?.kind).toBe("broadcast");
  });

  // 何を保証するか: kind が省略された RoomSummary は "normal" が既に入って
  // いれば触らない — archive/title 同型の "if defined" merge。broadcast だと
  // 分かった room が rooms/loaded の再取得で normal 扱いに戻る回帰を防ぐ。
  test("rooms/loaded with no kind field leaves an already-known kind untouched", () => {
    const withKind = dispatch(initialState(), {
      type: "protocol-event",
      event: { type: "kind", kind: "broadcast", ts: "t", r: "r1" },
    });
    const reloaded = dispatch(withKind, {
      type: "rooms/loaded",
      rooms: [{ id: "r1", members: [], last_mid: 0, last_ts: null }],
    });
    expect(reloaded.rooms.get("r1")?.kind).toBe("broadcast");
  });

  // 新規 room (create_room から subscribe stream で流れてくる初回 event 群) は
  // kind → member → msg の順で届く。newRoom の default が "normal" なので、
  // kind event が来る前に room が構築されていても kind 反映で上書きされる
  // 経路 (KindEvent が member より先着) を単に確認する。
  test("newRoom defaults to kind:'normal'", () => {
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: {
        type: "msg",
        mid: 1,
        from: "u1",
        ts: "t",
        msg: "hi",
        r: "r1",
      },
    });
    expect(state.rooms.get("r1")?.kind).toBe("normal");
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

describe("reducer / translator availability (DR-0023)", () => {
  test("replaces the host capability with the latest daemon probe result", () => {
    const available = dispatch(initialState(), { type: "translator/availability", host: true });
    expect(available.hostTranslatorAvailable).toBe(true);
    const unavailable = dispatch(available, { type: "translator/availability", host: false });
    expect(unavailable.hostTranslatorAvailable).toBe(false);
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

  // The `?from=` hint is the document a markdown link was followed from, and
  // the FileViewer's "did you mean" recovery is the only thing that reads it —
  // which means a break in this hop is invisible until a link 404s and the
  // suggestion silently fails to appear (kawaz r76 m45). Pin the hop.
  test("the source-document hint reaches the tree, and clears when absent", () => {
    const followed = dispatch(initialState(), {
      type: "locator/changed",
      locator: {
        view: "session",
        sid: "sess-1",
        path: "docs/packages/x.ts",
        from: "docs/QUESTIONS.md",
      },
    });
    expect(followed.sessionTrees.get("sess-1")?.selectedFrom).toBe("docs/QUESTIONS.md");

    // Selecting a file from the tree carries no hint; the previous document
    // must not linger and get credited for the next failure.
    const picked = dispatch(followed, {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: "docs/other.md" },
    });
    expect(picked.sessionTrees.get("sess-1")?.selectedFrom).toBeNull();
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

  // Auto-expanding the ancestors of a selected file must never undo what the
  // user opened by hand, so this action only ever adds.
  test("fs/dirs-expanded adds every path and keeps existing ones open", () => {
    const manual = dispatch(initialState(), {
      type: "fs/dir-toggled",
      sid: "sess-1",
      path: "docs",
    });
    const state = dispatch(manual, {
      type: "fs/dirs-expanded",
      sid: "sess-1",
      paths: ["src", "src/client", "docs"],
    });
    expect([...(state.sessionTrees.get("sess-1")?.expanded ?? [])].sort()).toEqual([
      "docs",
      "src",
      "src/client",
    ]);
  });

  test("fs/dirs-expanded returns the same state when nothing is new", () => {
    const opened = dispatch(initialState(), { type: "fs/dir-toggled", sid: "sess-1", path: "src" });
    const again = dispatch(opened, { type: "fs/dirs-expanded", sid: "sess-1", paths: ["src"] });
    expect(again).toBe(opened);
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
        mtime: "2026-07-20T00:00:00.000Z",
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

// The preview's task-list toggle writes the flipped source back into the
// cached response instead of refetching, so the view updates without the
// loading→loaded cycle that would remount the preview and lose scroll
// position (kawaz r55 m90).
describe("reducer / fs/file-patched", () => {
  const loaded = () =>
    dispatch(initialState(), {
      type: "fs/file-loaded",
      sid: "sess-1",
      path: "docs/QUESTIONS.md",
      response: {
        ok: true,
        sid: "sess-1",
        path: "docs/QUESTIONS.md",
        size: 8,
        truncated: false,
        binary: false,
        content: "- [ ] a\n",
        mtime: "2026-07-20T00:00:00.000Z",
      },
    });

  test("replaces the cached content, keeping status and the rest of the response", () => {
    const state = dispatch(loaded(), {
      type: "fs/file-patched",
      sid: "sess-1",
      path: "docs/QUESTIONS.md",
      content: "- [x] a\n",
    });
    const file = state.sessionTrees.get("sess-1")?.file;
    expect(file?.status).toBe("loaded");
    expect(file?.response?.content).toBe("- [x] a\n");
    // Lock tokens are deliberately untouched by a token-less patch: the write
    // was built on a fresh read that may hold edits this cache never saw, so
    // claiming its mtime would let the textarea editor clobber them.
    expect(file?.response?.mtime).toBe("2026-07-20T00:00:00.000Z");
    expect(file?.response?.size).toBe(8);
  });

  test("advances the lock tokens when the patch carries them", () => {
    const state = dispatch(loaded(), {
      type: "fs/file-patched",
      sid: "sess-1",
      path: "docs/QUESTIONS.md",
      content: "- [x] a\n",
      mtime: "2026-07-21T00:00:00.000Z",
      size: 9,
    });
    const response = state.sessionTrees.get("sess-1")?.file?.response;
    expect(response?.mtime).toBe("2026-07-21T00:00:00.000Z");
    expect(response?.size).toBe(9);
  });

  // A patch that arrives after the user navigated elsewhere must not
  // resurrect the old file or overwrite the new one's content.
  test("ignores a patch for a path that is no longer the cached file", () => {
    const before = loaded();
    const after = dispatch(before, {
      type: "fs/file-patched",
      sid: "sess-1",
      path: "docs/OTHER.md",
      content: "clobbered",
    });
    expect(after).toBe(before);
  });

  test("ignores a patch while the file is loading or errored", () => {
    const loading = dispatch(initialState(), {
      type: "fs/file-loading",
      sid: "sess-1",
      path: "docs/QUESTIONS.md",
    });
    expect(
      dispatch(loading, {
        type: "fs/file-patched",
        sid: "sess-1",
        path: "docs/QUESTIONS.md",
        content: "- [x] a\n",
      }),
    ).toBe(loading);
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

// U1: agents/loaded (initial op:"agents" fetch AND the pushed ev:"agents"
// stream event both fold in through this one action — see ws.ts) and
// daemon-info/loaded (a `ping` reply's provenance fields, for the footer).
describe("reducer / agents/loaded and daemon-info/loaded (U1)", () => {
  test("initial state has an empty agents list and no daemonInfo", () => {
    const state = initialState();
    expect(state.agents).toEqual([]);
    expect(state.daemonInfo).toBeNull();
  });

  test("agents/loaded replaces the agents list wholesale", () => {
    const first = dispatch(initialState(), {
      type: "agents/loaded",
      agents: [
        {
          pid: 1,
          cwd: "/repo",
          kind: "interactive",
          startedAt: 1,
          sessionId: "s1",
          config_dir: "/home/.claude",
        },
      ],
    });
    expect(first.agents).toHaveLength(1);
    // A later push with a different (e.g. shrunk) set replaces rather than
    // merges — the daemon's poll result is already the full merged list.
    const second = dispatch(first, { type: "agents/loaded", agents: [] });
    expect(second.agents).toEqual([]);
  });

  test("daemon-info/loaded stores version/exe/script for the footer", () => {
    const state = dispatch(initialState(), {
      type: "daemon-info/loaded",
      version: "0.19.0",
      exe: "/usr/local/bin/bun",
      script: "/repos/claude-ccmsg/main/packages/daemon/src/index.ts",
    });
    expect(state.daemonInfo).toEqual({
      version: "0.19.0",
      exe: "/usr/local/bin/bun",
      script: "/repos/claude-ccmsg/main/packages/daemon/src/index.ts",
    });
  });

  test("daemon-info/loaded tolerates a reply with no exe/script (older daemon)", () => {
    const state = dispatch(initialState(), { type: "daemon-info/loaded", version: "0.10.0" });
    expect(state.daemonInfo).toEqual({ version: "0.10.0", exe: undefined, script: undefined });
  });
});

// Sessions stopped on a harness API error: the one-shot op:"session_errors"
// reply and the pushed ev:"session_errors" stream event both fold in through
// this one action (same pairing as agents/loaded above, see ws.ts).
describe("reducer / session-errors/loaded", () => {
  test("initial state has an empty sessionErrors map", () => {
    expect(initialState().sessionErrors.size).toBe(0);
  });

  test("session-errors/loaded indexes the wire list by sid, dropping the sid from the value", () => {
    const state = dispatch(initialState(), {
      type: "session-errors/loaded",
      errors: [{ sid: "s1", text: "API Error: 500", timestamp: "2026-07-27T09:00:00Z" }],
    });
    expect(state.sessionErrors.get("s1")).toEqual({
      text: "API Error: 500",
      timestamp: "2026-07-27T09:00:00Z",
    });
  });

  // The daemon always sends the full list, so a session that recovered simply
  // stops appearing — replacing (not merging) is what makes it drop out.
  test("a later list replaces the map wholesale, so a recovered session drops out", () => {
    const first = dispatch(initialState(), {
      type: "session-errors/loaded",
      errors: [
        { sid: "s1", text: "API Error: 500", timestamp: "2026-07-27T09:00:00Z" },
        { sid: "s2", text: "Prompt is too long", timestamp: "2026-07-27T09:01:00Z" },
      ],
    });
    expect(first.sessionErrors.size).toBe(2);
    const second = dispatch(first, {
      type: "session-errors/loaded",
      errors: [{ sid: "s2", text: "Prompt is too long", timestamp: "2026-07-27T09:01:00Z" }],
    });
    expect([...second.sessionErrors.keys()]).toEqual(["s2"]);
  });

  test("an empty list clears every flagged session", () => {
    const first = dispatch(initialState(), {
      type: "session-errors/loaded",
      errors: [{ sid: "s1", text: "API Error: 500", timestamp: "2026-07-27T09:00:00Z" }],
    });
    expect(dispatch(first, { type: "session-errors/loaded", errors: [] }).sessionErrors.size).toBe(
      0,
    );
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

// timeline/tail (U2 live-tail addendum, DR-0009): folds a
// transcript_subscribe push (relayed verbatim by ws.ts's ev:"transcript"
// handler) into the cached TimelineState. The core contract under test is
// applyTimelineTail's contiguity guard — it must never splice a push at the
// wrong offset.
describe("reducer / timeline/tail (U2 live-tail addendum)", () => {
  function loaded(sid: string, res: TranscriptReadResponse): AppState {
    return dispatch(initialState(), {
      type: "timeline/loaded",
      sid,
      mode: "replace",
      response: res,
    });
  }

  // Core case: a tail push whose `start` exactly matches the cache's `end`
  // (the daemon's contiguity invariant, DR-0009 addendum) appends its lines
  // and moves both `end`/`size` forward — no reload needed for the live-tail
  // UI requirement ("リロード不要").
  test("contiguous push (start === cached end) appends lines and advances end/size", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a", "b"],
      start: 0,
      end: 100,
      size: 100,
    });
    const state = dispatch(initial, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["c"],
      start: 100,
      end: 130,
      size: 130,
    });
    const timeline = state.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["a", "b", "c"]);
    expect(timeline?.end).toBe(130);
    expect(timeline?.size).toBe(130);
    // start/atStart/status are untouched by a tail append (only the tail end
    // of the cache grows, the "load older" boundary doesn't move).
    expect(timeline?.start).toBe(0);
    expect(timeline?.status).toBe("loaded");
  });

  // Multiple contiguous pushes in a row (the common live-tail case: several
  // small batches as Claude Code appends lines) keep chaining correctly —
  // each push's `start` must line up with the *previous push's* `end`, not
  // just the original load's `end`.
  test("a second contiguous push chains onto the first push's new end", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 50,
      size: 50,
    });
    const afterFirst = dispatch(initial, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["b"],
      start: 50,
      end: 80,
      size: 80,
    });
    const afterSecond = dispatch(afterFirst, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["c"],
      start: 80,
      end: 120,
      size: 120,
    });
    const timeline = afterSecond.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["a", "b", "c"]);
    expect(timeline?.end).toBe(120);
  });

  // Non-contiguous push (a gap between cached `end` and the push's `start`,
  // e.g. a subscribe response racing an in-flight transcript_read, or a
  // "load older" page leaving `end` at a stale value) must be dropped rather
  // than spliced at the wrong offset — see applyTimelineTail's doc comment.
  // The cache's lines/end/size are left exactly as they were; `needsResync`
  // is the signal Timeline.tsx's resync effect uses to auto-recover (below),
  // not a "更新"-button-only recovery — see the applyTimelineTail
  // "non-contiguous push sets needsResync" test for that half.
  test("non-contiguous push (gap) is dropped, cache lines/end/size unchanged", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 50,
      size: 50,
    });
    const state = dispatch(initial, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["gap-skipped"],
      start: 999, // does not match cached end (50)
      end: 1050,
      size: 1050,
    });
    const timeline = state.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["a"]);
    expect(timeline?.end).toBe(50);
    expect(timeline?.size).toBe(50);
  });

  // Regression (adversarial review, store.ts major finding): a non-contiguous
  // push must not just silently drop forever — it flags `needsResync` so
  // Timeline.tsx's resync effect can issue a background transcript_read and
  // catch the cache back up, instead of live tail going permanently silent
  // until a manual "更新" click.
  test("non-contiguous push (gap) sets needsResync", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 50,
      size: 50,
    });
    const state = dispatch(initial, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["gap-skipped"],
      start: 999,
      end: 1050,
      size: 1050,
    });
    expect(state.sessionTrees.get("sess-1")?.timeline.needsResync).toBe(true);
  });

  // While needsResync is already flagged (a resync re-read is presumably
  // in flight), further non-contiguous pushes must not re-flag or otherwise
  // touch the cache — avoids re-triggering Timeline.tsx's resync effect on
  // every subsequent push before its own re-read lands.
  test("further pushes while needsResync is set are dropped without re-touching the cache", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 50,
      size: 50,
    });
    const afterGap = dispatch(initial, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["gap-skipped"],
      start: 999,
      end: 1050,
      size: 1050,
    });
    const afterSecondGap = dispatch(afterGap, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["still-skipped"],
      start: 2000,
      end: 2050,
      size: 2050,
    });
    const timeline = afterSecondGap.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["a"]);
    expect(timeline?.end).toBe(50);
    expect(timeline?.needsResync).toBe(true);
  });

  // A fresh `timeline/loaded` (the resync effect's background re-read
  // landing) must clear needsResync — applyTimelineLoaded constructs a
  // brand-new TimelineState literal rather than spreading `prev`, so a stale
  // `needsResync: true` can never survive into it.
  test("a subsequent timeline/loaded clears needsResync", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 50,
      size: 50,
    });
    const afterGap = dispatch(initial, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["gap-skipped"],
      start: 999,
      end: 1050,
      size: 1050,
    });
    expect(afterGap.sessionTrees.get("sess-1")?.timeline.needsResync).toBe(true);
    const resynced = dispatch(afterGap, {
      type: "timeline/loaded",
      sid: "sess-1",
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["a", "b"], start: 0, end: 1050, size: 1050 },
    });
    expect(resynced.sessionTrees.get("sess-1")?.timeline.needsResync).toBeUndefined();
    expect(resynced.sessionTrees.get("sess-1")?.timeline.lines).toEqual(["a", "b"]);
  });

  // A push for a sid whose TimelineState is still "idle" (never loaded yet —
  // e.g. transcript_subscribe's ack raced ahead of the initial
  // transcript_read) must not fabricate a cache out of just the tail lines;
  // the initial load's own "replace" is what establishes the real `start`.
  test("push while TimelineState is still idle (never loaded) is dropped", () => {
    const state = dispatch(initialState(), {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["too-early"],
      start: 0,
      end: 30,
      size: 30,
    });
    // Dropped before withSessionTree's copy-on-write even commits — no
    // sess-1 entry is fabricated in sessionTrees at all (applyTimelineTail
    // returns the untouched `state` on its early-return branch).
    expect(state.sessionTrees.has("sess-1")).toBe(false);
  });

  // A push while the cache is mid-"更新" (status:"loading", e.g. the refresh
  // button was just clicked) must also be dropped — the loading reload is
  // about to overwrite everything anyway, splicing onto stale lines here
  // would just be discarded seconds later, and worse, could resurrect data
  // that's about to be replaced with the wrong `end` bookkeeping.
  test("push while status is 'loading' (mid-refresh) is dropped", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 50,
      size: 50,
    });
    const loading = dispatch(initial, { type: "timeline/loading", sid: "sess-1" });
    const state = dispatch(loading, {
      type: "timeline/tail",
      sid: "sess-1",
      lines: ["b"],
      start: 50,
      end: 80,
      size: 80,
    });
    const timeline = state.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.status).toBe("loading");
    expect(timeline?.lines).toEqual(["a"]);
  });

  // A tail push for a sid that isn't the one currently loaded (e.g. a stale
  // subscription that outlived a session switch) must only affect that
  // sid's own tree, never bleed into an unrelated session's cache.
  test("push targets only its own sid's tree, unrelated sessions untouched", () => {
    const initial = loaded("sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["a"],
      start: 0,
      end: 50,
      size: 50,
    });
    const state = dispatch(initial, {
      type: "timeline/tail",
      sid: "sess-2",
      lines: ["b"],
      start: 0,
      end: 30,
      size: 30,
    });
    // sess-1 (loaded, but start !== 0 so this push wouldn't be contiguous
    // for it anyway) is untouched — the push targets sess-2, not sess-1.
    expect(state.sessionTrees.get("sess-1")?.timeline.lines).toEqual(["a"]);
    // sess-2 had no prior load (idle) so its push is dropped too, and no
    // sess-2 entry is fabricated — crucially, sess-1's tree is untouched by
    // it either way (proving the two trees don't bleed into each other).
    expect(state.sessionTrees.has("sess-2")).toBe(false);
    expect(state.sessionTrees.size).toBe(1);
  });
});

// timeline/evicted: App's SessionView LRU drops a session's whole view, and
// the transcript it cached in the store has no other release path — without
// this every distinct session ever opened leaves its lines resident for the
// lifetime of the tab. Everything else in the tree survives, because a revisit
// genuinely reuses it (the transcript, by contrast, is re-read wholesale on
// arrival regardless).
describe("reducer / timeline/evicted", () => {
  function loadedTree(sid: string, lines: string[]) {
    let state = dispatch(initialState(), { type: "fs/dir-toggled", sid, path: "src" });
    state = dispatch(state, {
      type: "fs/dir-loaded",
      sid,
      path: "src",
      entries: [{ name: "main.ts", type: "file" }],
    });
    return dispatch(state, {
      type: "timeline/loaded",
      sid,
      mode: "replace",
      response: { ok: true, sid, lines, start: 0, end: 10, size: 10 },
    });
  }

  test("drops the evicted session's transcript but keeps its file-browsing state", () => {
    const loaded = loadedTree("sess-1", ["a", "b"]);
    const state = dispatch(loaded, { type: "timeline/evicted", sids: ["sess-1"] });
    const tree = state.sessionTrees.get("sess-1");
    expect(tree?.timeline.lines).toEqual([]);
    // "idle", not "loaded" with empty lines: a revisit must take the same
    // first-visit load path as a session that was never opened.
    expect(tree?.timeline.status).toBe("idle");
    expect(tree?.dirs.get("src")).toEqual([{ name: "main.ts", type: "file" }]);
    expect(tree?.expanded.has("src")).toBe(true);
  });

  test("evicts only the named sessions", () => {
    let state = loadedTree("sess-1", ["a"]);
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-2",
      mode: "replace",
      response: { ok: true, sid: "sess-2", lines: ["b"], start: 0, end: 10, size: 10 },
    });
    const evicted = dispatch(state, { type: "timeline/evicted", sids: ["sess-1"] });
    expect(evicted.sessionTrees.get("sess-1")?.timeline.lines).toEqual([]);
    expect(evicted.sessionTrees.get("sess-2")?.timeline.lines).toEqual(["b"]);
  });

  test("evicting a session with nothing loaded changes nothing", () => {
    const state = loadedTree("sess-1", ["a"]);
    // Never-opened sid: absence in sessionTrees is meaningful, so no entry is
    // fabricated. Already-idle sid: no new state object for subscribers.
    const evicted = dispatch(state, { type: "timeline/evicted", sids: ["never-seen"] });
    expect(evicted).toBe(state);
    expect(evicted.sessionTrees.has("never-seen")).toBe(false);
    const twice = dispatch(dispatch(state, { type: "timeline/evicted", sids: ["sess-1"] }), {
      type: "timeline/evicted",
      sids: ["sess-1"],
    });
    expect(twice.sessionTrees.get("sess-1")?.timeline.status).toBe("idle");
  });
});

// selectedRoomId/selectedSid (kawaz 2026-07-12): the sidebar's RoomList and
// SessionList must highlight exactly the row the locator (state.view)
// currently points at, never a leftover id from a previously-visited view.
// `currentRoomId`/`currentSid` themselves are NOT cleared on a cross-view
// locator change (they keep backing per-view state like sessionTrees/anchor
// scroll independently of each other) — these selectors are the one place
// that derives "what's actually selected right now" from state.view, so
// RoomList/SessionList read active-ness through them instead of the raw
// fields directly.
describe("reducer / selectedRoomId and selectedSid (selection one-source-of-truth)", () => {
  test("room view: selectedRoomId is the room, selectedSid is null", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
    });
    expect(selectedRoomId(state)).toBe("r1");
    expect(selectedSid(state)).toBeNull();
  });

  test("session (Files) view: selectedSid is the sid, selectedRoomId is null", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: null },
    });
    expect(selectedSid(state)).toBe("sess-1");
    expect(selectedRoomId(state)).toBeNull();
  });

  test("timeline view: selectedSid is the sid (same as session view), selectedRoomId is null", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
    });
    expect(selectedSid(state)).toBe("sess-1");
    expect(selectedRoomId(state)).toBeNull();
  });

  // The regression this pins: selecting a session then a room used to leave
  // SessionList's row for that session still highlighted, because
  // currentSid was never cleared by the room-view branch of
  // applyLocatorChanged. selectedSid must reflect the *current* view, not
  // whatever sid was last visited.
  test("session -> room: selectedSid clears even though currentSid is still retained on state", () => {
    const onSession = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: null },
    });
    const onRoom = dispatch(onSession, {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
    });
    // currentSid itself is untouched (still backs sess-1's cached tree) ...
    expect(onRoom.currentSid).toBe("sess-1");
    // ... but the selector — what RoomList/SessionList must actually read —
    // reports no session selected while a room is the active view.
    expect(selectedSid(onRoom)).toBeNull();
    expect(selectedRoomId(onRoom)).toBe("r1");
  });

  // Symmetric case: room -> session leaves currentRoomId on state (so a
  // later back-to-room doesn't need a refetch) but selectedRoomId must
  // reflect the session view is now active, not the stale room.
  test("room -> session: selectedRoomId clears even though currentRoomId is still retained on state", () => {
    const onRoom = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
    });
    const onSession = dispatch(onRoom, {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: null },
    });
    expect(onSession.currentRoomId).toBe("r1");
    expect(selectedRoomId(onSession)).toBeNull();
    expect(selectedSid(onSession)).toBe("sess-1");
  });

  test("initial state (no locator applied yet): both selectors report nothing selected", () => {
    const state = initialState();
    expect(selectedRoomId(state)).toBeNull();
    expect(selectedSid(state)).toBeNull();
  });
});

// DR-0020 Phase 2: sessionStatuses cache lifecycle. `loaded` is always a full
// replace of the sid's snapshot (the daemon pushes whole recomputed snapshots,
// never deltas) and `cleared` drops the entry entirely — absence means "not
// subscribed", which SessionList's badge and Timeline's mini panel rely on to
// avoid rendering stale not-live data.
describe("reducer / session-status/loaded and session-status/cleared (DR-0020)", () => {
  const snapshotA = {
    todos: [{ id: "t1", subject: "fix bug", status: "in_progress" }],
    workflows: [],
    background: [],
    context: {
      tokens: 522_000,
      model: "claude-fable-5",
      timestamp: "2026-07-17T00:00:00.000Z",
    },
    teammates: [{ name: "worker-a", spawned: true, state: "active" }],
    external_files: [{ path: "/external/shared.md", origin: "tool" as const }],
  };
  const snapshotB = {
    todos: [],
    workflows: [
      { task_id: "w1", name: "release", status: "running", started_at: "2026-07-16T00:00:00.000Z" },
    ],
    background: [],
    teammates: [],
  };

  test("loaded stores the snapshot under its sid", () => {
    const state = dispatch(initialState(), {
      type: "session-status/loaded",
      sid: "sess-1",
      snapshot: snapshotA,
    });
    expect(state.sessionStatuses.get("sess-1")).toEqual(snapshotA);
  });

  test("loaded replaces (not merges) a prior snapshot for the same sid", () => {
    const first = dispatch(initialState(), {
      type: "session-status/loaded",
      sid: "sess-1",
      snapshot: snapshotA,
    });
    const second = dispatch(first, {
      type: "session-status/loaded",
      sid: "sess-1",
      snapshot: snapshotB,
    });
    // Full replace: snapshotA's todo must NOT survive alongside snapshotB's
    // workflow — the daemon's push is the complete recomputed state.
    expect(second.sessionStatuses.get("sess-1")).toEqual(snapshotB);
  });

  test("snapshots are keyed per sid — two sessions don't bleed into each other", () => {
    const one = dispatch(initialState(), {
      type: "session-status/loaded",
      sid: "sess-1",
      snapshot: snapshotA,
    });
    const two = dispatch(one, {
      type: "session-status/loaded",
      sid: "sess-2",
      snapshot: snapshotB,
    });
    expect(two.sessionStatuses.get("sess-1")).toEqual(snapshotA);
    expect(two.sessionStatuses.get("sess-2")).toEqual(snapshotB);
  });

  test("cleared removes the sid's entry (absence = not subscribed)", () => {
    const loaded = dispatch(initialState(), {
      type: "session-status/loaded",
      sid: "sess-1",
      snapshot: snapshotA,
    });
    const cleared = dispatch(loaded, { type: "session-status/cleared", sid: "sess-1" });
    expect(cleared.sessionStatuses.has("sess-1")).toBe(false);
  });

  test("cleared for an absent sid is a no-op returning the same state object", () => {
    const state = initialState();
    expect(dispatch(state, { type: "session-status/cleared", sid: "nope" })).toBe(state);
  });

  test("does not mutate the previous state (reducer purity)", () => {
    const before = initialState();
    dispatch(before, { type: "session-status/loaded", sid: "sess-1", snapshot: snapshotA });
    expect(before.sessionStatuses.size).toBe(0);
  });
});

describe("reducer / pinned/hydrated, pinned/added, pinned/removed (DR-0021 §2.4/§3.2)", () => {
  function hit(sid: string): SessionSearchHit {
    return {
      sid,
      config_dir: "/home/.claude",
      file: `/home/.claude/projects/x/${sid}.jsonl`,
      cwd: "/repos/claude-ccmsg/main",
      repo: "kawaz/claude-ccmsg",
      ws: "main",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
      size: 1024,
      matches: [],
      title: null,
    };
  }

  test("hydrated replaces pinnedSessions with the given hits, keyed by sid", () => {
    const state = dispatch(initialState(), {
      type: "pinned/hydrated",
      hits: [hit("a"), hit("b")],
    });
    expect(state.pinnedSessions.size).toBe(2);
    expect(state.pinnedSessions.get("a")).toEqual(hit("a"));
  });

  // A later hydrate is a full replace, not a merge — matches rooms/loaded's
  // own "the daemon's/localStorage's snapshot wins" convention.
  test("a later hydrated call fully replaces (not merges) the map", () => {
    const first = dispatch(initialState(), { type: "pinned/hydrated", hits: [hit("a")] });
    const second = dispatch(first, { type: "pinned/hydrated", hits: [hit("b")] });
    expect(second.pinnedSessions.has("a")).toBe(false);
    expect(second.pinnedSessions.has("b")).toBe(true);
  });

  test("added inserts a new pin", () => {
    const state = dispatch(initialState(), { type: "pinned/added", hit: hit("a") });
    expect(state.pinnedSessions.get("a")).toEqual(hit("a"));
  });

  test("added for an already-pinned sid replaces its cached metadata", () => {
    const first = dispatch(initialState(), { type: "pinned/added", hit: hit("a") });
    const refreshed = { ...hit("a"), size: 9999 };
    const second = dispatch(first, { type: "pinned/added", hit: refreshed });
    expect(second.pinnedSessions.get("a")?.size).toBe(9999);
  });

  test("removed deletes the sid's pin", () => {
    const pinned = dispatch(initialState(), { type: "pinned/added", hit: hit("a") });
    const removed = dispatch(pinned, { type: "pinned/removed", sid: "a" });
    expect(removed.pinnedSessions.has("a")).toBe(false);
  });

  test("removed for a sid that was never pinned is a no-op returning the same state object", () => {
    const state = initialState();
    expect(dispatch(state, { type: "pinned/removed", sid: "nope" })).toBe(state);
  });

  // The SessionView header button is one sid-keyed action: absent -> present,
  // then present -> absent, without requiring UI code to choose two reducers.
  test("toggled pins and then unpins the same sid", () => {
    const pinned = dispatch(initialState(), { type: "pinned/toggled", hit: hit("a") });
    expect(pinned.pinnedSessions.has("a")).toBe(true);
    const unpinned = dispatch(pinned, { type: "pinned/toggled", hit: hit("a") });
    expect(unpinned.pinnedSessions.has("a")).toBe(false);
  });

  // A fresh page load has no SessionTreeState yet. The first TL locator creates
  // one with the QUESTIONS.md label regexp ready to use, while keeping matching
  // case-insensitive because only regexp mode is part of the requested default.
  test("a newly opened Timeline starts with the label-search default", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "a" },
    });
    expect(state.sessionTrees.get("a")?.timelineSearch).toEqual({
      queryText: "👺\\s*[A-Za-z0-9α-ωΑ-Ω\\-]{2,}",
      caseSensitive: false,
      regex: true,
    });
  });

  // Timeline's SearchBar edits persist per sid: editing one session's in-view
  // query must create/update only that sid's tree and never leak into another
  // session's search state.
  test("timeline/search-changed stores per-sid search state", () => {
    const first = dispatch(initialState(), {
      type: "timeline/search-changed",
      sid: "a",
      search: { queryText: "foo", caseSensitive: true, regex: false },
    });
    const second = dispatch(first, {
      type: "timeline/search-changed",
      sid: "b",
      search: { queryText: "bar", caseSensitive: false, regex: true },
    });
    expect(second.sessionTrees.get("a")?.timelineSearch).toEqual({
      queryText: "foo",
      caseSensitive: true,
      regex: false,
    });
    expect(second.sessionTrees.get("b")?.timelineSearch).toEqual({
      queryText: "bar",
      caseSensitive: false,
      regex: true,
    });
  });

  // Opening a search result is deliberately not a pin operation: it caches the
  // historical hit and query handoff in the sid's session tree only.
  test("session-search/opened caches hit and Timeline search without pinning", () => {
    const state = dispatch(initialState(), {
      type: "session-search/opened",
      hit: hit("a"),
      search: { queryText: "foo\nbar", caseSensitive: true, regex: true },
    });
    expect(state.pinnedSessions.has("a")).toBe(false);
    expect(state.sessionTrees.get("a")?.searchHit).toEqual(hit("a"));
    expect(state.sessionTrees.get("a")?.timelineSearch).toEqual({
      queryText: "foo\nbar",
      caseSensitive: true,
      regex: true,
    });
  });

  test("does not mutate the previous state (reducer purity)", () => {
    const before = initialState();
    dispatch(before, { type: "pinned/added", hit: hit("a") });
    expect(before.pinnedSessions.size).toBe(0);
  });
});

// Subscribe stopped carrying every room's history (kawaz r99 m12), so the
// store now distinguishes "a room I know of" from "a room I have the events
// for". These tests pin both halves: what a listed-but-unfetched room does with
// events that reach it, and what marks it fetched.
describe("reducer / room history fetch state", () => {
  const listed = (): AppState =>
    dispatch(initialState(), {
      type: "rooms/loaded",
      rooms: [{ id: "r1", members: [], last_mid: 2, last_ts: null }],
    });

  test("a room from rooms/loaded starts unfetched", () => {
    expect(listed().rooms.get("r1")?.history).toBe("idle");
  });

  test("an unfetched room takes an event's metadata but not the event itself", () => {
    // The daemon's recent-replay pushes the last few minutes of msgs to a
    // subscriber with no cursor. Appending one to an empty timeline would put
    // it ahead of the older msgs a later room_history fetch delivers.
    const state = dispatch(listed(), {
      type: "protocol-event",
      event: { type: "msg", mid: 3, from: ADMIN_ID, ts: "t3", msg: "recent", r: "r1" },
    });
    const room = state.rooms.get("r1");
    expect(room?.timeline).toEqual([]);
    expect(room?.msgs.size).toBe(0);
    // ...but the sidebar's ordering/badge inputs still move.
    expect(room?.lastMid).toBe(3);
    expect(room?.lastTs).toBe("t3");
  });

  test("a title event on an unfetched room still renames it", () => {
    const state = dispatch(listed(), {
      type: "protocol-event",
      event: { type: "title", title: "renamed", ts: "t4", r: "r1" },
    });
    expect(state.rooms.get("r1")?.title).toBe("renamed");
    expect(state.rooms.get("r1")?.timeline).toEqual([]);
  });

  test("events fold normally once the fetch is in flight and after it lands", () => {
    // "loading" already folds: the fetched snapshot's own events arrive between
    // the request and its reply.
    const loading = dispatch(listed(), { type: "room-history/loading", room: "r1" });
    const withSnapshot = dispatch(loading, {
      type: "protocol-event",
      event: { type: "msg", mid: 1, from: ADMIN_ID, ts: "t1", msg: "old", r: "r1" },
    });
    expect(withSnapshot.rooms.get("r1")?.timeline).toHaveLength(1);

    const loaded = dispatch(withSnapshot, { type: "room-history/loaded", room: "r1" });
    expect(loaded.rooms.get("r1")?.history).toBe("loaded");
    const live = dispatch(loaded, {
      type: "protocol-event",
      event: { type: "msg", mid: 2, from: ADMIN_ID, ts: "t2", msg: "new", r: "r1" },
    });
    expect(live.rooms.get("r1")?.timeline).toHaveLength(2);
  });

  test("a failed fetch is recorded as an error, not as loaded", () => {
    const state = dispatch(dispatch(listed(), { type: "room-history/loading", room: "r1" }), {
      type: "room-history/loaded",
      room: "r1",
      error: "disconnected",
    });
    expect(state.rooms.get("r1")?.history).toBe("error");
  });

  test("a room the store has never seen folds its introductory snapshot as-is", () => {
    // create_room / invite deliver the new room's whole snapshot unprompted —
    // that IS its history, so there is nothing to fetch.
    const state = dispatch(initialState(), {
      type: "protocol-event",
      event: { ...member, r: "r-new" },
    });
    const room = state.rooms.get("r-new");
    expect(room?.history).toBe("loaded");
    expect(room?.timeline).toHaveLength(1);
  });

  test("rooms/history-reset drops the named rooms' events, keeping their metadata", () => {
    const loaded = dispatch(dispatch(listed(), { type: "room-history/loading", room: "r1" }), {
      type: "room-history/loaded",
      room: "r1",
    });
    const painted = dispatch(loaded, {
      type: "protocol-event",
      event: { type: "msg", mid: 1, from: ADMIN_ID, ts: "t1", msg: "old", r: "r1" },
    });
    const reset = dispatch(painted, { type: "rooms/history-reset", rooms: ["r1"] });
    const room = reset.rooms.get("r1");
    expect(room?.history).toBe("idle");
    expect(room?.timeline).toEqual([]);
    expect(room?.msgs.size).toBe(0);
    // metadata the `op:"rooms"` reply owns survives, so the sidebar row stays put
    expect(room?.lastMid).toBe(2);
  });
});

// Retained probe results. The gateway's cached document carries no limits, so
// what a `?refresh=true` probe found has to survive in the store or the screen
// loses it at the next poll.
describe("llm-usage/probed", () => {
  const record: ProbeRecord = {
    limits: [{ kind: "weekly_all", percent: 100, severity: "critical" }],
  };
  const failed: ProbeRecord = { limits: [], probeError: "429" };

  test("records what a probe found, keyed by credential", () => {
    const state = dispatch(initialState(), {
      type: "llm-usage/probed",
      records: new Map([["a", record]]),
    });
    expect(state.llmUsageProbes.get("a")).toEqual(record);
  });

  // A probe that failed for one credential still answered for the others, so
  // the ones it did not mention keep what they had.
  test("merges rather than replacing, leaving untouched credentials alone", () => {
    const first = dispatch(initialState(), {
      type: "llm-usage/probed",
      records: new Map([
        ["a", record],
        ["b", failed],
      ]),
    });
    const second = dispatch(first, {
      type: "llm-usage/probed",
      records: new Map([["b", record]]),
    });
    expect(second.llmUsageProbes.get("a")).toEqual(record);
    expect(second.llmUsageProbes.get("b")).toEqual(record);
  });

  // Every cached read produces an empty record set; treating that as "the
  // limits are gone" is exactly the bug retention exists to prevent.
  test("an empty result set leaves the state untouched", () => {
    const probed = dispatch(initialState(), {
      type: "llm-usage/probed",
      records: new Map([["a", record]]),
    });
    const after = dispatch(probed, { type: "llm-usage/probed", records: new Map() });
    expect(after).toBe(probed);
    expect(after.llmUsageProbes.get("a")).toEqual(record);
  });

  test("does not mutate the previous state's map", () => {
    const before = initialState();
    dispatch(before, { type: "llm-usage/probed", records: new Map([["a", record]]) });
    expect(before.llmUsageProbes.size).toBe(0);
  });
});

// ev:"llm_requests" carries every live conversation series, main and subagent
// alike. Only the main one drives a session's prompt-cache ring, and this
// reducer is where that selection happens — a subagent leaking through would
// restart the ring on traffic the session itself never issued.
describe("llm-requests/loaded", () => {
  const main = {
    ts: 1785564745,
    session_id: "s1",
    prefix: "484eda9c",
    main: true,
  };
  const subagent = {
    ts: 1785564900,
    session_id: "s1",
    prefix: "9c31aa02",
    main: false,
  };

  test("keeps the main series and drops the subagent one", () => {
    const after = dispatch(initialState(), {
      type: "llm-requests/loaded",
      requests: [main, subagent],
    });
    expect(after.llmRequests.size).toBe(1);
    // The newer subagent timestamp must NOT be what the session's ring reads.
    expect(after.llmRequests.get("s1")).toEqual(main);
  });

  test("indexes several sessions by sid", () => {
    const other = { ts: 1785564800, session_id: "s2", prefix: "484eda9c", main: true };
    const after = dispatch(initialState(), {
      type: "llm-requests/loaded",
      requests: [main, subagent, other],
    });
    expect([...after.llmRequests.keys()].sort()).toEqual(["s1", "s2"]);
  });

  test("a session with only subagent traffic gets no entry", () => {
    const after = dispatch(initialState(), {
      type: "llm-requests/loaded",
      requests: [subagent],
    });
    expect(after.llmRequests.size).toBe(0);
  });

  test("the set is replaced whole, so an expired window disappears", () => {
    const loaded = dispatch(initialState(), {
      type: "llm-requests/loaded",
      requests: [main],
    });
    const after = dispatch(loaded, { type: "llm-requests/loaded", requests: [] });
    expect(after.llmRequests.size).toBe(0);
  });
});

// フォームパネルの開閉。描画先が幅で変わる (デスクトップ = FormPane、スマホ =
// サイドバー内) ため状態は store が持ち、遷移そのものは sidebar-panel.ts の
// 純関数が決める (その排他の網羅は sidebar-panel.test.ts)。
describe("panel/toggled, panel/closed", () => {
  test("押した panel が開き、もう一度押すと閉じる", () => {
    const opened = dispatch(initialState(), { type: "panel/toggled", kind: "session-search" });
    expect(opened.activePanel).toEqual({ kind: "session-search" });
    expect(
      dispatch(opened, { type: "panel/toggled", kind: "session-search" }).activePanel,
    ).toBeNull();
  });

  test("別の panel を押すと入れ替わる (section をまたいでも 1 つだけ)", () => {
    const search = dispatch(initialState(), { type: "panel/toggled", kind: "session-search" });
    const room = dispatch(search, { type: "panel/toggled", kind: "room-creator" });
    expect(room.activePanel).toEqual({ kind: "room-creator" });
  });

  test("フォームの閉じるボタンはどの panel でも閉じる", () => {
    const opened = dispatch(initialState(), { type: "panel/toggled", kind: "session-creator" });
    expect(dispatch(opened, { type: "panel/closed" }).activePanel).toBeNull();
  });
});

// Timeline の「ここから fork」は launcher をその fork 元ごと開く要求そのもの。
// 中継用のフィールドを別に持たないので、「要求を消し忘れて古い fork 元が
// 蘇る」経路自体が無い。
describe("session-creator/prefill", () => {
  test("fork 要求は launcher を fork 元ごと開く", () => {
    const prefill = { resumeSid: "sid-1", resumeAt: "uuid-1" };
    const forked = dispatch(initialState(), { type: "session-creator/prefill", prefill });
    expect(forked.activePanel).toEqual({ kind: "session-creator", prefill });
  });

  test("fork 要求は開いていた別 panel を置き換える", () => {
    const searching = dispatch(initialState(), { type: "panel/toggled", kind: "session-search" });
    const prefill = { resumeSid: "sid-1", resumeAt: "uuid-1" };
    expect(dispatch(searching, { type: "session-creator/prefill", prefill }).activePanel).toEqual({
      kind: "session-creator",
      prefill,
    });
  });

  // fork で開いた launcher を閉じて「+ 新規」で開き直すと、前の fork 元
  // (と、そこから入る cwd/model/effort) は引き継がない。
  test("閉じて開き直した launcher は fork 元を引き継がない", () => {
    const prefill = { resumeSid: "sid-1", resumeAt: "uuid-1" };
    const forked = dispatch(initialState(), { type: "session-creator/prefill", prefill });
    const closed = dispatch(forked, { type: "panel/closed" });
    expect(
      dispatch(closed, { type: "panel/toggled", kind: "session-creator" }).activePanel,
    ).toEqual({ kind: "session-creator", prefill: null });
  });

  // hello 由来の capability。probe が終わるまで daemon は false を返すので、
  // 再接続で true に変わる経路がそのまま「後から有効になる」経路になる。
  test("fork availability follows the latest hello", () => {
    const on = dispatch(initialState(), { type: "fork/availability", available: true });
    expect(on.forkAvailable).toBe(true);
    expect(dispatch(on, { type: "fork/availability", available: false }).forkAvailable).toBe(false);
  });
});
