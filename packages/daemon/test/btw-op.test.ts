// btw_ask / btw_cancel over the wire (DR-0060 §2, §5, §6), with the
// session's hooks module a fake sidecar the test answers: the daemon asks the
// module which ops it runs (`describe`) and then `fork.ask`, and the
// module's result is the btw's answer. What the module is asked, who may ask,
// what the tabs that follow the session are sent, and what is refused.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BTW_PROMPT_PREFIX, SIDECAR_OP_NAMES, type SidecarRequest } from "@ccmsg/protocol";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { btwFile } from "../src/btw.ts";
import { fakeSidecar, nextRequest, sidecarReply } from "./fake-sidecar.ts";
import {
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
  type TestClient,
} from "./helpers.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const USAGE = {
  input_tokens: 3,
  output_tokens: 7,
  cache_read_input_tokens: 63_729,
  cache_creation_input_tokens: 0,
};
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
): Promise<void> {
  const ctx = await startInProcessDaemon({ config: { session_launcher: { root_dirs: [dir] } } });
  try {
    await run(ctx);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

/** Answer the daemon's next request on `sidecar` (past session.facts) as the
 * module: describe with `ops`, and hand the request on to `then`. */
async function answerDescribe(
  sidecar: { lines: AsyncGenerator<string, void> },
  module: TestClient,
  ops: readonly string[],
): Promise<void> {
  const asked = await nextRequest(sidecar);
  expect(asked.op).toBe("describe");
  await module.requestOk(
    sidecarReply({ id: asked.id, ok: true, result: { v: [1], ops: [...ops] } }),
  );
}

describe("btw_ask", () => {
  test("the session's module is asked a fork with the prefixed prompt and the chosen effort; a tab that follows the session sees its answer and usage", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(dir, async (ctx) => {
      const module = await sessionConn(ctx, SID, {
        cwd: files.cwd,
        transcript_path: files.transcript,
      });
      const sidecar = await fakeSidecar(
        { sock: ctx.sock, stateDir: path.join(ctx.base, "s") },
        SID,
        "run1",
      );
      try {
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
        await answerDescribe(sidecar, module, SIDECAR_OP_NAMES);
        const fork: SidecarRequest = await nextRequest(sidecar);
        expect(fork).toMatchObject({
          v: 1,
          op: "fork.ask",
          id: fork.id,
          args: { prompt: `${BTW_PROMPT_PREFIX}\n\nさっきの単語は?`, effort: "low" },
        });
        await module.requestOk(
          sidecarReply({
            id: fork.id,
            ok: true,
            result: { outcome: "answered", text: "pelican", usage: USAGE, effort: "low" },
          }),
        );
        const done = await viewer.readEventUntil(
          "btw",
          (ev) => ev.btw.id === asked.btw.id && ev.btw.status !== "running",
        );
        expect(done.ev.btw).toMatchObject({
          status: "done",
          response: "pelican",
          usage: USAGE,
          effort: "low",
        });
        // The asking tab follows no session: it is sent nothing.
        expect((await asker.pendingEvents()).filter((ev) => "ev" in ev && ev.ev === "btw")).toEqual(
          [],
        );
        // Kept: a tab that follows the session later is sent it.
        const later = await userConn(ctx);
        await later.requestOk({ op: "transcript_subscribe", sid: SID });
        const listed = await later.readEventUntil("btws");
        expect(listed.ev.btws.map((b) => [b.id, b.status])).toEqual([[asked.btw.id, "done"]]);
        expect(fs.existsSync(btwFile(path.join(ctx.base, "s"), SID))).toBe(true);
      } finally {
        sidecar.close();
      }
    });
  });

  // A module that runs no fork.ask (a session started on an older plugin)
  // cannot be asked: the btw fails, and the person is told to restart.
  test("a module that does not know fork.ask: failed, with a restart to do", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(dir, async (ctx) => {
      const module = await sessionConn(ctx, SID, {
        cwd: files.cwd,
        transcript_path: files.transcript,
      });
      const sidecar = await fakeSidecar(
        { sock: ctx.sock, stateDir: path.join(ctx.base, "s") },
        SID,
        "run1",
      );
      try {
        const viewer = await userConn(ctx);
        await viewer.requestOk({ op: "transcript_subscribe", sid: SID });
        await viewer.readEventUntil("btws");
        const user = await userConn(ctx);
        const asked = await user.requestOk({ op: "btw_ask", session_id: SID, prompt: "q" });
        await answerDescribe(
          sidecar,
          module,
          SIDECAR_OP_NAMES.filter((op) => op !== "fork.ask" && op !== "fork.stop"),
        );
        const done = await viewer.readEventUntil(
          "btw",
          (ev) => ev.btw.id === asked.btw.id && ev.btw.status !== "running",
        );
        expect(done.ev.btw.status).toBe("failed");
        expect(done.ev.btw.error).toContain("再起動");
      } finally {
        sidecar.close();
      }
    });
  });

  test("a session without a hooks module: failed as no_module", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(dir, async (ctx) => {
      await sessionConn(ctx, SID, { cwd: files.cwd, transcript_path: files.transcript });
      const viewer = await userConn(ctx);
      await viewer.requestOk({ op: "transcript_subscribe", sid: SID });
      await viewer.readEventUntil("btws");
      const user = await userConn(ctx);
      const asked = await user.requestOk({ op: "btw_ask", session_id: SID, prompt: "q" });
      const done = await viewer.readEventUntil(
        "btw",
        (ev) => ev.btw.id === asked.btw.id && ev.btw.status !== "running",
      );
      expect(done.ev.btw.status).toBe("failed");
      expect(done.ev.btw.error).toStartWith("no_module:");
    });
  });

  test("a session's agent may not ask (bad_request)", async () => {
    const dir = tmp("btw-op-");
    const files = sessionFiles(dir);
    await withDaemon(dir, async (ctx) => {
      const session = await sessionConn(ctx, SID, {
        cwd: files.cwd,
        transcript_path: files.transcript,
      });
      const refused = await session.requestError({ op: "btw_ask", session_id: SID, prompt: "q" });
      expect(refused.error.code).toBe("bad_request");
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
