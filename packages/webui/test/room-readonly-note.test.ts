// DR-0035 §2: a 1on1 room is read-only. RoomView drops its composer for that
// kind and shows RoomReadOnlyNote instead, so the note is what tells the
// person the room takes no message and where to write to the session.
//
// Test strategy mirrors tabs.test.ts: the component is called directly and the
// returned Preact VNode tree is walked by hand, since there is no DOM or
// renderToString in this repo.
import { describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import type { MemberInfo, RoomState } from "../src/client/store.ts";
import { RoomReadOnlyNote } from "../src/client/components/RoomReadOnlyNote.tsx";

function makeRoom(kind: RoomState["kind"], members: MemberInfo[]): RoomState {
  return {
    id: "r1",
    membersById: new Map(members.map((m) => [m.id, m])),
    memberOrder: members.map((m) => m.id),
    msgs: new Map(),
    timeline: [],
    lastMid: 0,
    lastTs: null,
    sayUnread: new Set<number>(),
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

function isVNode(x: unknown): x is VNode {
  return x != null && typeof x === "object" && "type" in x && "props" in x;
}

function childList(node: VNode): unknown[] {
  const c = (node.props as { children?: unknown }).children;
  return (Array.isArray(c) ? c : [c]).flat(Infinity);
}

/** Visible text of the note, links included. */
function textOf(node: VNode): string {
  return childList(node)
    .map((c) => (isVNode(c) ? textOf(c) : typeof c === "string" ? c : ""))
    .join("");
}

function linkOf(node: VNode): VNode | undefined {
  return childList(node).find((c): c is VNode => isVNode(c) && c.type === "a");
}

describe("RoomReadOnlyNote (DR-0035 §2)", () => {
  // 何を保証するか: 1on1 以外の room では何も出さない (通常 room と broadcast
  // room は Composer を持つので、読み取り専用の注記が紛れ込まない)。
  test("renders nothing for a normal or broadcast room", () => {
    for (const kind of ["normal", "broadcast"] as const) {
      expect(RoomReadOnlyNote({ room: makeRoom(kind, [member("a1", "sid-A", false)]) })).toBeNull();
    }
  });

  // 何を保証するか: 1on1 room では読み取り専用であることと、次の行動
  // (セッション画面の入力欄から入力する) を示し、在室の 1 セッションの画面へ
  // リンクする。
  test("a 1on1 room says it is read-only and links to its session's input box", () => {
    const note = RoomReadOnlyNote({ room: makeRoom("1on1", [member("a1", "sid-A", false)]) });
    expect(isVNode(note)).toBe(true);
    const p = note as VNode;
    expect(p.type).toBe("p");
    expect((p.props as { class?: string }).class).toBe("room-readonly-note");
    expect(textOf(p)).toBe(
      "この 1on1 room は読み取り専用です。セッションへの入力はセッション画面の入力欄から。",
    );
    expect((linkOf(p)!.props as { href?: string }).href).toBe("/s/sid-A");
  });

  // 何を保証するか: 在室メンバーが居ない (kick / leave 済み) 1on1 room でも
  // 読み取り専用の注記は出し、行き先が分からないのでリンクは付けない。
  test("a 1on1 room with no present member still shows the note, without a link", () => {
    const note = RoomReadOnlyNote({ room: makeRoom("1on1", [member("a1", "sid-A", true)]) });
    const p = note as VNode;
    expect(textOf(p)).toBe(
      "この 1on1 room は読み取り専用です。セッションへの入力はセッション画面の入力欄から。",
    );
    expect(linkOf(p)).toBeUndefined();
  });
});
