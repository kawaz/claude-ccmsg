// The agent's reply to a comment (DR-0062 §5): what the model writes into
// `comment_reply`, and the text its call answers when the reply was recorded,
// which a reader of the transcript reads the reply's cid from.
// 何を保証するか:
//   - tool の入力は cid (c と英小文字・数字 4 字) と空白だけでない本文で、他は読めない
//   - 記録した時の結果の文から新しい cid が読める (返信先の引用に括弧や改行が
//     あっても)。エラーの結果、断りや subagent の断りの文、cid の食い違う文からは
//     読めない
import { describe, expect, test } from "bun:test";
import {
  commentReplyRecorded,
  commentReplyRecordedText,
  CommentReplyToolInputSchema,
} from "../src/comment-reply.ts";
import { parseWith } from "../src/parse.ts";

describe("comment_reply's input", () => {
  test("a cid and a body", () => {
    expect(parseWith(CommentReplyToolInputSchema, { cid: "c7k2p", body: "そう" })).toMatchObject({
      ok: true,
      value: { cid: "c7k2p", body: "そう" },
    });
    for (const input of [
      { cid: "c7k2p", body: " \n " },
      { cid: "C7K2P", body: "x" },
      { cid: "c7k2", body: "x" },
      { body: "x" },
      { cid: "c7k2p" },
    ]) {
      expect(parseWith(CommentReplyToolInputSchema, input).ok).toBe(false);
    }
  });
});

describe("commentReplyRecorded: the reply's cid its call's result says", () => {
  test("the text of a reply recorded gives the new cid", () => {
    const text = commentReplyRecordedText("c7k2p", "ここは undefined を返すのでは？", "c8m1t");
    expect(text).toBe(
      'c7k2p (「ここは undefined を返すのでは？」) への返信を記録した。この返信の cid は c8m1t (人がこれに返信すると reply_to="c8m1t" で届く)',
    );
    expect(commentReplyRecorded(text, false)).toBe("c8m1t");
    expect(commentReplyRecorded(`\n${text}\n`, false)).toBe("c8m1t");
  });

  test("a quote with brackets and the words of the text itself still reads", () => {
    const quote = "「」) への返信を記録した。この返信の cid は c0000 (";
    expect(commentReplyRecorded(commentReplyRecordedText("c1111", quote, "c2222"), false)).toBe(
      "c2222",
    );
    expect(commentReplyRecorded(commentReplyRecordedText("c1111", "", "c2222"), false)).toBe(
      "c2222",
    );
  });

  test("anything else gives none", () => {
    const text = commentReplyRecordedText("c7k2p", "q", "c8m1t");
    expect(commentReplyRecorded(text, true)).toBeNull();
    expect(
      commentReplyRecorded(
        "cid c99xx はこのセッションの本体に届いたコメントに無いので記録していない。届いた <comment> の cid を確かめて書き直す",
        false,
      ),
    ).toBeNull();
    expect(
      commentReplyRecorded(
        "comment_reply は subagent / teammate からは使えない (コメントは本体のセッションに届く)。何も記録していない",
        false,
      ),
    ).toBeNull();
    expect(commentReplyRecorded(text.replace('reply_to="c8m1t"', 'reply_to="c0000"'), false)).toBe(
      null,
    );
    expect(commentReplyRecorded(`${text} 追記`, false)).toBeNull();
  });
});
