// `ccmsg sidecar` (DR-0035 §3): bind the run's socket, name the run to the
// daemon and keep naming it to whichever daemon runs, copy lines to stdout,
// leave on a signal or when stdout's reader is gone; the module's reply to
// what it copied goes back over POST /op; `ccmsg sidecar launch` (DR-0018
// §3.7) carries its `launch` tool, and `ccmsg sidecar permit` (DR-0040) its
// `permit` tool.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  jsonText,
  LaunchCommandInputSchema,
  parseWith,
  PROTOCOL_VERSION,
  resolvePaths,
  SessionLaunchResponseTextSchema,
  PermitRequestResponseTextSchema,
  type SidecarRequest,
  SidecarRequestSchema,
  sidecarSocketName,
} from "@ccmsg/protocol";
import { nameRunNoSpawn } from "../src/client.ts";
import { keepNamed, socketPeerClosed, startSidecar, streamEnded } from "../src/sidecar.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import {
  connect,
  defined,
  spawnDaemonProc,
  startInProcessDaemon,
  stopInProcessDaemon,
  stopTestDaemon,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
  userConn,
} from "../../daemon/test/helpers.ts";
import { writeSocket } from "../../daemon/src/peer-inject.ts";
import { openLifeline } from "../../testkit/src/lifeline.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LEAKY_FIXTURE = fileURLToPath(new URL("./leaky-sidecar.fixture.ts", import.meta.url));

const SidecarRequestTextSchema = jsonText(SidecarRequestSchema);

/** A line the sidecar wrote for the hooks module, read as the request it is. */
function sidecarRequestOf(line: string): SidecarRequest {
  const read = parseWith(SidecarRequestTextSchema, line);
  if (!read.ok) throw new Error(`not a sidecar request: ${read.failure.summary}: ${line}`);
  return read.value;
}
const SID = "11111111-2222-4333-8444-555555555555";
const RUN = "mgq1k2x3abcd1234";

/** The base dirs this file's tests make, removed after the file. */
const bases: string[] = [];
function shortBase(): string {
  const base = shortTmpDir("ccmsg-sc-");
  bases.push(base);
  return base;
}
/** Sidecars started under a harness a test killed. One that did not leave is
 * stopped here rather than left running after the suite. */
