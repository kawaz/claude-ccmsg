// A btw's fork asked of the session's module (DR-0060 §2): which run is
// asked (the first whose module runs `model.fork`, as `describe` says), and
// what each way the request ends means for the btw — its answer, or the
// words of its failure, which say what to do next.
import { describe, expect, test } from "bun:test";
import {
  jsonText,
  parseWith,
  SIDECAR_OP_NAMES,
  type SidecarReply,
  SidecarRequestSchema,
} from "@ccmsg/protocol";
import { askModelFork, type BtwForkDeps } from "../src/btw-fork.ts";
import { SidecarReplies } from "../src/sidecar-call.ts";
import type { SidecarRun } from "../src/sidecar-runs.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const RequestTextSchema = jsonText(SidecarRequestSchema);
const USAGE = {
  input_tokens: 3,
  output_tokens: 8,
  cache_read_input_tokens: 77_332,
  cache_creation_input_tokens: 4,
};
const OLD_OPS = SIDECAR_OP_NAMES.filter((op) => op !== "model.fork");

function runOf(runId: string): SidecarRun {
  return { sid: SID, runId, startedAt: 1, socket: `/sidecars/${SID}.${runId}.sock` };
}

/** How a run's module answers: the ops it says it runs (`describe`), and its
 * reply to `model.fork` — a result, a failure, or none ("silent"). */
interface Module {
  ops: readonly string[] | "silent";
  fork?: { result: object } | { error: string } | "silent";
}

function deps(
  runs: Record<string, Module>,
  movedOn = false,
): { deps: BtwForkDeps; asked: string[] } {
  const replies = new SidecarReplies();
  let n = 0;
  const asked: string[] = [];
  return {
    asked,
    deps: {
      replies,
      newId: () => `id${String(++n)}`,
      now: Date.now,
      describeDeadlineMs: 50,
      forkDeadlineMs: 60_000 * 15,
      runs: {
        liveOf: (sid) => (sid === SID ? Object.keys(runs).map(runOf) : []),
        movedOn: () => movedOn,
      },
      write: async (socket, line) => {
        const runId = /\.([0-9a-z]+)\.sock$/.exec(socket)?.[1] ?? "";
        const module = runs[runId];
        const read = parseWith(RequestTextSchema, line);
        if (module === undefined || !read.ok) return "not_written";
        const request = read.value;
        asked.push(`${runId}:${request.op}`);
        let reply: SidecarReply | undefined;
        if (request.op === "describe" && module.ops !== "silent") {
          reply = { id: request.id, ok: true, result: { v: [1], ops: [...module.ops] } };
        } else if (request.op === "model.fork" && module.fork !== undefined) {
          const fork = module.fork;
          if (fork === "silent") reply = undefined;
          else if ("error" in fork) {
            reply = { id: request.id, ok: false, error: { code: "internal", message: fork.error } };
          } else reply = { id: request.id, ok: true, result: fork.result };
        }
        if (reply !== undefined) replies.take(SID, reply);
        return "written";
      },
    },
  };
}

