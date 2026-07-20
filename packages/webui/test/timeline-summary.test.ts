import { describe, expect, test } from "bun:test";
import { foldSummaryView } from "../src/client/timeline-summary.ts";

describe("foldSummaryView", () => {
  test("keeps thinking decoration while closed", () => {
    expect(foldSummaryView("thinking", false, { kind: "thinking" })).toEqual({
      label: "thinking",
      decoration: { kind: "thinking" },
    });
  });

  test("keeps agent identity decoration while closed", () => {
    const decoration = { kind: "agent", prefix: "SendMessage →", name: "team-lead" } as const;
    expect(foldSummaryView("SendMessage → team-lead", false, decoration)).toEqual({
      label: "SendMessage → team-lead",
      decoration,
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
