// A btw comment over the wire (DR-0062 §14, DR-0060 §1): `comment_add` with
// the btw flag, sent now, and the session's hooks module a fake sidecar the
// test answers: the daemon asks the module which ops it runs (`describe`) and
// then `fork.ask`, and the module's result is the answer's record. What the
// module is asked, what the tabs that look at the session are sent, and how a
// session whose module cannot fork ends its answer.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BTW_PROMPT_PREFIX,
  parseCommentBlocks,
  SIDECAR_OP_NAMES,
  type SidecarRequest,
} from "@ccmsg/protocol";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { commentsFile } from "../src/comments.ts";
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

/** Ask a btw at the moment of the conversation from a tab of its own, and
 * say what the daemon made of it. */
async function askBtw(ctx: InProcessDaemon, body: string) {
  const asker = await userConn(ctx);
  const added = await asker.requestOk({
    op: "comment_add",
    session_id: SID,
    anchor: { kind: "timing" },
    body,
    btw: true,
    send_now: true,
  });
  return { asker, question: added.comment, outcome: added.outcome };
}

/** The answer to `question` once it ended, as a tab that looks at the
 * session is told it. */
async function endedAnswer(viewer: TestClient, question: string) {
  const told = await viewer.readEventUntil(
    "comment",
    (ev) =>
      ev.comment.author === "btw" &&
      ev.comment.anchor.kind === "comment" &&
      ev.comment.anchor.cid === question &&
      ev.comment.status !== "running",
  );
  const answer = told.ev.comment;
  if (answer.author !== "btw") throw new Error(`told a ${answer.author}'s comment`);
  return answer;
}

/** A tab that looks at the session, past the comments it is sent first. */
async function viewerOf(ctx: InProcessDaemon): Promise<TestClient> {
  const viewer = await userConn(ctx);
  await viewer.requestOk({ op: "session_status_subscribe", sid: SID });
  await viewer.readEventUntil("comments");
  return viewer;
}

describe("a btw comment asked of the session's module", () => {
  // A fork runs on the session's model and effort: the answer names the level
  // the fork ran at and what it cost, and the question's block goes after the
  // prefix.
  test("the module is asked a fork with the prefixed block; a tab that looks at the session sees the answer, its usage and the effort it ran at", async () => {
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
        const viewer = await viewerOf(ctx);
        const asking = askBtw(ctx, "さっきの単語は?");
        await answerDescribe(sidecar, module, SIDECAR_OP_NAMES);
        const fork: SidecarRequest = await nextRequest(sidecar);
        const { asker, question, outcome } = await asking;
        expect(outcome).toEqual({ kind: "comment", id: question.cid, outcome: "btw_started" });
        // Sent at the transcript's last row then: what the fork read up to.
        expect(question).toMatchObject({ status: "sent", sent: { after_uuid: "u-2" } });
        if (fork.op !== "fork.ask") throw new Error(`asked ${fork.op}, not fork.ask`);
        expect(Object.keys(fork.args).toSorted()).toEqual(["key", "prompt"]);
        const prefix = `${BTW_PROMPT_PREFIX}\n\n`;
        expect(fork.args.prompt.startsWith(prefix)).toBe(true);
        expect(parseCommentBlocks(fork.args.prompt.slice(prefix.length))).toEqual([
          { comment: question.cid, body: "さっきの単語は?" },
        ]);
        await module.requestOk(
          sidecarReply({
            id: fork.id,
            ok: true,
            result: { outcome: "answered", text: "pelican", usage: USAGE, effort: "low" },
          }),
        );
        expect(await endedAnswer(viewer, question.cid)).toMatchObject({
          status: "done",
          body: "pelican",
          usage: USAGE,
          effort: "low",
        });
        // The asking tab looks at no session: it is sent no comment.
        expect(
          (await asker.pendingEvents()).filter((ev) => "ev" in ev && ev.ev === "comment"),
        ).toEqual([]);
        // Kept: a tab that looks at the session later is sent it.
        const later = await userConn(ctx);
        await later.requestOk({ op: "session_status_subscribe", sid: SID });
        const listed = await later.readEventUntil("comments");
        expect(
          listed.ev.comments.map((c) => [c.author, c.author === "agent" ? "-" : c.status]),
        ).toEqual([
          ["user", "sent"],
          ["btw", "done"],
        ]);
        expect(fs.existsSync(commentsFile(path.join(ctx.base, "s"), SID))).toBe(true);
      } finally {
        sidecar.close();
      }
    });
  });

  // A module that runs no fork.ask (a session started on an older plugin)
  // cannot be asked: the answer fails, and the person is told to restart.
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
        const viewer = await viewerOf(ctx);
        const asking = askBtw(ctx, "q");
        await answerDescribe(
          sidecar,
          module,
          SIDECAR_OP_NAMES.filter((op) => op !== "fork.ask" && op !== "fork.stop"),
        );
        const { question } = await asking;
        const answer = await endedAnswer(viewer, question.cid);
        expect(answer.status).toBe("failed");
        expect(answer.error).toContain("再起動");
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
      const viewer = await viewerOf(ctx);
      const { question } = await askBtw(ctx, "q");
      const answer = await endedAnswer(viewer, question.cid);
      expect(answer.status).toBe("failed");
      expect(answer.error).toStartWith("no_module:");
    });
  });
});
