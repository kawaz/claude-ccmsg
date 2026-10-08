// session_input (DR-0035 §1, §5): the daemon writes a fill request to every
// live sidecar of a session and answers with what the session's hooks module
// reports, or unconfirmed.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSidecarDir, sidecarSocketName } from "@ccmsg/protocol";
import {
  PendingInputs,
  liveSidecars,
  sessionInput,
  type SessionInputDeps,
} from "../src/session-input.ts";
import {
  connect,
  spawnDaemonProc,
  stopTestDaemon,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
} from "./helpers.ts";

const SID = "11111111-2222-4333-8444-555555555555";

describe("PendingInputs.settle", () => {
  test("one accepted decides it, even after another run said not_delivered", async () => {
    const pending = new PendingInputs();
    pending.open("i1", SID);
    const settled = pending.settle("i1", 2, 5_000);
    expect(pending.report("i1", SID, { outcome: "not_delivered", reason: "no_terminal" })).toBe(
      true,
    );
    expect(pending.report("i1", SID, { outcome: "accepted" })).toBe(true);
    expect(await settled).toEqual({ outcome: "accepted" });
  });

  test("not_delivered decides it only once every run has said so", async () => {
    const pending = new PendingInputs();
    pending.open("i2", SID);
    const settled = pending.settle("i2", 2, 5_000);
    pending.report("i2", SID, { outcome: "not_delivered", reason: "dialog" });
    pending.report("i2", SID, { outcome: "not_delivered", reason: "no_terminal" });
    expect(await settled).toEqual({ outcome: "not_delivered", reason: "dialog" });
  });

  test("a report that arrives before settle is called still counts", async () => {
    const pending = new PendingInputs();
    pending.open("i3", SID);
    pending.report("i3", SID, { outcome: "accepted" });
    expect(await pending.settle("i3", 1, 5_000)).toEqual({ outcome: "accepted" });
  });

  test("silence until the deadline is unconfirmed, and the id is forgotten", async () => {
    const pending = new PendingInputs();
    pending.open("i4", SID);
    expect(await pending.settle("i4", 1, 20)).toEqual({ outcome: "unconfirmed" });
    expect(pending.report("i4", SID, { outcome: "accepted" })).toBe(false);
  });

  test("a report naming another session is not taken", () => {
    const pending = new PendingInputs();
    pending.open("i5", SID);
    expect(
      pending.report("i5", "99999999-2222-4333-8444-555555555555", { outcome: "accepted" }),
    ).toBe(false);
  });
});

function fakeDeps(overrides: Partial<SessionInputDeps>): SessionInputDeps {
  return {
    sidecarDir: "/sidecars",
    pending: new PendingInputs(),
    newId: () => "fixed-id",
    listDir: async () => [],
    isAlive: () => true,
    write: async () => "delivered",
    confirmMs: 5_000,
    ...overrides,
  };
}

describe("liveSidecars", () => {
  test("takes the session's sockets of live harness pids only", async () => {
    const deps = fakeDeps({
      listDir: async () => [
        `${SID}.100.sock`,
        `${SID}.200.sock`,
        `99999999-2222-4333-8444-555555555555.100.sock`,
        `${SID}.abc.sock`,
        `${SID}.100.sock.tmp`,
      ],
      isAlive: (pid) => pid === 100,
    });
    expect(await liveSidecars(SID, deps)).toEqual([`/sidecars/${SID}.100.sock`]);
  });

  test("a missing directory is no sidecar", async () => {
    const deps = fakeDeps({
      listDir: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await liveSidecars(SID, deps)).toEqual([]);
  });
});

describe("sessionInput", () => {
  test("no sidecar took the line: not_delivered no_module, nothing left waiting", async () => {
    const pending = new PendingInputs();
    const deps = fakeDeps({
      pending,
      listDir: async () => [`${SID}.100.sock`],
      write: async () => "unavailable",
    });
    expect(await sessionInput(SID, "hello", deps)).toEqual({
      id: "fixed-id",
      runs: 0,
      outcome: "not_delivered",
      reason: "no_module",
    });
    expect(pending.report("fixed-id", SID, { outcome: "accepted" })).toBe(false);
  });

  test("writes one fill line carrying the id and the text verbatim", async () => {
    const lines: string[] = [];
    const pending = new PendingInputs();
    const deps = fakeDeps({
      pending,
      listDir: async () => [`${SID}.100.sock`],
      write: async (_socket, line) => {
        lines.push(line);
        pending.report("fixed-id", SID, { outcome: "accepted" });
        return "delivered";
      },
    });
    const text = "two\nlines  ";
    expect(await sessionInput(SID, text, deps)).toEqual({
      id: "fixed-id",
      runs: 1,
      outcome: "accepted",
    });
    expect(lines).toEqual([`${JSON.stringify({ kind: "prompt.fill", id: "fixed-id", text })}\n`]);
  });
});

/** A daemon whose state dir is short enough for the sidecar sockets to live
 * under it (macOS's tmpdir is not), so the test reads the same path the
 * daemon derives. */
async function startShortDaemon(): Promise<DaemonCtx> {
  const base = fs.mkdtempSync("/tmp/ccmsg-si-");
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const proc = spawnDaemonProc(stateDir, dataDir);
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  return {
    base,
    stateDir,
    configDir: testConfigDir(dataDir),
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock,
    proc,
    env: {},
  };
}

/** Stand in for a sidecar: listen where the daemon looks for this run, and
 * hand over each line it is written. */
function fakeSidecar(
  stateDir: string,
  sid: string,
  pid: number,
): { lines: AsyncGenerator<string>; close(): void } {
  const dir = resolveSidecarDir(stateDir);
  expect(dir.startsWith(stateDir)).toBe(true);
  fs.mkdirSync(dir, { recursive: true });
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const server = Bun.listen({
    unix: path.join(dir, sidecarSocketName(sid, pid)),
    socket: {
      data: (_s, chunk) => {
        for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
          if (line !== "") queue.push(line);
        }
        wake?.();
      },
    },
  });
  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return { lines: lines(), close: () => server.stop(true) };
}

