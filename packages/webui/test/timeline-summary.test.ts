import { describe, expect, test } from "bun:test";
import { foldSummaryView } from "../src/client/timeline-summary.ts";

describe("foldSummaryView", () => {
  test("keeps thinking decoration while closed", () => {
    expect(foldSummaryView("thinking", false, { kind: "thinking" })).toEqual({
      label: "thinking",
      decoration: { kind: "thinking" },
    });
  });

  // 閉時 summary は通信方向だけでなく、どのツール/メッセージ種別かも保持する。
  // decoration は identicon と破線枠を加えるが、label の語彙を置き換えない。
  test("keeps agent tool identity decoration while closed", () => {
    const send = { kind: "agent", prefix: "SendMessage →", name: "team-lead" } as const;
    expect(foldSummaryView("SendMessage → team-lead", false, send)).toEqual({
      label: "SendMessage → team-lead",
      decoration: send,
    });

    const peer = { kind: "agent", prefix: "peer-message ←", name: "worker" } as const;
    expect(foldSummaryView("peer-message ← worker", false, peer)).toEqual({
      label: "peer-message ← worker",
      decoration: peer,
    });

    const spawn = { kind: "agent", prefix: "Agent:", name: "worker" } as const;
    expect(foldSummaryView("Agent: worker", false, spawn)).toEqual({
      label: "Agent: worker",
      decoration: spawn,
    });
  });

  test("keeps Bash decoration while closed", () => {
    expect(foldSummaryView("Bash List files", false, { kind: "bash" })).toEqual({
      label: "Bash List files",
      decoration: { kind: "bash" },
    });
  });

  test("keeps task-notification decoration while closed", () => {
    expect(
      foldSummaryView("task-notification Monitor event", false, { kind: "task-notification" }),
    ).toEqual({
      label: "task-notification Monitor event",
      decoration: { kind: "task-notification" },
    });
  });

  test("removes decoration while open", () => {
    expect(
      foldSummaryView("peer-message ← teammate", true, {
        kind: "agent",
        prefix: "peer-message ←",
        name: "teammate",
      }),
    ).toEqual({ label: "peer-message ← teammate" });
    expect(foldSummaryView("Bash List files", true, { kind: "bash" })).toEqual({
      label: "Bash List files",
    });
    expect(foldSummaryView("task-notification", true, { kind: "task-notification" })).toEqual({
      label: "task-notification",
    });
  });
});
