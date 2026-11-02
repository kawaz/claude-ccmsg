// session_rename (DR-0047): the title is checked before any module is asked,
// every live run is asked at once, one renaming is enough, a session busy with
// a turn is renamed after it, and a session without a module is no_module.
import { describe, expect, test } from "bun:test";
import {
  jsonText,
  parseWith,
  type SessionRenameResult,
  type SidecarReply,
  SidecarRequestSchema,
} from "@ccmsg/protocol";
import { SidecarReplies } from "../src/sidecar-call.ts";
import type { SidecarRun } from "../src/sidecar-runs.ts";
import {
  RENAME_TITLE_MAX_LEN,
  renameSession,
  type SessionRenameDeps,
  validateRenameTitle,
} from "../src/session-rename.ts";
import { startInProcessDaemon, stopInProcessDaemon, sessionConn, userConn } from "./helpers.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const RequestTextSchema = jsonText(SidecarRequestSchema);

function runOf(runId: string): SidecarRun {
  return { sid: SID, runId, startedAt: 1, socket: `/sidecars/${SID}.${runId}.sock` };
}

/** How a run behaves: takes no line, takes it and says nothing, answers a
 * result, or answers something that is not session.rename's. */
type Behaviour = "unwritten" | "silent" | "garbled" | SessionRenameResult;

/** Deps whose runs behave as `runs` says, by run id. */
function deps(
  runs: Record<string, Behaviour>,
  session: { running: boolean; movedOn?: boolean } = { running: true },
): { deps: SessionRenameDeps; written: string[] } {
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
        const result = behaviour === "garbled" ? { outcome: "sent" } : behaviour;
        const reply: SidecarReply = { id: read.value.id, ok: true, result };
        replies.take(SID, reply);
        return "written";
      },
    },
  };
}

describe("validateRenameTitle", () => {
  test("trims and accepts an ordinary title", () => {
    expect(validateRenameTitle("  ccmsg 行レイアウト  ")).toEqual({
      ok: true,
      title: "ccmsg 行レイアウト",
    });
  });

  // Only control characters are refused: punctuation is part of a title.
  test("keeps colons and slashes", () => {
    expect(validateRenameTitle("fix: a/b ratio 1:2")).toEqual({
      ok: true,
      title: "fix: a/b ratio 1:2",
    });
  });

  test("rejects an empty or whitespace-only title", () => {
    expect(validateRenameTitle("   ").ok).toBe(false);
    expect(validateRenameTitle("").ok).toBe(false);
  });

  // A title is one line of the Sessions list.
  test("rejects control characters (newline, tab, CR, escape, DEL)", () => {
    for (const bad of ["a\nb", "a\tb", "a\rb", "a\u001bb", "a\u007fb"]) {
      const res = validateRenameTitle(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.msg).toContain("control characters");
    }
  });

  test("rejects a title past the length cap and says the cap in the message", () => {
    const res = validateRenameTitle("x".repeat(RENAME_TITLE_MAX_LEN + 1));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.msg).toContain(String(RENAME_TITLE_MAX_LEN));
  });

  test("accepts a title exactly at the cap", () => {
    expect(validateRenameTitle("x".repeat(RENAME_TITLE_MAX_LEN)).ok).toBe(true);
  });
});

describe("renameSession", () => {
  test("every run is asked at once with the name; one renaming is enough", async () => {
    const { deps: d, written } = deps({
      run1: { outcome: "queued" },
      run2: { outcome: "renamed" },
    });
    const done = await renameSession(SID, "新しい名前", d);
    expect(done.outcome).toEqual({ ok: true, outcome: "renamed" });
    expect(written.map((line) => parseWith(RequestTextSchema, line))).toEqual([
      { ok: true, value: { v: 1, op: "session.rename", id: "id1", args: { name: "新しい名前" } } },
      { ok: true, value: { v: 1, op: "session.rename", id: "id2", args: { name: "新しい名前" } } },
    ]);
    expect(done.tries.map((t) => t.result)).toEqual(["queued", "renamed"]);
  });

  // A session answering a turn is renamed once the turn ends: the person is
  // told so, and it is not an error.
  test("a module that left it for the turn's end: queued, over a refusal elsewhere", async () => {
    const done = await renameSession(
      SID,
      "t",
      deps({ run1: { outcome: "queued" }, run2: { outcome: "refused", message: "no" } }).deps,
    );
    expect(done.outcome).toEqual({ ok: true, outcome: "queued" });
  });

  // The engine's words reach the person.
  test("a module the engine refused: rename_failed with what the engine said", async () => {
    const done = await renameSession(
      SID,
      "t",
      deps({ run1: { outcome: "refused", message: "unknown command rename" } }).deps,
    );
    expect(done.outcome).toEqual({
      ok: false,
      code: "rename_failed",
      msg: "the session refused /rename: unknown command rename",
    });
  });

  // A module of an older plugin, which does not read session.rename, answers
  // nothing.
  test("no answer, or one not of session.rename's shape: rename_failed", async () => {
    for (const silent of ["silent", "garbled"] as const) {
      const done = await renameSession(SID, "t", deps({ run1: "unwritten", run2: silent }).deps);
      expect(done.outcome).toMatchObject({ ok: false, code: "rename_failed" });
      if (done.outcome.ok) throw new Error("renamed");
      expect(done.outcome.msg).toContain("whether it will be renamed is not known");
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
      const done = await renameSession(SID, "t", d);
      expect(done.outcome).toMatchObject({ ok: false, code });
      expect(written).toEqual([]);
    }
  });
});

describe("session_rename over the wire", () => {
  // Renaming a session is the person's, so the same user-role gate as
  // session_kill applies — and it applies before any validation.
  test("session role is refused with bad_request", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, "a9e47000-0000-4000-8000-000000000001", {
        repo: "",
        ws: "",
        cwd: "",
      });
      const res = await c.requestError({
        op: "session_rename",
        session_id: "sid-victim",
        title: "hijacked",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      c.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // A bad title costs nothing to reject, so it is refused before any module
  // is asked.
  test("a title with a newline is refused synchronously with invalid_args", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await userConn(ctx);
      const res = await c.requestError({
        op: "session_rename",
        session_id: "00000000-0000-0000-0000-000000000000",
        title: "line one\nline two",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
      expect(res.error.msg).toContain("control characters");
      c.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("an empty title is refused with invalid_args", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await userConn(ctx);
      const res = await c.requestError({
        op: "session_rename",
        session_id: "00000000-0000-0000-0000-000000000000",
        title: "   ",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
      c.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("missing request_id is refused with bad_request", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await userConn(ctx);
      const res = await c.requestRaw({
        op: "session_rename",
        session_id: "sid-x",
        title: "ok title",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      c.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // DR-0039 §7: without a module there is no other route to try.
  test("a session no run of which is named: session_not_found when it does not run, no_module when it does", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const gone = await u.requestError({
        op: "session_rename",
        session_id: "00000000-0000-0000-0000-000000000000",
        title: "新しい名前",
      });
      expect(gone.error.code).toBe("session_not_found");
      const running = await sessionConn(ctx, SID);
      const noModule = await u.requestError({
        op: "session_rename",
        session_id: SID,
        title: "新しい名前",
      });
      expect(noModule.error.code).toBe("no_module");
      running.close();
      u.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
