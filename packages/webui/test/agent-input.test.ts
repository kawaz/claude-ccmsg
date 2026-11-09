// The input to a running subagent (DR-0039 §6), the pure layer: how a
// subagent reads as a destination, and what came of a send.
import { describe, expect, test } from "bun:test";
import type { ErrorResponse } from "@ccmsg/protocol";
import { classifyAgentInputReply } from "../src/client/components/agent-input.ts";

describe("classifyAgentInputReply", () => {
  test("only appended clears the text; a stopped subagent says so", () => {
    expect(classifyAgentInputReply({ ok: true, outcome: "appended" })).toEqual({
      kind: "appended",
    });
    const stopped = classifyAgentInputReply({
      ok: true,
      outcome: "not_delivered",
      reason: "not_running",
    });
    expect(stopped.kind).toBe("not_delivered");
    expect(stopped.kind === "not_delivered" ? stopped.text : "").toContain("もう走っていない");
    const lost: ErrorResponse = { ok: false, error: { code: "request_timeout", msg: "m" } };
    expect(classifyAgentInputReply(lost).kind).toBe("unconfirmed");
  });
});
