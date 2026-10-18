// user_prompt (DR-0035 §1, §5): the daemon asks the hooks module of one run
// of a session at a time to `prompt.send` the text, and answers with what the
// module replies, or unconfirmed.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Parsed,
  jsonText,
  parseWith,
  PROTOCOL_VERSION,
  type PromptSendResult,
  type RequestInput,
  resolvePaths,
  type SidecarErrorCode,
  type SidecarReply,
  type SidecarReplyOf,
  type SidecarRequest,
  SidecarRequestSchema,
  sidecarSocketName,
} from "@ccmsg/protocol";
import * as net from "node:net";
import {
  inputReadiness,
  productionInputDeps,
  readPromptSendReply,
  userPrompt,
  type UserPromptDeps,
} from "../src/user-prompt.ts";
import { SidecarReplies } from "../src/sidecar-call.ts";
import { userMessage } from "../src/user-message.ts";
import type { SidecarRun } from "../src/sidecar-runs.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import {
  connect,
  spawnDaemonProc,
  stopTestDaemon,
  testConfigDir,
  type TestClient,
  waitConnectable,
  type DaemonCtx,
  sessionConn,
  userConn,
} from "./helpers.ts";
import { fakeHarness, sessionWithConfig } from "./peer-harness.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";

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
  // prompt.send's shape is the schema's (userPrompt below, and the
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

/** A live run of SID, as the daemon knows it from its sidecar's name. */
function runOf(runId: string, extra: Partial<SidecarRun> = {}): SidecarRun {
  return {
    sid: SID,
    runId,
    startedAt: 1,
    socket: `/sidecars/${SID}.${runId}.sock`,
    ...extra,
  };
}

/** The run id a socket of SID is named after. */
function runIdOf(socket: string): string {
  const runId = /\.([0-9a-z]+)\.sock$/.exec(socket)?.[1];
  if (runId === undefined) throw new Error(`not a sidecar socket: ${socket}`);
  return runId;
}

/** Deps over live runs of SID that behave as `runs` says, in the order given.
 * Records every line written, by socket. */
