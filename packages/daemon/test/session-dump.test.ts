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
      format: "ccmsg-session-dump-v1",
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
