// A btw's fork asked of the session's module (DR-0060 §2): which run is
// asked (the first whose module runs `fork.ask`, as `describe` says), when
// the fork is stopped (`fork.stop`: the btw stopped from here, or out of
// time), and what each way the request ends means for the btw — its answer,
// or the words of its failure, which say what to do next.
import { describe, expect, test } from "bun:test";
import {
  jsonText,
  parseWith,
  SIDECAR_OP_NAMES,
  type SidecarReply,
  SidecarRequestSchema,
} from "@ccmsg/protocol";
import { askBtwFork, type BtwForkDeps } from "../src/btw-fork.ts";
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
const OLD_OPS = SIDECAR_OP_NAMES.filter((op) => op !== "fork.ask" && op !== "fork.stop");

function runOf(runId: string): SidecarRun {
  return { sid: SID, runId, startedAt: 1, socket: `/sidecars/${SID}.${runId}.sock` };
}

/** How a run's module answers: the ops it says it runs (`describe`), and its
 * reply to `fork.ask` — a result, a failure, or none ("silent"); a
 * `fork.stop` is answered `stopped`. */
interface Module {
  ops: readonly string[] | "silent";
  fork?: { result: object } | { error: string } | "silent";
}

function deps(
  runs: Record<string, Module>,
  movedOn = false,
): { deps: BtwForkDeps; asked: string[]; logs: string[] } {
  const replies = new SidecarReplies();
  let n = 0;
  const asked: string[] = [];
  const logs: string[] = [];
  return {
    asked,
    logs,
    deps: {
      replies,
      newId: () => `id${String(++n)}`,
      now: Date.now,
      describeDeadlineMs: 50,
      forkDeadlineMs: 60_000 * 15,
      log: (msg) => logs.push(msg),
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
        asked.push(
          request.op === "fork.ask" || request.op === "fork.stop"
            ? `${runId}:${request.op}:${request.args.key}`
            : `${runId}:${request.op}`,
        );
        let reply: SidecarReply | undefined;
        if (request.op === "describe" && module.ops !== "silent") {
          reply = { id: request.id, ok: true, result: { v: [1], ops: [...module.ops] } };
        } else if (request.op === "fork.stop") {
          reply = { id: request.id, ok: true, result: { outcome: "stopped" } };
        } else if (request.op === "fork.ask" && module.fork !== undefined) {
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

/** A stop that never aborts. */
const RUNNING = new AbortController().signal;

describe("askBtwFork", () => {
  test("the answer, its usage and the effort it ran at", async () => {
    const { deps: d, asked } = deps({
      run1: {
        ops: SIDECAR_OP_NAMES,
        fork: { result: { outcome: "answered", text: "X", usage: USAGE, effort: "low" } },
      },
    });
    expect(await askBtwFork(SID, "q", "low", RUNNING, d)).toEqual({
      status: "done",
      text: "X",
      usage: USAGE,
      effort: "low",
    });
    // The key is the fork's, which a fork.stop would name.
    expect(asked).toEqual(["run1:describe", "run1:fork.ask:id2"]);
  });

  // A fork whose turn's end never came is answered without what it cost.
  test("an answer without usage: done, with none", async () => {
    const { deps: d } = deps({
      run1: { ops: SIDECAR_OP_NAMES, fork: { result: { outcome: "answered", text: "X" } } },
    });
    expect(await askBtwFork(SID, "q", undefined, RUNNING, d)).toEqual({
      status: "done",
      text: "X",
    });
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
    expect(await askBtwFork(SID, "q", undefined, RUNNING, d)).toMatchObject({ status: "done" });
    expect(asked).toEqual(["run1:describe", "run2:describe", "run2:fork.ask:id3"]);
  });

  // Each way the module says the fork gave no answer, in words that say what
  // to do next.
  test.each([
    ["old_engine", { message: "2.1.329" }, "Claude Code を 2.1.330 以降にすると聞けるようになる"],
    ["denied", { message: "past the agent limit" }, "fork を起こせなかった (past the agent limit)"],
    ["failed", { message: "途中まで" }, "fork が途中で失敗した"],
    ["stopped", {}, "セッションの側で止められた"],
    ["empty", {}, "答えに文が無かった"],
  ])("not answered (%s): failed, with what to do next", async (reason, extra, words) => {
    const { deps: d } = deps({
      run1: {
        ops: SIDECAR_OP_NAMES,
        fork: { result: { outcome: "not_answered", reason, usage: USAGE, ...extra } },
      },
    });
    const end = await askBtwFork(SID, "q", undefined, RUNNING, d);
    expect(end).toMatchObject({ status: "failed", reason, usage: USAGE });
    expect(end.status === "failed" ? end.error : "").toContain(words);
  });

  // The stop goes to the run the fork was asked of, under the fork's key.
  test("a stop from here stops the fork in the session (fork.stop), and logs it", async () => {
    const stopper = new AbortController();
    const {
      deps: d,
      asked,
      logs,
    } = deps({
      run1: { ops: SIDECAR_OP_NAMES, fork: "silent" },
    });
    const ended = askBtwFork(SID, "q", undefined, stopper.signal, { ...d, forkDeadlineMs: 200 });
    for (let i = 0; i < 50 && !asked.includes("run1:fork.ask:id2"); i++) await Bun.sleep(1);
    stopper.abort();
    await ended;
    expect(asked).toEqual(["run1:describe", "run1:fork.ask:id2", "run1:fork.stop:id2"]);
    expect(logs).toContain(`btw_fork_stop: session_id=${SID} key=id2 why=canceled outcome=stopped`);
  });

  test("stopped before the fork was asked: nothing is asked", async () => {
    const stopper = new AbortController();
    stopper.abort();
    const { deps: d, asked } = deps({ run1: { ops: SIDECAR_OP_NAMES, fork: "silent" } });
    expect(await askBtwFork(SID, "q", undefined, stopper.signal, d)).toMatchObject({
      status: "failed",
      reason: "canceled",
    });
    expect(asked).toEqual(["run1:describe"]);
  });

  test("the module's op failing: failed with its words", async () => {
    const { deps: d } = deps({
      run1: { ops: SIDECAR_OP_NAMES, fork: { error: "Error: agent.spawn: refused" } },
    });
    expect(await askBtwFork(SID, "q", undefined, RUNNING, d)).toEqual({
      status: "failed",
      reason: "internal",
      error: "module で fork が失敗した: Error: agent.spawn: refused",
    });
  });

  test("a result of another shape: failed as unreadable, saying to restart", async () => {
    const { deps: d } = deps({
      run1: { ops: SIDECAR_OP_NAMES, fork: { result: { outcome: "forked" } } },
    });
    const end = await askBtwFork(SID, "q", undefined, RUNNING, d);
    expect(end).toMatchObject({ status: "failed", reason: "unreadable" });
    expect(end.status === "failed" ? end.error : "").toContain("再起動");
  });

  // Out of time, the fork is stopped: it would go on using the session's
  // tools for an answer no one waits for.
  test("an answer that does not come in time: failed as timeout, and the fork stopped", async () => {
    const { deps: d, asked } = deps({ run1: { ops: SIDECAR_OP_NAMES, fork: "silent" } });
    const end = await askBtwFork(SID, "q", undefined, RUNNING, { ...d, forkDeadlineMs: 30 });
    expect(end).toMatchObject({ status: "failed", reason: "timeout" });
    for (let i = 0; i < 50 && asked.length < 3; i++) await Bun.sleep(1);
    expect(asked).toEqual(["run1:describe", "run1:fork.ask:id2", "run1:fork.stop:id2"]);
  });

  // DR-0039 §7: a session without such a module cannot be asked; no other
  // route is tried.
  test("only older modules: failed as old_module, saying to restart the session", async () => {
    const { deps: d, asked } = deps({ run1: { ops: OLD_OPS } });
    expect(await askBtwFork(SID, "q", undefined, RUNNING, d)).toEqual({
      status: "failed",
      reason: "old_module",
      error:
        "このセッションの ccmsg の module が古く、btw の fork を知らない。セッションを再起動すると聞けるようになる",
    });
    expect(asked).toEqual(["run1:describe"]);
  });

  test("no module answering describe: failed as no_answer", async () => {
    const { deps: d } = deps({ run1: { ops: "silent" } });
    expect(await askBtwFork(SID, "q", undefined, RUNNING, d)).toMatchObject({
      status: "failed",
      reason: "no_answer",
    });
  });

  test("no run: no_module, or session_changed for a session that moved to another id", async () => {
    expect(await askBtwFork(SID, "q", undefined, RUNNING, deps({}).deps)).toMatchObject({
      status: "failed",
      reason: "no_module",
    });
    expect(await askBtwFork(SID, "q", undefined, RUNNING, deps({}, true).deps)).toMatchObject({
      status: "failed",
      reason: "session_changed",
    });
  });
});
