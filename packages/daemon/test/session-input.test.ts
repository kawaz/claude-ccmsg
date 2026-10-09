// session_input (DR-0035 §1, §5): the daemon asks the hooks module of one run
// of a session at a time to `prompt.send` the text, and answers with what the
// module replies, or unconfirmed.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Parsed,
  jsonText,
  parseWith,
  type PromptSendResult,
  resolveSidecarDir,
  type SidecarErrorCode,
  type SidecarReply,
  type SidecarReplyOf,
  type SidecarRequest,
  SidecarRequestSchema,
  sidecarSocketName,
} from "@ccmsg/protocol";
import * as net from "node:net";
import {
  productionInputDeps,
  readPromptSendReply,
  sessionInput,
  type SessionInputDeps,
} from "../src/session-input.ts";
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
const RequestTextSchema = jsonText(SidecarRequestSchema);

/** A line the daemon wrote to a sidecar, read as the request it must be. */
function requestIn(line: string): SidecarRequest {
  const read = parseWith(RequestTextSchema, line);
  if (!read.ok) throw new Error(`not a sidecar request: ${read.failure.summary}`);
  return read.value;
}

describe("readPromptSendReply", () => {
  const ok = (result: PromptSendResult): Parsed<SidecarReplyOf<"prompt.send">> => ({
    ok: true,
    value: { id: "i", ok: true, result },
  });
  const failed = (code: SidecarErrorCode): Parsed<SidecarReplyOf<"prompt.send">> => ({
    ok: true,
    value: { id: "i", ok: false, error: { code, message: "m" } },
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
    expect(
      readPromptSendReply(ok({ outcome: "not_delivered", reason: "session_changed" })),
    ).toEqual({ outcome: "not_delivered", reason: "session_changed" });
  });

  // What the composer holds is unknown after these. Which results are not of
  // prompt.send's shape is the schema's (sessionInput below, and the
  // protocol's own tests).
  test("an op that failed part-way, or a result not of prompt.send's shape, is unconfirmed", () => {
    expect(readPromptSendReply(failed("internal"))).toEqual({ outcome: "unconfirmed" });
    expect(
      readPromptSendReply({ ok: false, failure: { issues: [], summary: "not a result" } }),
    ).toEqual({ outcome: "unconfirmed" });
  });
});

/** What one run does with the line written to it: not take it, take part of
 * it and stay silent, stay silent, reply with a result (of any shape: the
 * module may be of another ccmsg), or reply that the op could not run. */
type RunBehaviour =
  | "unwritten"
  | "uncertain"
  | "silent"
  | { result: SidecarResultInTransit }
  | { error: SidecarErrorCode };

/** A result as a reply carries it, before the op's schema reads it. */
type SidecarResultInTransit = Extract<SidecarReply, { ok: true }>["result"];

function replyFor(
  id: string,
  behaviour: { result: SidecarResultInTransit } | { error: SidecarErrorCode },
): SidecarReply {
  return "result" in behaviour
    ? { id, ok: true, result: behaviour.result }
    : { id, ok: false, error: { code: behaviour.error, message: "m" } };
}

/** The pid a sidecar socket of SID is named after. */
function pidOf(socket: string): string {
  const pid = /\.(\d+)\.sock$/.exec(socket)?.[1];
  if (pid === undefined) throw new Error(`not a sidecar socket: ${socket}`);
  return pid;
}

/** Deps over a fake sidecar directory whose runs behave as `runs` says, in
 * socket-name order. Records every line written, by socket. */
