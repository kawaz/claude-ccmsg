// btw_ask / btw_cancel over the wire (DR-0060 §2, §5, §6), with the config's
// btw_command a fake that records its input and writes a canned stream-json:
// what the command is handed, who may ask, what the tabs that follow the
// session are sent, and what is refused.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BTW_PROMPT_PREFIX,
  BtwCommandInputSchema,
  jsonText,
  parseWith,
  type BtwCommandInput,
} from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { btwFile } from "../src/btw.ts";
import {
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
} from "./helpers.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";

/** A btw command that writes its standard input to `<dir>/input.json`, then
 * answers as `claude -p --output-format stream-json` would: a text block in
 * two deltas, and a successful result. */
function fakeBtwCommand(dir: string): string {
  const lines = [
    { type: "system", subtype: "init", session_id: "fork" },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "m1" } },
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pel" } },
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ican" } },
    },
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", content: [{ type: "text", text: "pelican" }] },
    },
    { type: "result", subtype: "success", is_error: false, result: "pelican" },
  ];
  const out = lines.map((l) => `printf '%s\\n' '${JSON.stringify(l)}'`).join("\n");
  return writeMockBin(
    path.join(dir, "fake-btw"),
    `#!/bin/sh\ncat > ${JSON.stringify(path.join(dir, "input.json"))}\n${out}\n`,
  );
}

/** A session whose transcript is `<config dir>/projects/p/<sid>.jsonl`, with
 * rows of uuids `u-1` and `u-2` and a row of none after them. */
