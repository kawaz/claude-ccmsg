// Reducer unit tests (DR-0005 §1): the reducer is the single place both
// WS-delivered protocol events and UI actions are folded into AppState. These
// tests exercise that fold directly (no WS, no DOM) — the whole point of
// making the reducer pure is that its contract is testable this way.
import { describe, expect, test } from "bun:test";
import type {
  MemberEvent,
  RoomSummary,
  SayRecord,
  SessionSearchHit,
  StorageEvent,
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
import type { Pin } from "../src/client/pinned-sessions.ts";
import { CLOSED_SIDEBAR, parseSidebarUrl } from "../src/client/sidebar-url.ts";
import type { Locator } from "../src/client/locator.ts";
import { nextRequestGeneration } from "../src/client/request-generation.ts";

function dispatch(state: AppState, action: Action): AppState {
  return reducer(state, action);
}

type Answer<T extends Action["type"]> = Omit<
  Extract<Action, { type: T }>,
  "type" | "sid" | "generation"
>;

/** A transcript_read for `sid` asked and answered: the request the reducer
 * records, then the answer carrying the same generation. */
function readTranscript(state: AppState, sid: string, answer: Answer<"timeline/loaded">): AppState {
  const generation = nextRequestGeneration();
  const asked = dispatch(state, { type: "timeline/loading", sid, generation });
  return dispatch(asked, { type: "timeline/loaded", sid, generation, ...answer });
}

/** An `after` read asked and answered: started as a resync, so the cache
 * stays loaded while it is in flight (useTranscriptLoader). */
function appendTranscript(
  state: AppState,
  sid: string,
  response: TranscriptReadResponse,
): AppState {
  const generation = nextRequestGeneration();
  const asked = dispatch(state, { type: "timeline/resyncing", sid, generation });
  return dispatch(asked, { type: "timeline/loaded", sid, generation, mode: "append", response });
}

/** An fs_read of `path` asked and answered, as readTranscript. */
function readFile(
  state: AppState,
  sid: string,
  path: string,
  answer: Omit<Answer<"fs/file-loaded">, "path">,
): AppState {
  const generation = nextRequestGeneration();
  const asked = dispatch(state, { type: "fs/file-loading", sid, path, generation });
  return dispatch(asked, { type: "fs/file-loaded", sid, path, generation, ...answer });
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
  // The `rooms` reply seeds every room's metadata and present members in one
  // shot, when the sidebar's room fold is first opened.
  test("creates rooms with members from RoomSummary[]", () => {
    const summaries: RoomSummary[] = [
      {
        id: "r1",
        title: "hello",
        members: [member],
        last_mid: 3,
        last_ts: "2026-07-09T00:01:00.000Z",
        archived: true,
        kind: "broadcast",
      },
    ];
    const state = dispatch(initialState(), { type: "rooms/loaded", rooms: summaries });
    const room = state.rooms.get("r1");
    expect(room?.title).toBe("hello");
    expect(room?.lastMid).toBe(3);
    expect(room?.lastTs).toBe("2026-07-09T00:01:00.000Z");
    expect(room?.archived).toBe(true);
    expect(room?.kind).toBe("broadcast");
    expect(room?.membersById.get("a1")?.repo).toBe("kawaz/claude-ccmsg");
    expect(room?.membersById.get("a1")?.left).toBe(false);
    expect(room?.memberOrder).toEqual(["a1"]);
    expect(room?.history).toBe("idle");
    expect(state.roomList).toBe("loaded");
  });

  test("an absent kind is a normal room", () => {
    const state = dispatch(initialState(), {
      type: "rooms/loaded",
      rooms: [{ id: "r1", members: [], last_mid: 0, last_ts: null }],
    });
    expect(state.rooms.get("r1")?.kind).toBe("normal");
  });

  // A room already opened was folded from its whole log, which knows
  // everything a summary says; the summary must not overwrite it (it would
  // drop the left members the log keeps).
  test("leaves a room whose log is already loaded as the log folded it", () => {
    const opened = dispatch(initialState(), {
      type: "room-history/loaded",
      room: "r1",
      events: [member, { type: "leave", id: "a1", ts: "2026-07-09T00:02:00.000Z" }],
    });
    const listed = dispatch(opened, {
      type: "rooms/loaded",
      rooms: [{ id: "r1", title: "other", members: [], last_mid: 0, last_ts: null }],
    });
    expect(listed.rooms.get("r1")).toBe(opened.rooms.get("r1"));
  });

  test("does not mutate the previous state (reducer purity)", () => {
    const before = initialState();
    const summaries: RoomSummary[] = [{ id: "r1", members: [], last_mid: 0, last_ts: null }];
    const after = dispatch(before, { type: "rooms/loaded", rooms: summaries });
    expect(before.rooms.size).toBe(0);
    expect(after.rooms.size).toBe(1);
    expect(after).not.toBe(before);
  });

  test("rooms/loading and rooms/failed move only the list's status", () => {
    const loading = dispatch(initialState(), { type: "rooms/loading" });
    expect(loading.roomList).toBe("loading");
    const failed = dispatch(loading, { type: "rooms/failed" });
    expect(failed.roomList).toBe("error");
    expect(failed.rooms.size).toBe(0);
  });
});