function scripted(
  runs: Record<string, RunBehaviour>,
  extra: Partial<UserPromptDeps> = {},
): { deps: UserPromptDeps; written: { socket: string; line: SidecarRequest }[] } {
  const replies = new SidecarReplies();
  let n = 0;
  const written: { socket: string; line: SidecarRequest }[] = [];
  const deps: UserPromptDeps = {
    replies,
    newId: () => `id${++n}`,
    runs: {
      liveOf: (sid) => (sid === SID ? Object.keys(runs).map((runId) => runOf(runId)) : []),
      movedOn: () => false,
    },
    write: async (socket, line) => {
      const behaviour = runs[runIdOf(socket)];
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
    ...extra,
  };
  return { deps, written };
}

const notDelivered = (reason: string): RunBehaviour => ({
  result: { outcome: "not_delivered", reason },
});
const ACCEPTED: RunBehaviour = { result: { outcome: "accepted" } };

// user_message (DR-0039 §6): the same runs are asked to agent.append; a run
// whose loops do not include the subagent passes it to the next.
describe("userMessage", () => {
  const APPENDED: RunBehaviour = { result: { outcome: "appended" } };
  const agentDeps = (runs: Record<string, RunBehaviour>, isRunning = true) => {
    const { deps, written } = scripted(runs);
    return { deps: { ...deps, isRunning: () => isRunning }, written };
  };

  test("appended by the run the subagent runs in, the next tried after not_running", async () => {
    const { deps, written } = agentDeps({ run100: notDelivered("not_running"), run200: APPENDED });
    expect(await userMessage({ sid: SID, agentId: "a1", text: "hi" }, deps)).toMatchObject({
      outcome: "appended",
    });
    expect(written.map((w) => w.line)).toEqual([
      { v: 1, op: "agent.append", id: "id1", args: { agentId: "a1", text: "hi" } },
      { v: 1, op: "agent.append", id: "id2", args: { agentId: "a1", text: "hi" } },
    ]);
  });

  test("not running in any run: not_running; a refusal stops at that run", async () => {
    expect(
      await userMessage(
        { sid: SID, agentId: "a1", text: "hi" },
        agentDeps({ run100: notDelivered("not_running") }).deps,
      ),
    ).toMatchObject({ outcome: "not_delivered", reason: "not_running" });
    const { deps, written } = agentDeps({ run100: notDelivered("refused"), run200: APPENDED });
    expect(await userMessage({ sid: SID, agentId: "a1", text: "hi" }, deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "refused",
    });
    expect(written.length).toBe(1);
  });

  test("no module, a changed session, an ended one; and a run that does not answer", async () => {
    expect(
      await userMessage({ sid: SID, agentId: "a1", text: "hi" }, agentDeps({}).deps),
    ).toMatchObject({
      reason: "no_module",
    });
    expect(
      await userMessage({ sid: SID, agentId: "a1", text: "hi" }, agentDeps({}, false).deps),
    ).toMatchObject({
      reason: "ended",
    });
    const { deps } = scripted({}, { runs: { liveOf: () => [], movedOn: (sid) => sid === SID } });
    expect(
      await userMessage(
        { sid: SID, agentId: "a1", text: "hi" },
        { ...deps, isRunning: () => true },
      ),
    ).toMatchObject({
      reason: "session_changed",
    });
    const silent = agentDeps({ run100: "silent" }).deps;
    expect(
      await userMessage({ sid: SID, agentId: "a1", text: "hi" }, { ...silent, deadlineMs: 50 }),
    ).toMatchObject({
      outcome: "unconfirmed",
    });
  });
});

describe("userPrompt asks one run at a time", () => {
  test("no live run: not_delivered no_module", async () => {
    const { deps } = scripted({});
    expect(await userPrompt(SID, "hi", deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "no_module",
    });
  });

  // After /clear the old id has no sidecar; the run it was serves the new id.
  // The person is told the session changed, not to update the plugin.
  test("no run of the id, its run serving another id: session_changed", async () => {
    const { deps } = scripted({}, { runs: { liveOf: () => [], movedOn: (sid) => sid === SID } });
    expect(await userPrompt(SID, "hi", deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "session_changed",
    });
  });

  test("a run whose session changed its id passes the text to the next", async () => {
    const { deps, written } = scripted({
      run100: notDelivered("session_changed"),
      run200: ACCEPTED,
    });
    expect(await userPrompt(SID, "hi", deps)).toMatchObject({ outcome: "accepted" });
    expect(written.length).toBe(2);
  });

  test("a run that cannot take input passes the text to the next, under a new id", async () => {
    const { deps, written } = scripted({
      run100: notDelivered("no_terminal"),
      run200: ACCEPTED,
    });
    const text = "two\nlines  ";
    expect(await userPrompt(SID, text, deps)).toMatchObject({ outcome: "accepted" });
    expect(written).toEqual([
      {
        socket: `${SID}.run100.sock`,
        line: { v: 1, op: "prompt.send", id: "id1", args: { text } },
      },
      {
        socket: `${SID}.run200.sock`,
        line: { v: 1, op: "prompt.send", id: "id2", args: { text } },
      },
    ]);
  });

  test("a run that did not take the line is passed over", async () => {
    const { deps, written } = scripted({ run100: "unwritten", run200: ACCEPTED });
    expect(await userPrompt(SID, "hi", deps)).toMatchObject({ outcome: "accepted" });
    expect(written.map((w) => w.socket)).toEqual([`${SID}.run200.sock`]);
  });

  test("no run that takes the line: not_delivered no_module", async () => {
    const { deps } = scripted({ run100: "unwritten", run200: "unwritten" });
    expect(await userPrompt(SID, "hi", deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "no_module",
    });
  });

  // Each of these may mean the run holding the composer answered: asking the
  // next run could put the text in twice.
  for (const reason of ["dialog", "refused", "not_submitted", "enter_failed"] as const) {
    test(`${reason} stops at that run`, async () => {
      const { deps, written } = scripted({ run100: notDelivered(reason), run200: ACCEPTED });
      expect(await userPrompt(SID, "hi", deps)).toMatchObject({
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
      const { deps, written } = scripted(
        { run100: behaviour, run200: ACCEPTED },
        { deadlineMs: 30 },
      );
      expect(await userPrompt(SID, "hi", deps)).toMatchObject({ outcome: "unconfirmed" });
      expect(written.length).toBe(1);
    });
  }

  test("every run unable: not_delivered with the last run's reason", async () => {
    const { deps } = scripted({
      run100: notDelivered("no_terminal"),
      run200: notDelivered("no_composer"),
    });
    expect(await userPrompt(SID, "hi", deps)).toMatchObject({
      outcome: "not_delivered",
      reason: "no_composer",
    });
  });

  // The deadline covers every try: a next run is not asked once it has passed.
  test("the deadline is one budget for all tries", async () => {
    let clock = 0;
    const { deps, written } = scripted(
      { run100: notDelivered("no_terminal"), run200: ACCEPTED },
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
    expect(await userPrompt(SID, "hi", deps)).toMatchObject({ outcome: "unconfirmed" });
    expect(written.length).toBe(1);
  });
});

// Over real sockets: the first run's sidecar has stopped reading, so a large
// line goes in part-way and the write runs out of time. The module may still
// get the whole line, so the second run must not be sent it as well.
test("a write that stopped part-way is unconfirmed and goes to no other run", async () => {
  const dir = shortTmpDir("ccmsg-si-w-");
  const held = new Set<net.Socket>();
  const stalled = net.createServer({ pauseOnConnect: true }, (c) => {
    held.add(c);
  });
  await new Promise<void>((resolve) =>
    stalled.listen(path.join(dir, sidecarSocketName(SID, "run100")), resolve),
  );
  let reached = 0;
  const reading = Bun.listen({
    unix: path.join(dir, sidecarSocketName(SID, "run200")),
    socket: {
      data: (_s, chunk) => {
        reached += chunk.length;
      },
    },
  });
  try {
    const runs = ["run100", "run200"].map((runId) =>
      runOf(runId, { socket: path.join(dir, sidecarSocketName(SID, runId)) }),
    );
    const deps: UserPromptDeps = {
      ...productionInputDeps(new SidecarReplies(), { liveOf: () => runs, movedOn: () => false }),
      deadlineMs: 400,
    };
    const res = await userPrompt(SID, "x".repeat(4 * 1024 * 1024), deps);
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

/** Readiness over live runs of SID: `terminals` gives each run's
 * HYOUI_SESSION_ID as it named it (null for a run started outside hyoui). */
function readinessOver(
  terminals: Record<string, string | null>,
  extra: { movedOn?: boolean; isRunning?: boolean } = {},
) {
  return inputReadiness(SID, {
    runs: {
      liveOf: () =>
        Object.entries(terminals).map(([runId, hyoui]) =>
          runOf(runId, hyoui === null ? {} : { hyouiSessionId: hyoui }),
        ),
      movedOn: () => extra.movedOn ?? false,
    },
    isRunning: () => extra.isRunning ?? true,
  });
}

describe("inputReadiness", () => {
  test("a run whose sidecar named a hyoui terminal: ready", () => {
    expect(readinessOver({ run1: "hy-1" })).toEqual({ kind: "ready" });
  });

  // userPrompt moves past a run that answers no_terminal, so one run with a
  // terminal among several is enough.
  test("ready when any run has a terminal, no_terminal when none has", () => {
    expect(readinessOver({ run1: null, run2: "hy-2" })).toEqual({ kind: "ready" });
    expect(readinessOver({ run1: null, run2: null })).toEqual({ kind: "no_terminal" });
  });

  test("no run: no_module while running, ended once not", () => {
    expect(readinessOver({})).toEqual({ kind: "no_module" });
    expect(readinessOver({}, { isRunning: false })).toEqual({ kind: "ended" });
  });

  // The same judgment userPrompt gives after /clear: a run that served the
  // id now serves another.
  test("no run of the id, its run serving another id: session_changed", () => {
    expect(readinessOver({}, { movedOn: true, isRunning: false })).toEqual({
      kind: "session_changed",
    });
  });
});

/** A daemon whose state dir is short enough for the sidecar sockets to live
 * under it (macOS's tmpdir is not), so the test reads the same path the
 * daemon derives. */
async function startShortDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonCtx> {
  const base = shortTmpDir("ccmsg-si-");
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const proc = spawnDaemonProc(stateDir, dataDir, extraEnv);
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
    env: extraEnv,
  };
}

/** A `ps` that records being run and prints nothing: the daemon has no use
 * for it in judging readiness, and a run in a sandbox could not run it. */
function psRecorder(base: string): { env: Record<string, string>; calls(): string } {
  const bin = path.join(base, "bin");
  const log = path.join(base, "ps.log");
  fs.mkdirSync(bin, { recursive: true });
  writeMockBin(path.join(bin, "ps"), `#!/bin/sh\necho "$*" >> "${log}"\nexit 1\n`);
  return {
    env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
  };
}

/** Stand in for a run's sidecar: bind where the daemon writes for this run,
 * hand over each line it is written, and name the run to the daemon on a
 * session connection of its own (sidecar_hello), as `ccmsg sidecar` does.
 * `leave` closes that connection — the run is gone — and resolves once the
 * daemon has let go of it. */
async function fakeSidecar(
  ctx: DaemonCtx,
  sid: string,
  runId: string,
  hyouiSessionId?: string,
): Promise<{ lines: AsyncGenerator<string, void>; leave(): Promise<void>; close(): void }> {
  const dir = resolvePaths({ CCMSG_STATE_DIR: ctx.stateDir }).sidecars;
  fs.mkdirSync(dir, { recursive: true });
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const server = Bun.listen({
    unix: path.join(dir, sidecarSocketName(sid, runId)),
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
  const naming: TestClient = await connect(ctx.sock);
  await naming.hello({ role: "session", sid });
  await naming.requestOk({
    op: "sidecar_hello",
    run_id: runId,
    started_at: Date.now(),
    ...(hyouiSessionId !== undefined ? { hyoui_session_id: hyouiSessionId } : {}),
  });
  return {
    lines: lines(),
    leave: () => naming.end(),
    close: () => {
      naming.close();
      server.stop(true);
    },
  };
}

/** The next request the daemon wrote to `sidecar`, past the `session.facts`
 * it asks each run that names itself (session-facts.test.ts). */
async function nextRequest(sidecar: {
  lines: AsyncGenerator<string, void>;
}): Promise<SidecarRequest> {
  for (;;) {
    const next = await sidecar.lines.next();
    if (next.done === true) throw new Error("the sidecar closed");
    const request = requestIn(next.value);
    if (request.op !== "session.facts") return request;
  }
}

/** A module's reply as `ccmsg sidecar reply` hands it to the daemon. */
function sidecarReply(reply: SidecarReply): Extract<RequestInput, { op: "sidecar_reply" }> {
  return { op: "sidecar_reply", reply };
}

// send_message with an agent id (DR-0039 §3): the session's live run is
// matched as any send's, and the text goes to its module as agent.append,
// naming the sender, rather than into its peer socket.
describe("send_message with an agent id over the wire", () => {
  test("the module is asked to append, the sender named, and its answer is the result", async () => {
    const ctx = await startShortDaemon();
    const harness = fakeHarness(SID, { pid: process.pid });
    const sidecar = await fakeSidecar(ctx, SID, "run1");
    const SENDER = "22222222-2222-4333-8444-555555555555";
    try {
      const sender = await sessionWithConfig(ctx, SENDER, harness.configDir);
      const results = sender.requestOk({
        op: "send_message",
        to: { session_id: SID },
        agent_id: "a1",
        text: "確認お願い",
      });
      const line = await nextRequest(sidecar);
      expect(line).toEqual({
        v: 1,
        op: "agent.append",
        id: line.id,
        args: { agentId: "a1", from: SENDER, text: "確認お願い" },
      });
      const module = await connect(ctx.sock);
      await module.hello({ role: "session", sid: SID });
      await module.requestOk(
        sidecarReply({ id: line.id, ok: true, result: { outcome: "appended" } }),
      );
      expect((await results).results).toEqual([{ sid: SID, outcome: "delivered" }]);
      expect(harness.frames).toEqual([]);
      sender.close();
      module.close();
    } finally {
      sidecar.close();
      harness.dispose();
      await stopTestDaemon(ctx);
    }
  });
});

describe("user_prompt over the wire", () => {
  test("the module's accepted reply is the answer", async () => {
    const ctx = await startShortDaemon();
    const sidecar = await fakeSidecar(ctx, SID, "run1", "hy-1");
    try {
      const user = await userConn(ctx);
      const reply = user.request({ op: "user_prompt", session_id: SID, text: "hi there" });
      const line = await nextRequest(sidecar);
      expect(line).toEqual({ v: 1, op: "prompt.send", id: line.id, args: { text: "hi there" } });
      const module = await sessionConn(ctx, SID);
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
    const sidecar = await fakeSidecar(ctx, SID, "run1", "hy-1");
    try {
      const user = await userConn(ctx);
      const reply = user.request({ op: "user_prompt", session_id: SID, text: "hi" });
      const line = await nextRequest(sidecar);
      const module = await sessionConn(ctx, SID);
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

  // A socket still bound by a run whose sidecar's connection has closed is
  // passed over rather than written to: the daemon writes only to runs named
  // on a connection still open.
  test("a run whose sidecar left is no run: not_delivered no_module", async () => {
    const ctx = await startShortDaemon();
    const left = await fakeSidecar(ctx, SID, "run1", "hy-1");
    try {
      await left.leave();
      const user = await userConn(ctx);
      const res = await user.request({ op: "user_prompt", session_id: SID, text: "hi" });
      expect(res).toEqual({ ok: true, outcome: "not_delivered", reason: "no_module" });
      user.close();
    } finally {
      left.close();
      await stopTestDaemon(ctx);
    }
  });

  // A resume started twice: each run named itself with a run id of its own,
  // and the daemon asks one, then the next when the first cannot take input.
  test("two runs of one session are asked one after the other", async () => {
    const ctx = await startShortDaemon();
    const first = await fakeSidecar(ctx, SID, "run1");
    const second = await fakeSidecar(ctx, SID, "run2", "hy-2");
    try {
      const user = await userConn(ctx);
      const reply = user.request({ op: "user_prompt", session_id: SID, text: "hi" });
      const module = await sessionConn(ctx, SID);
      const toFirst = await nextRequest(first);
      await module.request(
        sidecarReply({
          id: toFirst.id,
          ok: true,
          result: { outcome: "not_delivered", reason: "no_terminal" },
        }),
      );
      const toSecond = await nextRequest(second);
      expect(toSecond.id).not.toBe(toFirst.id);
      await module.request(
        sidecarReply({ id: toSecond.id, ok: true, result: { outcome: "accepted" } }),
      );
      expect(await reply).toEqual({ ok: true, outcome: "accepted" });
      user.close();
      module.close();
    } finally {
      first.close();
      second.close();
      await stopTestDaemon(ctx);
    }
  });

  test("sidecar_hello is a session's: refused without one, and with arguments not of its shape", async () => {
    const ctx = await startShortDaemon();
    try {
      const user = await userConn(ctx);
      const asUser = await user.requestError({
        op: "sidecar_hello",
        run_id: "run1",
        started_at: 1,
      });
      expect(asUser.error.code).toBe("bad_request");
      const session = await sessionConn(ctx, SID);
      const badRun = await session.requestRefusal({
        op: "sidecar_hello",
        run_id: "../x",
        started_at: 1,
      });
      expect(badRun.error.code).toBe("invalid_args");
      user.close();
      session.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("refusals: role, arguments, and replies nobody waits for", async () => {
    const ctx = await startShortDaemon();
    try {
      const session = await sessionConn(ctx, SID);
      const asSession = await session.requestError({
        op: "user_prompt",
        session_id: SID,
        text: "x",
      });
      expect(asSession.error.code).toBe("bad_request");

      const user = await userConn(ctx);
      const blank = await user.requestError({
        op: "user_prompt",
        session_id: SID,
        text: " \n ",
      });
      expect(blank.error.code).toBe("invalid_args");
      const noSid = await user.requestRefusal({ op: "user_prompt", text: "x" });
      expect(noSid.error.code).toBe("invalid_args");
      const replyAsUser = await user.requestError(sidecarReply({ id: "x", ok: true, result: {} }));
      expect(replyAsUser.error.code).toBe("bad_request");

      const unknown = await session.requestError(
        sidecarReply({ id: "never-sent", ok: true, result: {} }),
      );
      expect(unknown.error.code).toBe("not_found");
      const malformed = await session.requestRefusal({
        op: "sidecar_reply",
        reply: { id: "never-sent", ok: false },
      });
      expect(malformed.error.code).toBe("invalid_args");
      const noReply = await session.requestRefusal({ op: "sidecar_reply" });
      expect(noReply.error.code).toBe("invalid_args");
      // A refused reply leaves a line in daemon.log, with its id when it has one.
      const log = fs.readFileSync(path.join(ctx.stateDir, "daemon.log"), "utf8");
      expect(log).toContain(`sidecar_reply never-sent from ${SID} refused: no request is waiting`);
      expect(log).toContain(`request sidecar_reply from ${SID} refused: reply.error: Invalid key`);

      // user_message is the user role's too, and both need hello first.
      const appendAsSession = await session.requestError({
        op: "user_message",
        session_id: SID,
        agent_id: "a1",
        text: "x",
      });
      expect(appendAsSession.error.code).toBe("bad_request");
      const raw = await connect(ctx.sock);
      for (const op of ["user_prompt", "user_message"] as const) {
        const early = await raw.requestError(
          op === "user_prompt"
            ? { op, session_id: SID, text: "x" }
            : { op, session_id: SID, agent_id: "a1", text: "x" },
        );
        expect({ op, code: early.error.code }).toEqual({ op, code: "hello_required" });
      }
      raw.close();
      user.close();
      session.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("a reply from another session does not answer the request", async () => {
    const ctx = await startShortDaemon();
    const sidecar = await fakeSidecar(ctx, SID, "run1", "hy-1");
    try {
      const user = await userConn(ctx);
      // Left waiting: the connection closes before the daemon would answer it.
      const reply = user
        .request({ op: "user_prompt", session_id: SID, text: "hi" })
        .catch(() => undefined);
      const line = await nextRequest(sidecar);
      const other = await sessionConn(ctx, "99999999-2222-4333-8444-555555555555", {
        repo: "",
        ws: "",
        cwd: "",
      });
      const res = await other.requestError(
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

describe("session.facts asked of a run that names itself", () => {
  // A daemon that started after the module has none of the facts the module
  // sent before: it asks the run as soon as the run names itself, and takes
  // the answer as if the module had sent it.
  test("the module's answer is taken as its facts", async () => {
    const ctx = await startShortDaemon();
    const transcript = path.join(ctx.base, `${SID}.jsonl`);
    fs.writeFileSync(transcript, "");
    let sidecar: { close(): void } | undefined;
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
      await user.requestOk({ op: "session_status_subscribe", sid: SID });
      const named = await fakeSidecar(ctx, SID, "run1", "hy-1");
      sidecar = named;
      const next = await named.lines.next();
      if (next.done === true) throw new Error("the sidecar closed");
      const asked = requestIn(next.value);
      expect(asked).toEqual({ v: 1, op: "session.facts", id: asked.id, args: {} });
      const facts = { at: 5, model: "claude-opus-5-5[1m]", context: { window: 1_000_000, at: 5 } };
      expect(
        await session.request(sidecarReply({ id: asked.id, ok: true, result: facts })),
      ).toEqual({ ok: true });
      const pushed = await user.readEventUntil(
        "session_status",
        (ev) => ev.context?.window === 1_000_000,
      );
      expect(pushed.ev.context?.model).toBe("claude-opus-5-5[1m]");
      user.close();
      session.close();
    } finally {
      sidecar?.close();
      await stopTestDaemon(ctx);
    }
  });
});

describe("input_readiness on session_status", () => {
  // The snapshot says whether a person's input can reach the session before
  // anything is sent, and a run named or gone pushes the change: the push
  // follows the name and the close, with no directory watched and no poll.
  test("follows the runs the session's sidecars name, and their terminals", async () => {
    const base = shortTmpDir("ccmsg-si-ps-");
    const ps = psRecorder(base);
    const ctx = await startShortDaemon(ps.env);
    const transcript = path.join(ctx.base, `${SID}.jsonl`);
    fs.writeFileSync(transcript, "");
    const sidecars: { close(): void }[] = [];
    try {
      const session = await sessionConn(ctx, SID, { transcript_path: transcript });
      const user = await userConn(ctx);
      const initial = await user.requestOk({ op: "session_status_subscribe", sid: SID });
      expect(initial.input_readiness).toEqual({ kind: "no_module" });

      const outsideHyoui = await fakeSidecar(ctx, SID, "run1");
      sidecars.push(outsideHyoui);
      const noTerminal = await user.readEventUntil(
        "session_status",
        (ev) => ev.input_readiness?.kind === "no_terminal",
      );
      expect(noTerminal.ev.sid).toBe(SID);

      const underHyoui = await fakeSidecar(ctx, SID, "run2", "hy-1");
      sidecars.push(underHyoui);
      await user.readEventUntil("session_status", (ev) => ev.input_readiness?.kind === "ready");

      await underHyoui.leave();
      await user.readEventUntil(
        "session_status",
        (ev) => ev.input_readiness?.kind === "no_terminal",
      );
      await outsideHyoui.leave();
      await user.readEventUntil("session_status", (ev) => ev.input_readiness?.kind === "no_module");
      // Judged from what the sidecars named, not from the processes: a run in
      // a sandbox that cannot be looked at with `ps` is judged the same.
      expect(ps.calls()).toBe("");
      user.close();
      session.close();
    } finally {
      for (const sidecar of sidecars) sidecar.close();
      await stopTestDaemon(ctx);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // After /clear the run names itself under the new id with the run id it
  // had, and the old id is told apart from one that never had a module.
  test("an id whose run now serves another id: session_changed", async () => {
    const ctx = await startShortDaemon();
    const OTHER = "99999999-2222-4333-8444-555555555555";
    const sidecars: { close(): void }[] = [];
    try {
      const user = await userConn(ctx);
      const before = await fakeSidecar(ctx, SID, "run1", "hy-1");
      sidecars.push(before);
      await before.leave();
      sidecars.push(await fakeSidecar(ctx, OTHER, "run1", "hy-1"));
      // The old id is still registered (its sidecar said hello as it), so its
      // peer row is judged.
      const peers = await user.requestOk({ op: "peers" });
      expect(peers.peers.find((p) => p.sid === SID)?.input_readiness).toEqual({
        kind: "session_changed",
      });
      const sent = await user.request({ op: "user_prompt", session_id: SID, text: "hi" });
      expect(sent).toEqual({ ok: true, outcome: "not_delivered", reason: "session_changed" });
      user.close();
    } finally {
      for (const sidecar of sidecars) sidecar.close();
      await stopTestDaemon(ctx);
    }
  });

  // A peer row carries it too, for a client that follows no status of the
  // session (no transcript yet, or only its Terminal tab open).
  test("rides the peers reply and the peers push", async () => {
    const ctx = await startShortDaemon();
    let sidecar: { close(): void } | undefined;
    try {
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      const session = await sessionConn(ctx, SID);
      const rowOf = (peers: readonly { sid: string; input_readiness?: { kind: string } }[]) =>
        peers.find((p) => p.sid === SID)?.input_readiness?.kind;
      await user.readEventUntil("peers", (ev) => rowOf(ev.peers) === "no_module");

      sidecar = await fakeSidecar(ctx, SID, "run1", "hy-1");
      await user.readEventUntil("peers", (ev) => rowOf(ev.peers) === "ready");
      const reply = await user.requestOk({ op: "peers" });
      expect(rowOf(reply.peers)).toBe("ready");
      user.close();
      session.close();
    } finally {
      sidecar?.close();
      await stopTestDaemon(ctx);
    }
  });
});
