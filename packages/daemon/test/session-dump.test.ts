import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compareContextAgents,
  dumpSession,
  formatJsonlDump,
  writeSessionDumpFile,
  type ContextAgentRecord,
  type SessionDump,
} from "../src/session-dump.ts";

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

/** Await a dumpSession call expected to reject and hand back its Error, so the
 * rejection assertions read like the sync `toThrow` ones they replaced. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected dumpSession to throw");
}

function row(timestamp: string, type: string, content: unknown, extra = {}): string {
  return JSON.stringify({ timestamp, type, message: { role: type, content }, ...extra });
}

describe("dumpSession", () => {
  test("extracts normalized conversation entries and hydrates canonical ccmsg messages", async () => {
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

    const dump = await dumpSession(SID, { dataDir, configDirs: [configDir] });
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
  test("excludes plain-text system promptSource rows from user entries", async () => {
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

    const dump = await dumpSession(SID, { dataDir, configDirs: [configDir] });
    expect(dump.entries.filter((entry) => entry.kind === "user")).toEqual([
      expect.objectContaining({ text: "human prompt" }),
    ]);
  });

  test("applies inclusive timezone-aware since and until bounds", async () => {
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
    const dump = await dumpSession(SID, {
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

  test("rejects timezone-less timestamps and reversed ranges", async () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(transcript, row("2026-07-20T00:00:00Z", "user", "hello") + "\n");
    expect(
      (
        await rejection(
          dumpSession(SID, { dataDir, configDirs: [configDir], since: "2026-07-20T00:00:00" }),
        )
      ).message,
    ).toContain("with timezone");
    expect(
      (
        await rejection(
          dumpSession(SID, {
            dataDir,
            configDirs: [configDir],
            since: "2026-07-20T00:00:01Z",
            until: "2026-07-20T00:00:00Z",
          }),
        )
      ).message,
    ).toContain("must not be later");
  });

  // The motivating case: several records can carry the same timestamp, so a
  // clock-based bound cannot express "from this message on". A uuid can.
  test("cuts at the named record, not at its timestamp", async () => {
    const { configDir, dataDir, transcript } = fixture();
    const uuid = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee0${n}`;
    fs.writeFileSync(
      transcript,
      [
        row("2026-07-19T18:47:51Z", "user", "before", { uuid: uuid(1) }),
        // Same second as the record above: a `--since` timestamp covering one
        // of these two necessarily covers both.
        row("2026-07-19T18:47:51Z", "user", "boundary", { uuid: uuid(2) }),
        row("2026-07-19T18:47:52Z", "assistant", [{ type: "text", text: "upper" }], {
          uuid: uuid(3),
        }),
        row("2026-07-19T18:47:53Z", "assistant", [{ type: "text", text: "after" }], {
          uuid: uuid(4),
        }),
      ].join("\n") + "\n",
    );
    const base = { dataDir, configDirs: [configDir] };
    const dump = await dumpSession(SID, { ...base, since: uuid(2), until: uuid(3) });
    expect(dump.entries.map((entry) => entry.text)).toEqual(["boundary", "upper"]);
    // The header still reports the boundary as a time, since that is the scale
    // the entries' `t` offsets are measured on.
    expect(dump.header).toMatchObject({
      since: "2026-07-19T18:47:51.000Z",
      until: "2026-07-19T18:47:52.000Z",
    });
    // The equivalent timestamp bound cannot separate the two 18:47:51 records —
    // which is what makes the uuid form worth having.
    const byTime = await dumpSession(SID, { ...base, since: "2026-07-19T18:47:51Z" });
    expect(byTime.entries.map((entry) => entry.text)).toEqual([
      "before",
      "boundary",
      "upper",
      "after",
    ]);
  });

  test("accepts a uuid bound on one end and a timestamp on the other", async () => {
    const { configDir, dataDir, transcript } = fixture();
    const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02";
    fs.writeFileSync(
      transcript,
      [
        row("2026-07-19T18:47:51Z", "user", "before"),
        row("2026-07-19T18:47:52Z", "user", "lower", { uuid }),
        row("2026-07-19T18:47:53Z", "assistant", [{ type: "text", text: "upper" }]),
        row("2026-07-19T18:47:54Z", "assistant", [{ type: "text", text: "after" }]),
      ].join("\n") + "\n",
    );
    const dump = await dumpSession(SID, {
      dataDir,
      configDirs: [configDir],
      since: uuid,
      until: "2026-07-19T18:47:53Z",
    });
    expect(dump.entries.map((entry) => entry.text)).toEqual(["lower", "upper"]);
  });

  test("refuses a uuid no record in this transcript carries", async () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(
      transcript,
      row("2026-07-20T00:00:00Z", "user", "hello", {
        uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01",
      }) + "\n",
    );
    const message = (
      await rejection(
        dumpSession(SID, {
          dataDir,
          configDirs: [configDir],
          since: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        }),
      )
    ).message;
    // Cause and remedy both, since the likely mistake is pasting a uuid that
    // belongs to a different session.
    expect(message).toContain("not found in this session's transcript");
    expect(message).toContain("ISO 8601 timestamp instead");
  });

  test("rejects a record range whose ends are in transcript order reversed", async () => {
    const { configDir, dataDir, transcript } = fixture();
    const uuid = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee0${n}`;
    fs.writeFileSync(
      transcript,
      [
        // Same timestamp on both, so only their positions can order them.
        row("2026-07-20T00:00:00Z", "user", "first", { uuid: uuid(1) }),
        row("2026-07-20T00:00:00Z", "user", "second", { uuid: uuid(2) }),
      ].join("\n") + "\n",
    );
    const base = { dataDir, configDirs: [configDir] };
    expect(
      (await rejection(dumpSession(SID, { ...base, since: uuid(2), until: uuid(1) }))).message,
    ).toContain("must not be later");
    // The same-position pair is a valid one-record range, not a reversed one.
    const one = await dumpSession(SID, { ...base, since: uuid(2), until: uuid(2) });
    expect(one.entries.map((entry) => entry.text)).toEqual(["second"]);
  });

  // A dump is a self-contained handoff: current agent/workflow identities, possibly-alive
  // process-local work, and only rooms where the session is still a member must be
  // recoverable without consulting the live daemon. Terminal notification and CronDelete
  // rows remove false liveness candidates; text inside summary/result cannot forge status.
  test("includes folded handoff state and excludes completed background work", async () => {
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
      path.join(subagentsDir, "agent-ateam-stale-123456.meta.json"),
      JSON.stringify({
        taskKind: "in_process_teammate",
        name: "stale",
        description: "finished work",
        agentType: "claude",
      }),
    );
    fs.writeFileSync(
      path.join(subagentsDir, "agent-a1234567890abcdef.meta.json"),
      JSON.stringify({
        description: "direct work",
        agentType: "codex-sol-worker",
        toolUseId: "direct-use",
      }),
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
    const staleTeammateUse = {
      type: "tool_use",
      id: "stale-use",
      name: "Agent",
      input: { name: "stale", description: "finished work" },
    };
    const stopUse = {
      type: "tool_use",
      id: "stop-use",
      name: "TaskStop",
      input: { task_id: "stale" },
    };
    const todoCreateUse = {
      type: "tool_use",
      id: "todo-create-use",
      name: "TaskCreate",
      input: { subject: "ship dump options" },
    };
    const todoDoneUse = {
      type: "tool_use",
      id: "todo-done-use",
      name: "TaskUpdate",
      input: { taskId: "1", status: "completed" },
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
          staleTeammateUse,
          stopUse,
          todoCreateUse,
          todoDoneUse,
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
          "2026-07-20T00:00:01Z",
          "user",
          [{ type: "tool_result", tool_use_id: "stale-use", content: "ok" }],
          { toolUseResult: { status: "teammate_spawned", name: "stale" } },
        ),
        row(
          "2026-07-20T00:00:01Z",
          "user",
          [{ type: "tool_result", tool_use_id: "todo-create-use", content: "ok" }],
          { toolUseResult: { task: { id: "1", subject: "ship dump options" } } },
        ),
        row(
          "2026-07-20T00:00:01Z",
          "user",
          [{ type: "tool_result", tool_use_id: "todo-done-use", content: "ok" }],
          { toolUseResult: { success: true, taskId: "1" } },
        ),
        row(
          "2026-07-20T00:00:01Z",
          "user",
          [{ type: "tool_result", tool_use_id: "stop-use", content: "ok" }],
          { toolUseResult: { task_type: "in_process_teammate", task_id: "stale-internal" } },
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

    const { context } = await dumpSession(SID, { dataDir, configDirs: [configDir] });
    expect(context.kind).toBe("session-context");
    expect(context.note).toContain("only when rewind or context clearing preserved");
    expect(context.agents).toEqual([
      expect.objectContaining({
        agent_id: "a1234567890abcdef",
        kind: "subagent",
        state: "completed",
        description: "direct work",
      }),
      // Spawned and stopped inside the range: a rewound session was working
      // with it moments ago, so its state and prompt still matter.
      expect.objectContaining({
        agent_id: "ateam-stale-123456",
        kind: "teammate",
        name: "stale",
        state: "stopped",
      }),
      expect.objectContaining({
        agent_id: "ateam-worker-123456",
        kind: "teammate",
        name: "worker",
        state: "spawned",
        model: "claude-fable-5[1m]",
      }),
    ]);
    // The nested subagent was spawned by another agent, so this session's
    // entries never name it. One line keeps "not listed" from reading as
    // "never existed" while staying cheap.
    expect(context.agents_past).toEqual([
      { agent_id: "a2222222222222222", description: "nested work" },
    ]);
    // Completed todos stay: a rewound session that only sees open items risks
    // redoing finished work.
    expect(context.todos).toEqual([{ id: "1", subject: "ship dump options", status: "completed" }]);
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

  test("emits thinking blocks as their own kind (kawaz r38 mid=40)", async () => {
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
    const { entries } = await dumpSession(SID, { configDirs: [configDir], dataDir });
    expect(entries.map((e) => e.kind)).toEqual(["thinking", "assistant"]);
    const thinking = entries[0]!;
    expect(thinking.text).toBe("internal reasoning");
    expect(thinking.to).toBeNull();
  });

  // The two trims serve opposite readers: --no-thinking is memory recovery
  // (conclusions already landed in the transcript, reasoning is bulk), --no-agent
  // is journal generation (thinking is the payload, agent machinery is not).
  // Cross-session ccmsg traffic survives both — it is correspondence, not
  // machinery — so a journal keeps what the session actually said to peers.
  test("--no-thinking and --no-agent trim opposite halves of the dump", async () => {
    const { configDir, dataDir, transcript } = fixture();
    fs.writeFileSync(
      path.join(dataDir, "rooms", "r9.jsonl"),
      `${JSON.stringify({
        type: "msg",
        mid: 1,
        from: "a2",
        to: ["a1"],
        ts: "2026-07-20T00:00:30Z",
        msg: "canonical received",
      })}\n`,
    );
    const receive = JSON.stringify({
      type: "msg",
      mid: 1,
      from: "a2",
      to: ["a1"],
      ts: "2026-07-20T00:00:30Z",
      msg_via: "ccmsg read r9m1",
      r: "r9",
    });
    fs.writeFileSync(
      transcript,
      [
        row("2026-07-20T00:00:00Z", "user", "human prompt"),
        row("2026-07-20T00:00:10Z", "assistant", [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "visible answer" },
        ]),
        row("2026-07-20T00:00:20Z", "assistant", [
          {
            type: "tool_use",
            id: "spawn1",
            name: "Agent",
            input: { name: "worker", description: "do work", prompt: "inspect it" },
          },
          {
            type: "tool_use",
            id: "send1",
            name: "SendMessage",
            input: { to: "worker", summary: "send task", message: "start now" },
          },
        ]),
        row(
          "2026-07-20T00:00:30Z",
          "user",
          `<teammate-message teammate_id="ccmsg">${receive}</teammate-message>`,
          { isMeta: true },
        ),
        row("2026-07-20T00:00:40Z", "user", `<agent-message from="worker">report</agent-message>`, {
          isMeta: true,
        }),
      ].join("\n") + "\n",
    );

    const base = { configDirs: [configDir], dataDir };
    expect((await dumpSession(SID, base)).entries.map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "assistant",
      "agent-spawn",
      "agent-send",
      "ccmsg-received",
      "peer-message",
    ]);
    expect(
      (await dumpSession(SID, { ...base, noThinking: true })).entries.map((e) => e.kind),
    ).toEqual(["user", "assistant", "agent-spawn", "agent-send", "ccmsg-received", "peer-message"]);
    const journal = await dumpSession(SID, { ...base, noAgent: true });
    expect(journal.entries.map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "assistant",
      "ccmsg-received",
    ]);
    // --no-agent drops the agent context wholesale; todos/rooms/background stay
    // because they describe the session's own work, not its subordinates.
    expect(journal.context.agents).toBeUndefined();
    expect(journal.context.agents_past).toBeUndefined();
    expect(journal.context.workflows).toBeUndefined();
    expect(journal.context.todos).toEqual([]);
    expect(journal.context.rooms.map((r) => r.room)).toEqual([]);
  });

  // A rewound session must re-read the agents it is still working with, not the
  // roster of everyone it ever spawned (measured: 45 agents, 43 of them idle).
  // The dumped range decides: an agent the entries never mention belongs to a
  // past this session is not resuming, so it folds to a line that keeps it
  // recognizable and addressable via --agent.
  describe("range-scoped agent context", () => {
    function agentFixture(): ReturnType<typeof fixture> {
      const f = fixture();
      const subagentsDir = path.join(f.transcript.slice(0, -".jsonl".length), "subagents");
      fs.mkdirSync(subagentsDir, { recursive: true });
      for (const [file, meta] of [
        ["agent-aearly-111111111111.meta.json", { taskKind: "in_process_teammate", name: "early" }],
        ["agent-alate-2222222222222.meta.json", { taskKind: "in_process_teammate", name: "late" }],
        [
          "agent-a3333333333333333.meta.json",
          { description: "nameless background work", toolUseId: "bg-use" },
        ],
      ] as const) {
        fs.writeFileSync(path.join(subagentsDir, file), JSON.stringify(meta));
      }
      fs.writeFileSync(
        f.transcript,
        [
          row("2026-07-20T00:00:00Z", "assistant", [
            {
              type: "tool_use",
              id: "early-use",
              name: "Agent",
              input: { name: "early", description: "early job", prompt: "early prompt" },
            },
          ]),
          row("2026-07-20T00:00:01Z", "assistant", [
            {
              type: "tool_use",
              id: "early-send",
              name: "SendMessage",
              input: { to: "early", message: "early instruction" },
            },
          ]),
          row("2026-07-20T02:00:00Z", "assistant", [
            {
              type: "tool_use",
              id: "late-use",
              name: "Agent",
              input: { name: "late", description: "late job", prompt: "late prompt" },
            },
            { type: "tool_use", id: "bg-use", name: "Agent", input: { description: "bg job" } },
          ]),
          row(
            "2026-07-20T02:00:01Z",
            "user",
            `<agent-message from="late">late report</agent-message>`,
            {
              isMeta: true,
            },
          ),
        ].join("\n") + "\n",
      );
      return f;
    }

    test("expands agents the range involves and folds the rest to one line", async () => {
      const { configDir, dataDir } = agentFixture();
      const dump = await dumpSession(SID, {
        dataDir,
        configDirs: [configDir],
        since: "2026-07-20T01:00:00Z",
      });
      expect(dump.context.agents?.map((a) => a.name ?? a.agent_id)).toEqual([
        "a3333333333333333",
        "late",
      ]);
      // Folded to the three fields that let a reader recognize it and name it
      // in --agent — the spawn prompt and live state are deliberately gone.
      expect(dump.context.agents_past).toEqual([
        { agent_id: "aearly-111111111111", name: "early" },
      ]);
      expect(dump.header.agent_detail).toContain("--agent");
    });

    test("keeps every agent expanded when the range covers them all", async () => {
      const { configDir, dataDir } = agentFixture();
      const dump = await dumpSession(SID, { dataDir, configDirs: [configDir] });
      expect(dump.context.agents?.map((a) => a.name ?? a.agent_id)).toEqual([
        "a3333333333333333",
        "early",
        "late",
      ]);
      // Nothing folded, so the read-back hint would be noise.
      expect(dump.context.agents_past).toBeUndefined();
      expect(dump.header.agent_detail).toBeUndefined();
    });

    test("--agent expands one agent regardless of the range, by name or id prefix", async () => {
      const { configDir, dataDir } = agentFixture();
      const base = { dataDir, configDirs: [configDir] };
      const byName = await dumpSession(SID, { ...base, agent: "early" });
      // The read-back of a folded agent is issued without the --since that
      // folded it, so the whole exchange comes back — and only that exchange.
      expect(byName.entries.map((e) => e.text)).toEqual(["early prompt", "early instruction"]);
      expect(byName.context.agents?.map((a) => a.name)).toEqual(["early"]);
      // --agent narrows alongside --since rather than overriding it, and the
      // selected agent stays expanded even when the range holds none of it.
      const ranged = await dumpSession(SID, {
        ...base,
        agent: "early",
        since: "2026-07-20T01:00:00Z",
      });
      expect(ranged.entries).toEqual([]);
      expect(ranged.context.agents?.map((a) => a.name)).toEqual(["early"]);
      // A targeted read already answers "which agent", so the others are not
      // listed at all.
      expect(byName.context.agents_past).toBeUndefined();
      // A nameless background subagent is reachable by its id prefix, and its
      // entries only carry the spawning tool_use_id.
      const byPrefix = await dumpSession(SID, { ...base, agent: "a333" });
      expect(byPrefix.entries.map((e) => e.meta.description)).toEqual(["bg job"]);
      expect(byPrefix.context.agents?.map((a) => a.agent_id)).toEqual(["a3333333333333333"]);
    });

    test("--agent rejects unknown and ambiguous selectors, and --no-agent", async () => {
      const { configDir, dataDir } = agentFixture();
      const base = { dataDir, configDirs: [configDir] };
      expect((await rejection(dumpSession(SID, { ...base, agent: "nobody" }))).message).toContain(
        "no agent matches",
      );
      expect((await rejection(dumpSession(SID, { ...base, agent: "a" }))).message).toContain(
        "use more characters",
      );
      expect(
        (await rejection(dumpSession(SID, { ...base, agent: "early", noAgent: true }))).message,
      ).toContain("contradict each other");
    });

    test("--agent returns every round of a repeatedly delegated name", async () => {
      const { configDir, dataDir, transcript } = fixture();
      const subagentsDir = path.join(transcript.slice(0, -".jsonl".length), "subagents");
      fs.mkdirSync(subagentsDir, { recursive: true });
      for (const id of ["aretry-111111111111", "aretry-222222222222"]) {
        fs.writeFileSync(
          path.join(subagentsDir, `agent-${id}.meta.json`),
          JSON.stringify({ taskKind: "in_process_teammate", name: "retry" }),
        );
      }
      fs.writeFileSync(
        transcript,
        [
          row("2026-07-20T00:00:00Z", "assistant", [
            {
              type: "tool_use",
              id: "round-1",
              name: "Agent",
              input: { name: "retry", description: "retry job", prompt: "round one" },
            },
          ]),
          row("2026-07-20T00:00:01Z", "assistant", [
            {
              type: "tool_use",
              id: "round-2",
              name: "Agent",
              input: { name: "retry", description: "retry job", prompt: "round two" },
            },
          ]),
        ].join("\n") + "\n",
      );
      // Re-delegating the same job spawns a fresh agent per round under one
      // name. "Show me the retry work" means all the rounds, so the shared name
      // selects them all rather than demanding a choice between opaque ids.
      const dump = await dumpSession(SID, { dataDir, configDirs: [configDir], agent: "retry" });
      expect(dump.entries.map((e) => e.text)).toEqual(["round one", "round two"]);
      expect(dump.context.agents?.map((a) => a.agent_id)).toEqual([
        "aretry-111111111111",
        "aretry-222222222222",
      ]);
    });
  });
});

describe("agent roster ordering", () => {
  // The roster is built by walking `subagents/`, so its input order is whatever
  // readdir yields — insertion order on APFS, hash order on ext4. The sort has
  // to impose a total order on top of that; a comparator that can return 0 for
  // two distinct agents leaves them in filesystem order, which is how the
  // repeatedly-delegated-name dump came out one way on macOS and the other way
  // on Linux CI. These assertions are on the comparator itself so they fire on
  // every platform rather than only on the one whose readdir happens to
  // disagree with the expectation.
  function record(agentId: string, name?: string): ContextAgentRecord {
    return {
      agent: { agent_id: agentId, kind: "teammate", state: "unknown", ...(name ? { name } : {}) },
      tokens: [agentId],
    };
  }

  test("agents sharing a name are ordered by id, never left equal", () => {
    const first = record("aretry-111111111111", "retry");
    const second = record("aretry-222222222222", "retry");
    expect(compareContextAgents(first, second)).toBeLessThan(0);
    expect(compareContextAgents(second, first)).toBeGreaterThan(0);
  });

  test("distinct agents never compare equal, whichever fields they share", () => {
    // A comparator returning 0 hands the decision back to the filesystem, so
    // the contract is "0 only for the very same agent".
    const agents = [
      record("a111", "retry"),
      record("a222", "retry"),
      record("a333"),
      record("a444", "other"),
    ];
    for (const a of agents) {
      for (const b of agents) {
        if (a === b) expect(compareContextAgents(a, b)).toBe(0);
        else expect(compareContextAgents(a, b)).not.toBe(0);
      }
    }
  });

  test("sorting is independent of the order the roster arrived in", () => {
    const agents = [
      record("a333"),
      record("aretry-222222222222", "retry"),
      record("a444", "other"),
      record("aretry-111111111111", "retry"),
    ];
    const ids = (input: ContextAgentRecord[]) =>
      [...input].sort(compareContextAgents).map((r) => r.agent.agent_id);
    const expected = ["a333", "a444", "aretry-111111111111", "aretry-222222222222"];
    expect(ids(agents)).toEqual(expected);
    expect(ids([...agents].reverse())).toEqual(expected);
  });
});

describe("dump file output", () => {
  /** Minimum shape the writers care about: the session name they build the
   * file name from, and enough entries to see one line per entry. */
  function dump(): SessionDump {
    return {
      header: {
        session: SID,
        since: "2026-07-20T00:00:00.000Z",
        until: null,
        generated: "2026-07-20T01:00:00.000Z",
        format: "ccmsg-session-dump-v2",
      },
      context: {
        kind: "session-context",
        note: "n",
        todos: [],
        background: [],
        schedules: [],
        rooms: [],
      },
      entries: [
        { t: 0, kind: "user", from: null, to: null, text: "a", meta: {} },
        { t: 1, kind: "assistant", from: null, to: null, text: "b", meta: {} },
      ] as unknown as SessionDump["entries"],
    };
  }

  test("serializes header, context, then one line per entry", () => {
    const lines = formatJsonlDump(dump()).split("\n");
    // trailing newline leaves an empty final element: 2 + 2 entries + "".
    expect(lines.length).toBe(5);
    expect(lines[4]).toBe("");
    expect(JSON.parse(lines[0]!).format).toBe("ccmsg-session-dump-v2");
    expect(JSON.parse(lines[1]!).kind).toBe("session-context");
    expect(lines.slice(2, 4).map((l) => JSON.parse(l).text)).toEqual(["a", "b"]);
  });

  test("auto-names inside a directory by sid and local wall-clock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-dump-out-"));
    roots.push(root);
    const dir = path.join(root, "dumps");
    const at = new Date(2026, 6, 20, 9, 5, 3);
    const file = writeSessionDumpFile(dump(), { dir, at });
    expect(file).toBe(path.join(dir, `${SID}-20260720-090503.jsonl`));
    // The directory is created on demand: a fresh data dir has no dumps/ yet.
    expect(fs.readFileSync(file, "utf8")).toBe(formatJsonlDump(dump()));
  });

  test("writes an explicit path as given, resolved to an absolute one", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-dump-out-"));
    roots.push(root);
    const file = writeSessionDumpFile(dump(), { file: path.join(root, "nested", "mine.jsonl") });
    expect(file).toBe(path.join(root, "nested", "mine.jsonl"));
    expect(fs.existsSync(file)).toBe(true);
  });
});
