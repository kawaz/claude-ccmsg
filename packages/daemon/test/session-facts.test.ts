// What a session's hooks module says of its session (session_facts, DR-0035
// §3) and how the daemon lays it over the transcript's fold: the window is
// only ever the module's, the model is the transcript's, and
// facts older than the ones held are dropped.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_VERSION, type SessionFacts, type SessionStatusSnapshot } from "@ccmsg/protocol";
import { SessionFactsStore } from "../src/session-facts.ts";
import { contextWithFacts, withFacts } from "../src/session-status.ts";
import { assistantRow, line } from "../../protocol/test/transcript-rows.ts";
import { connect, startTestDaemon, stopTestDaemon, userConn } from "./helpers.ts";

const SID = "11111111-2222-4333-8444-555555555555";

describe("SessionFactsStore", () => {
  // A send and the reply to the daemon's own request can cross: the facts the
  // module put together later are its latest.
  test("facts older than the ones held are dropped; newer and equal replace them", () => {
    const store = new SessionFactsStore();
    expect(store.take(SID, { at: 10, model: "a" })).toBe(true);
    expect(store.take(SID, { at: 9, model: "old" })).toBe(false);
    expect(store.get(SID)).toEqual({ at: 10, model: "a" });
    expect(store.take(SID, { at: 10, model: "b" })).toBe(true);
    expect(store.take(SID, { at: 11 })).toBe(true);
    // Whole, not merged: what the module no longer says is gone.
    expect(store.get(SID)).toEqual({ at: 11 });
  });

  test("forgotten with the session", () => {
    const store = new SessionFactsStore();
    store.take(SID, { at: 1 });
    expect(store.forget(SID)).toBe(true);
    expect(store.get(SID)).toBeUndefined();
    expect(store.forget(SID)).toBe(false);
  });
});

describe("the context with the module's facts laid over the transcript's", () => {
  const FOLDED = {
    tokens: 120_000,
    model: "claude-opus-5-5",
    effort: "high",
    timestamp: "2026-10-14T00:00:00.000Z",
  };
  const FACTS: SessionFacts = {
    at: Date.parse("2026-10-14T00:00:05.000Z"),
    model: "claude-opus-5-5[1m]",
    context: { window: 1_000_000, at: Date.parse("2026-10-14T00:00:05.000Z") },
  };

  test("without facts the fold stands as it is", () => {
    expect(contextWithFacts(FOLDED, undefined)).toEqual(FOLDED);
    expect(contextWithFacts(undefined, undefined)).toBeUndefined();
  });

  // The module names the model the session was started with (`[1m]` kept,
  // or an alias); the context shows the one the transcript says answered.
  test("the module's window, the transcript's model, fill and effort", () => {
    expect(contextWithFacts(FOLDED, { ...FACTS, model: "opus[1m]" })).toEqual({
      tokens: 120_000,
      window: 1_000_000,
      model: "claude-opus-5-5",
      effort: "high",
      timestamp: "2026-10-14T00:00:00.000Z",
      engine: { model: "opus[1m]" },
    });
  });

  // DR-0041 §5, §6: the transcript's model is the one that answered, an
  // override's included; the session's own values, which the overrides are
  // read against, are the module's, beside it.
  test("the module's model and effort as the session's own, beside the model that answered", () => {
    const answeredOverridden = { ...FOLDED, model: "claude-sonnet-5-5", effort: "max" };
    expect(
      contextWithFacts(answeredOverridden, { ...FACTS, model: "claude-fable-5-1", effort: "low" }),
    ).toMatchObject({
      model: "claude-sonnet-5-5",
      engine: { model: "claude-fable-5-1", effort: "low" },
    });
    // A module that has not seen a request yet knows the model only.
    expect(contextWithFacts(answeredOverridden, FACTS)?.engine).toEqual({
      model: "claude-opus-5-5[1m]",
    });
  });

  // Right after the start no response has named the model that answers, so
  // there is no context to show yet.
  test("before the first response: no context, whatever the module says", () => {
    expect(contextWithFacts(undefined, FACTS)).toBeUndefined();
  });

  // No engine either: the module does not know the session's own values.
  test("facts without a model leave the transcript's", () => {
    expect(contextWithFacts(FOLDED, { at: 1, context: { window: 200_000, at: 1 } })).toEqual({
      ...FOLDED,
      window: 200_000,
    });
  });

  // Both fills are the input of the last response; the module's comes at the
  // end of each main-thread turn, the transcript's with each assistant row.
  test("the fill is the newer of the module's and the transcript's", () => {
    const measuredLater: SessionFacts = {
      ...FACTS,
      context: { window: 1_000_000, tokens: 150_000, at: Date.parse("2026-10-14T00:00:05.000Z") },
    };
    expect(contextWithFacts(FOLDED, measuredLater)).toMatchObject({
      tokens: 150_000,
      timestamp: "2026-10-14T00:00:05.000Z",
    });
    // A long run of tool calls: rows after the last measure are newer.
    const rowLater = { ...FOLDED, timestamp: "2026-10-14T00:00:09.000Z" };
    expect(contextWithFacts(rowLater, measuredLater)).toMatchObject({
      tokens: 120_000,
      timestamp: "2026-10-14T00:00:09.000Z",
    });
  });

  test("the module's effort over the transcript's", () => {
    expect(contextWithFacts(FOLDED, { ...FACTS, effort: "xhigh" })?.effort).toBe("xhigh");
  });

  test("facts that know nothing yet add nothing", () => {
    expect(contextWithFacts(undefined, { at: 1 })).toBeUndefined();
  });

  test("withFacts lays them over the snapshot and keeps the rest", () => {
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [],
      background: [],
      context: FOLDED,
    };
    expect(withFacts(snapshot, FACTS)).toEqual({
      ...snapshot,
      context: { ...FOLDED, window: 1_000_000, engine: { model: "claude-opus-5-5[1m]" } },
    });
    expect(withFacts(snapshot, undefined)).toBe(snapshot);
  });
});

