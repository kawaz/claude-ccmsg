// DR-0036 §2: rooms are read-only. RoomView shows RoomReadOnlyNote under the
// header, so the note is what tells the person the room takes no message, and
// for a 1on1 room where to write to its session instead.
//
// Test strategy mirrors tabs.test.ts: the component is called directly and the
// returned Preact VNode tree is walked by hand, since there is no DOM or
// renderToString in this repo.
import { describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import type { MemberInfo, RoomState } from "../src/client/store.ts";
import { RoomReadOnlyNote } from "../src/client/components/RoomReadOnlyNote.tsx";
import { collect, defined, flattenText, stringProp } from "./helpers.ts";

function makeRoom(kind: RoomState["kind"], members: MemberInfo[]): RoomState {
  return {
    id: "r1",
    membersById: new Map(members.map((m) => [m.id, m])),
    memberOrder: members.map((m) => m.id),
    msgs: new Map(),
    timeline: [],
    lastMid: 0,
    lastTs: null,
    kind,
    history: "loaded",
  };
}

function member(id: string, sid: string, left: boolean): MemberInfo {
  return {
    type: "member",
    id,
    sid,
    repo: "repo",
    ws: "ws",
    cwd: "/cwd",
    joined_at: "2026-10-09T00:00:00Z",
    left,
  };
}

/** Visible text of the note, links included. */
function textOf(node: VNode): string {
  return flattenText(node);
}

function linkOf(node: VNode): VNode | undefined {
  return collect(node.props.children, (n) => n.type === "a")[0];
}

describe("RoomReadOnlyNote (DR-0036 §2)", () => {
  // 何を保証するか: どの種類の room でも読み取り専用であることを示し、1on1
  // 以外には行き先を添えない (セッション間のやり取りの行き先は 1 つではない)。
  test("a normal or broadcast room says it is read-only, with no link", () => {
    for (const kind of ["normal", "broadcast"] as const) {
      const note = RoomReadOnlyNote({ room: makeRoom(kind, [member("a1", "sid-A", false)]) });
      expect(stringProp(note, "class")).toBe("room-readonly-note");
      expect(textOf(note)).toBe("この room は読み取り専用です。");
      expect(linkOf(note)).toBeUndefined();
    }
  });

  // 何を保証するか: 1on1 room では次の行動 (セッション画面の入力欄から入力
  // する) を示し、在室の 1 セッションの画面へリンクする。
  test("a 1on1 room links to its session's input box", () => {
    const note = RoomReadOnlyNote({ room: makeRoom("1on1", [member("a1", "sid-A", false)]) });
    expect(textOf(note)).toBe(
      "この room は読み取り専用です。セッションへの入力はセッション画面の入力欄から。",
    );
    expect(stringProp(defined(linkOf(note), "the link"), "href")).toBe("/s/sid-A");
  });

  // 何を保証するか: 在室メンバーが居ない 1on1 room は行き先が分からないので、
  // 読み取り専用の注記だけを出しリンクは付けない。
  test("a 1on1 room with no present member says only that it is read-only", () => {
    const note = RoomReadOnlyNote({ room: makeRoom("1on1", [member("a1", "sid-A", true)]) });
    expect(textOf(note)).toBe("この room は読み取り専用です。");
    expect(linkOf(note)).toBeUndefined();
  });
});
