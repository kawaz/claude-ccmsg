import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dumpSession } from "../src/session-dump.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { configDir: string; dataDir: string; transcript: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-session-dump-"));
  roots.push(root);
  const configDir = path.join(root, ".claude-test");
  const projectDir = path.join(configDir, "projects", "-repo");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "rooms"), { recursive: true });
  return { configDir, dataDir, transcript: path.join(projectDir, `${SID}.jsonl`) };
}

function row(timestamp: string, type: string, content: unknown, extra = {}): string {
  return JSON.stringify({ timestamp, type, message: { role: type, content }, ...extra });
}

describe("dumpSession", () => {
  test("extracts normalized conversation entries and hydrates canonical ccmsg messages", () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(
      path.join(dataDir, "rooms", "r9.jsonl"),
      [
        {
          type: "msg",
          mid: 1,
          from: "a2",
          to: ["a1"],
          ts: "2026-07-20T00:01:00Z",
          msg: "canonical received",
        },
        {
          type: "msg",
          mid: 2,
          from: "a1",
          to: ["a2"],
          ts: "2026-07-20T00:02:00Z",
          msg: "canonical sent",
          reply_to: "r9m1",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    const receive = JSON.stringify({
      type: "msg",
      mid: 1,
      from: "a2",
      to: ["a1"],
      ts: "2026-07-20T00:01:00Z",
      msg_via: "ccmsg read r9m1",
      r: "r9",
    });
    const sentEcho = JSON.stringify({
      type: "msg",
      mid: 2,
      from: "a1",
      to: ["a2"],
      ts: "2026-07-20T00:02:00Z",
      msg_via: "ccmsg read r9m2",
      r: "r9",
    });
    const lines = [
      row("2026-07-20T00:00:00Z", "user", "human prompt"),
      row("2026-07-20T00:00:10Z", "assistant", [{ type: "text", text: "assistant answer" }]),
      row("2026-07-20T00:00:20Z", "assistant", [
        {
          type: "tool_use",
          id: SID,
          name: "Agent",
          input: {
            name: "worker",
            subagent_type: "claude",
            description: "do work",
            prompt: "inspect it",
            run_in_background: true,
          },
        },
        {
          type: "tool_use",
          id: "send1",
          name: "SendMessage",
          input: { to: "worker", summary: "send task", message: "start now" },
        },
      ]),
      row(
        "2026-07-20T00:01:01Z",
        "user",
        `<teammate-message teammate_id="ccmsg">${receive}</teammate-message>`,
        { isMeta: true },
      ),
      row(
        "2026-07-20T00:01:02Z",
        "user",
        `<agent-message from="worker" summary="done">plain peer report</agent-message>`,
        { isMeta: true },
      ),
      JSON.stringify({
        timestamp: "2026-07-20T00:01:03Z",
        type: "queue-operation",
        operation: "enqueue",
        content: `<agent-message from="worker" summary="done">plain peer report</agent-message>`,
      }),
      row("2026-07-20T00:01:50Z", "assistant", [
        {
          type: "tool_use",
          id: "bash1",
          name: "Bash",
          input: { command: "/plugin/bin/ccmsg reply r9m1 'canonical sent'", description: "reply" },
        },
      ]),
      row("2026-07-20T00:01:51Z", "user", [
        {
          type: "tool_result",
          tool_use_id: "bash1",
          content: '{"ok":true,"room":"r9","mid":2,"to":["a2","u1"]}\n',
        },
      ]),
      row(
        "2026-07-20T00:02:01Z",
        "user",
        `<teammate-message teammate_id="ccmsg">${sentEcho}</teammate-message>`,
        { isMeta: true },
      ),
    ];
    fs.writeFileSync(transcript, lines.join("\n") + "\n");

    const dump = dumpSession(SID, { dataDir, configDirs: [configDir] });
    const { entries } = dump;
    expect(dump.header).toMatchObject({
      session: SID,
      since: "2026-07-20T00:00:00.000Z",
      until: null,
      format: "ccmsg-session-dump-v2",
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "agent-spawn",
      "agent-send",
      "ccmsg-received",
      "peer-message",
      "ccmsg-sent",
    ]);
    expect(entries.find((entry) => entry.kind === "ccmsg-received")).toMatchObject({
      text: "canonical received",
      meta: { room: "r9", mid: 1 },
    });
    expect(entries.find((entry) => entry.kind === "ccmsg-sent")).toMatchObject({
      t: 120000,
      text: "canonical sent",
      meta: { room: "r9", mid: 2, reply_to: "r9m1", op: "reply", tool_use_id: "bash1" },
    });
    expect(entries.filter((entry) => entry.meta.mid === 2)).toHaveLength(1);
    expect(entries.find((entry) => entry.kind === "agent-spawn")).toMatchObject({
      to: "worker",
      text: "inspect it",
      meta: { tool_use_id: "self", subagent_type: "claude", run_in_background: true },
    });
    expect(entries.find((entry) => entry.kind === "agent-send")).toMatchObject({
      from: "self",
      to: "worker",
      text: "start now",
      meta: { summary: "send task" },
    });
    expect(entries.find((entry) => entry.kind === "user")).toMatchObject({
      t: 0,
      from: "user",
      to: "self",
    });
    expect(entries.every((entry) => !("ts" in entry) && !("session" in entry))).toBe(true);
  });

  // Claude Code records some task lifecycle notices as type:user with plain
  // text. promptSource:"system" is authoritative even when no body wrapper is
  // available, while the adjacent typed/human row remains a real user entry.
  test("excludes plain-text system promptSource rows from user entries", () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(
      transcript,
      [
        row(
          "2026-07-20T00:00:00Z",
          "user",
          '6 background agents were stopped by the user: "worker-a", "worker-b".',
          {
            origin: { kind: "task-notification" },
            promptSource: "system",
            queuePriority: "later",
          },
        ),
        row("2026-07-20T00:00:01Z", "user", "human prompt", {
          origin: { kind: "human" },
          promptSource: "typed",
        }),
      ].join("\n") + "\n",
    );

    const dump = dumpSession(SID, { dataDir, configDirs: [configDir] });
    expect(dump.entries.filter((entry) => entry.kind === "user")).toEqual([
      expect.objectContaining({ text: "human prompt" }),
    ]);
  });

  test("applies inclusive timezone-aware since and until bounds", () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(
      transcript,
      [
        row("2026-07-19T18:47:51Z", "user", "before"),
        row("2026-07-19T18:47:52Z", "user", "lower"),
        row("2026-07-19T18:47:53Z", "assistant", [{ type: "text", text: "upper" }]),
        row("2026-07-19T18:47:54Z", "assistant", [{ type: "text", text: "after" }]),
      ].join("\n") + "\n",
    );
    const dump = dumpSession(SID, {
      dataDir,
      configDirs: [configDir],
      since: "2026-07-20T03:47:52+09:00",
      until: "2026-07-20T03:47:53+09:00",
    });
    expect(dump.header).toMatchObject({
      since: "2026-07-19T18:47:52.000Z",
      until: "2026-07-19T18:47:53.000Z",
    });
    expect(dump.entries.map((entry) => ({ t: entry.t, text: entry.text }))).toEqual([
      { t: 0, text: "lower" },
      { t: 1000, text: "upper" },
    ]);
  });

  test("rejects timezone-less timestamps and reversed ranges", () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(transcript, row("2026-07-20T00:00:00Z", "user", "hello") + "\n");
    expect(() =>
      dumpSession(SID, { dataDir, configDirs: [configDir], since: "2026-07-20T00:00:00" }),
    ).toThrow("with timezone");
    expect(() =>
      dumpSession(SID, {
        dataDir,
        configDirs: [configDir],
        since: "2026-07-20T00:00:01Z",
        until: "2026-07-20T00:00:00Z",
      }),
    ).toThrow("must not be later");
  });

  // A dump is a self-contained handoff: current agent/workflow identities, possibly-alive
  // process-local work, and only rooms where the session is still a member must be
  // recoverable without consulting the live daemon. Terminal notification and CronDelete
  // rows remove false liveness candidates; text inside summary/result cannot forge status.
  test("includes folded handoff state and excludes completed background work", () => {
    const { configDir, dataDir, transcript } = fixture();
    const sidDir = transcript.slice(0, -".jsonl".length);
    const subagentsDir = path.join(sidDir, "subagents");
    const runId = "wf_12345678-abc";
    fs.mkdirSync(path.join(subagentsDir, "workflows", runId), { recursive: true });
    fs.mkdirSync(path.join(sidDir, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, "agent-ateam-worker-123456.meta.json"),
      JSON.stringify({
        taskKind: "in_process_teammate",
        name: "worker",
        description: "team work",
        agentType: "claude",
        model: "claude-fable-5[1m]",
      }),
    );
    fs.writeFileSync(
      path.join(subagentsDir, "agent-a1234567890abcdef.meta.json"),
      JSON.stringify({ description: "direct work", agentType: "codex-sol-worker" }),
    );
    fs.writeFileSync(
      path.join(subagentsDir, "agent-a2222222222222222.meta.json"),
      JSON.stringify({
        description: "nested work",
        agentType: "codex-sol-reviewer",
        parentAgentId: "a1234567890abcdef",
      }),
    );
    fs.writeFileSync(
      path.join(sidDir, "workflows", `${runId}.json`),
      JSON.stringify({
        phases: [{ title: "Inspect" }],
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Inspect" },
          {
            type: "workflow_agent",
            agentId: "aabcdef1234567890",
            state: "done",
            label: "reader",
            phaseIndex: 1,
          },
        ],
      }),
    );
    const teammateUse = {
      type: "tool_use",
      id: "team-use",
      name: "Agent",
      input: { name: "worker", description: "team work" },
    };
    const directUse = {
      type: "tool_use",
      id: "direct-use",
      name: "Agent",
      input: { description: "direct work", run_in_background: true },
    };
    const workflowUse = {
      type: "tool_use",
      id: "workflow-use",
      name: "Workflow",
      input: {},
    };
    const monitorUse = {
      type: "tool_use",
      id: "monitor-use",
      name: "Monitor",
      input: { description: "ccmsg subscribe", persistent: true },
    };
    const bashUse = {
      type: "tool_use",
      id: "bash-use",
      name: "Bash",
      input: { description: "background build", run_in_background: true },
    };
    const cronKeepUse = {
      type: "tool_use",
      id: "cron-keep-use",
      name: "CronCreate",
      input: { cron: "33 4 20 7 *", prompt: "keep prompt", recurring: false },
    };
    const cronDeleteUse = {
      type: "tool_use",
      id: "cron-delete-use",
      name: "CronCreate",
      input: { cron: "7 * * * *", prompt: "delete prompt" },
    };
    fs.writeFileSync(
      transcript,
      [
        row("2026-07-20T00:00:00Z", "assistant", [
          teammateUse,
          directUse,
          workflowUse,
          monitorUse,
          bashUse,
          cronKeepUse,
          cronDeleteUse,
        ]),
        row(
          "2026-07-20T00:00:01Z",
          "user",
          [{ type: "tool_result", tool_use_id: "team-use", content: "ok" }],
          { toolUseResult: { status: "teammate_spawned", name: "worker" } },
        ),
        row(
          "2026-07-20T00:00:02Z",
          "user",
          [{ type: "tool_result", tool_use_id: "direct-use", content: "ok" }],
          { toolUseResult: { agentId: "a1234567890abcdef" } },
        ),
        row(
          "2026-07-20T00:00:03Z",
          "user",
          [{ type: "tool_result", tool_use_id: "workflow-use", content: "ok" }],
          {
            toolUseResult: {
              taskId: "workflow-task",
              workflowName: "handoff-check",
              status: "async_launched",
              runId,
            },
          },
        ),
        row(
          "2026-07-20T00:00:04Z",
          "user",
          [{ type: "tool_result", tool_use_id: "monitor-use", content: "ok" }],
          { toolUseResult: { taskId: "monitor-task" } },
        ),
        row(
          "2026-07-20T00:00:05Z",
          "user",
          [{ type: "tool_result", tool_use_id: "bash-use", content: "ok" }],
          { toolUseResult: { backgroundTaskId: "bash-task" } },
        ),
        row("2026-07-20T00:00:06Z", "user", [
          {
            type: "tool_result",
            tool_use_id: "cron-keep-use",
            content:
              "Scheduled one-shot task dkeep123 (33 4 20 7 *). Session-only (not written to disk, dies when Claude exits).",
          },
        ]),
        row("2026-07-20T00:00:07Z", "user", [
          {
            type: "tool_result",
            tool_use_id: "cron-delete-use",
            content: "Scheduled recurring task ddelete1 (7 * * * *).",
          },
        ]),
        row("2026-07-20T00:00:08Z", "assistant", [
          {
            type: "tool_use",
            id: "cron-remove-use",
            name: "CronDelete",
            input: { id: "ddelete1" },
          },
        ]),
        row("2026-07-20T00:00:09Z", "user", [
          { type: "tool_result", tool_use_id: "cron-remove-use", content: "Deleted task." },
        ]),
        JSON.stringify({
          timestamp: "2026-07-20T00:00:10Z",
          type: "queue-operation",
          operation: "enqueue",
          content:
            "<task-notification><task-id>a1234567890abcdef</task-id><status>completed</status></task-notification>",
        }),
        JSON.stringify({
          timestamp: "2026-07-20T00:00:11Z",
          type: "queue-operation",
          operation: "enqueue",
          content:
            "<task-notification><task-id>a2222222222222222</task-id><status>completed</status><summary>nested finished</summary><result>body with <status>failed</status></result></task-notification>",
        }),
        JSON.stringify({
          timestamp: "2026-07-20T00:00:12Z",
          type: "queue-operation",
          operation: "enqueue",
          content:
            "<task-notification><task-id>bash-task</task-id><status>completed</status></task-notification>",
        }),
      ].join("\n") + "\n",
    );
    const member = {
      type: "member",
      id: "a1",
      sid: SID,
      repo: "repo",
      ws: "main",
      cwd: "/repo",
      joined_at: "2026-07-20T00:00:00Z",
    };
    fs.writeFileSync(
      path.join(dataDir, "rooms", "r3.jsonl"),
      [
        member,
        { ...member, id: "a2", sid: "peer", ws: "peer" },
        { type: "title", title: "handoff room", ts: "2026-07-20T00:00:01Z" },
        { type: "kind", kind: "broadcast", ts: "2026-07-20T00:00:02Z" },
        { type: "msg", mid: 7, from: "a2", ts: "2026-07-20T00:00:03Z", msg: "latest" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(dataDir, "rooms", "r4.jsonl"),
      [member, { type: "leave", id: "a1", ts: "2026-07-20T00:00:01Z" }]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    const { context } = dumpSession(SID, { dataDir, configDirs: [configDir] });
    expect(context.kind).toBe("session-context");
    expect(context.note).toContain("only when rewind or context clearing preserved");
    expect(context.agents).toEqual([
      expect.objectContaining({
        agent_id: "a1234567890abcdef",
        kind: "subagent",
        state: "completed",
        description: "direct work",
      }),
      expect.objectContaining({
        agent_id: "a2222222222222222",
        kind: "subagent",
        state: "completed",
        description: "nested work",
      }),
      expect.objectContaining({
        agent_id: "ateam-worker-123456",
        kind: "teammate",
        name: "worker",
        state: "spawned",
        model: "claude-fable-5[1m]",
      }),
    ]);
    expect(context.workflows).toEqual([
      expect.objectContaining({
        task_id: "workflow-task",
        name: "handoff-check",
        run_id: runId,
        phases: [{ title: "Inspect", done: 1, total: 1 }],
        agents: [expect.objectContaining({ agent_id: "aabcdef1234567890", state: "done" })],
      }),
    ]);
    expect(context.background).toEqual([
      {
        task_id: "monitor-task",
        kind: "monitor",
        description: "ccmsg subscribe",
        state: "possibly-alive",
        started_at: "2026-07-20T00:00:00Z",
      },
    ]);
    expect(context.schedules).toEqual([
      {
        task_id: "dkeep123",
        cron: "33 4 20 7 *",
        prompt: "keep prompt",
        recurring: false,
        state: "possibly-alive",
      },
    ]);
    expect(context.rooms).toEqual([
      expect.objectContaining({
        room: "r3",
        title: "handoff room",
        kind: "broadcast",
        last_mid: 7,
        members: [
          expect.objectContaining({ id: "a1", sid: SID }),
          expect.objectContaining({ id: "a2", sid: "peer" }),
        ],
      }),
    ]);
  });

  test("emits thinking blocks as their own kind (kawaz r38 mid=40)", () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(
      transcript,
      [
        row("2026-07-20T00:00:00Z", "assistant", [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "visible answer" },
        ]),
      ].join("\n") + "\n",
    );
    const { entries } = dumpSession(SID, { configDirs: [configDir], dataDir });
    expect(entries.map((e) => e.kind)).toEqual(["thinking", "assistant"]);
    const thinking = entries[0]!;
    expect(thinking.text).toBe("internal reasoning");
    expect(thinking.to).toBeNull();
  });
});