describe("reducer / room-history/loaded folds the whole log", () => {
  const log = (events: StorageEvent[]): AppState =>
    dispatch(initialState(), { type: "room-history/loaded", room: "r1", events });

  test("msgs go to the timeline and msgs by mid; lastMid and lastTs follow the log", () => {
    const state = log([
      member,
      { type: "msg", mid: 5, from: ADMIN_ID, ts: "t1", msg: "a" },
      { type: "msg", mid: 2, from: "a1", ts: "t2", msg: "b" },
    ]);
    const room = state.rooms.get("r1");
    expect(room?.history).toBe("loaded");
    expect(room?.msgs.get(5)?.msg).toBe("a");
    expect(room?.msgs.get(2)?.msg).toBe("b");
    expect(room?.timeline.map((ev) => ev.type)).toEqual(["member", "msg", "msg"]);
    expect(room?.lastMid).toBe(5);
    expect(room?.lastTs).toBe("t2");
  });

  // A log can hold the same msg twice (two daemons appended to one file); the
  // view shows it once.
  test("a mid seen twice keeps its first line", () => {
    const first = { type: "msg" as const, mid: 1, from: ADMIN_ID, ts: "t1", msg: "first" };
    const room = log([first, { ...first, ts: "t2", msg: "again" }]).rooms.get("r1");
    expect(room?.timeline).toEqual([first]);
    expect(room?.msgs.get(1)).toEqual(first);
  });

  test("leave flips left without removing the member (history preserved)", () => {
    const room = log([member, { type: "leave", id: "a1", ts: "t2" }]).rooms.get("r1");
    expect(room?.membersById.get("a1")?.left).toBe(true);
    expect(room?.memberOrder).toEqual(["a1"]);
    expect(room?.timeline).toHaveLength(2);
  });

  test("a leave for an unknown id changes no member but keeps its line", () => {
    const room = log([{ type: "leave", id: "a99", ts: "t" }]).rooms.get("r1");
    expect(room?.membersById.has("a99")).toBe(false);
    expect(room?.timeline).toHaveLength(1);
  });

  // title / archive / kind are last-wins, and each keeps
  // its line in the timeline.
  test("title, archive and kind take the log's last value", () => {
    const room = log([
      { type: "title", title: "first", ts: "t1" },
      { type: "kind", kind: "broadcast", ts: "t2" },
      { type: "archive", archived: true, ts: "t3" },
      { type: "title", title: "renamed", ts: "t4" },
      { type: "archive", archived: false, ts: "t5" },
    ]).rooms.get("r1");
    expect(room?.title).toBe("renamed");
    expect(room?.archived).toBe(false);
    expect(room?.kind).toBe("broadcast");
    expect(room?.timeline).toHaveLength(5);
  });

  test("next / prev are lines that change no other room state", () => {
    const room = log([
      { type: "prev", room: "r0", ts: "t1" },
      { type: "next", room: "r2", ts: "t2" },
    ]).rooms.get("r1");
    expect(room?.timeline).toHaveLength(2);
    expect(room?.lastMid).toBe(0);
    expect(room?.kind).toBe("normal");
  });

  // A 1on1 room's say rows show as bubbles; the ack is state, not
  // conversation, so it adds no line. The daemon's own says stay apart.
  test("a 1on1 room's say joins its timeline, its say_read adds no line, says stay apart", () => {
    const say: StorageEvent = {
      type: "say",
      sid: "sid-abcdefgh",
      text: "hi",
      ts: "2026-08-31T00:00:00.000Z",
      seq: 7,
    };
    const state = log([say, { type: "say_read", ref: 7, ts: "2026-08-31T00:00:01.000Z", seq: 8 }]);
    expect(state.rooms.get("r1")?.timeline).toEqual([say]);
    expect(state.rooms.get("r1")?.lastTs).toBe("2026-08-31T00:00:01.000Z");
    expect(state.says).toEqual([]);
  });
});

describe("reducer / says (DR-0036 §3)", () => {
  const record = (id: string, read: boolean): SayRecord => ({
    id,
    sid: "sid-abcdefgh",
    text: `say ${id}`,
    ts: "2026-08-31T00:00:00.000Z",
    read,
  });

  // 輪郭: ev:"says" は daemon が持つ全件なので、置き換える (merge しない)。
  // 再起動した daemon の空の全件で、前の daemon の say (未読含む) が消える。
  test("says/loaded replaces the whole set", () => {
    let state = dispatch(initialState(), {
      type: "says/loaded",
      says: [record("i/1", false), record("i/2", false)],
    });
    expect(state.says.map((r) => r.id)).toEqual(["i/1", "i/2"]);
    state = dispatch(state, { type: "says/loaded", says: [record("i/1", true)] });
    expect(state.says).toEqual([record("i/1", true)]);
    state = dispatch(state, { type: "says/loaded", says: [] });
    expect(state.says).toEqual([]);
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
  test("sets currentRoomId + currentMid", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: 4 },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(state.view).toBe("room");
    expect(state.currentRoomId).toBe("r1");
    expect(state.currentMid).toBe(4);
  });

  test("room-only locator (#rXXXX, no message anchor) leaves currentMid null", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
      sidebar: CLOSED_SIDEBAR,
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
      sidebar: CLOSED_SIDEBAR,
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
      sidebar: CLOSED_SIDEBAR,
    });
    expect(state.sessionTrees.get("sess-1")?.selectedPath).toBe("src/index.ts");
    expect(state.sessionTrees.has("sess-2")).toBe(false);
  });

  // The `?from=` hint is the document a markdown link was followed from, and
  // the FileViewer's "did you mean" recovery is the only thing that reads it —
  // which means a break in this hop is invisible until a link 404s and the
  // suggestion silently fails to appear. Pin the hop.
  test("the source-document hint reaches the tree, and clears when absent", () => {
    const followed = dispatch(initialState(), {
      type: "locator/changed",
      sidebar: CLOSED_SIDEBAR,
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
      sidebar: CLOSED_SIDEBAR,
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
      sidebar: CLOSED_SIDEBAR,
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
        sidebar: CLOSED_SIDEBAR,
      }),
      {
        type: "locator/changed",
        locator: { view: "session", sid: "sess-1", path: null },
        sidebar: CLOSED_SIDEBAR,
      },
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
      generation: nextRequestGeneration(),
    });
    const file = state.sessionTrees.get("sess-1")?.file;
    expect(file?.status).toBe("loading");
    expect(file?.path).toBe("README.md");
  });

  test("fs/file-loaded (success) stores the FsReadResponse and flips status to loaded", () => {
    const state = readFile(initialState(), "sess-1", "README.md", {
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
    const state = readFile(initialState(), "sess-1", "secret.env", { error: "path_forbidden" });
    const file = state.sessionTrees.get("sess-1")?.file;
    expect(file?.status).toBe("error");
    expect(file?.error).toBe("path_forbidden");
    expect(file?.response).toBeUndefined();
  });
});

