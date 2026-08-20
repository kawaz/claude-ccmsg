import { describe, expect, test } from "bun:test";
import {
  RENAME_TITLE_MAX_LEN,
  renameCommandArgs,
  sessionRename,
  validateRenameTitle,
  type SessionRenameDeps,
} from "../src/session-rename.ts";
import { connect, startTestDaemon, stopTestDaemon } from "./helpers.ts";

/** Deps that record what was run instead of spawning hyoui. `hyoui` is the
 * terminal handle to hand back for any session id (null = "no terminal"),
 * `namespace` the hyoui namespace to hand back (null = "unset, hyoui's own
 * default applies"). */
function fakeDeps(opts: {
  hyoui: string | null;
  namespace?: string | null;
  fail?: string;
}): SessionRenameDeps & {
  runs: string[][];
} {
  const runs: string[][] = [];
  return {
    runs,
    hyouiSessionId: () => opts.hyoui,
    hyouiNamespace: () => opts.namespace ?? null,
    runHyoui: async (args) => {
      runs.push(args);
      if (opts.fail) throw new Error(opts.fail);
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

  // `:` is the one punctuation mark that could plausibly break the hyoui spec
  // syntax, and it does not: hyoui splits a spec on its FIRST colon only, so
  // everything after `text:` is the value verbatim. Asserted here so a future
  // "let's also reject colons" edit has to argue with a test.
  test("keeps colons and slashes — hyoui splits a spec on its first colon only", () => {
    expect(validateRenameTitle("fix: a/b ratio 1:2")).toEqual({
      ok: true,
      title: "fix: a/b ratio 1:2",
    });
  });

  test("rejects an empty or whitespace-only title", () => {
    expect(validateRenameTitle("   ").ok).toBe(false);
    expect(validateRenameTitle("").ok).toBe(false);
  });

  test("rejects a non-string title", () => {
    expect(validateRenameTitle(undefined).ok).toBe(false);
    expect(validateRenameTitle(42).ok).toBe(false);
  });

  // The reason the whole validation exists: hyoui does no escape processing,
  // so a raw newline inside the `text:` spec would reach the TUI as Enter and
  // submit a half-typed `/rename`.
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

describe("renameCommandArgs", () => {
  // The command shape is the whole contract with hyoui: one `text:` spec
  // carrying the literal line to type, then a separate `key:Enter` to submit.
  // No namespace of its own = omit `--namespace` and let hyoui apply its own
  // "default".
  test("builds `input <session> text:/rename <title> key:Enter` when the session has no namespace", () => {
    expect(renameCommandArgs("run-abc", "新しい名前", null)).toEqual([
      "input",
      "run-abc",
      "text:/rename 新しい名前",
      "key:Enter",
    ]);
  });

  // kawaz r135m40/41: a session launched under a business overlay's hyoui
  // wrapper lives in that overlay's namespace, not the daemon's own — the
  // argv must carry it or hyoui looks in the wrong namespace and reports the
  // (actually live) session as gone.
  test("includes --namespace before the session id when the session has one", () => {
    expect(renameCommandArgs("run-abc", "新しい名前", "emeradaco")).toEqual([
      "input",
      "--namespace",
      "emeradaco",
      "run-abc",
      "text:/rename 新しい名前",
      "key:Enter",
    ]);
  });

  // Each element is its own argv entry, so a title with spaces needs no
  // quoting and must not be split.
  test("keeps a multi-word title inside a single spec argument", () => {
    const args = renameCommandArgs("run-abc", "two words here", null);
    expect(args).toHaveLength(4);
    expect(args[2]).toBe("text:/rename two words here");
  });
});

describe("sessionRename", () => {
  test("sends the command and reports the terminal it went to", async () => {
    const deps = fakeDeps({ hyoui: "run-xyz" });
    const res = await sessionRename("sid-1", "新タイトル", deps);
    expect(res).toEqual({ ok: true, hyoui_session_id: "run-xyz", title: "新タイトル" });
    expect(deps.runs).toEqual([["input", "run-xyz", "text:/rename 新タイトル", "key:Enter"]]);
  });

  // The bug this whole namespace plumbing exists to fix: without it, a
  // business-overlay session's rename fails with a false "no such session"
  // even though the session is live (kawaz r135m40/41, reproduced by hand).
  test("carries the session's own namespace into the hyoui command", async () => {
    const deps = fakeDeps({ hyoui: "run-xyz", namespace: "emeradaco" });
    const res = await sessionRename("sid-1", "新タイトル", deps);
    expect(res).toEqual({ ok: true, hyoui_session_id: "run-xyz", title: "新タイトル" });
    expect(deps.runs).toEqual([
      ["input", "--namespace", "emeradaco", "run-xyz", "text:/rename 新タイトル", "key:Enter"],
    ]);
  });

  // No terminal = nothing to type into. The important half of this assertion
  // is that hyoui is never run: guessing a handle would type into someone
  // else's terminal.
  test("refuses with terminal_unavailable and runs nothing when no handle is known", async () => {
    const deps = fakeDeps({ hyoui: null });
    const res = await sessionRename("sid-1", "t", deps);
    expect(res).toEqual({ ok: false, reason: "terminal_unavailable" });
    expect(deps.runs).toEqual([]);
  });

  test("maps a hyoui failure to send_failed, carrying the reason", async () => {
    const deps = fakeDeps({ hyoui: "run-xyz", fail: "hyoui exited 1: no such session" });
    const res = await sessionRename("sid-1", "t", deps);
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "send_failed") {
      expect(res.msg).toContain("no such session");
    } else {
      throw new Error(`expected send_failed, got ${JSON.stringify(res)}`);
    }
  });
});

describe("session_rename over the wire", () => {
  // Typing into another session's terminal is at least as strong as
  // signalling it, so the same user-role gate as session_kill applies — and
  // it applies before any validation or spawning.
  test("session role is refused with bad_request", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "session", sid: "sid-agent" });
      const res = await c.request({
        op: "session_rename",
        request_id: "r1",
        session_id: "sid-victim",
        title: "hijacked",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // A bad title costs nothing to reject, so it is refused synchronously —
  // before the 2-phase ack — and no result event ever follows.
  test("a title with a newline is refused synchronously with invalid_args", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });
      const res = await c.request({
        op: "session_rename",
        request_id: "r2",
        session_id: "00000000-0000-0000-0000-000000000000",
        title: "line one\nline two",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
      expect(res.error.msg).toContain("control characters");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("an empty title is refused with invalid_args", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });
      const res = await c.request({
        op: "session_rename",
        request_id: "r3",
        session_id: "00000000-0000-0000-0000-000000000000",
        title: "   ",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("missing request_id is refused with invalid_args", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });
      const res = await c.request({
        op: "session_rename",
        session_id: "sid-x",
        title: "ok title",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // A well-formed request for a session the agents poll has never seen: the
  // ack arrives on the positional slot, then the outcome event says there is
  // no terminal. Nothing is spawned, so this stays fast and hermetic.
  test("user role with an unknown session gets ack then terminal_unavailable", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });
      const ack = await c.request({
        op: "session_rename",
        request_id: "r4",
        session_id: "00000000-0000-0000-0000-000000000000",
        title: "新しい名前",
      });
      expect(ack.ok).toBe(true);
      expect(ack.accepted).toBe(true);
      expect(ack.request_id).toBe("r4");
      const { ev } = await c.readEventUntil<{
        ev: string;
        request_id: string;
        ok: boolean;
        error?: { code: string };
      }>((e) => e.ev === "session_rename_result");
      expect(ev.request_id).toBe("r4");
      expect(ev.ok).toBe(false);
      expect(ev.error?.code).toBe("terminal_unavailable");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  }, 30000);
});