function scripted(
  runs: Record<string, RunBehaviour>,
  extra: Partial<SessionInputDeps> = {},
): { deps: SessionInputDeps; written: { socket: string; line: SidecarRequest }[] } {
  const replies = new SidecarReplies();
  let n = 0;
  const written: { socket: string; line: SidecarRequest }[] = [];
  const deps: SessionInputDeps = {
    sidecarDir: "/sidecars",
    replies,
    newId: () => `id${++n}`,
    listDir: async () => Object.keys(runs).map((pid) => `${SID}.${pid}.sock`),
    isAlive: () => true,
    write: async (socket, line) => {
      const behaviour = runs[pidOf(socket)];
      if (behaviour === undefined) throw new Error(`no run behind ${socket}`);
      if (behaviour === "unwritten") return "not_written";
      const request = requestIn(line);
      written.push({ socket: path.basename(socket), line: request });
      if (behaviour === "uncertain") return "uncertain";
      if (behaviour !== "silent") replies.take(SID, replyFor(request.id, behaviour));
      return "written";
    },
    now: Date.now,
    deadlineMs: 5_000,
    pidsOf: () => [],
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

  // After /clear the old id has no sidecar; the process it ran in serves the
  // new id. The person is told the session changed, not to update the plugin.
  test("no run of the id, its process serving another id: session_changed", async () => {
    const OTHER = "99999999-2222-4333-8444-555555555555";
    const moved = (extra: Partial<SessionInputDeps>) =>
      scripted({}, { listDir: async () => [`${OTHER}.100.sock`], ...extra }).deps;
    expect(await sessionInput(SID, "hi", moved({ pidsOf: () => [100] }))).toMatchObject({
      outcome: "not_delivered",
      reason: "session_changed",
    });
    // Not known to have run in that process, or that process gone: no module.
    for (const extra of [
      { pidsOf: () => [] },
      { pidsOf: () => [200] },
      { pidsOf: () => [100], isAlive: () => false },
    ]) {
      expect(await sessionInput(SID, "hi", moved(extra))).toMatchObject({
        outcome: "not_delivered",
        reason: "no_module",
      });
    }
  });

  test("a run whose session changed its id passes the text to the next", async () => {
    const { deps, written } = scripted({
      "100": notDelivered("session_changed"),
      "200": ACCEPTED,
    });
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({ outcome: "accepted" });
    expect(written.length).toBe(2);
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

  test("no run that takes the line: not_delivered no_module", async () => {
    const { deps } = scripted({ "100": "unwritten", "200": "unwritten" });
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
    ["a write that stopped part-way, with no reply", "uncertain"],
    ["the module's own unconfirmed", { result: { outcome: "unconfirmed" } }],
    ["an op that failed part-way", { error: "internal" }],
    // A module of another ccmsg: what its result says about the composer is
    // not known.
    ["a result of no shape", { result: null }],
    ["an outcome prompt.send does not have", { result: { outcome: "delivered" } }],
    [
      "a reason the module does not give",
      { result: { outcome: "not_delivered", reason: "no_module" } },
    ],
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
          const request = requestIn(line);
          written.push({ socket: path.basename(socket), line: request });
          clock += 1_000;
          deps.replies.take(SID, {
            id: request.id,
            ok: true,
            result: { outcome: "not_delivered", reason: "no_terminal" },
          });
          return "written";
        },
      },
    );
    expect(await sessionInput(SID, "hi", deps)).toMatchObject({ outcome: "unconfirmed" });
    expect(written.length).toBe(1);
  });
});

// Over real sockets: the first run's sidecar has stopped reading, so a large
// line goes in part-way and the write runs out of time. The module may still
// get the whole line, so the second run must not be sent it as well.
test("a write that stopped part-way is unconfirmed and goes to no other run", async () => {
  const dir = fs.mkdtempSync("/tmp/ccmsg-si-w-");
  const held = new Set<net.Socket>();
  const stalled = net.createServer({ pauseOnConnect: true }, (c) => {
    held.add(c);
  });
  await new Promise<void>((resolve) =>
    stalled.listen(path.join(dir, sidecarSocketName(SID, 100)), resolve),
  );
  let reached = 0;
  const reading = Bun.listen({
    unix: path.join(dir, sidecarSocketName(SID, 200)),
    socket: {
      data: (_s, chunk) => {
        reached += chunk.length;
      },
    },
  });
  try {
    const deps: SessionInputDeps = {
      ...productionInputDeps(dir, new SidecarReplies()),
      isAlive: () => true,
      deadlineMs: 400,
    };
    const res = await sessionInput(SID, "x".repeat(4 * 1024 * 1024), deps);
    expect(res.outcome).toBe("unconfirmed");
    expect(res.tries.map((t) => t.result)).toEqual(["write_uncertain"]);
    expect(reached).toBe(0);
  } finally {
    for (const c of held) c.destroy();
    stalled.close();
    reading.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
): { lines: AsyncGenerator<string, void>; close(): void } {
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
  async function* lines(): AsyncGenerator<string, void> {
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

/** The next request the daemon wrote to `sidecar`. */
async function nextRequest(sidecar: {
  lines: AsyncGenerator<string, void>;
}): Promise<SidecarRequest> {
  const next = await sidecar.lines.next();
  if (next.done === true) throw new Error("the sidecar closed");
  return requestIn(next.value);
}

/** A module's reply as `ccmsg sidecar reply` hands it to the daemon. */
function sidecarReply(reply: object) {
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
      const line = await nextRequest(sidecar);
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
      const line = await nextRequest(sidecar);
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
      const blank = await user.request({
        op: "session_input",
        session_id: SID,
        text: " \n ",
      });
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
      // A refused reply leaves a line in daemon.log, with its id when it has one.
      const log = fs.readFileSync(path.join(ctx.stateDir, "daemon.log"), "utf8");
      expect(log).toContain(`sidecar_reply never-sent from ${SID} refused: no request is waiting`);
      expect(log).toContain(`request sidecar_reply from ${SID} refused: reply.error: Invalid key`);
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
      const line = await nextRequest(sidecar);
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
