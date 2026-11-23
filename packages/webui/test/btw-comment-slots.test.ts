// The btw comments of a session's records as the Timeline places them
// (btw-slots.ts placedBtws, DR-0062 §12): a question with its answers, at the
// point it was sent (else where it was written); the unsent ones only for the
// 💬 filter, and none taken back.
import { describe, expect, test } from "bun:test";
import type { BtwAnswer, CommentRecord, UserComment } from "@ccmsg/protocol";
import { placedBtws } from "../src/client/btw-slots.ts";

function question(cid: string, patch: Partial<UserComment> = {}): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid,
    session_id: "s1",
    anchor: { kind: "timing" },
    body: cid,
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: "w" },
    sent: { at: "2030-01-01T00:00:01.000Z", after_uuid: "s" },
    updated_at: "v",
    btw: true,
    status: "sent",
    ...patch,
  };
}

function answer(cid: string, to: string): BtwAnswer {
  return {
    kind: "comment",
    author: "btw",
    cid,
    session_id: "s1",
    anchor: { kind: "comment", cid: to },
    body: "",
    written: { at: "2030-01-01T00:00:01.000Z" },
    updated_at: "v",
    status: "failed",
  };
}

describe("placedBtws", () => {
  const records: CommentRecord[] = [
    question("c0001"),
    answer("c0002", "c0001"),
    answer("c0003", "c0001"),
    question("c0004", { status: "draft", sent: undefined }),
    question("c0005", { status: "deleted" }),
    question("c0006", { btw: false }),
  ];

  test("a question sent with its answers in order, at the point it was sent", () => {
    expect(
      placedBtws(records, false).map((p) => [p.question.cid, p.answers.map((a) => a.cid), p.after]),
    ).toEqual([["c0001", ["c0002", "c0003"], "s"]]);
  });

  test("with the unsent ones, a draft stands where it was written", () => {
    expect(placedBtws(records, true).map((p) => [p.question.cid, p.after])).toEqual([
      ["c0001", "s"],
      ["c0004", "w"],
    ]);
  });
});