function sessionFiles(base: string): { cwd: string; configDir: string; transcript: string } {
  const cwd = path.join(base, "repo");
  const configDir = path.join(base, ".claude-x");
  const transcript = path.join(configDir, "projects", "p", `${SID}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-11-22T00:00:00.000Z" }),
      JSON.stringify({ type: "assistant", uuid: "u-2", timestamp: "2026-11-22T00:00:01.000Z" }),
      JSON.stringify({ type: "last-prompt", leafUuid: "u-2" }),
      "",
    ].join("\n"),
  );
  return { cwd, configDir, transcript };
}

async function withDaemon(
  dir: string,
  run: (ctx: InProcessDaemon) => Promise<void>,
  options: { btwCommand?: boolean } = {},
): Promise<void> {
  const ctx = await startInProcessDaemon(
    options.btwCommand === false ? {} : { config: { btw_command: [fakeBtwCommand(dir)] } },
  );
  try {
    await run(ctx);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

const InputText = jsonText(BtwCommandInputSchema);

function inputOf(dir: string): BtwCommandInput {
  const read = parseWith(InputText, fs.readFileSync(path.join(dir, "input.json"), "utf8"));
  if (!read.ok) throw new Error(`not a btw command input: ${read.failure.summary}`);
  return read.value;
}

describe("btw_ask", () => {
  test("the fake command is handed the session's place and the prefixed prompt; a tab that follows the session sees the btw run to its answer", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(dir, async (ctx) => {
      await sessionConn(ctx, SID, { cwd: files.cwd, transcript_path: files.transcript });
      const viewer = await userConn(ctx);
      await viewer.requestOk({ op: "transcript_subscribe", sid: SID });
      const first = await viewer.readEventUntil("btws");
      expect(first.ev).toEqual({ ev: "btws", session_id: SID, btws: [] });

      const asker = await userConn(ctx);
      const asked = await asker.requestOk({
        op: "btw_ask",
        session_id: SID,
        prompt: "さっきの単語は?",
        effort: "low",
      });
      expect(asked.btw).toMatchObject({
        session_id: SID,
        after_uuid: "u-2",
        prompt: "さっきの単語は?",
        status: "running",
        effort: "low",
      });
      const done = await viewer.readEventUntil(
        "btw",
        (ev) => ev.btw.id === asked.btw.id && ev.btw.status !== "running",
      );
      expect(done.ev.btw).toMatchObject({ status: "done", response: "pelican" });
      // The asking tab follows no session: it is sent nothing.
      expect((await asker.pendingEvents()).filter((ev) => "ev" in ev && ev.ev === "btw")).toEqual(
        [],
      );

      expect(inputOf(dir)).toEqual({
        // The hello's cwd, as the daemon adopts it (its realpath).
        cwd: fs.realpathSync(files.cwd),
        config_dir: files.configDir,
        resume: SID,
        effort: "low",
        prompt: `${BTW_PROMPT_PREFIX}\n\nさっきの単語は?`,
      });

      // Kept: a tab that follows the session later is sent it.
      const later = await userConn(ctx);
      await later.requestOk({ op: "transcript_subscribe", sid: SID });
      const listed = await later.readEventUntil("btws");
      expect(listed.ev.btws.map((b) => [b.id, b.status])).toEqual([[asked.btw.id, "done"]]);
      expect(fs.existsSync(btwFile(path.join(ctx.base, "s"), SID))).toBe(true);
    });
  });

  test("a session started as sonnet[1m] at effort low forks as claude-sonnet-5-5[1m] at low, after a one-shot max", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    // The last answer ran on a one-shot max (DR-0041 §4).
    fs.appendFileSync(
      files.transcript,
      `${JSON.stringify({
        type: "assistant",
        uuid: "u-3",
        isSidechain: false,
        timestamp: "2026-11-22T00:00:02.000Z",
        effort: "max",
        message: { model: "claude-sonnet-5-5", role: "assistant", content: [] },
      })}\n`,
    );
    await withDaemon(dir, async (ctx) => {
      const module = await sessionConn(ctx, SID, {
        cwd: files.cwd,
        transcript_path: files.transcript,
      });
      // What the session's hooks module says: its own model and effort.
      await module.requestOk({
        op: "session_facts",
        facts: {
          at: 1,
          model: "sonnet[1m]",
          effort: "low",
          context: { window: 1_000_000, at: 1 },
          request_override: {
            session: { model: "sonnet[1m]", effort: "low" },
            once: { model: null, effort: null },
          },
        },
      });
      const watcher = await userConn(ctx);
      await watcher.requestOk({ op: "transcript_subscribe", sid: SID });
      await watcher.readEventUntil("btws");
      const user = await userConn(ctx);
      const asked = await user.requestOk({ op: "btw_ask", session_id: SID, prompt: "q" });
      expect(asked.btw).toMatchObject({ model: "claude-sonnet-5-5[1m]", effort: "low" });
      await watcher.readEventUntil(
        "btw",
        (ev) => ev.btw.id === asked.btw.id && ev.btw.status !== "running",
      );
      expect(inputOf(dir)).toMatchObject({ model: "claude-sonnet-5-5[1m]", effort: "low" });
    });
  });

  test("a session's agent may not ask (bad_request), and starts nothing", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(dir, async (ctx) => {
      const session = await sessionConn(ctx, SID, {
        cwd: files.cwd,
        transcript_path: files.transcript,
      });
      const refused = await session.requestError({ op: "btw_ask", session_id: SID, prompt: "q" });
      expect(refused.error.code).toBe("bad_request");
      expect(fs.existsSync(path.join(dir, "input.json"))).toBe(false);
    });
  });

  test("a session the daemon does not know is session_not_found", async () => {
    const dir = tmp("btw-op-");
    await withDaemon(dir, async (ctx) => {
      const user = await userConn(ctx);
      const refused = await user.requestError({ op: "btw_ask", session_id: SID, prompt: "q" });
      expect(refused.error.code).toBe("session_not_found");
    });
  });

  test("a test's daemon given no btw_command runs none: btw_launch_unavailable", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(
      dir,
      async (ctx) => {
        await sessionConn(ctx, SID, { cwd: files.cwd, transcript_path: files.transcript });
        const user = await userConn(ctx);
        const refused = await user.requestError({ op: "btw_ask", session_id: SID, prompt: "q" });
        expect(refused.error.code).toBe("btw_launch_unavailable");
      },
      { btwCommand: false },
    );
  });
});

describe("btw_cancel", () => {
  test("an id with no btw is not_found; a session's agent may not cancel", async () => {
    const dir = tmp("btw-op-");
    await withDaemon(dir, async (ctx) => {
      const user = await userConn(ctx);
      expect((await user.requestError({ op: "btw_cancel", id: "nope" })).error.code).toBe(
        "not_found",
      );
      const session = await sessionConn(ctx, SID);
      expect((await session.requestError({ op: "btw_cancel", id: "nope" })).error.code).toBe(
        "bad_request",
      );
    });
  });
});