describe("session_input over the wire", () => {
  test("the module's accepted report is the reply", async () => {
    const ctx = await startShortDaemon();
    const sidecar = fakeSidecar(ctx.stateDir, SID, process.pid);
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const reply = user.request({ op: "session_input", session_id: SID, text: "hi there" });
      const line = JSON.parse((await sidecar.lines.next()).value as string);
      expect(line).toEqual({ kind: "prompt.fill", id: line.id, text: "hi there" });
      const module = await connect(ctx.sock);
      await module.hello({ role: "session", sid: SID });
      const taken = await module.request({
        op: "session_input_result",
        id: line.id,
        outcome: "accepted",
      });
      expect(taken).toEqual({ ok: true });
      expect(await reply).toEqual({ ok: true, outcome: "accepted" });
      user.close();
      module.close();
    } finally {
      sidecar.close();
      await stopTestDaemon(ctx);
    }
  });

  test("a not_delivered report comes back with its reason", async () => {
    const ctx = await startShortDaemon();
    const sidecar = fakeSidecar(ctx.stateDir, SID, process.pid);
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const reply = user.request({ op: "session_input", session_id: SID, text: "hi" });
      const line = JSON.parse((await sidecar.lines.next()).value as string);
      const module = await connect(ctx.sock);
      await module.hello({ role: "session", sid: SID });
      await module.request({
        op: "session_input_result",
        id: line.id,
        outcome: "not_delivered",
        reason: "dialog",
      });
      expect(await reply).toEqual({ ok: true, outcome: "not_delivered", reason: "dialog" });
      user.close();
      module.close();
    } finally {
      sidecar.close();
      await stopTestDaemon(ctx);
    }
  });

  // A socket left by a run whose harness is gone is passed over rather than
  // written to: the pid it is named after belongs to a process that exited.
  test("no live sidecar is not_delivered no_module", async () => {
    const ctx = await startShortDaemon();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const stale = fakeSidecar(ctx.stateDir, SID, gone.pid);
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const res = await user.request({ op: "session_input", session_id: SID, text: "hi" });
      expect(res).toEqual({
        ok: true,
        outcome: "not_delivered",
        reason: "no_module",
      });
      user.close();
    } finally {
      stale.close();
      await stopTestDaemon(ctx);
    }
  });

  test("refusals: role, arguments, and reports nobody waits for", async () => {
    const ctx = await startShortDaemon();
    try {
      const session = await connect(ctx.sock);
      await session.hello({ role: "session", sid: SID });
      const asSession = await session.request({ op: "session_input", session_id: SID, text: "x" });
      expect(asSession.error.code).toBe("bad_request");

      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const blank = await user.request({ op: "session_input", session_id: SID, text: " \n " });
      expect(blank.error.code).toBe("invalid_args");
      const noSid = await user.request({ op: "session_input", text: "x" });
      expect(noSid.error.code).toBe("invalid_args");
      const resultAsUser = await user.request({
        op: "session_input_result",
        id: "x",
        outcome: "accepted",
      });
      expect(resultAsUser.error.code).toBe("bad_request");

      const unknown = await session.request({
        op: "session_input_result",
        id: "never-sent",
        outcome: "accepted",
      });
      expect(unknown.error.code).toBe("not_found");
      const noReason = await session.request({
        op: "session_input_result",
        id: "never-sent",
        outcome: "not_delivered",
      });
      expect(noReason.error.code).toBe("invalid_args");
      user.close();
      session.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("a report from another session does not answer the request", async () => {
    const ctx = await startShortDaemon();
    const sidecar = fakeSidecar(ctx.stateDir, SID, process.pid);
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      // Left waiting: the connection closes before the daemon would answer it.
      const reply = user
        .request({ op: "session_input", session_id: SID, text: "hi" })
        .catch(() => undefined);
      const line = JSON.parse((await sidecar.lines.next()).value as string);
      const other = await connect(ctx.sock);
      await other.hello({ role: "session", sid: "99999999-2222-4333-8444-555555555555" });
      const res = await other.request({
        op: "session_input_result",
        id: line.id,
        outcome: "accepted",
      });
      expect(res.error.code).toBe("not_found");
      user.close();
      other.close();
      await reply;
    } finally {
      sidecar.close();
      await stopTestDaemon(ctx);
    }
  });
});
