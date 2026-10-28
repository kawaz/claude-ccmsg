// claude_update (DR-0043 §6, §8): user role only; `claude update` and then
// `claude --version` with the daemon's PATH, the version read from the
// latter's first word and never from the update's output; each failure its
// own code; one run at a time; the version held in memory, answered by ping
// and pushed to every user-role subscriber (never a session).
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import {
  CLAUDE_UPDATE_TIMEOUT_MS,
  outputGist,
  productionClaudeUpdateDeps,
  versionWord,
  type ClaudeUpdateDeps,
  type CommandRun,
} from "../src/claude-update.ts";
import type { Conn, Daemon } from "../src/server.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { requestError, requestOk, stubDaemon } from "./drive-request.ts";
import { isKind, streamItemOf, type StreamItem } from "./helpers.ts";

const tmpDir = perTestTmpDir();

const USER: Conn["identity"] = { role: "user" };
const SESSION: Conn["identity"] = {
  role: "session",
  sid: "s1",
  repo: "r",
  ws: "w",
  cwd: "",
};

const exited = (code: number, stdout = "", stderr = ""): CommandRun => ({
  kind: "exited",
  code,
  stdout,
  stderr,
});

/** Deps answering each argv's last word ("update" / "--version") from
 * `answers`, recording every argv run and every deadline given. */
function fakeDeps(
  answers: { update: CommandRun | Promise<CommandRun>; version?: CommandRun },
  claude: string | null = "/opt/bin/claude",
): ClaudeUpdateDeps & { runs: string[][]; deadlines: number[] } {
  const runs: string[][] = [];
  const deadlines: number[] = [];
  return {
    runs,
    deadlines,
    which: () => claude,
    run: (argv, deadline) => {
      runs.push([...argv]);
      deadlines.push(deadline);
      if (argv.at(-1) === "update") return Promise.resolve(answers.update);
      return Promise.resolve(answers.version ?? exited(0, "2.1.312 (Claude Code)\n"));
    },
    now: () => 1_000,
  };
}

/** A daemon whose claude_update runs `deps`, with one user-role and one
 * session-role subscriber recording what is pushed to them. */
function harness(deps: ClaudeUpdateDeps): {
  daemon: Daemon;
  userPushes: StreamItem[];
  sessionPushes: StreamItem[];
} {
  const daemon = stubDaemon({ claudeUpdateDeps: deps });
  const userPushes: StreamItem[] = [];
  const sessionPushes: StreamItem[] = [];
  daemon.subscribers.add({
    identity: USER,
    subscribed: true,
    write: (line) => userPushes.push(streamItemOf(line)),
  });
  daemon.subscribers.add({
    identity: SESSION,
    subscribed: true,
    write: (line) => sessionPushes.push(streamItemOf(line)),
  });
  return { daemon, userPushes, sessionPushes };
}

