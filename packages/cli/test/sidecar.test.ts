// `ccmsg sidecar` (DR-0035 §3): bind the run's socket, name the run to the
// daemon and keep naming it to whichever daemon runs, copy lines to stdout,
// leave on a signal or when stdout's reader is gone; `ccmsg sidecar reply`
// carries the module's reply to the daemon; `ccmsg sidecar send` (DR-0037 §2)
// sends a SendMessage the module took over and prints its result.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  jsonText,
  parseWith,
  resolvePaths,
  resolveSidecarDir,
  SendMessageResultTextSchema,
  type SidecarRequest,
  SidecarRequestSchema,
  sidecarSocketName,
} from "@ccmsg/protocol";
import { nameRunNoSpawn } from "../src/client.ts";
import { keepNamed, startSidecar } from "../src/sidecar.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import {
  connect,
  defined,
  spawnDaemonProc,
  stopTestDaemon,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
} from "../../daemon/test/helpers.ts";
import { fakeHarness, parseEnvelope } from "../../daemon/test/peer-harness.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const SidecarRequestTextSchema = jsonText(SidecarRequestSchema);

/** A line the sidecar wrote for the hooks module, read as the request it is. */
function sidecarRequestOf(line: string): SidecarRequest {
  const read = parseWith(SidecarRequestTextSchema, line);
  if (!read.ok) throw new Error(`not a sidecar request: ${read.failure.summary}: ${line}`);
  return read.value;
}
const SID = "11111111-2222-4333-8444-555555555555";
const RUN = "mgq1k2x3abcd1234";

/** Sidecar sockets need a directory short enough for `sun_path`, which
 * macOS's tmpdir is not. */
const bases: string[] = [];
function shortBase(): string {
  const base = fs.mkdtempSync("/tmp/ccmsg-sc-");
  bases.push(base);
  return base;
}
afterAll(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true });
});

async function writeTo(socketPath: string, ...pieces: string[]): Promise<void> {
  const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } });
  for (const piece of pieces) socket.write(piece);
  socket.end();
}

