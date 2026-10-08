// session_input (DR-0035 §1, §5): the daemon writes a fill request to every
// live sidecar of a session and answers with what the session's hooks module
// reports, or unconfirmed.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSidecarDir, sidecarSocketName } from "@ccmsg/protocol";
import {
  type ModuleReport,
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

describe("PendingInputs", () => {
  test("the first report under an id is the one that counts", async () => {
    const pending = new PendingInputs();
    pending.open("i1", SID);
    const waited = pending.wait("i1", 5_000);
    expect(pending.report("i1", SID, { outcome: "not_delivered", reason: "dialog" })).toBe(true);
    expect(pending.report("i1", SID, { outcome: "accepted" })).toBe(true);
    expect(await waited).toEqual({ outcome: "not_delivered", reason: "dialog" });
  });

  test("a report that arrives before the wait still counts", async () => {
    const pending = new PendingInputs();
    pending.open("i2", SID);
    pending.report("i2", SID, { outcome: "accepted" });
    expect(await pending.wait("i2", 5_000)).toEqual({ outcome: "accepted" });
  });

  test("silence until the deadline is no report, and the id is forgotten", async () => {
    const pending = new PendingInputs();
    pending.open("i3", SID);
    expect(await pending.wait("i3", 20)).toBeUndefined();
    expect(pending.report("i3", SID, { outcome: "accepted" })).toBe(false);
  });

  test("a report naming another session is not taken", () => {
    const pending = new PendingInputs();
    pending.open("i4", SID);
    expect(
      pending.report("i4", "99999999-2222-4333-8444-555555555555", { outcome: "accepted" }),
    ).toBe(false);
  });
});

/** What one run does with the line written to it: not take it, answer with a
 * report, or stay silent. */
type RunBehaviour = "unwritten" | "silent" | ModuleReport;

/** Deps over a fake sidecar directory whose runs behave as `runs` says, in
 * socket-name order. Records every line written, by socket. */
function scripted(
  runs: Record<string, RunBehaviour>,
  extra: Partial<SessionInputDeps> = {},
): { deps: SessionInputDeps; written: { socket: string; line: Record<string, unknown> }[] } {
  const pending = new PendingInputs();
  let n = 0;
  const written: { socket: string; line: Record<string, unknown> }[] = [];
  const deps: SessionInputDeps = {
    sidecarDir: "/sidecars",
    pending,
    newId: () => `id${++n}`,
    listDir: async () => Object.keys(runs).map((pid) => `${SID}.${pid}.sock`),
    isAlive: () => true,
    write: async (socket, line) => {
      const pid = /\.(\d+)\.sock$/.exec(socket)![1]!;
      const behaviour = runs[pid]!;
      if (behaviour === "unwritten") return "unavailable";
      const parsed = JSON.parse(line) as Record<string, unknown>;
      written.push({ socket: path.basename(socket), line: parsed });
      if (behaviour !== "silent") pending.report(parsed.id as string, SID, behaviour);
      return "delivered";
    },
    now: Date.now,
    deadlineMs: 5_000,
    ...extra,
  };
  return { deps, written };
}

describe("liveSidecars", () => {
  test("takes the session's sockets of live harness pids only, in name order", async () => {
    const { deps } = scripted(
      {},
      {
        listDir: async () => [
          `${SID}.200.sock`,
          `${SID}.100.sock`,
          `${SID}.300.sock`,
          `99999999-2222-4333-8444-555555555555.100.sock`,
          `${SID}.abc.sock`,
          `${SID}.100.sock.tmp`,
        ],
        isAlive: (pid) => pid !== 300,
      },
    );
    expect(await liveSidecars(SID, deps)).toEqual([
      `/sidecars/${SID}.100.sock`,
      `/sidecars/${SID}.200.sock`,
    ]);
  });

  test("a missing directory is no sidecar", async () => {
    const { deps } = scripted(
      {},
      {
        listDir: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    );
    expect(await liveSidecars(SID, deps)).toEqual([]);
  });
});

describe("sessionInput asks one run at a time", () => {
  test("no live run: not_delivered no_module", async () => {
    const { deps } = scripted({});
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "no_module",
    });
  });

  test("a run that cannot take input passes the text to the next, under a new id", async () => {
    const { deps, written } = scripted({
      "100": { outcome: "not_delivered", reason: "no_terminal" },
      "200": { outcome: "accepted" },
    });
    const text = "two\nlines  ";
    expect(await sessionInput(SID, text, deps)).toMatchObject({ outcome: "accepted" });
    expect(written).toEqual([
      { socket: `${SID}.100.sock`, line: { kind: "prompt.fill", id: "id1", text } },
      { socket: `${SID}.200.sock`, line: { kind: "prompt.fill", id: "id2", text } },
    ]);
  });

  test("a run that did not take the line is passed over", async () => {
    const { deps, written } = scripted({ "100": "unwritten", "200": { outcome: "accepted" } });
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({ outcome: "accepted" });
    expect(written.map((w) => w.socket)).toEqual([`${SID}.200.sock`]);
  });

  // Each of these may mean the run holding the composer answered: asking the
  // next run could put the text in twice.
  for (const reason of ["dialog", "refused", "not_submitted", "enter_failed"] as const) {
    test(`${reason} stops at that run`, async () => {
      const { deps, written } = scripted({
        "100": { outcome: "not_delivered", reason },
        "200": { outcome: "accepted" },
      });
      expect(await sessionInput(SID, "hi", deps)).toMatchObject({
        outcome: "not_delivered",
        reason,
      });
      expect(written.length).toBe(1);
    });
  }

  test("silence stops at that run and is unconfirmed", async () => {
    const { deps, written } = scripted(
      { "100": "silent", "200": { outcome: "accepted" } },
      { deadlineMs: 30 },
    );
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({ outcome: "unconfirmed" });
    expect(written.length).toBe(1);
  });

  test("every run unable: not_delivered with the last run's reason", async () => {
    const { deps } = scripted({
      "100": { outcome: "not_delivered", reason: "no_terminal" },
      "200": { outcome: "not_delivered", reason: "no_composer" },
    });
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "no_composer",
    });
  });

  // The deadline covers every try: a next run is not asked once it has passed.
  test("the deadline is one budget for all tries", async () => {
    let clock = 0;
    const { deps, written } = scripted(
      {
        "100": { outcome: "not_delivered", reason: "no_terminal" },
        "200": { outcome: "accepted" },
      },
      {
        now: () => clock,
        deadlineMs: 1_000,
        write: async (socket, line) => {
          written.push({ socket: path.basename(socket), line: JSON.parse(line) });
          clock += 1_000;
          deps.pending.report(JSON.parse(line).id, SID, {
            outcome: "not_delivered",
            reason: "no_terminal",
          });
          return "delivered";
        },
      },
    );
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({ outcome: "unconfirmed" });
    expect(written.length).toBe(1);
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
