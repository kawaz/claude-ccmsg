// What a session's hooks module says of its session (session_facts, DR-0035
// §3) and how the daemon lays it over the transcript's fold: the window is
// only ever the module's, the model the module read names the session, and
// facts older than the ones held are dropped.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_VERSION, type SessionFacts, type SessionStatusSnapshot } from "@ccmsg/protocol";
import { SessionFactsStore } from "../src/session-facts.ts";
import { apiErrorOfFacts, contextWithFacts, withFacts } from "../src/session-status.ts";
import { connect, startTestDaemon, stopTestDaemon } from "./helpers.ts";

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

  // The transcript's message.model drops the `[1m]` the session was started
  // with; the module's keeps it, and the window is the module's alone.
  test("the module's window and model, the transcript's fill and effort", () => {
    expect(contextWithFacts(FOLDED, FACTS)).toEqual({
      tokens: 120_000,
      window: 1_000_000,
      model: "claude-opus-5-5[1m]",
      effort: "high",
      timestamp: "2026-10-14T00:00:00.000Z",
    });
  });

  // Right after the start: no response yet, so no fill, but the window and
  // the model are known.
  test("before the first response: the window and the model, no fill", () => {
    expect(contextWithFacts(undefined, FACTS)).toEqual({
      window: 1_000_000,
      model: "claude-opus-5-5[1m]",
      timestamp: "2026-10-14T00:00:05.000Z",
    });
  });

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
    expect(contextWithFacts(undefined, { ...FACTS, effort: "low" })?.effort).toBe("low");
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
      context: { ...FOLDED, window: 1_000_000, model: "claude-opus-5-5[1m]" },
    });
    expect(withFacts(snapshot, undefined)).toBe(snapshot);
  });
});

describe("the API error with the module's facts", () => {
  const FOLDED_ERROR = { text: "Prompt is too long", timestamp: "2026-10-14T00:00:00.000Z" };
  const snapshot: SessionStatusSnapshot = {
    todos: [],
    workflows: [],
    background: [],
    api_error: FOLDED_ERROR,
  };

  test("the module's error carries its kind, and its text when the harness showed one", () => {
    const at = Date.parse("2026-10-14T00:00:05.000Z");
    expect(apiErrorOfFacts({ at, api_error: { kind: "overloaded", text: "529", at } })).toEqual({
      text: "529",
      timestamp: "2026-10-14T00:00:05.000Z",
      kind: "overloaded",
    });
    expect(apiErrorOfFacts({ at, api_error: { kind: "unknown", at } })?.text).toBe("unknown");
    expect(apiErrorOfFacts({ at })).toBeUndefined();
  });

  // The module always says whether the latest turn ended on an error, so its
  // "none" stands over an error row the transcript fold still holds.
  test("facts without an error clear the fold's; without facts the fold's stands", () => {
    expect(withFacts(snapshot, { at: 1 }).api_error).toBeUndefined();
    expect(withFacts(snapshot, undefined).api_error).toEqual(FOLDED_ERROR);
  });
});

describe("session_facts over the wire", () => {
  // The facts are no transcript line: taking them pushes the session's status
  // to whoever follows it.
  test("a session's facts reach the status of that session, and are pushed", async () => {
    const ctx = await startTestDaemon();
    const transcript = path.join(ctx.base, `${SID}.jsonl`);
    fs.writeFileSync(transcript, "");
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
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const initial = await user.requestOk({ op: "session_status_subscribe", sid: SID });
      expect(initial.context).toBeUndefined();

      const facts = {
        at: Date.now(),
        model: "claude-opus-5-5[1m]",
        context: { window: 1_000_000, at: Date.now() },
      };
      expect(await session.requestOk({ op: "session_facts", facts })).toEqual({ ok: true });
      const pushed = await user.readEventUntil(
        "session_status",
        (ev) => ev.context?.window === 1_000_000,
      );
      expect(pushed.ev.sid).toBe(SID);
      expect(pushed.ev.context?.model).toBe("claude-opus-5-5[1m]");
      expect(pushed.ev.context?.tokens).toBeUndefined();

      // Older facts change nothing; the status still says the newer ones.
      await session.requestOk({
        op: "session_facts",
        facts: { at: facts.at - 1, model: "older", context: { window: 200_000, at: 1 } },
      });
      const after = await user.requestOk({ op: "session_status", sid: SID });
      expect(after.context?.model).toBe("claude-opus-5-5[1m]");
      user.close();
      session.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("only a session says facts of itself", async () => {
    const ctx = await startTestDaemon();
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const refused = await user.requestError({ op: "session_facts", facts: { at: 1 } });
      expect(refused.error.msg).toContain("requires session role");
      user.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });
});
