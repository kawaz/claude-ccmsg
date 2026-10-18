// A session_status snapshot with every field of SessionStatusSnapshot set.
// `Required<>` makes a field added to the protocol's snapshot fail the
// typecheck here until it gets a value, so the tests that relay this snapshot
// (the ev:"session_status" push and the session_status_subscribe response)
// cover the new field too.
import type { SessionStatusSnapshot } from "@ccmsg/protocol";

export function fullSessionStatusSnapshot(): Required<SessionStatusSnapshot> {
  return {
    todos: [{ id: "t1", subject: "fix bug", status: "in_progress" }],
    workflows: [
      {
        task_id: "w1",
        name: "release",
        status: "running",
        started_at: "2026-07-16T00:00:00.000Z",
      },
    ],
    background: [
      {
        task_id: "b1",
        kind: "monitor",
        description: "watch ci",
        status: "running",
        started_at: "2026-07-16T00:00:00.000Z",
      },
    ],
    context: {
      tokens: 522_000,
      model: "claude-fable-5",
      timestamp: "2026-07-17T00:00:00.000Z",
    },
    teammates: [
      {
        name: "worker-a",
        spawned: true,
        state: "idle",
        spawned_at: "2026-07-17T00:00:00.000Z",
      },
    ],
    agent_tree: {
      teammates: [],
      agents: [
        {
          agent_id: "a1",
          agent_type: "Explore",
          spawn_depth: 1,
          kind: "subagent",
          state: "running",
          children: [],
        },
      ],
      workflows: [],
    },
    external_files: [{ path: "/external/shared.md", origin: "tool" }],
    workspace_folders: [{ name: "lib", path: "/work/lib" }],
    api_error: { text: "overloaded", timestamp: "2026-07-17T00:00:00.000Z" },
    input_readiness: { kind: "ready" },
    turn: { state: "responding", since: "2026-07-17T00:00:00.000Z" },
    subagents: [{ id: "a1", type: "Explore", since: "2026-07-17T00:00:00.000Z" }],
  };
}
