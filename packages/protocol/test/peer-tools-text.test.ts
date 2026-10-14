// The `send` tool's result as the model reads it, read back by a transcript's
// reader (DR-0039 §3): one definition for both.
import { describe, expect, test } from "bun:test";
import { CCMSG_TOOLS, ccmsgSendCall, readSendResultText, sendResultText } from "../src/index.ts";

const A = "aaaaaaaa-2222-4333-8444-555555555555";
const B = "bbbbbbbb-2222-4333-8444-555555555555";

describe("readSendResultText", () => {
  test("reads back what sendResultText writes, a name or cwd with ': ' included", () => {
    const all = sendResultText([
      { sid: A, name: "x: y", cwd: "/w: z", outcome: "delivered" },
      { sid: B, outcome: "delivered" },
    ]);
    expect(readSendResultText(all)).toEqual({ status: "sent", to: [A, B] });

    const some = sendResultText([
      { sid: A, outcome: "delivered" },
      { sid: B, outcome: "not_delivered", reason: "refused" },
    ]);
    expect(readSendResultText(some)).toEqual({ status: "sent", to: [A], detail: some });

    const maybe = sendResultText([{ sid: B, outcome: "unconfirmed" }]);
    expect(readSendResultText(maybe)).toEqual({ status: "unconfirmed", to: [B], detail: maybe });

    for (const failed of [
      sendResultText([]),
      sendResultText([{ sid: A, outcome: "not_delivered", reason: "self" }]),
      sendResultText([{ sid: B, outcome: "not_delivered", reason: "no_module" }]),
      "send の入力が形に合わないので何もしていない: text: Invalid type",
    ]) {
      expect(readSendResultText(failed)).toEqual({ status: "failed", detail: failed });
    }
  });

  // The module's own text for a send that could not be told carries the
  // advice a reader takes it by.
  test("a send that went no further but may have arrived is unconfirmed", () => {
    const text =
      "ccmsg が送信の結果を返さず、届いたか確かめられなかった。送り直すと二重に届くかもしれないので、まず相手の返事を待つ";
    expect(readSendResultText(text)).toEqual({ status: "unconfirmed", to: [], detail: text });
  });
});

describe("ccmsgSendCall", () => {
  test("reads the text and the session named by id of a send tool call", () => {
    expect(ccmsgSendCall(CCMSG_TOOLS.send, { cwd: "/w", text: "hi" })).toEqual({ text: "hi" });
    expect(ccmsgSendCall(CCMSG_TOOLS.send, { session_id: A, text: "hi" })).toEqual({
      text: "hi",
      sessionId: A,
    });
  });

  test("another tool, or a send with no text, is none", () => {
    expect(ccmsgSendCall(CCMSG_TOOLS.say, { text: "hi" })).toBeNull();
    expect(ccmsgSendCall("SendMessage", { to: A, text: "hi" })).toBeNull();
    expect(ccmsgSendCall(CCMSG_TOOLS.send, { cwd: "/w", text: 1 })).toBeNull();
  });
});