describe("claude_update", () => {
  test("updates, reads the version back, holds it, and pushes it to user subscribers", async () => {
    const deps = fakeDeps({ update: exited(0, "Successfully updated\n") });
    const h = harness(deps);
    const reply = await requestOk(h.daemon, USER, { op: "claude_update", request_id: "q1" });
    expect(reply).toEqual({ ok: true, version: "2.1.312", exit_code: 0 });
    expect(deps.runs).toEqual([
      ["/opt/bin/claude", "update"],
      ["/opt/bin/claude", "--version"],
    ]);
    // Both commands share the one deadline.
    expect(deps.deadlines).toEqual([
      1_000 + CLAUDE_UPDATE_TIMEOUT_MS,
      1_000 + CLAUDE_UPDATE_TIMEOUT_MS,
    ]);
    expect(h.daemon.claudeVersion).toEqual({ version: "2.1.312", observed_at: 1_000 });
    expect(h.userPushes.filter(isKind("claude_version"))).toEqual([
      { ev: "claude_version", version: "2.1.312", observed_at: 1_000 },
    ]);
    expect(h.sessionPushes).toEqual([]);
    const pong = await requestOk(h.daemon, USER, { op: "ping", request_id: "q2" });
    expect(pong.claude_version).toEqual({ version: "2.1.312", observed_at: 1_000 });
  });

  test("ping names no version before an update has run", async () => {
    const h = harness(fakeDeps({ update: exited(0) }));
    const pong = await requestOk(h.daemon, USER, { op: "ping", request_id: "q1" });
    expect(pong.claude_version).toBeUndefined();
  });

  // The update's output is for people; the version comes from --version only.
  test("reads the version from --version even when the update's output names another", async () => {
    const deps = fakeDeps({
      update: exited(0, "Updated to 9.9.9\n2.1.999 (Claude Code)\n"),
      version: exited(0, "2.1.312 (Claude Code)\n"),
    });
    const reply = await requestOk(harness(deps).daemon, USER, {
      op: "claude_update",
      request_id: "q1",
    });
    expect(reply.ok && reply.version).toBe("2.1.312");
  });

  test("refuses a session-role caller before running anything", async () => {
    const deps = fakeDeps({ update: exited(0) });
    const h = harness(deps);
    const reply = await requestError(h.daemon, SESSION, { op: "claude_update", request_id: "q1" });
    expect(reply.error.code).toBe(ErrorCode.bad_request);
    expect(deps.runs).toEqual([]);
  });

  test("claude_not_found when the daemon's PATH names no claude", async () => {
    const deps = fakeDeps({ update: exited(0) }, null);
    const h = harness(deps);
    const reply = await requestError(h.daemon, USER, { op: "claude_update", request_id: "q1" });
    expect(reply.error.code).toBe(ErrorCode.claude_not_found);
    expect(deps.runs).toEqual([]);
  });

  test("claude_update_failed names the exit code and the end of stderr, and keeps the version", async () => {
    const deps = fakeDeps({
      update: exited(1, "", "Checking for updates\n\nError: network unreachable\nretry later\n"),
    });
    const h = harness(deps);
    h.daemon.claudeVersion = { version: "2.1.300", observed_at: 5 };
    const reply = await requestError(h.daemon, USER, { op: "claude_update", request_id: "q1" });
    expect(reply.error.code).toBe(ErrorCode.claude_update_failed);
    expect(reply.error.msg).toBe("claude update exited 1: Error: network unreachable\nretry later");
    expect(deps.runs).toHaveLength(1);
    expect(h.daemon.claudeVersion).toEqual({ version: "2.1.300", observed_at: 5 });
    expect(h.userPushes).toEqual([]);
  });

  test("claude_version_unreadable when --version fails or names no version", async () => {
    for (const version of [
      exited(2, "", "dyld: library not loaded\n"),
      exited(0, "Claude Code\n"),
      exited(0, ""),
    ]) {
      const h = harness(fakeDeps({ update: exited(0), version }));
      const reply = await requestError(h.daemon, USER, { op: "claude_update", request_id: "q1" });
      expect(reply.error.code).toBe(ErrorCode.claude_version_unreadable);
      expect(h.daemon.claudeVersion).toBeNull();
    }
  });

  test("claude_update_timeout when the run is stopped at the deadline", async () => {
    const h = harness(fakeDeps({ update: { kind: "timed_out" } }));
    const reply = await requestError(h.daemon, USER, { op: "claude_update", request_id: "q1" });
    expect(reply.error.code).toBe(ErrorCode.claude_update_timeout);
  });

  // One at a time: a second ask while the first runs is refused, and once the
  // first ends the next one runs.
  test("claude_update_busy while one is running", async () => {
    const held = Promise.withResolvers<CommandRun>();
    const deps = fakeDeps({ update: held.promise });
    const h = harness(deps);
    const first = requestOk(h.daemon, USER, { op: "claude_update", request_id: "q1" });
    const second = await requestError(h.daemon, USER, { op: "claude_update", request_id: "q2" });
    expect(second.error.code).toBe(ErrorCode.claude_update_busy);
    expect(deps.runs).toEqual([["/opt/bin/claude", "update"]]);
    held.resolve(exited(0));
    expect((await first).ok).toBe(true);
    const third = await requestOk(h.daemon, USER, { op: "claude_update", request_id: "q3" });
    expect(third.ok).toBe(true);
  });

  test("the next run is not refused after one that failed", async () => {
    const h = harness(fakeDeps({ update: exited(1) }));
    await requestError(h.daemon, USER, { op: "claude_update", request_id: "q1" });
    const again = await requestError(h.daemon, USER, { op: "claude_update", request_id: "q2" });
    expect(again.error.code).toBe(ErrorCode.claude_update_failed);
  });
});

describe("versionWord / outputGist", () => {
  test("the first word when it is a version", () => {
    expect(versionWord("2.1.312 (Claude Code)\n")).toBe("2.1.312");
    expect(versionWord("  2.2.0-beta.1 (Claude Code)")).toBe("2.2.0-beta.1");
    expect(versionWord("Claude Code 2.1.312")).toBeNull();
    expect(versionWord("2.1 (Claude Code)")).toBeNull();
    expect(versionWord("")).toBeNull();
  });

  test("the last two non-empty lines, each clipped", () => {
    expect(outputGist("a\n\nb\nc\n\n")).toBe("b\nc");
    expect(outputGist("")).toBe("");
    const long = "x".repeat(400);
    expect(outputGist(long)).toBe(`${"x".repeat(160)}…`);
  });
});

describe("productionClaudeUpdateDeps", () => {
  test("finds claude on the PATH it is given, and runs it with that environment", async () => {
    const bin = tmpDir("ccmsg-claude-update-");
    writeMockBin(
      path.join(bin, "claude"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.312 (Claude Code)"; else echo "updating" >&2; exit 3; fi\n',
    );
    const deps = productionClaudeUpdateDeps({ PATH: `${bin}:/usr/bin:/bin` });
    const claude = deps.which();
    expect(claude).toBe(path.join(bin, "claude"));
    if (claude === null) return;
    const far = Date.now() + 30_000;
    expect(await deps.run([claude, "--version"], far)).toEqual(
      exited(0, "2.1.312 (Claude Code)\n"),
    );
    expect(await deps.run([claude, "update"], far)).toEqual(exited(3, "", "updating\n"));
    expect(productionClaudeUpdateDeps({ PATH: "/nonexistent" }).which()).toBeNull();
  });

  test("stops a command still running at the deadline", async () => {
    const bin = tmpDir("ccmsg-claude-update-");
    const marker = path.join(bin, "finished");
    writeMockBin(path.join(bin, "claude"), `#!/bin/sh\nsleep 30\ntouch '${marker}'\n`);
    const deps = productionClaudeUpdateDeps({ PATH: `${bin}:/usr/bin:/bin` });
    const started = Date.now();
    expect(await deps.run([path.join(bin, "claude"), "update"], started + 300)).toEqual({
      kind: "timed_out",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
