// The 🔔🔐 badges' rule (DR-0050 §3, §7), shared by the TL header and the
// Sessions list:
// - a Sessions row shows both badges when either kind has something unread,
//   none at 0 / 0 (the TL toolbar always shows them, timeline-toolbar-badges)
// - the counter reads from 1, is absent at 0, and is `99+` past 99 (§9 U14)
// - selecting a kind opens the tail with only that kind (§9 U5); pressing the
//   selected one takes the filter off and leaves the position
// - the counts are the session's unread says and unread requests only
import { describe, expect, test } from "bun:test";
import type { UnreadPermit, UnreadSay } from "@ccmsg/protocol";
import { agentSayerLabel } from "../src/client/components/agent-tree-view.ts";
import {
  badgeCounterText,
  badgeHref,
  rowBadgesShown,
  notificationCountsOf,
} from "../src/client/notification-badges.ts";

describe("notification badges", () => {
  test("a Sessions row shows both when either is unread, none at 0 / 0", () => {
    expect(rowBadgesShown({ say: 0, permit: 0 })).toBe(false);
    expect(rowBadgesShown({ say: 1, permit: 0 })).toBe(true);
    expect(rowBadgesShown({ say: 0, permit: 1 })).toBe(true);
  });

  test("the counter is absent at 0, the number from 1, and 99+ past 99", () => {
    expect(badgeCounterText(0)).toBeNull();
    expect(badgeCounterText(1)).toBe("1");
    expect(badgeCounterText(99)).toBe("99");
    expect(badgeCounterText(100)).toBe("99+");
  });

  test("selecting a kind opens the tail filtered; the selected one takes the filter off in place", () => {
    expect(badgeHref("s1", "say", { position: "u-1", filter: null })).toBe(
      "/s/s1/timeline/head?filter=say",
    );
    expect(badgeHref("s1", "permit", { position: "u-1", filter: "say" })).toBe(
      "/s/s1/timeline/head?filter=permit",
    );
    expect(badgeHref("s1", "say", { position: "u-1", filter: "say" })).toBe("/s/s1/timeline/u-1");
  });

  test("counts the session's unread says and its requests not yet acted on", () => {
    const says: UnreadSay[] = [
      { session_id: "s1", tool_use_id: "t1", ts: "2026-11-08T00:00:00.000Z" },
      { session_id: "s1", tool_use_id: "t2", ts: "2026-11-08T00:00:01.000Z" },
      { session_id: "s2", tool_use_id: "t3", ts: "2026-11-08T00:00:02.000Z" },
    ];
    const request = (id: string, sid: string): UnreadPermit => ({
      session_id: sid,
      tool_use_id: id,
      ts: "2026-11-08T00:00:00.000Z",
    });
    const requests = [request("toolu_1", "s1"), request("toolu_3", "s2")];
    expect(notificationCountsOf("s1", says, requests)).toEqual({ say: 2, permit: 1 });
    expect(notificationCountsOf("s3", says, requests)).toEqual({ say: 0, permit: 0 });
  });
});

// DR-0050 §10: a worker's say counts in its session's 🔔 (main + workers), and
// its bubble names the worker by the agent tree, with model/effort when known.
describe("a worker's say", () => {
  test("counts in the session's 🔔 with the main thread's", () => {
    const says: UnreadSay[] = [
      { session_id: "s1", tool_use_id: "t1", ts: "2026-11-08T00:00:00.000Z" },
      { session_id: "s1", tool_use_id: "t2", ts: "2026-11-08T00:00:01.000Z", agent_id: "a1" },
    ];
    expect(notificationCountsOf("s1", says, [])).toEqual({ say: 2, permit: 0 });
  });

  test("names the worker with its model/effort, or by name or id alone", () => {
    const tree = {
      teammates: [],
      workflows: [],
      agents: [
        {
          agent_id: "a1",
          name: "reviewer",
          model: "fable[1m]",
          running_model: "claude-fable-5-1",
          effort: "low",
          kind: "subagent" as const,
          spawn_depth: 0,
          state: "active" as const,
          children: [],
        },
        {
          agent_id: "a2",
          name: "builder",
          kind: "subagent" as const,
          spawn_depth: 0,
          state: "active" as const,
          children: [],
        },
      ],
    };
    expect(agentSayerLabel(tree, "a1")).toBe("🤖 reviewer (fable-5-1/low)");
    expect(agentSayerLabel(tree, "a2")).toBe("🤖 builder");
    expect(agentSayerLabel(tree, "a9")).toBe("🤖 a9");
    expect(agentSayerLabel(undefined, "a1")).toBe("🤖 a1");
  });
});
