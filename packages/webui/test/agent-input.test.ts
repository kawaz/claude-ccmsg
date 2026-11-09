// The input to a running subagent (DR-0039 §6), the pure layer: how a
// subagent reads as a destination, and what came of a send.
import { describe, expect, test } from "bun:test";
import type { ErrorResponse, SessionSubagent } from "@ccmsg/protocol";
import { classifyAgentInputReply, subagentLabel } from "../src/client/components/agent-input.ts";

const A: SessionSubagent = {
  id: "a1",
  description: "調査",
  type: "Explore",
  since: "2026-10-15T00:00:00.000Z",
};
const B: SessionSubagent = { id: "b2" };

describe("subagentLabel / classifyAgentInputReply", () => {
  test("a row names the type and the task, and when its turn started if known", () => {
    expect(subagentLabel(A, Date.parse("2026-10-15T00:03:30.000Z"))).toBe(
      "Explore · 調査 — turn の途中 (開始から 3 分)",
    );
    // A start the module did not see is not guessed.
    expect(subagentLabel(B, 0)).toBe("b2 — turn の途中");
  });

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