describe("askModelFork", () => {
  test("the answer, its usage and the effort it ran at", async () => {
    const { deps: d, asked } = deps({
      run1: {
        ops: SIDECAR_OP_NAMES,
        fork: { result: { outcome: "answered", text: "X", usage: USAGE, effort: "low" } },
      },
    });
    expect(await askModelFork(SID, "q", "low", d)).toEqual({
      status: "done",
      text: "X",
      usage: USAGE,
      effort: "low",
    });
    expect(asked).toEqual(["run1:describe", "run1:model.fork"]);
  });

  // A run whose module is older is passed over for one that forks.
  test("the first run whose module forks is asked, an older one passed over", async () => {
    const { deps: d, asked } = deps({
      run1: { ops: OLD_OPS },
      run2: {
        ops: SIDECAR_OP_NAMES,
        fork: { result: { outcome: "answered", text: "X", usage: USAGE } },
      },
    });
    expect(await askModelFork(SID, "q", undefined, d)).toMatchObject({ status: "done" });
    expect(asked).toEqual(["run1:describe", "run2:describe", "run2:model.fork"]);
  });

  test("nothing to fork yet: failed, saying to send the session something first", async () => {
    const { deps: d } = deps({
      run1: {
        ops: SIDECAR_OP_NAMES,
        fork: { result: { outcome: "not_answered", reason: "nothing-to-fork" } },
      },
    });
    expect(await askModelFork(SID, "q", undefined, d)).toEqual({
      status: "failed",
      reason: "nothing-to-fork",
      error:
        "本体がまだ 1 回も応答していないので聞けない (resume の直後や /clear の後)。本体に何か送ってからもう一度",
    });
  });

  test("an API error: its status and kind, and what it cost", async () => {
    const { deps: d } = deps({
      run1: {
        ops: SIDECAR_OP_NAMES,
        fork: {
          result: {
            outcome: "not_answered",
            reason: "api-error",
            status: 529,
            error: "overloaded",
            usage: USAGE,
          },
        },
      },
    });
    const end = await askModelFork(SID, "q", undefined, d);
    expect(end).toMatchObject({ status: "failed", reason: "api-error", usage: USAGE });
    expect(end.status === "failed" ? end.error : "").toContain("status 529, overloaded");
  });

  test("a reply with no text: failed, naming that a btw has no tools", async () => {
    const { deps: d } = deps({
      run1: {
        ops: SIDECAR_OP_NAMES,
        fork: { result: { outcome: "not_answered", reason: "empty-reply", usage: USAGE } },
      },
    });
    const end = await askModelFork(SID, "直して", undefined, d);
    expect(end).toMatchObject({ status: "failed", reason: "empty-reply" });
    expect(end.status === "failed" ? end.error : "").toContain("tool を使えない");
  });

  test("the module's op failing: failed with its words", async () => {
    const { deps: d } = deps({
      run1: { ops: SIDECAR_OP_NAMES, fork: { error: "Error: model.fork: bad effort" } },
    });
    expect(await askModelFork(SID, "q", undefined, d)).toEqual({
      status: "failed",
      reason: "internal",
      error: "module で fork が失敗した: Error: model.fork: bad effort",
    });
  });

  test("a result of another shape: failed as unreadable, saying to restart", async () => {
    const { deps: d } = deps({
      run1: { ops: SIDECAR_OP_NAMES, fork: { result: { outcome: "forked" } } },
    });
    const end = await askModelFork(SID, "q", undefined, d);
    expect(end).toMatchObject({ status: "failed", reason: "unreadable" });
    expect(end.status === "failed" ? end.error : "").toContain("再起動");
  });

  test("an answer that does not come in time: failed as timeout", async () => {
    const { deps: d } = deps({ run1: { ops: SIDECAR_OP_NAMES, fork: "silent" } });
    const end = await askModelFork(SID, "q", undefined, { ...d, forkDeadlineMs: 30 });
    expect(end).toMatchObject({ status: "failed", reason: "timeout" });
  });

  // DR-0039 §7: a session without such a module cannot be asked; no other
  // route is tried.
  test("only older modules: failed as old_module, saying to restart the session", async () => {
    const { deps: d, asked } = deps({ run1: { ops: OLD_OPS } });
    expect(await askModelFork(SID, "q", undefined, d)).toEqual({
      status: "failed",
      reason: "old_module",
      error:
        "このセッションの ccmsg の module が古く、btw の fork を知らない。セッションを再起動すると聞けるようになる",
    });
    expect(asked).toEqual(["run1:describe"]);
  });

  test("no module answering describe: failed as no_answer", async () => {
    const { deps: d } = deps({ run1: { ops: "silent" } });
    expect(await askModelFork(SID, "q", undefined, d)).toMatchObject({
      status: "failed",
      reason: "no_answer",
    });
  });

  test("no run: no_module, or session_changed for a session that moved to another id", async () => {
    expect(await askModelFork(SID, "q", undefined, deps({}).deps)).toMatchObject({
      status: "failed",
      reason: "no_module",
    });
    expect(await askModelFork(SID, "q", undefined, deps({}, true).deps)).toMatchObject({
      status: "failed",
      reason: "session_changed",
    });
  });
});