// The preview's task-list toggle writes the flipped source back into the
// cached response instead of refetching, so the view updates without the
// loading→loaded cycle that would remount the preview and lose scroll
// position.
describe("reducer / fs/file-patched", () => {
  const loaded = () =>
    readFile(initialState(), "sess-1", "docs/QUESTIONS.md", {
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
      generation: nextRequestGeneration(),
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

describe("reducer / peers/loaded and sidebar/set", () => {
  test("peers/loaded replaces the peers list", () => {
    const state = dispatch(initialState(), {
      type: "peers/loaded",
      peers: [{ sid: "s1", repo: "r", ws: "w", cwd: "/c" }],
    });
    expect(state.peers).toHaveLength(1);
  });

  // 既定は「在る」。消すのはハンバーガーを押した時だけ。
  test("既定は在る、sidebar/set で消せる", () => {
    expect(initialState().sidebarOpen).toBe(true);
    expect(dispatch(initialState(), { type: "sidebar/set", open: false }).sidebarOpen).toBe(false);
  });
});

// サイドバーは「在る / 無い」だけで、遷移では動かない。
// 押し出し方式では本文がサイドバーに隠れないので、セッションを選んだから
// 引っ込める、という理由が無くなった。
describe("reducer / locator/changed (サイドバーは遷移で動かない)", () => {
  const atRoom = (state: AppState, sidebar = CLOSED_SIDEBAR) =>
    dispatch(state, {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
      sidebar,
    });

  test("行き先が変わっても在るまま", () => {
    const moved = dispatch(atRoom(initialState()), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "s1", position: "head" },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(moved.sidebarOpen).toBe(true);
  });

  test("消してあれば遷移で勝手に出てこない", () => {
    const hidden = dispatch(initialState(), { type: "sidebar/set", open: false });
    const moved = dispatch(hidden, {
      type: "locator/changed",
      locator: { view: "timeline", sid: "s1", position: "head" },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(moved.sidebarOpen).toBe(false);
  });

  // フォームの開閉は path を変えず `sb.*` だけが変わる遷移。ここでも動かない。
  test("パネルの開閉でも動かない", () => {
    const opened = dispatch(atRoom(initialState()), {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
      sidebar: parseSidebarUrl("?sb.panel=new"),
    });
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

  // 常設の行に出るのは version だけ。exe は hover の title に回るので
  // state には残す (App.tsx の footer)。
  test("daemon-info/loaded stores version/exe for the footer", () => {
    const state = dispatch(initialState(), {
      type: "daemon-info/loaded",
      version: "0.19.0",
      exe: "/usr/local/bin/bun",
    });
    expect(state.daemonInfo).toEqual({ version: "0.19.0", exe: "/usr/local/bin/bun" });
  });

  test("daemon-info/loaded tolerates a reply with no exe (older daemon)", () => {
    const state = dispatch(initialState(), { type: "daemon-info/loaded", version: "0.10.0" });
    expect(state.daemonInfo).toEqual({ version: "0.10.0", exe: undefined });
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

  // A session whose hooks module sends facts has its error classified by
  // Claude Code (DR-0035 §3); the sidebar's hover shows the kind.
  test("the kind of a module's error is kept", () => {
    const state = dispatch(initialState(), {
      type: "session-errors/loaded",
      errors: [
        {
          sid: "s1",
          text: "API Error: 429",
          timestamp: "2026-10-14T00:00:00Z",
          kind: "rate_limit",
        },
      ],
    });
    expect(state.sessionErrors.get("s1")).toEqual({
      text: "API Error: 429",
      timestamp: "2026-10-14T00:00:00Z",
      kind: "rate_limit",
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
  // happens here (that's useTranscriptLoader's job), the reducer only records
  // what's selected, same division of labor as the session/Files form.
  test("#t<sid> switches view to 'timeline', sets currentSid, creates an idle timeline cache", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(state.view).toBe("timeline");
    expect(state.currentSid).toBe("sess-1");
    const tree = state.sessionTrees.get("sess-1");
    expect(tree).toBeDefined();
    expect(tree?.timeline.status).toBe("idle");
    expect(tree?.timeline.lines).toEqual([]);
  });

  // The position is the URL's (`/timeline/<uuid>`, or the tail when absent),
  // and stops being one the moment the URL leaves the Timeline — the Timeline
  // reads "head" then, the same as it would from the location itself.
  test("records the selected position while the URL is a Timeline, and null otherwise", () => {
    const pinned = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1", position: "u-7" },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(pinned.timelinePosition).toBe("u-7");

    const tail = dispatch(pinned, {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(tail.timelinePosition).toBe("head");

    const leaving: Locator[] = [
      { view: "session", sid: "sess-1", path: null },
      { view: "room", room: "r1", mid: null },
      { view: "usage", tab: "quota" },
      { view: "catalog" },
      { view: "unknown", pathname: "/nope" },
    ];
    for (const locator of leaving) {
      const state = dispatch(pinned, { type: "locator/changed", locator, sidebar: CLOSED_SIDEBAR });
      expect(state.timelinePosition).toBeNull();
    }
  });

  // Revisiting a session's timeline (e.g. Files -> Timeline -> Files ->
  // Timeline) must not discard already-loaded lines — same non-refetch
  // guarantee store.test.ts already pins for the Files tree above.
  test("navigating away and back to a session's timeline preserves its loaded lines", () => {
    const visited = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
      sidebar: CLOSED_SIDEBAR,
    });
    const res: TranscriptReadResponse = {
      ok: true,
      sid: "sess-1",
      lines: ['{"type":"user"}'],
      start: 0,
      end: 20,
      size: 20,
    };
    const loaded = readTranscript(visited, "sess-1", { mode: "replace", response: res });
    const awayAndBack = dispatch(
      dispatch(loaded, {
        type: "locator/changed",
        locator: { view: "room", room: "r1", mid: null },
        sidebar: CLOSED_SIDEBAR,
      }),
      {
        type: "locator/changed",
        locator: { view: "timeline", sid: "sess-1" },
        sidebar: CLOSED_SIDEBAR,
      },
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
        sidebar: CLOSED_SIDEBAR,
      }),
      { type: "fs/dir-loaded", sid: "sess-1", path: "", entries: [{ name: "src", type: "dir" }] },
    );
    const toTimeline = dispatch(filesLoaded, {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(toTimeline.sessionTrees.get("sess-1")?.dirs.get("")).toEqual([
      { name: "src", type: "dir" },
    ]);
  });
});

describe("reducer / timeline/loading and timeline/loaded (DR-0009)", () => {
  test("timeline/loading sets status 'loading' and clears any prior error", () => {
    const errored = readTranscript(initialState(), "sess-1", {
      mode: "replace",
      error: "session_not_found",
    });
    const loading = dispatch(errored, {
      type: "timeline/loading",
      sid: "sess-1",
      generation: nextRequestGeneration(),
    });
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
    const generation = nextRequestGeneration();
    const asked = dispatch(initialState(), { type: "timeline/loading", sid: "sess-1", generation });
    const state = dispatch(asked, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation,
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
      generation,
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
    const state = readTranscript(initialState(), "sess-1", { mode: "replace", response: res });
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
    const afterInitial = readTranscript(initialState(), "sess-1", {
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
    const afterOlder = readTranscript(afterInitial, "sess-1", { mode: "prepend", response: older });
    const timeline = afterOlder.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["older-1", "older-2", "tail-1", "tail-2"]);
    expect(timeline?.start).toBe(20);
    expect(timeline?.end).toBe(200); // unchanged from the initial (tail) load
    expect(timeline?.atStart).toBe(false);
  });

  // Prepending a page whose own `start` is 0 reaches the true beginning of
  // the transcript — atStart must flip true so the "older" button disables.
  test("timeline/loaded (prepend) reaching start:0 sets atStart true", () => {
    const afterInitial = readTranscript(initialState(), "sess-1", {
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["tail"], start: 50, end: 100, size: 100 },
    });
    const afterOlder = readTranscript(afterInitial, "sess-1", {
      mode: "prepend",
      response: { ok: true, sid: "sess-1", lines: ["first"], start: 0, end: 50, size: 100 },
    });
    expect(afterOlder.sessionTrees.get("sess-1")?.timeline.atStart).toBe(true);
  });

  // "append" mode (an `after` read from the cache's `end`): what was written
  // since goes BEHIND what's cached; `start` and atStart stay where older
  // pages put them, `end` and `size` move on.
  test("timeline/loaded (append) adds the lines behind the cache, moves end, keeps start", () => {
    const afterInitial = readTranscript(initialState(), "sess-1", {
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["tail"], start: 0, end: 100, size: 100 },
    });
    const appended = appendTranscript(afterInitial, "sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["new-1", "new-2"],
      start: 100,
      end: 180,
      size: 200,
    });
    const timeline = appended.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["tail", "new-1", "new-2"]);
    expect(timeline?.start).toBe(0);
    expect(timeline?.atStart).toBe(true);
    expect(timeline?.end).toBe(180);
    expect(timeline?.size).toBe(200);
  });

  // A live-tail push moved `end` while the read was in flight: the answer no
  // longer starts where the cache stops. It is not spliced; a resync reads
  // again from the new end.
  test("timeline/loaded (append) that does not start at the cached end flags a resync", () => {
    const afterInitial = readTranscript(initialState(), "sess-1", {
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["tail"], start: 0, end: 100, size: 100 },
    });
    const appended = appendTranscript(afterInitial, "sess-1", {
      ok: true,
      sid: "sess-1",
      lines: ["x"],
      start: 50,
      end: 120,
      size: 120,
    });
    const timeline = appended.sessionTrees.get("sess-1")?.timeline;
    expect(timeline?.lines).toEqual(["tail"]);
    expect(timeline?.end).toBe(100);
    expect(timeline?.needsResync).toBe(true);
  });

  test("timeline/loaded (error) flips status to error and records the message, does not touch lines", () => {
    const withLines = readTranscript(initialState(), "sess-1", {
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["a"], start: 0, end: 5, size: 5 },
    });
    const errored = readTranscript(withLines, "sess-1", {
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
    return readTranscript(initialState(), sid, { mode: "replace", response: res });
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
  // is the signal useTranscriptLoader's resync effect uses to auto-recover (below),
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
  // useTranscriptLoader's resync effect can issue a background transcript_read and
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
  // touch the cache — avoids re-triggering useTranscriptLoader's resync effect on
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
    const generation = nextRequestGeneration();
    const resyncing = dispatch(afterGap, { type: "timeline/resyncing", sid: "sess-1", generation });
    const resynced = dispatch(resyncing, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation,
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
    const loading = dispatch(initial, {
      type: "timeline/loading",
      sid: "sess-1",
      generation: nextRequestGeneration(),
    });
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
    return readTranscript(state, sid, {
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
    state = readTranscript(state, "sess-2", {
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

// Responses answer the request that was current when they were sent. A
// response that lands after a newer request for the same slot (a switch to
// another agent, another file, a refetch) is stale and must not overwrite what
// the newer request is filling in, whichever order the daemon answers in.
// Source: docs/findings/2026-10-14-webui-hooks-review-react-guidance.md (high 3, 4).
describe("reducer / stale responses are ignored", () => {
  const transcript = (lines: string[], end: number): TranscriptReadResponse => ({
    ok: true,
    sid: "sess-1",
    lines,
    start: 0,
    end,
    size: end,
  });
  const timelineAt = (agentId: string | null): Action => ({
    type: "locator/changed",
    locator:
      agentId === null
        ? { view: "timeline", sid: "sess-1" }
        : { view: "timeline", sid: "sess-1", agent: { agentId } },
    sidebar: CLOSED_SIDEBAR,
  });

  test("agent A's transcript answering after a switch to agent B does not land on B", () => {
    let state = dispatch(initialState(), timelineAt("agent-a"));
    state = dispatch(state, { type: "timeline/loading", sid: "sess-1", generation: 1 });
    state = dispatch(state, timelineAt("agent-b"));
    state = dispatch(state, { type: "timeline/loading", sid: "sess-1", generation: 2 });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 1,
      mode: "replace",
      response: transcript(["from-a"], 10),
    });
    expect(state.sessionTrees.get("sess-1")?.timeline.status).toBe("loading");
    expect(state.sessionTrees.get("sess-1")?.timeline.lines).toEqual([]);
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 2,
      mode: "replace",
      response: transcript(["from-b"], 20),
    });
    expect(state.sessionTrees.get("sess-1")?.timeline.lines).toEqual(["from-b"]);
  });

  test("agent A's transcript answering after B already landed does not replace B", () => {
    let state = dispatch(initialState(), timelineAt("agent-a"));
    state = dispatch(state, { type: "timeline/loading", sid: "sess-1", generation: 1 });
    state = dispatch(state, timelineAt("agent-b"));
    state = dispatch(state, { type: "timeline/loading", sid: "sess-1", generation: 2 });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 2,
      mode: "replace",
      response: transcript(["from-b"], 20),
    });
    const settled = state;
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 1,
      mode: "replace",
      response: transcript(["from-a"], 10),
    });
    expect(state).toBe(settled);
  });

  test("an older page answering after a newer refresh does not splice into the refreshed cache", () => {
    let state = dispatch(initialState(), {
      type: "timeline/loading",
      sid: "sess-1",
      generation: 1,
    });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 1,
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["tail"], start: 50, end: 100, size: 100 },
    });
    state = dispatch(state, { type: "timeline/loading", sid: "sess-1", generation: 2 });
    state = dispatch(state, { type: "timeline/loading", sid: "sess-1", generation: 3 });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 3,
      mode: "replace",
      response: { ok: true, sid: "sess-1", lines: ["new-tail"], start: 60, end: 120, size: 120 },
    });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 2,
      mode: "prepend",
      response: { ok: true, sid: "sess-1", lines: ["older"], start: 0, end: 50, size: 100 },
    });
    expect(state.sessionTrees.get("sess-1")?.timeline.lines).toEqual(["new-tail"]);
    expect(state.sessionTrees.get("sess-1")?.timeline.start).toBe(60);
  });

  test("a transcript answering after its session was evicted does not refill the cache", () => {
    let state = dispatch(initialState(), {
      type: "timeline/loading",
      sid: "sess-1",
      generation: 1,
    });
    state = dispatch(state, { type: "timeline/evicted", sids: ["sess-1"] });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 1,
      mode: "replace",
      response: transcript(["evicted"], 10),
    });
    expect(state.sessionTrees.get("sess-1")?.timeline.status).toBe("idle");
    expect(state.sessionTrees.get("sess-1")?.timeline.lines).toEqual([]);
  });

  // The resync re-read keeps the pane on screen (no "loading"), but it is
  // still a request: a refresh issued after it supersedes it.
  test("a background resync superseded by a refresh does not land", () => {
    let state = dispatch(initialState(), {
      type: "timeline/loading",
      sid: "sess-1",
      generation: 1,
    });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 1,
      mode: "replace",
      response: transcript(["a"], 50),
    });
    state = dispatch(state, { type: "timeline/resyncing", sid: "sess-1", generation: 2 });
    expect(state.sessionTrees.get("sess-1")?.timeline.status).toBe("loaded");
    state = dispatch(state, { type: "timeline/loading", sid: "sess-1", generation: 3 });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 3,
      mode: "replace",
      response: transcript(["a", "b", "c"], 90),
    });
    state = dispatch(state, {
      type: "timeline/loaded",
      sid: "sess-1",
      generation: 2,
      mode: "replace",
      response: transcript(["a", "b"], 70),
    });
    expect(state.sessionTrees.get("sess-1")?.timeline.lines).toEqual(["a", "b", "c"]);
  });

  const fileResponse = (path: string, content: string) => ({
    ok: true as const,
    sid: "sess-1",
    path,
    size: content.length,
    truncated: false,
    binary: false,
    content,
    mtime: "2026-10-14T00:00:00.000Z",
  });

  test("file A answering after a switch to file B does not replace B", () => {
    let state = dispatch(initialState(), {
      type: "fs/file-loading",
      sid: "sess-1",
      path: "a.md",
      generation: 1,
    });
    state = dispatch(state, {
      type: "fs/file-loading",
      sid: "sess-1",
      path: "b.md",
      generation: 2,
    });
    state = dispatch(state, {
      type: "fs/file-loaded",
      sid: "sess-1",
      path: "a.md",
      generation: 1,
      response: fileResponse("a.md", "A"),
    });
    expect(state.sessionTrees.get("sess-1")?.file?.path).toBe("b.md");
    expect(state.sessionTrees.get("sess-1")?.file?.status).toBe("loading");
    state = dispatch(state, {
      type: "fs/file-loaded",
      sid: "sess-1",
      path: "b.md",
      generation: 2,
      response: fileResponse("b.md", "B"),
    });
    expect(state.sessionTrees.get("sess-1")?.file?.response?.content).toBe("B");
  });

  test("an earlier read of the same file answering after a refetch does not roll it back", () => {
    let state = dispatch(initialState(), {
      type: "fs/file-loading",
      sid: "sess-1",
      path: "a.md",
      generation: 1,
    });
    state = dispatch(state, {
      type: "fs/file-loading",
      sid: "sess-1",
      path: "a.md",
      generation: 2,
    });
    state = dispatch(state, {
      type: "fs/file-loaded",
      sid: "sess-1",
      path: "a.md",
      generation: 2,
      response: fileResponse("a.md", "fresh"),
    });
    state = dispatch(state, {
      type: "fs/file-loaded",
      sid: "sess-1",
      path: "a.md",
      generation: 1,
      response: fileResponse("a.md", "stale"),
    });
    expect(state.sessionTrees.get("sess-1")?.file?.response?.content).toBe("fresh");
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
      sidebar: CLOSED_SIDEBAR,
    });
    expect(selectedRoomId(state)).toBe("r1");
    expect(selectedSid(state)).toBeNull();
  });

  test("session (Files) view: selectedSid is the sid, selectedRoomId is null", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: null },
      sidebar: CLOSED_SIDEBAR,
    });
    expect(selectedSid(state)).toBe("sess-1");
    expect(selectedRoomId(state)).toBeNull();
  });

  test("timeline view: selectedSid is the sid (same as session view), selectedRoomId is null", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sess-1" },
      sidebar: CLOSED_SIDEBAR,
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
      sidebar: CLOSED_SIDEBAR,
    });
    const onRoom = dispatch(onSession, {
      type: "locator/changed",
      locator: { view: "room", room: "r1", mid: null },
      sidebar: CLOSED_SIDEBAR,
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
      sidebar: CLOSED_SIDEBAR,
    });
    const onSession = dispatch(onRoom, {
      type: "locator/changed",
      locator: { view: "session", sid: "sess-1", path: null },
      sidebar: CLOSED_SIDEBAR,
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
  // Pins are keyed by the session's cwd; each fixture sid gets its own
  // directory so the sid-level cases below stay one pin per sid.
  function dir(sid: string): string {
    return `/repos/${sid}`;
  }

  function hit(sid: string): SessionSearchHit {
    return {
      sid,
      config_dir: "/home/.claude",
      file: `/home/.claude/projects/x/${sid}.jsonl`,
      cwd: dir(sid),
      repo: "kawaz/claude-ccmsg",
      ws: "main",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
      size: 1024,
      matches: [],
      title: null,
    };
  }

  function pin(sid: string): Pin {
    return {
      sid,
      cwd: dir(sid),
      repo: "kawaz/claude-ccmsg",
      ws: "main",
      title: null,
      file: `/home/.claude/projects/x/${sid}.jsonl`,
      updated_at: "2026-07-15T00:00:00.000Z",
    };
  }

  test("hydrated replaces pinnedSessions with the given pins, keyed by cwd", () => {
    const state = dispatch(initialState(), {
      type: "pinned/hydrated",
      pins: [pin("a"), pin("b")],
    });
    expect(state.pinnedSessions.size).toBe(2);
    expect(state.pinnedSessions.get(dir("a"))).toEqual(pin("a"));
  });

  // A later hydrate is a full replace, not a merge — matches rooms/loaded's
  // own "the daemon's/localStorage's snapshot wins" convention.
  test("a later hydrated call fully replaces (not merges) the map", () => {
    const first = dispatch(initialState(), { type: "pinned/hydrated", pins: [pin("a")] });
    const second = dispatch(first, { type: "pinned/hydrated", pins: [pin("b")] });
    expect(second.pinnedSessions.has(dir("a"))).toBe(false);
    expect(second.pinnedSessions.has(dir("b"))).toBe(true);
  });

  test("added inserts a new pin", () => {
    const state = dispatch(initialState(), { type: "pinned/added", pin: pin("a") });
    expect(state.pinnedSessions.get(dir("a"))).toEqual(pin("a"));
  });

  test("added for an already-pinned sid replaces its cached metadata", () => {
    const first = dispatch(initialState(), { type: "pinned/added", pin: pin("a") });
    const refreshed = { ...pin("a"), title: "更新" };
    const second = dispatch(first, { type: "pinned/added", pin: refreshed });
    expect(second.pinnedSessions.get(dir("a"))?.title).toBe("更新");
  });

  test("removed deletes the sid's pin", () => {
    const pinned = dispatch(initialState(), { type: "pinned/added", pin: pin("a") });
    const removed = dispatch(pinned, { type: "pinned/removed", key: dir("a") });
    expect(removed.pinnedSessions.has(dir("a"))).toBe(false);
  });

  test("removed for a sid that was never pinned is a no-op returning the same state object", () => {
    const state = initialState();
    expect(dispatch(state, { type: "pinned/removed", key: dir("nope") })).toBe(state);
  });

  // A pin is a snapshot of what was known when it was made, and a session that
  // announced `ws` but no `repo` used to leave one that printed the half pair
  // for good — including once the session went offline, which is precisely
  // when a pin is the only record left. A connected session is the authority
  // on its own repo/ws, so peers/loaded repairs the record.
  test("peers/loaded fills in a pin whose stored repo/ws is worse than its live peer's", () => {
    const pinned = dispatch(initialState(), {
      type: "pinned/added",
      pin: { ...pin("a"), repo: null, ws: "wip-issue-board" },
    });
    const state = dispatch(pinned, {
      type: "peers/loaded",
      peers: [{ sid: "a", repo: "kawaz/claude-ccmsg", ws: "wip-issue-board", cwd: "/repos/wip" }],
    });
    expect(state.pinnedSessions.get(dir("a"))).toEqual({
      ...pin("a"),
      repo: "kawaz/claude-ccmsg",
      ws: "wip-issue-board",
    });
  });

  // Only repo/ws are repaired: the rest of the record is what the pin captured
  // (its title, its transcript, when it was last written), not a re-pin.
  test("peers/loaded leaves every other field of the pin untouched", () => {
    const stored = { ...pin("a"), repo: null, ws: null, title: "Issue管理", file: "/kept.jsonl" };
    const pinned = dispatch(initialState(), { type: "pinned/added", pin: stored });
    const state = dispatch(pinned, {
      type: "peers/loaded",
      peers: [{ sid: "a", repo: "kawaz/claude-ccmsg", ws: "main", cwd: "/repos/other" }],
    });
    expect(state.pinnedSessions.get(dir("a"))).toEqual({
      ...stored,
      repo: "kawaz/claude-ccmsg",
      ws: "main",
    });
  });

  // main.tsx writes localStorage whenever this Map's identity changes, and
  // peers/loaded fires on every connect/disconnect — a rewrite per event that
  // stores identical bytes is what returning the same Map avoids.
  test("peers/loaded keeps the same pinnedSessions Map when nothing needs repair", () => {
    const pinned = dispatch(initialState(), { type: "pinned/added", pin: pin("a") });
    const state = dispatch(pinned, {
      type: "peers/loaded",
      peers: [
        { sid: "a", repo: "kawaz/claude-ccmsg", ws: "main", cwd: "/repos/claude-ccmsg/main" },
      ],
    });
    expect(state.pinnedSessions).toBe(pinned.pinnedSessions);
  });

  // A peer that announced neither (and whose cwd the daemon could not resolve)
  // is not a better source: replacing the pair with two empty strings would
  // erase a label the pin legitimately holds.
  test("peers/loaded does not blank a pin from a peer that has neither repo nor ws", () => {
    const pinned = dispatch(initialState(), { type: "pinned/added", pin: pin("a") });
    const state = dispatch(pinned, {
      type: "peers/loaded",
      peers: [{ sid: "a", repo: "", ws: "", cwd: "/repos/claude-ccmsg/main" }],
    });
    expect(state.pinnedSessions).toBe(pinned.pinnedSessions);
    expect(state.pinnedSessions.get(dir("a"))).toEqual(pin("a"));
  });

  // Peers of sessions that were never pinned are just the peers list.
  test("peers/loaded ignores peers with no pin of their own", () => {
    const pinned = dispatch(initialState(), { type: "pinned/added", pin: pin("a") });
    const state = dispatch(pinned, {
      type: "peers/loaded",
      peers: [{ sid: "b", repo: "kawaz/other", ws: "main", cwd: "/repos/other/main" }],
    });
    expect(state.pinnedSessions).toBe(pinned.pinnedSessions);
    expect(state.peers).toHaveLength(1);
  });

  // Titles arrive on the agents stream, not with peers: `claude agents --json`
  // reports what /rename set as the session's `name`. Same repair, same
  // same-Map contract as peers/loaded.
  test("agents/loaded writes a renamed session's title into its pin", () => {
    const pinned = dispatch(initialState(), {
      type: "pinned/added",
      pin: { ...pin("a"), title: "古いタイトル" },
    });
    const state = dispatch(pinned, {
      type: "agents/loaded",
      agents: [
        {
          pid: 1,
          cwd: "/repo",
          kind: "interactive",
          startedAt: 1,
          sessionId: "a",
          name: "Issue管理",
          config_dir: "/home/.claude",
        },
      ],
    });
    expect(state.pinnedSessions.get(dir("a"))).toEqual({ ...pin("a"), title: "Issue管理" });
  });

  test("agents/loaded keeps the same pinnedSessions Map when no title changed", () => {
    const pinned = dispatch(initialState(), {
      type: "pinned/added",
      pin: { ...pin("a"), title: "Issue管理" },
    });
    const state = dispatch(pinned, {
      type: "agents/loaded",
      agents: [
        {
          pid: 1,
          cwd: "/repo",
          kind: "interactive",
          startedAt: 1,
          sessionId: "a",
          name: "Issue管理",
          config_dir: "/home/.claude",
        },
      ],
    });
    expect(state.pinnedSessions).toBe(pinned.pinnedSessions);
  });

  // The SessionView header button is one sid-keyed action: absent -> present,
  // then present -> absent, without requiring UI code to choose two reducers.
  test("toggled pins and then unpins the same sid", () => {
    const pinned = dispatch(initialState(), { type: "pinned/toggled", pin: pin("a") });
    expect(pinned.pinnedSessions.has(dir("a"))).toBe(true);
    const unpinned = dispatch(pinned, { type: "pinned/toggled", pin: pin("a") });
    expect(unpinned.pinnedSessions.has(dir("a"))).toBe(false);
  });

  // A fresh page load has no SessionTreeState yet. The first TL locator creates
  // one with the QUESTIONS.md label regexp ready to use, while keeping matching
  // case-insensitive because only regexp mode is part of the requested default.
  test("a newly opened Timeline starts with the label-search default", () => {
    const state = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "a" },
      sidebar: CLOSED_SIDEBAR,
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
    expect(state.pinnedSessions.has(dir("a"))).toBe(false);
    expect(state.sessionTrees.get("a")?.searchHit).toEqual(hit("a"));
    expect(state.sessionTrees.get("a")?.timelineSearch).toEqual({
      queryText: "foo\nbar",
      caseSensitive: true,
      regex: true,
    });
  });

  // The successor of a handed-over session runs in the same directory under a
  // new sid; its pin button acts on the directory's existing pin.
  test("toggled with a different sid in a pinned directory unpins the directory", () => {
    const pinned = dispatch(initialState(), { type: "pinned/toggled", pin: pin("a") });
    const unpinned = dispatch(pinned, {
      type: "pinned/toggled",
      pin: { ...pin("successor"), cwd: dir("a") },
    });
    expect(unpinned.pinnedSessions.size).toBe(0);
  });

  // Stored records from when pins were per sid can hold several sessions of
  // one directory; hydration keeps the most recently updated one per cwd.
  test("hydrated collapses stored pins sharing a cwd", () => {
    const older = { ...pin("old"), cwd: dir("a"), updated_at: "2026-07-01T00:00:00.000Z" };
    const newer = { ...pin("new"), cwd: dir("a"), updated_at: "2026-07-20T00:00:00.000Z" };
    const state = dispatch(initialState(), {
      type: "pinned/hydrated",
      pins: [older, newer],
    });
    expect([...state.pinnedSessions.entries()]).toEqual([[dir("a"), newer]]);
  });

  test("does not mutate the previous state (reducer purity)", () => {
    const before = initialState();
    dispatch(before, { type: "pinned/added", pin: pin("a") });
    expect(before.pinnedSessions.size).toBe(0);
  });
});

