// The webui's pure parts of btw (DR-0060): where a btw sits in the Timeline
// (btw-slots.ts, §7), what the input box says of a btw comment it could not
// ask (§8), how the store holds the pushes (§5), and which rows of
// SESSIONS go to the Non-interactive fold (session-tree.ts, §11).
import { describe, expect, test } from "bun:test";
import type { AgentInfo, BtwRecord } from "@ccmsg/protocol";
import { btwSlots } from "../src/client/btw-slots.ts";
import { userPromptReasonDetail } from "../src/client/components/session-input.ts";
import { commentSendErrorDetail, sendResultText } from "../src/client/comment-view.ts";
import { splitInteractive } from "../src/client/session-tree.ts";
import { initialState, reducer } from "../src/client/store.ts";
import type { FoldEntries, ParsedLine, TimelineGroup } from "../src/client/transcript-model.ts";
import type { SessionRow } from "../src/client/utils.ts";

function turn(ts: string, uuid: string): ParsedLine {
  return { kind: "turn", ts, uuid, role: "user", segments: [] };
}

function entry(offset: number, line: ParsedLine): TimelineGroup {
  return { kind: "entry", offset, line };
}

function fold(...entries: FoldEntries): TimelineGroup {
  return { kind: "fold", entries };
}

function btw(id: string, ts: string, afterUuid?: string): BtwRecord {
  return {
    id,
    session_id: "s1",
    ts,
    ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}),
    prompt: "q",
    response: "",
    status: "done",
  };
}

const GROUPS: TimelineGroup[] = [
  entry(0, turn("2026-11-22T10:00:00.000Z", "u-1")),
  fold(
    { offset: 10, line: turn("2026-11-22T10:05:00.000Z", "u-2") },
    {
      offset: 20,
      line: {
        kind: "meta",
        ts: "2026-11-22T10:06:00.000Z",
        uuid: "m-3",
        type: "system",
        summary: "",
        raw: "",
      },
    },
  ),
  entry(30, turn("2026-11-22T10:10:00.000Z", "u-4")),
];

const ids = (slots: BtwRecord[][]) => slots.map((slot) => slot.map((b) => b.id));

describe("btwSlots: a btw after its anchor's item", () => {
  test("right after the item holding the anchor row, a fold's inner row and a meta row included", () => {
    const slots = btwSlots(
      GROUPS,
      [
        btw("a", "2026-11-22T12:00:00.000Z", "u-1"),
        btw("b", "2026-11-22T12:00:00.000Z", "m-3"),
        btw("c", "2026-11-22T12:00:00.000Z", "u-4"),
      ],
      false,
    );
    expect(ids(slots)).toEqual([[], ["a"], ["b"], ["c"]]);
  });

  test("the anchor's time does not matter: a btw asked late still sits after its anchor", () => {
    const slots = btwSlots(GROUPS, [btw("late", "2026-11-23T00:00:00.000Z", "u-2")], false);
    expect(ids(slots)).toEqual([[], [], ["late"], []]);
  });

  test("several at one anchor, oldest first", () => {
    const slots = btwSlots(
      GROUPS,
      [btw("y", "2026-11-22T12:00:02.000Z", "u-1"), btw("x", "2026-11-22T12:00:01.000Z", "u-1")],
      false,
    );
    expect(ids(slots)[1]).toEqual(["x", "y"]);
  });

  test("an anchor the window does not hold, with a time inside the window: at its time", () => {
    const slots = btwSlots(GROUPS, [btw("gone", "2026-11-22T10:07:00.000Z", "compacted")], false);
    expect(ids(slots)).toEqual([[], [], ["gone"], []]);
  });

  test("older than a window that does not start at the file's start: not drawn until its place is loaded", () => {
    const old = btw("old", "2026-11-22T09:00:00.000Z", "u-0");
    expect(ids(btwSlots(GROUPS, [old], false)).flat()).toEqual([]);
    // From the file's start, nothing is older than the window: at the top.
    expect(ids(btwSlots(GROUPS, [old], true))).toEqual([["old"], [], [], []]);
  });

  test("a btw asked before any row (no anchor) is placed by its time", () => {
    const slots = btwSlots(GROUPS, [btw("first", "2026-11-22T09:00:00.000Z")], true);
    expect(ids(slots)).toEqual([["first"], [], [], []]);
  });
});

describe("the input box's btw", () => {
  // btw のコメントの fork を起こせなかった理由は、何をすればよいかと一緒に出る。
  // 起こした・空きを待つ結果は何も言わない。
  test("a btw comment's fork not started says why; started or waiting says nothing", () => {
    expect(commentSendErrorDetail("project_auto_mode_unreadable")).toContain("設定を直してから");
    expect(commentSendErrorDetail("btw_launch_unavailable")).toContain("起動コマンド");
    expect(commentSendErrorDetail("no_module")).toBe(userPromptReasonDetail("no_module"));
    for (const outcome of ["btw_started", "btw_waiting"] as const) {
      expect(sendResultText({ kind: "comment", id: "c0001", outcome })).toBeNull();
    }
  });
});

describe("the store's btws", () => {
  test("a session's set replaces what was held of it; one btw replaces its id", () => {
    let state = reducer(initialState(), {
      type: "btws/loaded",
      sid: "s1",
      btws: [btw("a", "t1"), btw("b", "t2")],
    });
    state = reducer(state, {
      type: "btw/changed",
      btw: { ...btw("a", "t1"), response: "答え" },
    });
    state = reducer(state, { type: "btw/changed", btw: btw("c", "t3") });
    expect([...(state.btws.get("s1")?.values() ?? [])].map((b) => [b.id, b.response])).toEqual([
      ["a", "答え"],
      ["b", ""],
      ["c", ""],
    ]);
    state = reducer(state, { type: "btws/loaded", sid: "s1", btws: [] });
    expect(state.btws.get("s1")?.size).toBe(0);
  });
});

describe("splitInteractive: the rows SESSIONS puts apart", () => {
  const agent = (entrypoint: string | undefined): AgentInfo => ({
    pid: 1,
    cwd: "/w",
    kind: "interactive",
    startedAt: 0,
    sessionId: "x",
    config_dir: "/c",
    ...(entrypoint !== undefined ? { entrypoint } : {}),
  });
  const row = (sid: string, entrypoint?: string, withAgent = true): SessionRow => ({
    sid,
    repo: "",
    ws: "",
    cwd: "/w",
    connected: true,
    ...(withAgent ? { agent: agent(entrypoint) } : {}),
  });

  test("claude -p and the SDKs go apart; the person's, unknown entrypoints and rows without an agents row stay", () => {
    const { interactive, nonInteractive } = splitInteractive([
      row("cli", "cli"),
      row("p", "sdk-cli"),
      row("ts", "sdk-ts"),
      row("py", "sdk-py"),
      row("desktop", "claude-desktop"),
      row("none", undefined),
      row("peer-only", undefined, false),
    ]);
    expect(interactive.map((r) => r.sid)).toEqual(["cli", "desktop", "none", "peer-only"]);
    expect(nonInteractive.map((r) => r.sid)).toEqual(["p", "ts", "py"]);
  });
});