const orphans: number[] = [];
afterAll(() => {
  for (const pid of orphans) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone, as it should be.
    }
  }
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

  // The sidecar binds and the daemon writes to `<stateDir>/sidecars` however
  // long the state dir: a socket path past `sun_path` (104 bytes on macOS,
  // 108 on Linux) is bound and connected as is, so there is no second place
  // to fall back to (DR-0035 §3).
  test("a socket path longer than sun_path is bound, written to and removed", async () => {
    const dir = path.join(shortBase(), "d".repeat(100), "e".repeat(100), "sidecars");
    const got = Promise.withResolvers<string>();
    const sidecar = startSidecar({
      dir,
      sid: SID,
      runId: "run4246",
      out: (line, done) => {
        got.resolve(line);
        done();
      },
    });
    try {
      expect(Buffer.byteLength(sidecar.path)).toBeGreaterThan(108);
      expect(await writeSocket(sidecar.path, "long\n", 2_000)).toBe("written");
      expect(await got.promise).toBe("long\n");
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

  test("out closing is the reader gone, with nothing written", async () => {
    const dir = path.join(shortBase(), "sc");
    const closed = Promise.withResolvers<void>();
    const sidecar = startSidecar({
      dir,
      sid: SID,
      runId: "run4245",
      out: (_line, done) => done(),
      outClosed: closed.promise,
    });
    closed.resolve();
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

describe("socketPeerClosed", () => {
  // A terminal's input is the person's and a pipe's write end cannot be read;
  // only a socket is watched.
  test("an fd that is not a socket is not watched", () => {
    const file = path.join(shortBase(), "out");
    fs.writeFileSync(file, "");
    const fd = fs.openSync(file, "r");
    try {
      expect(socketPeerClosed(fd)).toBeUndefined();
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("streamEnded", () => {
  test("settles once the stream ends, past whatever it carried", async () => {
    const source = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    let ended = false;
    const done = streamEnded(new ReadableStream({ start: (c) => source.resolve(c) })).then(() => {
      ended = true;
    });
    const controller = await source.promise;
    controller.enqueue(new Uint8Array([1]));
    await Promise.resolve();
    expect(ended).toBe(false);
    controller.close();
    await done;
    expect(ended).toBe(true);
  });

  test("a stream that fails has ended too", async () => {
    await streamEnded(
      new ReadableStream({
        start: (c) => c.error(new Error("ECONNRESET")),
      }),
    );
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
    const socketPath = path.join(
      resolvePaths({ CCMSG_STATE_DIR: stateDir }).sidecars,
      sidecarSocketName(SID, RUN),
    );
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
    const socketPath = path.join(
      resolvePaths({ CCMSG_STATE_DIR: stateDir }).sidecars,
      sidecarSocketName(SID, RUN),
    );
    await writeTo(socketPath, "first\n");
    await writeTo(socketPath, "second\n");
    const rest = await readUntil(err, () => false);
    expect(rest).toContain(`reader_gone ${socketPath}\n`);
    await proc.exited;
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  // A harness that dies is not one that stops writing: nothing may be written
  // to the sidecar for the rest of its life, and a sidecar that only learned
  // of the death from a write would outlive it, naming a session that is gone
  // to every daemon that starts. The harness here is a process that starts
  // the sidecar on a socket, as Claude Code's spawn does, and is killed.
  test("leaves once the process reading its output is gone, with nothing written", async () => {
    const stateDir = path.join(shortBase(), "s");
    const harness = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const child = Bun.spawn(JSON.parse(process.argv[1]), { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
         process.stderr.write("child " + child.pid + "\\n");
         await child.exited;`,
        JSON.stringify(sidecarArgv()),
      ],
      { env: sidecarEnv(stateDir), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const err = harness.stderr.getReader();
    const started = await readUntil(err, (t) => /ready .*\n/.test(t));
    const child = /child (\d+)/.exec(started);
    if (child !== null) orphans.push(Number(child[1]));
    const socketPath = path.join(
      resolvePaths({ CCMSG_STATE_DIR: stateDir }).sidecars,
      sidecarSocketName(SID, RUN),
    );
    harness.kill("SIGKILL");
    const rest = await readUntil(err, () => false);
    expect(rest).toContain(`reader_gone ${socketPath}\n`);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  // A sidecar a test run starts lives no longer than the run, as a daemon does
  // (packages/testkit/src/lifeline.ts): written to or not, and whatever reads
  // its output, it leaves once the run's lifeline closes.
  test("leaves once the test run's lifeline closes, with nothing written", async () => {
    const base = shortBase();
    const lifeline = openLifeline(path.join(base, "line.sock"));
    const stateDir = path.join(base, "s");
    const proc = Bun.spawn(sidecarArgv(), {
      env: { ...sidecarEnv(stateDir), CCMSG_TEST_LIFELINE: lifeline.path },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const err = proc.stderr.getReader();
      await readUntil(err, (t) => t.includes("\n"));
      const socketPath = path.join(
        resolvePaths({ CCMSG_STATE_DIR: stateDir }).sidecars,
        sidecarSocketName(SID, RUN),
      );
      lifeline.close();
      const rest = await readUntil(err, () => false);
      expect(rest).toContain(`stopped ${socketPath}\n`);
      expect(await proc.exited).toBe(0);
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      lifeline.close();
      proc.kill();
    }
  });

  // The run's end check names a sidecar a test left running, and the sidecar
  // goes with the run.
  test("a run that leaves a sidecar running fails naming it, and the sidecar goes with the run", async () => {
    const run = Bun.spawn([process.execPath, "test", LEAKY_FIXTURE], {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const out = await readUntil(run.stdout.getReader(), (t) => /socket=.*\n/.test(t));
      const socketPath = defined(/socket=(.*)\n/.exec(out)?.[1], "the leaked sidecar's socket");
      // The sidecar keeps a connection open until its process exits.
      const gone = Promise.withResolvers<void>();
      await Bun.connect({
        unix: socketPath,
        socket: { data() {}, close: () => gone.resolve(), error: () => gone.resolve() },
      });
      // Let the fixture's test finish with its sidecar still up.
      await run.stdin.end();
      const err = await new Response(run.stderr).text();
      expect(await run.exited).toBe(1);
      expect(err).toContain("1 process(es) were not stopped by the test that started them");
      expect(err).toContain(socketPath);
      await gone.promise;
    } finally {
      run.kill();
    }
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

async function startShortDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonCtx> {
  const base = shortBase();
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
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: testConfigDir(dataDir),
      CCMSG_DATA_DIR: dataDir,
    },
  };
}

describe("a request the sidecar copied out, and its reply", () => {
  // The whole route the module uses: the daemon writes to the sidecar, the
  // sidecar copies the request out, and the reply goes back over POST /op
  // (DR-0046) from the session's process, here this test process, recorded
  // as session SID in a config dir the daemon serves.
  test("answers the user_prompt request the sidecar copied out", async () => {
    const claudeConfig = path.join(shortBase(), "claude-config");
    fs.mkdirSync(path.join(claudeConfig, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(claudeConfig, "sessions", `${String(process.pid)}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: SID,
        cwd: "/tmp",
        startedAt: 1,
        kind: "interactive",
      }),
    );
    const ctx = await startShortDaemon({ CCMSG_CLAUDE_CONFIG_DIRS: claudeConfig });
    const sidecar = Bun.spawn(sidecarArgv("--hyoui-session-id", "hy-1"), {
      env: { ...process.env, ...ctx.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // Written to only once it has named the run.
      await readUntil(sidecar.stderr.getReader(), (t) => t.includes("named "));
      const user = await userConn(ctx);
      const answer = user.request({ op: "user_prompt", session_id: SID, text: "from the web" });
      // The daemon asks the run for its facts when it is named; the
      // user_prompt's request is the prompt.send.
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
      const reply = await fetch("http://ccmsg/op", {
        unix: path.join(ctx.stateDir, "http.sock"),
        method: "POST",
        body: JSON.stringify({
          op: "sidecar_reply",
          reply: {
            id: line.id,
            ok: true,
            result: { outcome: "not_delivered", reason: "no_terminal" },
          },
          hello: { sid: SID, protocol: PROTOCOL_VERSION },
        }),
      });
      expect([reply.status, await reply.text()]).toEqual([200, '{"ok":true,"request_id":"op"}']);
      expect(await answer).toEqual({ ok: true, outcome: "not_delivered", reason: "no_terminal" });
      user.close();
    } finally {
      sidecar.kill("SIGTERM");
      await sidecar.exited;
      await stopTestDaemon(ctx);
    }
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
    const user = await userConn(ctx);
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
      const before = await userConn(first);
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
      const after = await userConn(first);
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

// `launch` (DR-0018 §3.7): the launch goes to the daemon as the session's
// session_launch, the daemon runs the configured launch command, and its
// reply is printed as it came.
describe("ccmsg sidecar launch", () => {
  /** `ccmsg sidecar launch --sid SID` with `stdin` on its standard input. */
  async function runLaunch(
    stdin: string,
    env: Record<string, string | undefined>,
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, CLI, "sidecar", "launch", "--sid", SID], {
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

  /** A daemon in this process whose launch command is a script that prints
   * its standard input and exits `exit`; `run` gets the CLI's environment
   * for it and a directory to launch in. */
  async function withLauncher(
    exit: number,
    run: (env: Record<string, string | undefined>, work: string) => Promise<void>,
  ): Promise<void> {
    const work = fs.realpathSync(shortBase());
    const command = writeMockBin(
      path.join(work, "launch"),
      `#!/bin/sh\ncat\necho launched >&2\nexit ${String(exit)}\n`,
    );
    const ctx = await startInProcessDaemon({
      config: { session_launcher: { launch_command: [command], root_dirs: [work] } },
    });
    try {
      const { stateDir, configDir, dataDir } = ctx.daemon.paths;
      await run(
        {
          ...process.env,
          CCMSG_STATE_DIR: stateDir,
          CCMSG_CONFIG_DIR: configDir,
          CCMSG_DATA_DIR: dataDir,
        },
        work,
      );
    } finally {
      await stopInProcessDaemon(ctx);
    }
  }

  function launchReply(out: string) {
    const read = parseWith(SessionLaunchResponseTextSchema, out);
    if (!read.ok) throw new Error(`not a session_launch reply: ${read.failure.summary}: ${out}`);
    return read.value;
  }

  test("prints the daemon's reply: what the launch command read, and the new session's id", async () => {
    await withLauncher(0, async (env, work) => {
      const prompt = "line 1\n`not run` $HOME 'quoted'";
      const run = await runLaunch(
        JSON.stringify({ cwd: work, model: "haiku", effort: "low", prompt }),
        env,
      );
      expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: "" });
      const reply = launchReply(run.out);
      expect(reply).toMatchObject({ ok: true, exit_code: 0, stderr: "launched\n" });
      const read = parseWith(jsonText(LaunchCommandInputSchema), reply.stdout);
      if (!read.ok) throw new Error(read.failure.summary);
      expect(read.value).toEqual({
        cwd: work,
        model: "haiku",
        effort: "low",
        prompt,
        session_id: defined(reply.session_id, "the new session's id"),
      });
    });
  });

  test("a launch command that exits non-zero is printed as it came, with no session id", async () => {
    await withLauncher(4, async (env, work) => {
      const run = await runLaunch(
        JSON.stringify({ cwd: work, resume: SID, fork_session: true }),
        env,
      );
      expect(run.code).toBe(0);
      const reply = launchReply(run.out);
      expect(reply.exit_code).toBe(4);
      expect(reply).not.toHaveProperty("session_id");
    });
  });

  test("a launch the daemon refused prints its refusal on stderr and exits 1", async () => {
    await withLauncher(0, async (env, work) => {
      const run = await runLaunch(
        JSON.stringify({ cwd: path.join(work, "missing"), continue: true }),
        env,
      );
      expect({ code: run.code, out: run.out }).toEqual({ code: 1, out: "" });
      expect(JSON.parse(run.err)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    });
    // No session_launcher in the config: nothing can be launched.
    const ctx = await startInProcessDaemon();
    try {
      const { stateDir, configDir, dataDir } = ctx.daemon.paths;
      const env = {
        ...process.env,
        CCMSG_STATE_DIR: stateDir,
        CCMSG_CONFIG_DIR: configDir,
        CCMSG_DATA_DIR: dataDir,
      };
      const run = await runLaunch(JSON.stringify({ cwd: "/", continue: true }), env);
      expect(run.code).toBe(1);
      expect(JSON.parse(run.err)).toMatchObject({
        ok: false,
        error: { code: "launcher_not_configured" },
      });
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("input that is not one launch is refused before reaching the daemon", async () => {
    const env = sidecarEnv(path.join(shortBase(), "s"));
    for (const stdin of [
      '{"cwd":"/w"}',
      '{"cwd":"/w","continue":true,"extra":1}',
      '{"cwd":"/w","continue":true,"resume":"' + SID + '"}',
      "not json",
    ]) {
      const run = await runLaunch(stdin, env);
      expect({ stdin, code: run.code, out: run.out }).toEqual({ stdin, code: 1, out: "" });
      expect(run.err).toContain("standard input must be one launch as JSON");
    }
  });

  // No daemon can be had (here, the one it starts stops at its config): exit
  // 3, and nothing was asked to start. The tool tells this apart from a
  // refusal by the code (hooks/tools.ts).
  test("exits 3 when no daemon can be had", async () => {
    const base = shortBase();
    const configDir = path.join(base, "c");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.json"), "{ not json");
    const run = await runLaunch(JSON.stringify({ cwd: "/", continue: true }), {
      ...process.env,
      CCMSG_STATE_DIR: path.join(base, "s"),
      CCMSG_CONFIG_DIR: configDir,
      CCMSG_DATA_DIR: path.join(base, "d"),
    });
    expect({ code: run.code, out: run.out }).toEqual({ code: 3, out: "" });
    expect(run.err).toContain("ccmsg sidecar launch: the daemon could not be reached: ");
  });
});

// `permit` (DR-0040): the request goes to the daemon as the session's
// permit_request, and once the daemon recorded it the speakers say that a
// session is asking, through the speech binary `ccmsg say` uses.
describe("ccmsg sidecar permit", () => {
  /** `ccmsg sidecar permit --sid SID` with `stdin` on its standard input. */
  async function runPermit(
    stdin: string,
    env: Record<string, string | undefined>,
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, CLI, "sidecar", "permit", "--sid", SID], {
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

  /** A daemon in this process that speaks through a binary writing its
   * arguments to a file and exiting `speechExit` (the daemon speaks the
   * request, DR-0045 §6), the CLI's environment, and what was spoken once the
   * daemon's speeches ended. */
  async function withDaemon(
    speechExit: number,
    run: (
      env: Record<string, string | undefined>,
      ctx: Awaited<ReturnType<typeof startInProcessDaemon>>,
      spoken: () => Promise<string>,
      work: string,
    ) => Promise<void>,
  ): Promise<void> {
    const work = fs.realpathSync(shortBase());
    const spokenFile = path.join(work, "spoken");
    const speech = writeMockBin(
      path.join(work, "say"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(spokenFile)}\nexit ${String(speechExit)}\n`,
    );
    const ctx = await startInProcessDaemon({ env: { CCMSG_SAY_BIN: speech } });
    try {
      const { stateDir, configDir, dataDir } = ctx.daemon.paths;
      await run(
        {
          ...process.env,
          CCMSG_STATE_DIR: stateDir,
          CCMSG_CONFIG_DIR: configDir,
          CCMSG_DATA_DIR: dataDir,
        },
        ctx,
        async () => {
          await ctx.daemon.speaker.idle();
          return fs.existsSync(spokenFile) ? fs.readFileSync(spokenFile, "utf8") : "";
        },
        work,
      );
    } finally {
      await stopInProcessDaemon(ctx);
    }
  }

  test("records the request as the session's, says one is asking, and prints the reply", async () => {
    await withDaemon(0, async (env, ctx, spoken, work) => {
      const script = path.join(work, "deploy.sh");
      const command = { command: "sh deploy.sh \\\n  --prod", description: "本番に出す" };
      const run = await runPermit(
        JSON.stringify({
          blocked: "deploy が止められた",
          attachments: [script],
          commands: [command],
        }),
        env,
      );
      expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: "" });
      const reply = parseWith(PermitRequestResponseTextSchema, run.out);
      if (!reply.ok) throw new Error(reply.failure.summary);
      expect(ctx.daemon.permitRequests.snapshot()).toMatchObject([
        { id: reply.value.id, sid: SID, attachments: [script], commands: [command] },
      ]);
      // After `--`, so a voice starting with `-` is not an option of say.
      expect(await spoken()).toBe("-- 許可を求めています\n");
    });
  });

  // 何を保証するか: voice があれば固定文の代わりにそれを読み上げ (辞書も当たる)、
  // voice は依頼の記録に入る。`-` で始まる voice も say の option にならない。
  test("says the request's voice in place of the fixed sentence, and records it", async () => {
    await withDaemon(0, async (env, ctx, spoken) => {
      const { configDir } = ctx.daemon.paths;
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "say-dictionary.tsv"), "push\tプッシュ\n");
      for (const voice of ["push の許可をお願いします。", "-v の許可をお願いします。"]) {
        const run = await runPermit(
          JSON.stringify({ blocked: "x", commands: [{ command: "git push" }], voice }),
          env,
        );
        expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: "" });
      }
      expect(await spoken()).toBe(
        "-- プッシュ の許可をお願いします。\n-- -v の許可をお願いします。\n",
      );
      expect(ctx.daemon.permitRequests.snapshot().map((r) => r.voice)).toEqual([
        "push の許可をお願いします。",
        "-v の許可をお願いします。",
      ]);
    });
  });

  // The speech goes through the reading dictionary like a say does
  // (DR-0045 §6): one dictionary for everything the speakers say.
  test("says that one is asking with the reading dictionary applied", async () => {
    await withDaemon(0, async (env, ctx, spoken) => {
      const { configDir } = ctx.daemon.paths;
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "say-dictionary.tsv"), "許可\tきょか\n");
      const run = await runPermit(JSON.stringify({ blocked: "x", intents: ["編集"] }), env);
      expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: "" });
      expect(await spoken()).toBe("-- きょかを求めています\n");
    });
  });

  // The request is what the person reads; a speech that fails costs the
  // sound, not the request, and is the daemon's to log.
  test("a speech that fails is said in the daemon's log, and the request still stands", async () => {
    await withDaemon(5, async (env, ctx, spoken) => {
      const run = await runPermit(JSON.stringify({ blocked: "x", intents: ["編集"] }), env);
      expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: "" });
      expect(await spoken()).toBe("-- 許可を求めています\n");
      expect(fs.readFileSync(ctx.daemon.paths.log, "utf8")).toContain("exited 5");
      expect(ctx.daemon.permitRequests.snapshot()).toHaveLength(1);
    });
  });

  test("input that asks for nothing is refused before reaching the daemon, with no speech", async () => {
    await withDaemon(0, async (env, ctx, spoken) => {
      for (const stdin of [
        '{"blocked":"x"}',
        '{"blocked":"x","commands":[{"command":"ls"}],"extra":1}',
        '{"blocked":"x","commands":["ls"]}',
        "nope",
      ]) {
        const run = await runPermit(stdin, env);
        expect({ stdin, code: run.code, out: run.out }).toEqual({ stdin, code: 1, out: "" });
        expect(run.err).toContain("standard input must be one request for permission as JSON");
      }
      expect(ctx.daemon.permitRequests.snapshot()).toEqual([]);
      expect(await spoken()).toBe("");
    });
  });

  test("exits 3 when no daemon can be had, with no speech", async () => {
    const base = shortBase();
    const configDir = path.join(base, "c");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.json"), "{ not json");
    const spokenFile = path.join(base, "spoken");
    const speech = writeMockBin(
      path.join(base, "say"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(spokenFile)}\n`,
    );
    const run = await runPermit(JSON.stringify({ blocked: "x", commands: [{ command: "ls" }] }), {
      ...process.env,
      CCMSG_STATE_DIR: path.join(base, "s"),
      CCMSG_CONFIG_DIR: configDir,
      CCMSG_DATA_DIR: path.join(base, "d"),
      CCMSG_SAY_BIN: speech,
    });
    expect({ code: run.code, out: run.out }).toEqual({ code: 3, out: "" });
    expect(run.err).toContain("ccmsg sidecar permit: the daemon could not be reached: ");
    expect(fs.existsSync(spokenFile)).toBe(false);
  });
});
