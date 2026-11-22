// The webui's pure parts of btw (DR-0060): where a btw sits in the Timeline
// (btw-slots.ts, §7), what the input box's effort offers and says for it
// (btw-input.ts, §8), how the store holds the pushes (§5), and which rows of
// SESSIONS go to the Non-interactive fold (session-tree.ts, §11).
import { describe, expect, test } from "bun:test";
import type { AgentInfo, BtwRecord, ErrorResponse } from "@ccmsg/protocol";
import { btwSlots } from "../src/client/btw-slots.ts";
import {
  btwAskFailureText,
  btwEffortGroups,
  btwEffortOf,
} from "../src/client/components/btw-input.ts";
import { CURRENT_KEY, overrideGroups } from "../src/client/request-override-view.ts";
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

describe("the input box's btw (btw-input.ts)", () => {
  const groups = overrideGroups(
    "effort",
    undefined,
    {
      model: "claude-fable-5-1",
      effort: "low",
      timestamp: "t",
      engine: { model: "claude-fable-5-1", effort: "low" },
    },
    { turn: true, shorten: (m) => m },
  );

  test("the effort offers the in-effect and ⏱️ groups", () => {
    expect(btwEffortGroups(groups).map((g) => g.label)).toEqual(["in effect", "turn"]);
  });

  test("a ⏱️ choice is the btw's effort; the in-effect one names none", () => {
    expect(btwEffortOf({ kind: "once", override: { effort: "max" } })).toBe("max");
    expect(btwEffortOf({ kind: "current" })).toBeUndefined();
    expect(groups[0]?.options[0]?.key).toBe(CURRENT_KEY);
  });

  test("each refusal says what to do", () => {
    const refusal = (code: string, msg: string): ErrorResponse => ({
      ok: false,
      error: { code, msg },
    });
    expect(btwAskFailureText(refusal("btw_busy", "x"))).toContain("終わってから");
    expect(btwAskFailureText(refusal("session_not_found", "no cwd"))).toContain("no cwd");
    expect(btwAskFailureText(refusal("btw_command_unavailable", "ENOENT"))).toContain("ENOENT");
    expect(btwAskFailureText(refusal("bad_request", "y"))).toContain("y");
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