describe("startSidecar", () => {
  test("binds 0600 and copies each line, split or unterminated, to out", async () => {
    const dir = path.join(shortBase(), "sc");
    const lines: string[] = [];
    const got = Promise.withResolvers<void>();
    const sidecar = startSidecar({
      dir,
      sid: SID,
      runId: "run4242",
      out: (line, done) => {
        lines.push(line);
        if (lines.length === 3) got.resolve();
        done();
      },
    });
    try {
      expect(sidecar.path).toBe(path.join(dir, `${SID}.run4242.sock`));
      expect(fs.statSync(sidecar.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      await writeTo(sidecar.path, '{"a":', "1}\n", '{"b":2}\n\n');
      await writeTo(sidecar.path, '{"c":3}');
      await got.promise;
      expect(lines).toEqual(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']);
    } finally {
      sidecar.stop();
    }
    expect(await sidecar.stopped).toBe("stopped");
    expect(fs.existsSync(sidecar.path)).toBe(false);
  });

  // A character whose bytes arrive in separate writes is still one character.
  test("a multi-byte character split across writes arrives whole", async () => {
    const dir = path.join(shortBase(), "sc");
    const got = Promise.withResolvers<string>();
    const sidecar = startSidecar({
      dir,
      sid: SID,
      runId: "run4245",
      out: (line, done) => {
        got.resolve(line);
        done();
      },
    });
    try {
      const bytes = new TextEncoder().encode("書き\n");
      const socket = await Bun.connect({ unix: sidecar.path, socket: { data() {} } });
      for (const byte of bytes) {
        socket.write(new Uint8Array([byte]));
        socket.flush();
        await Bun.sleep(1);
      }
      socket.end();
      expect(await got.promise).toBe("書き\n");
    } finally {
      sidecar.stop();
    }
  });

  test("a failing out is the reader gone, and ends the sidecar", async () => {
    const dir = path.join(shortBase(), "sc");
    const sidecar = startSidecar({
      dir,
      sid: SID,
      runId: "run4243",
      out: (_line, done) => done(new Error("EPIPE")),
    });
    await writeTo(sidecar.path, "x\n");
    expect(await sidecar.stopped).toBe("reader_gone");
    expect(fs.existsSync(sidecar.path)).toBe(false);
  });

  // A later sidecar of the same run took the name over; leaving must not
  // remove its socket.
  test("leaving keeps a socket a later sidecar bound under the same name", async () => {
    const dir = path.join(shortBase(), "sc");
    const first = startSidecar({ dir, sid: SID, runId: "run4244", out: (_l, done) => done() });
    const second = startSidecar({ dir, sid: SID, runId: "run4244", out: (_l, done) => done() });
    first.stop();
    await first.stopped;
    expect(fs.existsSync(second.path)).toBe(true);
    second.stop();
    await second.stopped;
    expect(fs.existsSync(second.path)).toBe(false);
  });

  test("a session id or run id that is not one is refused before any path is made", () => {
    expect(() =>
      startSidecar({ dir: "/nonexistent", sid: "../x", runId: RUN, out: (_l, d) => d() }),
    ).toThrow(RangeError);
    expect(() =>
      startSidecar({ dir: "/nonexistent", sid: SID, runId: "../x", out: (_l, d) => d() }),
    ).toThrow(RangeError);
  });
});

/** `ccmsg sidecar` as the hooks module starts it for run RUN of SID. */
function sidecarArgv(...extra: string[]): string[] {
  return [
    process.execPath,
    CLI,
    "sidecar",
    "--sid",
    SID,
    "--run",
    RUN,
    "--started-at",
    String(Date.now()),
    ...extra,
  ];
}

function sidecarEnv(stateDir: string): Record<string, string> {
  return {
    ...process.env,
    CCMSG_STATE_DIR: stateDir,
    CCMSG_NO_SELF_EXEC: "1",
  };
}

async function readUntil(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  pred: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!pred(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("ccmsg sidecar (process)", () => {
  test("announces ready, copies a line to stdout, leaves on SIGTERM", async () => {
    const stateDir = path.join(shortBase(), "s");
    const proc = Bun.spawn(sidecarArgv(), {
      env: sidecarEnv(stateDir),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = proc.stderr.getReader();
    const ready = await readUntil(err, (t) => t.includes("\n"));
    const socketPath = path.join(resolveSidecarDir(stateDir), sidecarSocketName(SID, RUN));
    expect(ready).toBe(`ready ${socketPath}\n`);
    const request = '{"v":1,"op":"prompt.send","id":"1","args":{"text":"t"}}\n';
    await writeTo(socketPath, request);
    const out = await readUntil(proc.stdout.getReader(), (t) => t.includes("\n"));
    expect(out).toBe(request);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  // The reader is a process that exits at once, as the harness is when it
  // dies without killing its children: the pipe's read end is really closed.
  test("leaves once a write to stdout fails", async () => {
    const stateDir = path.join(shortBase(), "s");
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        '"$0" "$1" sidecar --sid "$2" --run "$3" --started-at 1 | true',
        process.execPath,
        CLI,
        SID,
        RUN,
      ],
      { env: sidecarEnv(stateDir), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const err = proc.stderr.getReader();
    await readUntil(err, (t) => t.includes("\n"));
    const socketPath = path.join(resolveSidecarDir(stateDir), sidecarSocketName(SID, RUN));
    await writeTo(socketPath, "first\n");
    await writeTo(socketPath, "second\n");
    const rest = await readUntil(err, () => false);
    expect(rest).toContain(`reader_gone ${socketPath}\n`);
    await proc.exited;
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  test("--help says what it is and no more", async () => {
    const proc = Bun.spawn([process.execPath, CLI, "sidecar", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("hooks module");
    expect(out).not.toContain(".sock");
    expect(out).not.toContain("prompt.send");
    expect(out).not.toContain('"op"');
  });

  for (const [name, args] of [
    ["a --sid that is not a session id", ["--sid", "nope", "--run", RUN, "--started-at", "1"]],
    ["a --run that is not a run id", ["--sid", SID, "--run", "../x", "--started-at", "1"]],
    ["no --run", ["--sid", SID, "--started-at", "1"]],
    ["a --started-at that is not a time", ["--sid", SID, "--run", RUN, "--started-at", "soon"]],
  ] as const) {
    test(`${name} is refused`, async () => {
      const proc = Bun.spawn([process.execPath, CLI, "sidecar", ...args], {
        env: sidecarEnv(path.join(shortBase(), "s")),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(2);
    });
  }
});

/** `ccmsg sidecar reply --sid SID` with `stdin` on its standard input, as the
 * module's `$.process.run` runs it. */
function runReply(stdin: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, CLI, "sidecar", "reply", "--sid", SID], {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function startShortDaemon(): Promise<DaemonCtx> {
  const base = shortBase();
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
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: testConfigDir(dataDir),
      CCMSG_DATA_DIR: dataDir,
      CCMSG_NO_SELF_EXEC: "1",
    },
  };
}

describe("ccmsg sidecar reply", () => {
  // The whole route the module uses: the daemon writes to the sidecar, the
  // sidecar copies the request out, and `sidecar reply` answers it.
  test("answers the session_input request the sidecar copied out", async () => {
    const ctx = await startShortDaemon();
    const sidecar = Bun.spawn(sidecarArgv("--hyoui-session-id", "hy-1"), {
      env: { ...process.env, ...ctx.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // Written to only once it has named the run.
      await readUntil(sidecar.stderr.getReader(), (t) => t.includes("named "));
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const answer = user.request({ op: "session_input", session_id: SID, text: "from the web" });
      // The daemon asks the run for its facts when it is named; the
      // session_input's request is the prompt.send.
      const promptSendIn = (text: string): SidecarRequest | undefined =>
        text
          .split("\n")
          .filter((l) => l !== "")
          .map(sidecarRequestOf)
          .find((r) => r.op === "prompt.send");
      const out = await readUntil(sidecar.stdout.getReader(), (t) => {
        const complete = t.slice(0, t.lastIndexOf("\n") + 1);
        return promptSendIn(complete) !== undefined;
      });
      const line = promptSendIn(out);
      if (line === undefined) throw new Error(`no prompt.send in ${out}`);
      expect(line).toEqual({
        v: 1,
        op: "prompt.send",
        id: line.id,
        args: { text: "from the web" },
      });
      const reply = runReply(
        JSON.stringify({
          id: line.id,
          ok: true,
          result: { outcome: "not_delivered", reason: "no_terminal" },
        }),
        ctx.env,
      );
      expect(await reply.exited).toBe(0);
      expect(await answer).toEqual({ ok: true, outcome: "not_delivered", reason: "no_terminal" });
      user.close();
    } finally {
      sidecar.kill("SIGTERM");
      await sidecar.exited;
      await stopTestDaemon(ctx);
    }
  });

  // Refused before a daemon is looked for: the state dir has none.
  for (const [name, stdin, says] of [
    ["input that is not JSON", "accepted", "must be one JSON reply"],
    ["a reply without an id", '{"ok":true,"result":{}}', "id: Invalid key"],
    [
      "an error code nobody defined",
      '{"id":"x","ok":false,"error":{"code":"bogus","message":""}}',
      'error.code: Invalid type: Expected "internal"',
    ],
  ] as const) {
    test(`${name} is refused before reaching the daemon`, async () => {
      const proc = runReply(stdin, sidecarEnv(path.join(shortBase(), "s")));
      expect(await proc.exited).toBe(1);
      expect(await new Response(proc.stderr).text()).toContain(says);
    });
  }
});

/** `ccmsg sidecar facts --sid SID` with `stdin` on its standard input, as the
 * module's `$.process.run` runs it. */
function runFacts(stdin: string, env: Record<string, string>) {
  return Bun.spawn([process.execPath, CLI, "sidecar", "facts", "--sid", SID], {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("ccmsg sidecar facts", () => {
  const FACTS = '{"at":5,"model":"claude-opus-5-5[1m]","context":{"window":1000000,"at":5}}';

  test("hands the facts to the daemon, as the session's", async () => {
    const ctx = await startShortDaemon();
    try {
      const proc = runFacts(FACTS, ctx.env);
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stderr).text()).toBe("");
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const status = await user.requestError({ op: "session_status", sid: SID });
      // No transcript for this session, but the facts registered it.
      expect(status.error.code).toBe("not_found");
      const peers = await user.requestOk({ op: "peers" });
      expect(peers.peers.some((p) => p.sid === SID)).toBe(true);
      user.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // No daemon is started for facts: a daemon the person stopped stays
  // stopped, and the next one asks the module for them.
  test("with no daemon listening the facts are dropped, and none is started", async () => {
    const stateDir = path.join(shortBase(), "s");
    const proc = runFacts(FACTS, sidecarEnv(stateDir));
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stderr).text()).toContain("no daemon took the facts");
    expect(fs.existsSync(path.join(stateDir, "daemon.sock"))).toBe(false);
  });

  test("input that is not the facts is refused before reaching the daemon", async () => {
    const proc = runFacts('{"model":"m"}', sidecarEnv(path.join(shortBase(), "s")));
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("must be the session's facts");
  });
});

/** A `ps` that records being run: naming the run needs none, and a sidecar
 * in a sandbox could not run it. */
function psRecorder(base: string): { path: string; calls(): string } {
  const bin = path.join(base, "bin");
  const log = path.join(base, "ps.log");
  fs.mkdirSync(bin, { recursive: true });
  writeMockBin(path.join(bin, "ps"), `#!/bin/sh\necho "$*" >> "${log}"\nexit 1\n`);
  return {
    path: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
  };
}

/** Stop the daemon of `ctx` and wait for it to exit, keeping its directories
 * for the next daemon. */
async function stopKeepingDirs(ctx: DaemonCtx): Promise<void> {
  const c = await connect(ctx.sock);
  await c.request({ op: "shutdown" }).catch(() => undefined);
  c.close();
  await ctx.proc.exited;
}

describe("ccmsg sidecar names its run to the daemon", () => {
  const rowOf = (peers: readonly { sid: string; input_readiness?: { kind: string } }[]) =>
    peers.find((p) => p.sid === SID)?.input_readiness?.kind;

  // The daemon learns of the run from the sidecar itself, and of its end from
  // the connection closing: no directory watched, no `ps`. The watcher
  // subscribes before the sidecar starts, as subscribing pushes no peers list.
  test("named once bound, gone once it leaves, with no ps run", async () => {
    const ctx = await startShortDaemon();
    const ps = psRecorder(ctx.base);
    const user = await connect(ctx.sock);
    await user.hello({ role: "user" });
    await user.request({ op: "subscribe" });
    const sidecar = Bun.spawn(sidecarArgv("--hyoui-session-id", "hy-1"), {
      env: { ...process.env, ...ctx.env, PATH: ps.path },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await user.readEventUntil("peers", (ev) => rowOf(ev.peers) === "ready");
      sidecar.kill("SIGTERM");
      expect(await sidecar.exited).toBe(0);
      await user.readEventUntil("peers", (ev) => rowOf(ev.peers) === "no_module");
      expect(ps.calls()).toBe("");
      user.close();
    } finally {
      sidecar.kill("SIGTERM");
      await sidecar.exited;
      await stopTestDaemon(ctx);
    }
  });
});

describe("keepNamed", () => {
  const PROBE_SID = "11111111-2222-4333-8444-666666666666";
  const PROBE_RUN = "mgq1k2x3abcd5678";
  const rowOf = (
    peers: readonly { sid: string; input_readiness?: { kind: string } }[],
    sid: string = SID,
  ) => peers.find((p) => p.sid === sid)?.input_readiness?.kind;
  const identity = { role: "session", sid: SID, repo: "", ws: "", cwd: "" } as const;
  const name = { runId: RUN, startedAt: 1, hyouiSessionId: "hy-1" };

  // A daemon that starts after the sidecar (a restart, an upgrade) knows
  // nothing of the run until the sidecar connects to it and names it again.
  //
  // Subscribing pushes no peers list, only the changes after it, so each
  // watcher subscribes before the run is named to its daemon: keepNamed is
  // started once `before` is subscribed, and the next attempt is let go once
  // `after` is.
  test("names the run, and again to the daemon that listens after the first", async () => {
    const first = await startShortDaemon();
    const paths = resolvePaths(first.env);
    const stop = Promise.withResolvers<void>();
    const asked: number[] = [];
    const askedOnce = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const lines: string[] = [];
    // keepNamed says it named the run once the daemon's answer reaches it,
    // which may be after the daemon's push to a watcher has: what it says is
    // read once it has said it.
    const namedTwice = Promise.withResolvers<void>();
    let named: Promise<void> | undefined;
    let second: DaemonCtx | undefined;
    try {
      const before = await connect(first.sock);
      await before.hello({ role: "user" });
      await before.request({ op: "subscribe" });
      named = keepNamed({
        paths,
        identity,
        name,
        stopped: stop.promise,
        log: (line) => {
          lines.push(line);
          if (lines.filter((l) => l.startsWith("named ")).length === 2) namedTwice.resolve();
        },
        wait: (ms) => {
          asked.push(ms);
          askedOnce.resolve();
          return gate.promise;
        },
      });
      await before.readEventUntil("peers", (ev) => rowOf(ev.peers) === "ready");
      before.close();
      await stopKeepingDirs(first);
      // No daemon listens: the next attempt waits.
      await askedOnce.promise;
      expect(asked).toEqual([250]);

      second = { ...first, proc: spawnDaemonProc(first.stateDir, first.dataDir) };
      await waitConnectable(first.sock);
      const after = await connect(first.sock);
      await after.hello({ role: "user" });
      await after.request({ op: "subscribe" });
      // A daemon that takes a run named now is not enough: once a probe run of
      // another session, named the way keepNamed names, shows as ready, this
      // run still does not, as its next attempt waits for the wait to be over.
      const probe = defined(
        await nameRunNoSpawn(
          paths,
          { ...identity, sid: PROBE_SID },
          { runId: PROBE_RUN, startedAt: 1, hyouiSessionId: "hy-2" },
        ),
        "the probe run named",
      );
      const { ev } = await after.readEventUntil(
        "peers",
        (e) => rowOf(e.peers, PROBE_SID) === "ready",
      );
      probe.close();
      expect(rowOf(ev.peers)).not.toBe("ready");
      expect(asked).toEqual([250]);
      expect(lines).toEqual([
        `named ${RUN} to ${paths.sock}`,
        `lost ${paths.sock}; naming the run again once a daemon listens`,
      ]);
      gate.resolve();
      await after.readEventUntil("peers", (ev) => rowOf(ev.peers) === "ready");
      await namedTwice.promise;

      // The sidecar going closes the connection: the run goes with it.
      stop.resolve();
      await named;
      await after.readEventUntil("peers", (ev) => rowOf(ev.peers) === "no_module");
      after.close();
      expect(lines).toEqual([
        `named ${RUN} to ${paths.sock}`,
        `lost ${paths.sock}; naming the run again once a daemon listens`,
        `named ${RUN} to ${paths.sock}`,
      ]);
    } finally {
      stop.resolve();
      gate.resolve();
      await named;
      await stopTestDaemon(second ?? first);
    }
  });

  test("stopped while no daemon listens, it ends without naming anything", async () => {
    const stateDir = path.join(shortBase(), "s");
    const stop = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const lines: string[] = [];
    const named = keepNamed({
      paths: resolvePaths({ CCMSG_STATE_DIR: stateDir }),
      identity,
      name,
      stopped: stop.promise,
      log: (line) => lines.push(line),
      wait: () => {
        waiting.resolve();
        return new Promise<void>(() => {});
      },
    });
    await waiting.promise;
    stop.resolve();
    await named;
    expect(lines).toEqual([]);
  });
});

/** `ccmsg sidecar send` as the module's `$.process.run` runs it: the text on
 * standard input, named as `/dev/stdin`. */
async function runSend(
  args: string[],
  stdin: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, CLI, "sidecar", "send", ...args], {
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** The reason a printed result gives for a send that reached nobody. */
function notDeliveredReason(out: string): string {
  const read = parseWith(SendMessageResultTextSchema, out);
  if (!read.ok || read.value.isDelivered) throw new Error(`not a refused send: ${out}`);
  return read.value.reason;
}

describe("ccmsg sidecar send", () => {
  const OTHER = "22222222-2222-4333-8444-555555555555";

  test("sends the text on standard input to the address, and prints that it was delivered", async () => {
    const ctx = await startShortDaemon();
    // The recipient's state file names a running process: this test's.
    const harness = fakeHarness(OTHER, { pid: process.pid });
    try {
      // The sender announces the config dir it runs under, which the daemon
      // then looks for the recipient in.
      const env = { ...process.env, ...ctx.env, CLAUDE_CONFIG_DIR: harness.configDir };
      const text = "line 1\n`not run` $HOME 'quoted' \"double\"\n";
      const sent = await runSend(["--sid", SID, "--to", `ccmsg:${OTHER}`, "/dev/stdin"], text, env);
      expect(sent).toEqual({ code: 0, out: '{"isDelivered":true}\n', err: "" });
      const { attrs, body } = parseEnvelope(await harness.nextContent());
      expect(attrs.from).toBe(`ccmsg:${SID}`);
      expect(body).toBe(text);

      const missing = await runSend(
        ["--sid", SID, "--to", "ccmsg:33333333-2222-4333-8444-555555555555", "/dev/stdin"],
        "hi",
        env,
      );
      expect(missing.code).toBe(0);
      expect(notDeliveredReason(missing.out)).toContain(
        "ccmsg peers で今いるセッションの宛先を確かめて",
      );

      const unreadable = await runSend(
        ["--sid", SID, "--to", "ccmsg:nobody", "/dev/stdin"],
        "hi",
        env,
      );
      expect(notDeliveredReason(unreadable.out)).toContain("ccmsg:path:<絶対パス> のどれでもない");
    } finally {
      harness.dispose();
      await stopTestDaemon(ctx);
    }
  });

  test("arguments that do not make a send exit 2 and print no result", async () => {
    const env = sidecarEnv(path.join(shortBase(), "s"));
    for (const args of [
      ["--sid", SID, "/dev/stdin"],
      ["--sid", SID, "--to", `ccmsg:${OTHER}`],
      ["--sid", SID, "--to", `ccmsg:${OTHER}`, "/dev/stdin", "extra"],
    ]) {
      const run = await runSend(args, "hi", env);
      expect({ args, code: run.code, out: run.out }).toEqual({ args, code: 2, out: "" });
      expect(run.err).toContain("usage: ccmsg sidecar send");
    }
  });
});
