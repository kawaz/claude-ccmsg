// session_input (DR-0035 §1, §5): the daemon asks the hooks module of one run
// of a session at a time to `prompt.send` the text, and answers with what the
// module replies, or unconfirmed.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveSidecarDir,
  type SidecarErrorCode,
  type SidecarReply,
  sidecarSocketName,
} from "@ccmsg/protocol";
import { readPromptSendReply, sessionInput, type SessionInputDeps } from "../src/session-input.ts";
import { SidecarReplies } from "../src/sidecar-call.ts";
import {
  connect,
  spawnDaemonProc,
  stopTestDaemon,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
} from "./helpers.ts";

const SID = "11111111-2222-4333-8444-555555555555";

describe("readPromptSendReply", () => {
  const ok = (result: unknown): SidecarReply => ({ id: "i", ok: true, result });
  const failed = (code: SidecarErrorCode): SidecarReply => ({
    id: "i",
    ok: false,
    error: { code, message: "m" },
  });

  test("the result of a prompt.send that ran is the outcome", () => {
    expect(readPromptSendReply(ok({ outcome: "accepted" }))).toEqual({ outcome: "accepted" });
    expect(readPromptSendReply(ok({ outcome: "not_delivered", reason: "dialog" }))).toEqual({
      outcome: "not_delivered",
      reason: "dialog",
    });
    expect(readPromptSendReply(ok({ outcome: "unconfirmed" }))).toEqual({
      outcome: "unconfirmed",
    });
  });

  // The op never ran, so nothing reached the composer.
  for (const code of ["unknown_op", "unsupported_version", "invalid_args"] as const) {
    test(`${code} is an op that could not run`, () => {
      expect(readPromptSendReply(failed(code))).toEqual({ outcome: "cannot_run", code });
    });
  }

  // What the composer holds is unknown after these.
  test("an op that failed part-way, or a result of no known shape, is unconfirmed", () => {
    expect(readPromptSendReply(failed("internal"))).toEqual({ outcome: "unconfirmed" });
    expect(readPromptSendReply(ok(null))).toEqual({ outcome: "unconfirmed" });
    expect(readPromptSendReply(ok({ outcome: "delivered" }))).toEqual({ outcome: "unconfirmed" });
    expect(readPromptSendReply(ok({ outcome: "not_delivered", reason: "no_module" }))).toEqual({
      outcome: "unconfirmed",
    });
  });
});

/** What one run does with the line written to it: not take it, stay silent,
 * reply with a result of the op, or reply that the op could not run. */
type RunBehaviour = "unwritten" | "silent" | { result: unknown } | { error: SidecarErrorCode };

function replyFor(id: string, behaviour: { result: unknown } | { error: SidecarErrorCode }) {
  return "result" in behaviour
    ? ({ id, ok: true, result: behaviour.result } as const)
    : ({ id, ok: false, error: { code: behaviour.error, message: "m" } } as const);
}

/** Deps over a fake sidecar directory whose runs behave as `runs` says, in
 * socket-name order. Records every line written, by socket. */
function scripted(
  runs: Record<string, RunBehaviour>,
  extra: Partial<SessionInputDeps> = {},
): { deps: SessionInputDeps; written: { socket: string; line: Record<string, unknown> }[] } {
  const replies = new SidecarReplies();
  let n = 0;
  const written: { socket: string; line: Record<string, unknown> }[] = [];
  const deps: SessionInputDeps = {
    sidecarDir: "/sidecars",
    replies,
    newId: () => `id${++n}`,
    listDir: async () => Object.keys(runs).map((pid) => `${SID}.${pid}.sock`),
    isAlive: () => true,
    write: async (socket, line) => {
      const pid = /\.(\d+)\.sock$/.exec(socket)![1]!;
      const behaviour = runs[pid]!;
      if (behaviour === "unwritten") return "unavailable";
      const parsed = JSON.parse(line) as Record<string, unknown>;
      written.push({ socket: path.basename(socket), line: parsed });
      if (behaviour !== "silent") replies.take(SID, replyFor(parsed.id as string, behaviour));
      return "delivered";
    },
    now: Date.now,
    deadlineMs: 5_000,
    ...extra,
  };
  return { deps, written };
}

