import { describe, expect, test } from "bun:test";
import { foldSummaryView } from "../src/client/timeline-summary.ts";

describe("foldSummaryView", () => {
  test("keeps thinking decoration while closed", () => {
    expect(foldSummaryView("thinking", false, { kind: "thinking" })).toEqual({
      label: "thinking",
      decoration: { kind: "thinking" },
    });
  });

  test("keeps directional agent identity decoration while closed", () => {
    const outbound = { kind: "agent", prefix: "🤖→", name: "team-lead" } as const;
    expect(foldSummaryView("🤖→ team-lead", false, outbound)).toEqual({
      label: "🤖→ team-lead",
      decoration: outbound,
    });

    const inbound = { kind: "agent", prefix: "🤖←", name: "worker" } as const;
    expect(foldSummaryView("🤖← worker", false, inbound)).toEqual({
      label: "🤖← worker",
      decoration: inbound,
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
      foldSummaryView("🤖← teammate", true, {
        kind: "agent",
        prefix: "🤖←",
        name: "teammate",
      }),
    ).toEqual({ label: "🤖← teammate" });
    expect(foldSummaryView("Bash List files", true, { kind: "bash" })).toEqual({
      label: "Bash List files",
    });
    expect(foldSummaryView("task-notification", true, { kind: "task-notification" })).toEqual({
      label: "task-notification",
    });
  });
});
