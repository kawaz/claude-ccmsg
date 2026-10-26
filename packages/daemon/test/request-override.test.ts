// The overrides of a session's requests as the daemon handles them (DR-0041
// §3, §5): the session override it holds, what it hands each run's module,
// and which changes of the module's values it hands the webui tabs.
import { describe, expect, test } from "bun:test";
import { jsonText, parseWith, type SidecarReply, SidecarRequestSchema } from "@ccmsg/protocol";
import { SidecarReplies } from "../src/sidecar-call.ts";
import type { SidecarRun } from "../src/sidecar-runs.ts";
import {
  isKind,
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import {
  type RequestOverrideDeps,
  RequestOverrideStates,
  SessionOverrides,
  sendRequestOverride,
} from "../src/request-override.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const RequestTextSchema = jsonText(SidecarRequestSchema);

describe("SessionOverrides", () => {
  // Read as a JSON Merge Patch: absent keeps, null clears, a value sets.
  test("a change keeps what it does not name, clears null, and sets a value", () => {
    const held = new SessionOverrides();
    expect(held.get(SID)).toEqual({});
    expect(held.has(SID)).toBe(false);
    expect(held.change(SID, { effort: "low" })).toEqual({ effort: "low" });
    expect(held.change(SID, { model: "sonnet" })).toEqual({ model: "sonnet", effort: "low" });
    expect(held.change(SID, { effort: null })).toEqual({ model: "sonnet" });
    expect(held.change(SID, {})).toEqual({ model: "sonnet" });
    expect(held.has(SID)).toBe(true);
    // An override that comes to nothing is let go.
    expect(held.change(SID, { model: null, effort: null })).toEqual({});
    expect(held.has(SID)).toBe(false);
  });
});

describe("RequestOverrideStates", () => {
  const OWN = { model: "claude-opus-5-5[1m]", effort: "high" };
  const NONE = { model: null, effort: null };

  test("both overrides of a session not heard of; afterwards only the ones that moved", () => {
    const states = new RequestOverrideStates();
    expect(states.take(SID, { session: OWN, once: NONE })).toEqual([
      { sid: SID, target: "session", ...OWN },
      { sid: SID, target: "once", ...NONE },
    ]);
    expect(states.take(SID, { session: OWN, once: NONE })).toEqual([]);
    expect(states.take(SID, { session: { ...OWN, effort: "low" }, once: NONE })).toEqual([
      { sid: SID, target: "session", model: OWN.model, effort: "low" },
    ]);
    expect(
      states.take(SID, {
        session: { ...OWN, effort: "low" },
        once: { model: "haiku", effort: null },
      }),
    ).toEqual([{ sid: SID, target: "once", model: "haiku", effort: null }]);
    // The one-shot ending with its turn.
    expect(states.take(SID, { session: { ...OWN, effort: "low" }, once: NONE })).toEqual([
      { sid: SID, target: "once", ...NONE },
    ]);
    expect(states.snapshot()).toEqual([
      { session_id: SID, session: { ...OWN, effort: "low" }, once: NONE },
    ]);
    states.forget(SID);
    expect(states.snapshot()).toEqual([]);
  });
});

/** A live run of SID. */
function runOf(runId: string): SidecarRun {
  return { sid: SID, runId, startedAt: 1, socket: `/sidecars/${SID}.${runId}.sock` };
}

/** Deps whose runs behave as `runs` says, by run id: take no line, take it and
 * say nothing, or apply it. */
function deps(runs: Record<string, "unwritten" | "silent" | "applied">): {
  deps: RequestOverrideDeps;
  written: { socket: string; line: string }[];
} {
  const replies = new SidecarReplies();
  let n = 0;
  const written: { socket: string; line: string }[] = [];
  return {
    written,
    deps: {
      replies,
      newId: () => `id${++n}`,
      now: Date.now,
      deadlineMs: 50,
      write: async (socket, line) => {
        const runId = /\.([0-9a-z]+)\.sock$/.exec(socket)?.[1] ?? "";
        const behaviour = runs[runId];
        if (behaviour === undefined || behaviour === "unwritten") return "not_written";
        written.push({ socket, line });
        const read = parseWith(RequestTextSchema, line);
        if (!read.ok) throw new Error(read.failure.summary);
        if (behaviour === "applied") {
          const reply: SidecarReply = {
            id: read.value.id,
            ok: true,
            result: { outcome: "applied" },
          };
          replies.take(SID, reply);
        }
        return "written";
      },
    },
  };
}

describe("sendRequestOverride", () => {
  test("to every run at once, as it came; applied when one module applied it", async () => {
    const { deps: d, written } = deps({ run1: "applied", run2: "applied" });
    const args = { effort: "low" } as const;
    const sent = await sendRequestOverride(SID, args, [runOf("run1"), runOf("run2")], d);
    expect(sent.delivery).toBe("applied");
    expect(written.map((w) => parseWith(RequestTextSchema, w.line))).toEqual([
      { ok: true, value: { v: 1, op: "request.override", id: "id1", args } },
      { ok: true, value: { v: 1, op: "request.override", id: "id2", args } },
    ]);
    expect(
      (
        await sendRequestOverride(
          SID,
          {},
          [runOf("run1"), runOf("run2")],
          deps({ run1: "unwritten", run2: "applied" }).deps,
        )
      ).delivery,
    ).toBe("applied");
  });

  test("no run to write to is no_module; a run that does not answer is unconfirmed", async () => {
    const args = {};
    expect((await sendRequestOverride(SID, args, [], deps({}).deps)).delivery).toBe("no_module");
    expect(
      (await sendRequestOverride(SID, args, [runOf("run1")], deps({ run1: "unwritten" }).deps))
        .delivery,
    ).toBe("no_module");
    const silent = await sendRequestOverride(
      SID,
      args,
      [runOf("run1"), runOf("run2")],
      deps({ run1: "silent", run2: "unwritten" }).deps,
    );
    expect(silent.delivery).toBe("unconfirmed");
    expect(silent.tries.map((t) => t.result)).toEqual(["unconfirmed", "unwritten"]);
  });
});

/** A subscribed user connection (a webui tab) and the overrides its
 * subscribe-time catch-up carried. */
async function tab(ctx: InProcessDaemon): Promise<{ u: TestClient; sessions: readonly object[] }> {
  const u = await userConn(ctx);
  await u.request({ op: "subscribe" });
  const { ev } = await u.readEventUntil("request_overrides");
  return { u, sessions: ev.sessions };
}

// DR-0041 §5: what the module says its overrides put on the requests reaches
// every tab, one override at a time, and only when it moved.
describe("ev:request_override over the wire", () => {
  test("every tab gets each change once; a newer tab gets them all at subscribe", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const a = await tab(ctx);
      const b = await tab(ctx);
      expect(a.sessions).toEqual([]);
      const module = await sessionConn(ctx, SID);
      const own = { model: "claude-opus-5-5[1m]", effort: "high" };
      const none = { model: null, effort: null };
      await module.requestOk({
        op: "session_facts",
        facts: { at: 1, request_override: { session: own, once: none } },
      });
      for (const { u } of [a, b]) {
        const first = await u.readEventUntil("request_override");
        const second = await u.readEventUntil("request_override");
        expect([first.ev, second.ev]).toEqual([
          { ev: "request_override", session_id: SID, target: "session", ...own },
          { ev: "request_override", session_id: SID, target: "once", ...none },
        ]);
      }
      // Facts that move no override's values: nothing.
      await module.requestOk({
        op: "session_facts",
        facts: {
          at: 2,
          turn: { state: "idle", since: 2 },
          request_override: { session: own, once: none },
        },
      });
      // The one-shot set, then ending with its turn.
      const once = { model: "haiku", effort: null };
      await module.requestOk({
        op: "session_facts",
        facts: { at: 3, request_override: { session: own, once } },
      });
      await module.requestOk({
        op: "session_facts",
        facts: { at: 4, request_override: { session: own, once: none } },
      });
      await a.u.request({ op: "ping" });
      const events = (await a.u.pendingEvents()).filter(isKind("request_override"));
      expect(events).toEqual([
        { ev: "request_override", session_id: SID, target: "once", ...once },
        { ev: "request_override", session_id: SID, target: "once", ...none },
      ]);
      const c = await tab(ctx);
      expect(c.sessions).toEqual([{ session_id: SID, session: own, once: none }]);
      // Never to a session.
      await module.request({ op: "ping" });
      expect((await module.pendingEvents()).filter(isKind("request_override"))).toEqual([]);
      for (const t of [a.u, b.u, c.u, module]) t.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