// The API error and its kind are read off the transcript for every session
// (DR-0039 §2): the module's facts say nothing of it.
describe("the API error with the module's facts", () => {
  test("the transcript's error stands over the module's facts", () => {
    const folded = {
      text: "Prompt is too long",
      timestamp: "2026-10-14T00:00:00.000Z",
      kind: "invalid_request",
    };
    const snapshot: SessionStatusSnapshot = {
      todos: [],
      workflows: [],
      background: [],
      api_error: folded,
    };
    expect(withFacts(snapshot, { at: 1, model: "m" }).api_error).toEqual(folded);
    const healthy: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };
    expect(withFacts(healthy, { at: 1, model: "m" }).api_error).toBeUndefined();
  });
});

describe("the turn with the module's facts", () => {
  test("the module's turn state rides the snapshot, its time as ISO", () => {
    const snapshot: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };
    const since = Date.parse("2026-10-14T00:00:07.000Z");
    expect(withFacts(snapshot, { at: since, turn: { state: "responding", since } }).turn).toEqual({
      state: "responding",
      since: "2026-10-14T00:00:07.000Z",
    });
    expect(withFacts(snapshot, { at: 1 }).turn).toBeUndefined();
  });
});

// The subagents running a turn (DR-0039 §6) ride the snapshot as the module
// said them, their start as ISO; one whose start the module did not see has
// none.
describe("the subagents with the module's facts", () => {
  test("ride the snapshot, their start as ISO", () => {
    const snapshot: SessionStatusSnapshot = { todos: [], workflows: [], background: [] };
    const since = Date.parse("2026-10-15T00:00:09.000Z");
    expect(
      withFacts(snapshot, {
        at: since,
        subagents: [{ id: "a1", description: "d", type: "Explore", since }, { id: "a2" }],
      }).subagents,
    ).toEqual([
      { id: "a1", description: "d", type: "Explore", since: "2026-10-15T00:00:09.000Z" },
      { id: "a2" },
    ]);
    expect(withFacts(snapshot, { at: 1 }).subagents).toBeUndefined();
  });
});

describe("session_facts over the wire", () => {
  // The facts are no transcript line: taking them pushes the session's status
  // to whoever follows it.
  test("a session's facts reach the status of that session, and are pushed", async () => {
    const ctx = await startTestDaemon();
    const transcript = path.join(ctx.base, `${SID}.jsonl`);
    // The model that answered, as the transcript has it: the context's model.
    fs.writeFileSync(transcript, `${line(assistantRow())}\n`);
    try {
      const session = await connect(ctx.sock);
      await session.requestOk({
        op: "hello",
        role: "session",
        protocol: PROTOCOL_VERSION,
        sid: SID,
        cwd: "/tmp",
        transcript_path: transcript,
      });
      const user = await userConn(ctx);
      const initial = await user.requestOk({ op: "session_status_subscribe", sid: SID });
      expect(initial.context?.model).toBe("claude-opus-5-5");
      expect(initial.context?.window).toBeUndefined();

      const facts = {
        at: Date.now(),
        model: "opus[1m]",
        context: { window: 1_000_000, at: Date.now() },
      };
      expect(await session.requestOk({ op: "session_facts", facts })).toEqual({ ok: true });
      const pushed = await user.readEventUntil(
        "session_status",
        (ev) => ev.context?.window === 1_000_000,
      );
      expect(pushed.ev.sid).toBe(SID);
      expect(pushed.ev.context?.model).toBe("claude-opus-5-5");
      expect(pushed.ev.context?.tokens).toBe(60);

      // Older facts change nothing; the status still says the newer ones.
      await session.requestOk({
        op: "session_facts",
        facts: { at: facts.at - 1, model: "older", context: { window: 200_000, at: 1 } },
      });
      const after = await user.requestOk({ op: "session_status", sid: SID });
      expect(after.context?.model).toBe("claude-opus-5-5");
      expect(after.context?.window).toBe(1_000_000);
      user.close();
      session.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("only a session says facts of itself", async () => {
    const ctx = await startTestDaemon();
    try {
      const user = await userConn(ctx);
      const refused = await user.requestError({ op: "session_facts", facts: { at: 1 } });
      expect(refused.error.msg).toContain("requires session role");
      user.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });
});