// Subscribe stopped carrying every room's history, so the
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

  test("loading, then the log replaces the room with its fold", () => {
    const loading = dispatch(listed(), { type: "room-history/loading", room: "r1" });
    expect(loading.rooms.get("r1")?.history).toBe("loading");
    const loaded = dispatch(loading, {
      type: "room-history/loaded",
      room: "r1",
      events: [{ type: "msg", mid: 1, from: ADMIN_ID, ts: "t1", msg: "old" }],
    });
    const room = loaded.rooms.get("r1");
    expect(room?.history).toBe("loaded");
    expect(room?.timeline).toHaveLength(1);
    expect(room?.lastMid).toBe(1);
  });

  test("a room never listed can be fetched directly (a link to it)", () => {
    const loading = dispatch(initialState(), { type: "room-history/loading", room: "r9" });
    expect(loading.rooms.get("r9")?.history).toBe("loading");
  });

  test("a failed fetch is recorded as an error, not as loaded", () => {
    const state = dispatch(dispatch(listed(), { type: "room-history/loading", room: "r1" }), {
      type: "room-history/failed",
      room: "r1",
      missing: false,
    });
    expect(state.rooms.get("r1")?.history).toBe("error");
    expect(state.missingTarget).toBeNull();
  });

  // The room on screen turned out not to exist: the view shows the 404 a gone
  // session gets. A room fetched while another view is on screen does not.
  test("room_not_found for the room on screen is the room's 404", () => {
    const onScreen = dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "room", room: "r9", mid: null },
      sidebar: CLOSED_SIDEBAR,
    });
    const gone = dispatch(onScreen, { type: "room-history/failed", room: "r9", missing: true });
    expect(gone.rooms.get("r9")?.history).toBe("missing");
    expect(gone.missingTarget).toEqual({ kind: "room", id: "r9" });

    const elsewhere = dispatch(initialState(), {
      type: "room-history/failed",
      room: "r9",
      missing: true,
    });
    expect(elsewhere.missingTarget).toBeNull();
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

