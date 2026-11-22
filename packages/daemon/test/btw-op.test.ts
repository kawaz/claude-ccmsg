// btw_ask / btw_cancel over the wire (DR-0060 §2, §5, §6), with the config's
// session_launcher.launch_command a fake that records its input and its
// environment and writes a canned stream-json (a btw's fork is a print launch
// of the launch command, DR-0064): what the command is handed, who may ask,
// what the tabs that follow the session are sent, and what is refused.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BTW_PROMPT_PREFIX,
  LaunchCommandInputSchema,
  jsonText,
  parseWith,
  type LaunchCommandInput,
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

/** A launch command that writes its standard input to `<dir>/input.json` and
 * its environment's CCMSG_* / TMPDIR / BTW_* keys to `<dir>/env.txt`, then
 * answers as `claude -p --output-format stream-json` would: a text block in
 * two deltas, and a successful result. With `answerAfter`, it waits that many
 * seconds before it answers. */
function fakeLaunchCommand(dir: string, answerAfter?: number): string {
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
    path.join(dir, "fake-launch"),
    `#!/bin/sh\ncat > ${JSON.stringify(path.join(dir, "input.json"))}\n` +
      `env | grep -E '^(CCMSG_|TMPDIR=|BTW_)' | sort > ${JSON.stringify(path.join(dir, "env.txt"))}\n` +
      (answerAfter !== undefined ? `sleep ${String(answerAfter)}\n` : "") +
      `${out}\n`,
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
  options: {
    launcher?: "fake" | "none" | "built-in";
    cleanEnv?: string[];
    env?: Record<string, string>;
    launchTimeoutSeconds?: number;
    answerAfter?: number;
  } = {},
): Promise<void> {
  const roots = { root_dirs: [dir] };
  const launcher = options.launcher ?? "fake";
  const ctx = await startInProcessDaemon({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(launcher === "none"
      ? {}
      : {
          config: {
            session_launcher:
              launcher === "built-in"
                ? roots
                : {
                    ...roots,
                    launch_command: [fakeLaunchCommand(dir, options.answerAfter)],
                    ...(options.cleanEnv !== undefined ? { clean_env: options.cleanEnv } : {}),
                    ...(options.launchTimeoutSeconds !== undefined
                      ? { launch_timeout_seconds: options.launchTimeoutSeconds }
                      : {}),
                  },
          },
        }),
  });
  try {
    await run(ctx);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

const InputText = jsonText(LaunchCommandInputSchema);

function inputOf(dir: string): LaunchCommandInput {
  const read = parseWith(InputText, fs.readFileSync(path.join(dir, "input.json"), "utf8"));
  if (!read.ok) throw new Error(`not a launch command input: ${read.failure.summary}`);
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

      // A fork under a new id of the daemon's.
      const { session_id: forkId, ...input } = inputOf(dir);
      expect(forkId).toMatch(/^[0-9a-f-]{36}$/);
      expect(forkId).not.toBe(SID);
      expect(input).toEqual({
        // The hello's cwd, as the daemon adopts it (its realpath).
        cwd: fs.realpathSync(files.cwd),
        resume: SID,
        fork_session: true,
        print: true,
        no_session_persistence: true,
        output_format: "stream-json",
        verbose: true,
        include_partial_messages: true,
        permission_prompts: "none",
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

  // DR-0064 §4: without a session_launcher section a daemon would run the
  // built-in launch command, which a test's daemon never runs (a real model
  // request); nor the one a section without launch_command names.
  test("a test's daemon given no launch command runs none: btw_launch_unavailable", async () => {
    for (const launcher of ["none", "built-in"] as const) {
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
        { launcher },
      );
    }
  });

  // DR-0064 §4: a btw has no deadline. launch_timeout_seconds is a launch's,
  // and a fork that answers past it is read to its end, not stopped. The wait
  // is the subject here: the command answers after the launch's deadline.
  test("a fork that answers after launch_timeout_seconds is not stopped", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(
      dir,
      async (ctx) => {
        await sessionConn(ctx, SID, { cwd: files.cwd, transcript_path: files.transcript });
        const watcher = await userConn(ctx);
        await watcher.requestOk({ op: "transcript_subscribe", sid: SID });
        await watcher.readEventUntil("btws");
        const user = await userConn(ctx);
        const asked = await user.requestOk({ op: "btw_ask", session_id: SID, prompt: "q" });
        const done = await watcher.readEventUntil(
          "btw",
          (ev) => ev.btw.id === asked.btw.id && ev.btw.status !== "running",
        );
        expect(done.ev.btw).toMatchObject({ status: "done", response: "pelican" });
      },
      { launchTimeoutSeconds: 1, answerAfter: 1.5 },
    );
  });

  // DR-0064 §4: the environment of a launch: clean_env applied, the TMPDIR a
  // launch gets, and who asked (the person).
  test("the launch command runs in a launch's environment, asked by user", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(
      dir,
      async (ctx) => {
        await sessionConn(ctx, SID, { cwd: files.cwd, transcript_path: files.transcript });
        const watcher = await userConn(ctx);
        await watcher.requestOk({ op: "transcript_subscribe", sid: SID });
        await watcher.readEventUntil("btws");
        const user = await userConn(ctx);
        const asked = await user.requestOk({ op: "btw_ask", session_id: SID, prompt: "q" });
        await watcher.readEventUntil(
          "btw",
          (ev) => ev.btw.id === asked.btw.id && ev.btw.status !== "running",
        );
        const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
        expect(env).toContain("CCMSG_LAUNCH_REQUESTED_BY=user\n");
        expect(env).toContain("BTW_OP_KEPT=y\n");
        expect(env).not.toContain("BTW_OP_DROPPED");
        expect(env).toMatch(/^TMPDIR=/m);
      },
      { cleanEnv: ["BTW_OP_DROPPED"], env: { BTW_OP_DROPPED: "x", BTW_OP_KEPT: "y" } },
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