const notDelivered = (reason: string): RunBehaviour => ({
  result: { outcome: "not_delivered", reason },
});
const ACCEPTED: RunBehaviour = { result: { outcome: "accepted" } };

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
      "100": notDelivered("no_terminal"),
      "200": ACCEPTED,
    });
    const text = "two\nlines  ";
    expect(await sessionInput(SID, text, deps)).toMatchObject({ outcome: "accepted" });
    expect(written).toEqual([
      {
        socket: `${SID}.100.sock`,
        line: { v: 1, op: "prompt.send", id: "id1", args: { text } },
      },
      {
        socket: `${SID}.200.sock`,
        line: { v: 1, op: "prompt.send", id: "id2", args: { text } },
      },
    ]);
  });

  test("a run that did not take the line is passed over", async () => {
    const { deps, written } = scripted({ "100": "unwritten", "200": ACCEPTED });
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({ outcome: "accepted" });
    expect(written.map((w) => w.socket)).toEqual([`${SID}.200.sock`]);
  });

  // A module of another ccmsg did not run the op: the composer was not
  // touched, so the next run is asked.
  test("a run whose module cannot run prompt.send is passed over", async () => {
    const { deps, written } = scripted({ "100": { error: "unknown_op" }, "200": ACCEPTED });
    const res = await sessionInput(SID, "hi", deps);
    expect(res).toMatchObject({ outcome: "accepted" });
    expect(res.tries.map((t) => t.result)).toEqual(["cannot_run:unknown_op", "accepted"]);
    expect(written.length).toBe(2);
  });

  test("no run able to run prompt.send: not_delivered no_module", async () => {
    const { deps } = scripted({
      "100": { error: "unknown_op" },
      "200": { error: "unsupported_version" },
    });
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "no_module",
    });
  });

  // Each of these may mean the run holding the composer answered: asking the
  // next run could put the text in twice.
  for (const reason of ["dialog", "refused", "not_submitted", "enter_failed"] as const) {
    test(`${reason} stops at that run`, async () => {
      const { deps, written } = scripted({ "100": notDelivered(reason), "200": ACCEPTED });
      expect(await sessionInput(SID, "hi", deps)).toMatchObject({
        outcome: "not_delivered",
        reason,
      });
      expect(written.length).toBe(1);
    });
  }

  for (const [name, behaviour] of [
    ["silence", "silent"],
    ["the module's own unconfirmed", { result: { outcome: "unconfirmed" } }],
    ["an op that failed part-way", { error: "internal" }],
  ] as const) {
    test(`${name} stops at that run and is unconfirmed`, async () => {
      const { deps, written } = scripted({ "100": behaviour, "200": ACCEPTED }, { deadlineMs: 30 });
      expect(await sessionInput(SID, "hi", deps)).toMatchObject({ outcome: "unconfirmed" });
      expect(written.length).toBe(1);
    });
  }

  test("every run unable: not_delivered with the last run's reason", async () => {
    const { deps } = scripted({
      "100": notDelivered("no_terminal"),
      "200": notDelivered("no_composer"),
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
      { "100": notDelivered("no_terminal"), "200": ACCEPTED },
      {
        now: () => clock,
        deadlineMs: 1_000,
        write: async (socket, line) => {
          written.push({ socket: path.basename(socket), line: JSON.parse(line) });
          clock += 1_000;
          deps.replies.take(SID, {
            id: JSON.parse(line).id,
            ok: true,
            result: { outcome: "not_delivered", reason: "no_terminal" },
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

/** A module's reply as `ccmsg sidecar reply` hands it to the daemon. */
function sidecarReply(reply: Record<string, unknown>) {
  return { op: "sidecar_reply", reply };
}

describe("session_input over the wire", () => {
  test("the module's accepted reply is the answer", async () => {
    const ctx = await startShortDaemon();
    const sidecar = fakeSidecar(ctx.stateDir, SID, process.pid);
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const reply = user.request({ op: "session_input", session_id: SID, text: "hi there" });
      const line = JSON.parse((await sidecar.lines.next()).value as string);
      expect(line).toEqual({ v: 1, op: "prompt.send", id: line.id, args: { text: "hi there" } });
      const module = await connect(ctx.sock);
      await module.hello({ role: "session", sid: SID });
      const taken = await module.request(
        sidecarReply({ id: line.id, ok: true, result: { outcome: "accepted" } }),
      );
      expect(taken).toEqual({ ok: true });
      expect(await reply).toEqual({ ok: true, outcome: "accepted" });
      user.close();
      module.close();
    } finally {
      sidecar.close();
      await stopTestDaemon(ctx);
    }
  });

  test("a not_delivered result comes back with its reason", async () => {
    const ctx = await startShortDaemon();
    const sidecar = fakeSidecar(ctx.stateDir, SID, process.pid);
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const reply = user.request({ op: "session_input", session_id: SID, text: "hi" });
      const line = JSON.parse((await sidecar.lines.next()).value as string);
      const module = await connect(ctx.sock);
      await module.hello({ role: "session", sid: SID });
      await module.request(
        sidecarReply({
          id: line.id,
          ok: true,
          result: { outcome: "not_delivered", reason: "dialog" },
        }),
      );
      expect(await reply).toEqual({ ok: true, outcome: "not_delivered", reason: "dialog" });
      user.close();
      module.close();
    } finally {
      sidecar.close();
      await stopTestDaemon(ctx);
    }
  });

  // The only run's module is of a ccmsg without prompt.send: answered at once
  // rather than at the deadline.
  test("unknown_op from the only run is not_delivered no_module", async () => {
    const ctx = await startShortDaemon();
    const sidecar = fakeSidecar(ctx.stateDir, SID, process.pid);
    try {
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const reply = user.request({ op: "session_input", session_id: SID, text: "hi" });
      const line = JSON.parse((await sidecar.lines.next()).value as string);
      const module = await connect(ctx.sock);
      await module.hello({ role: "session", sid: SID });
      await module.request(
        sidecarReply({
          id: line.id,
          ok: false,
          error: { code: "unknown_op", message: "no op prompt.send" },
        }),
      );
      expect(await reply).toEqual({ ok: true, outcome: "not_delivered", reason: "no_module" });
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

  test("refusals: role, arguments, and replies nobody waits for", async () => {
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
      const replyAsUser = await user.request(sidecarReply({ id: "x", ok: true, result: {} }));
      expect(replyAsUser.error.code).toBe("bad_request");

      const unknown = await session.request(
        sidecarReply({ id: "never-sent", ok: true, result: {} }),
      );
      expect(unknown.error.code).toBe("not_found");
      const malformed = await session.request(sidecarReply({ id: "never-sent", ok: false }));
      expect(malformed.error.code).toBe("invalid_args");
      const noReply = await session.request({ op: "sidecar_reply" });
      expect(noReply.error.code).toBe("invalid_args");
      user.close();
      session.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("a reply from another session does not answer the request", async () => {
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
      const res = await other.request(
        sidecarReply({ id: line.id, ok: true, result: { outcome: "accepted" } }),
      );
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