// The upstream service report reaches the store two ways — the answer to
// `llm_status`, and the daemon's push after a 529 — and both fold through one
// action. The capability action beside it is what makes the strip and the
// header badge exist at all.
describe("llm-status", () => {
  const report = {
    overall: { severity: "critical" as const, service_counts: { critical: 1 } },
    services: [
      { id: "anthropic", name: "Anthropic", severity: "critical" as const, routes: ["claude-a"] },
    ],
  };

  test("holds the report whichever way it arrived", () => {
    const after = dispatch(initialState(), { type: "llm-status/loaded", report });
    expect(after.llmStatus).toEqual(report);
  });

  test("replaces the report whole, so a recovered service stops being listed", () => {
    const loaded = dispatch(initialState(), { type: "llm-status/loaded", report });
    const after = dispatch(loaded, {
      type: "llm-status/loaded",
      report: { overall: { severity: "ok", service_counts: { ok: 1 } }, services: [] },
    });
    expect(after.llmStatus?.services).toEqual([]);
    expect(after.llmStatus?.overall.severity).toBe("ok");
  });

  // A daemon that no longer has a status endpoint has no report either, and a
  // badge nobody can clear is worse than no badge.
  test("losing the capability clears the report", () => {
    const loaded = dispatch(
      dispatch(initialState(), { type: "llm-status/availability", available: true }),
      { type: "llm-status/loaded", report },
    );
    expect(loaded.llmStatusAvailable).toBe(true);
    const after = dispatch(loaded, { type: "llm-status/availability", available: false });
    expect(after.llmStatusAvailable).toBe(false);
    expect(after.llmStatus).toBeNull();
  });

  // Re-announcing the same capability on a reconnect must not blank a report
  // the push already delivered.
  test("keeping the capability keeps the report", () => {
    const loaded = dispatch(initialState(), { type: "llm-status/loaded", report });
    const after = dispatch(loaded, { type: "llm-status/availability", available: true });
    expect(after.llmStatus).toEqual(report);
  });
});

