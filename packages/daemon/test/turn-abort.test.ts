// turn_abort as the daemon reads the modules' answers (DR-0044 §2): every
// live run is asked at once, one stopping it is enough, and a missing answer
// is not taken for "no turn".
import { describe, expect, test } from "bun:test";
import {
  jsonText,
  parseWith,
  type SidecarReply,
  SidecarRequestSchema,
  type TurnAbortResult,
} from "@ccmsg/protocol";
import { SidecarReplies } from "../src/sidecar-call.ts";
import type { SidecarRun } from "../src/sidecar-runs.ts";
import { abortTurn, type TurnAbortDeps } from "../src/turn-abort.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const RequestTextSchema = jsonText(SidecarRequestSchema);

function runOf(runId: string): SidecarRun {
  return { sid: SID, runId, startedAt: 1, socket: `/sidecars/${SID}.${runId}.sock` };
}

/** How a run behaves: takes no line, takes it and says nothing, answers a
 * result, or answers something that is not turn.abort's. */
type Behaviour = "unwritten" | "silent" | "garbled" | TurnAbortResult;

/** Deps whose runs behave as `runs` says, by run id. */
function deps(
  runs: Record<string, Behaviour>,
  session: { running: boolean; movedOn?: boolean } = { running: true },
): { deps: TurnAbortDeps; written: string[] } {
  const replies = new SidecarReplies();
  let n = 0;
  const written: string[] = [];
  return {
    written,
    deps: {
      replies,
      newId: () => `id${++n}`,
      now: Date.now,
      deadlineMs: 50,
      runs: {
        liveOf: (sid) => (sid === SID ? Object.keys(runs).map(runOf) : []),
        movedOn: () => session.movedOn === true,
      },
      isRunning: () => session.running,
      write: async (socket, line) => {
        const runId = /\.([0-9a-z]+)\.sock$/.exec(socket)?.[1] ?? "";
        const behaviour = runs[runId];
        if (behaviour === undefined || behaviour === "unwritten") return "not_written";
        written.push(line);
        const read = parseWith(RequestTextSchema, line);
        if (!read.ok) throw new Error(read.failure.summary);
        if (behaviour === "silent") return "written";
        const result = behaviour === "garbled" ? { outcome: "stopped" } : behaviour;
        const reply: SidecarReply = { id: read.value.id, ok: true, result };
        replies.take(SID, reply);
        return "written";
      },
    },
  };
}

describe("abortTurn", () => {
  test("every run is asked at once, with no arguments; one stopping it is enough", async () => {
    const { deps: d, written } = deps({
      run1: { outcome: "no_turn" },
      run2: { outcome: "aborted" },
    });
    const done = await abortTurn(SID, d);
    expect(done.outcome).toEqual({ ok: true });
    expect(written.map((line) => parseWith(RequestTextSchema, line))).toEqual([
      { ok: true, value: { v: 1, op: "turn.abort", id: "id1", args: {} } },
      { ok: true, value: { v: 1, op: "turn.abort", id: "id2", args: {} } },
    ]);
    expect(done.tries.map((t) => t.result)).toEqual(["no_turn", "aborted"]);
  });

  test("every module running no turn: no_turn", async () => {
    const done = await abortTurn(
      SID,
      deps({ run1: { outcome: "no_turn" }, run2: "unwritten" }).deps,
    );
    expect(done.outcome).toMatchObject({ ok: false, code: "no_turn" });
  });

  // The engine's words reach the person.
  test("a module the engine refused: abort_failed with what the engine said", async () => {
    const done = await abortTurn(
      SID,
      deps({
        run1: { outcome: "no_turn" },
        run2: { outcome: "refused", message: "t1 is not the running turn t2" },
      }).deps,
    );
    expect(done.outcome).toEqual({
      ok: false,
      code: "abort_failed",
      msg: "the session refused to stop its turn: t1 is not the running turn t2",
    });
  });

  // Whether the turn stopped is not known without an answer, so it is not
  // reported as having had no turn — a module of an older plugin, which
  // does not read turn.abort, answers nothing.
  test("no answer, or one not of turn.abort's shape: abort_failed, not no_turn", async () => {
    for (const silent of ["silent", "garbled"] as const) {
      const done = await abortTurn(SID, deps({ run1: { outcome: "no_turn" }, run2: silent }).deps);
      expect(done.outcome).toMatchObject({ ok: false, code: "abort_failed" });
      if (done.outcome.ok) throw new Error("stopped");
      expect(done.outcome.msg).toContain("whether its turn stopped is not known");
    }
  });

  // DR-0039 §7: without a module there is no other route to try.
  test("no run to write to: no_module for a running session, session_not_found otherwise", async () => {
    const cases: [Record<string, Behaviour>, { running: boolean; movedOn?: boolean }, string][] = [
      [{}, { running: true }, "no_module"],
      [{ run1: "unwritten" }, { running: true }, "no_module"],
      [{}, { running: false }, "session_not_found"],
      [{}, { running: true, movedOn: true }, "session_not_found"],
    ];
    for (const [runs, session, code] of cases) {
      const { deps: d, written } = deps(runs, session);
      const done = await abortTurn(SID, d);
      expect(done.outcome).toMatchObject({ ok: false, code });
      expect(written).toEqual([]);
    }
  });
});