// フォームパネルの開閉。状態の正本は URL の `sb.*` (sidebar-url.ts) で、
// store はそれを読み直した結果を持つだけ — 開閉も「遷移」なので、reducer に
// 入ってくる経路は locator/changed 一本きり。文法そのものの網羅は
// sidebar-url.test.ts、遷移で `sb.*` が引き継がれるかは navigation.test.ts。
describe("locator/changed の sb.* 反映", () => {
  const at = (search: string) =>
    dispatch(initialState(), {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sid-1" },
      sidebar: parseSidebarUrl(search),
    });

  test("sb.panel が開いている panel を決める", () => {
    expect(at("?sb.panel=search").sidebar.panel).toBe("session-search");
    expect(at("?sb.panel=new").sidebar.panel).toBe("session-creator");
    expect(at("").sidebar.panel).toBeNull();
  });

  test("fork のリンクは launcher を fork 元ごと開く", () => {
    const state = at(
      "?sb.panel=new&sb.resume=sid-9&sb.resume_session_at=uuid-1&sb.fork_session=true",
    );
    expect(state.sidebar.panel).toBe("session-creator");
    expect(state.sidebar.launch).toEqual({
      resume: "sid-9",
      resume_session_at: "uuid-1",
      fork_session: "true",
    });
  });

  // 「+ 新規」が組む URL は `sb.panel=new` だけ。前に fork で開いていても、
  // その `sb.*` は URL から消えている = 古い fork 元は蘇りようがない。
  test("「+ 新規」で開き直した launcher は fork 元を引き継がない", () => {
    const forked = at(
      "?sb.panel=new&sb.resume=sid-9&sb.resume_session_at=uuid-1&sb.fork_session=true",
    );
    const plain = dispatch(forked, {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sid-1" },
      sidebar: parseSidebarUrl("?sb.panel=new"),
    });
    expect(plain.sidebar.launch).toEqual({});
  });

  // 同値なら参照を据え置く。ランチャーを開いたまま別セッションへ移っても、
  // フォームの seed をやり直させないため (SessionCreator の effect の依存)。
  test("sb.* が同じなら sidebar の参照は変わらない", () => {
    const opened = at("?sb.panel=new&sb.cwd=/repos/app");
    const moved = dispatch(opened, {
      type: "locator/changed",
      locator: { view: "timeline", sid: "sid-2" },
      sidebar: parseSidebarUrl("?sb.panel=new&sb.cwd=/repos/app"),
    });
    expect(moved.sidebar).toBe(opened.sidebar);
    expect(moved.currentSid).toBe("sid-2");
  });
});

describe("peers/sort-key", () => {
  test("並び順は store が持つ (一覧と RoomCreator が同じ順で並ぶ)", () => {
    expect(initialState().peerSortKey).toBe("prompt");
    expect(dispatch(initialState(), { type: "peers/sort-key", key: "name" }).peerSortKey).toBe(
      "name",
    );
  });
});

describe("launch availability", () => {
  // hello 由来の capability。daemon の launcher 設定が変わって再接続すれば
  // 値も入れ替わる。
  test("launch availability follows the latest hello", () => {
    const on = dispatch(initialState(), { type: "launch/availability", available: true });
    expect(on.launchAvailable).toBe(true);
    expect(dispatch(on, { type: "launch/availability", available: false }).launchAvailable).toBe(
      false,
    );
  });
});

// 再接続のたびに同じ不一致が再検出される。導線は立ちっぱなしでよいので、
// 同じ中身なら state 自体を据え置いて再描画を起こさない。
describe("version-mismatch/detected", () => {
  test("同じ不一致を再検出しても state は変わらない", () => {
    const mismatch = { daemonVersion: "0.137.0" };
    const first = reducer(initialState(), { type: "version-mismatch/detected", mismatch });
    expect(first.versionMismatch).toEqual(mismatch);
    expect(reducer(first, { type: "version-mismatch/detected", mismatch: { ...mismatch } })).toBe(
      first,
    );
  });

  test("version が上がれば差し替わり、解消すれば消える", () => {
    const first = reducer(initialState(), {
      type: "version-mismatch/detected",
      mismatch: { daemonVersion: "0.137.0" },
    });
    const next = reducer(first, {
      type: "version-mismatch/detected",
      mismatch: { daemonVersion: "0.138.0" },
    });
    expect(next.versionMismatch?.daemonVersion).toBe("0.138.0");
    expect(
      reducer(next, { type: "version-mismatch/detected", mismatch: null }).versionMismatch,
    ).toBeNull();
  });
});
