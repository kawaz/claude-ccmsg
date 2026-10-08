// `ccmsg sidecar` (DR-0035 §3): bind the run's socket, copy lines to stdout,
// leave on a signal or when stdout's reader is gone; `ccmsg sidecar report`
// carries the module's answer to the daemon.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSidecarDir, sidecarSocketName } from "@ccmsg/protocol";
import { harnessPid, startSidecar, type AskProcess } from "../src/sidecar.ts";
import {
  connect,
  spawnDaemonProc,
  stopTestDaemon,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
} from "../../daemon/test/helpers.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";

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
      pid: 4242,
      out: (line, done) => {
        lines.push(line);
        if (lines.length === 3) got.resolve();
        done();
      },
    });
    try {
      expect(sidecar.path).toBe(path.join(dir, `${SID}.4242.sock`));
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

  test("a failing out is the reader gone, and ends the sidecar", async () => {
    const dir = path.join(shortBase(), "sc");
    const sidecar = startSidecar({
      dir,
      sid: SID,
      pid: 4243,
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
    const first = startSidecar({ dir, sid: SID, pid: 4244, out: (_l, done) => done() });
    const second = startSidecar({ dir, sid: SID, pid: 4244, out: (_l, done) => done() });
    first.stop();
    await first.stopped;
    expect(fs.existsSync(second.path)).toBe(true);
    second.stop();
    await second.stopped;
    expect(fs.existsSync(second.path)).toBe(false);
  });

  test("a session id that is not one is refused before any path is made", () => {
    expect(() =>
      startSidecar({ dir: "/nonexistent", sid: "../x", pid: 1, out: (_l, d) => d() }),
    ).toThrow(RangeError);
  });
});

describe("harnessPid", () => {
  const tree: Record<number, { ppid: number; command: string }> = {
    300: { ppid: 200, command: "bun run /x/packages/cli/src/index.ts sidecar" },
    200: { ppid: 100, command: "/opt/homebrew/bin/claude --plugin-dir /x" },
    100: { ppid: 1, command: "-zsh" },
    50: { ppid: 1, command: "/bin/bash script" },
  };
  const ask: AskProcess = (pid) => tree[pid];

  test("walks up to the first claude, with or without a directory", () => {
    expect(harnessPid(ask, 300)).toBe(200);
    expect(harnessPid(ask, 200)).toBe(200);
  });

  test("undefined outside a harness", () => {
    expect(harnessPid(ask, 50)).toBeUndefined();
    expect(harnessPid(ask, 999)).toBeUndefined();
  });
});

function sidecarEnv(stateDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
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
    const proc = Bun.spawn(
      [process.execPath, CLI, "sidecar", "--sid", SID, "--pid", String(process.pid)],
      { env: sidecarEnv(stateDir), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const err = proc.stderr.getReader();
    const ready = await readUntil(err, (t) => t.includes("\n"));
    const socketPath = path.join(resolveSidecarDir(stateDir), sidecarSocketName(SID, process.pid));
    expect(ready).toBe(`ready ${socketPath}\n`);
    await writeTo(socketPath, '{"kind":"prompt.fill","id":"1","text":"t"}\n');
    const out = await readUntil(proc.stdout.getReader(), (t) => t.includes("\n"));
    expect(out).toBe('{"kind":"prompt.fill","id":"1","text":"t"}\n');
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
        '"$0" "$1" sidecar --sid "$2" --pid "$3" | true',
        process.execPath,
        CLI,
        SID,
        String(process.pid),
      ],
      { env: sidecarEnv(stateDir), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const err = proc.stderr.getReader();
    await readUntil(err, (t) => t.includes("\n"));
    const socketPath = path.join(resolveSidecarDir(stateDir), sidecarSocketName(SID, process.pid));
    await writeTo(socketPath, "first\n");
    await writeTo(socketPath, "second\n");
    const rest = await readUntil(err, () => false);
    expect(rest).toBe(`reader_gone ${socketPath}\n`);
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
    expect(out).not.toContain("prompt.fill");
  });

  test("a non-session-id --sid is refused", async () => {
    const proc = Bun.spawn([process.execPath, CLI, "sidecar", "--sid", "nope", "--pid", "1"], {
      env: sidecarEnv(path.join(shortBase(), "s")),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(2);
  });
});

describe("ccmsg sidecar report", () => {
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

  // The whole route the module uses: the daemon writes to the sidecar, the
  // sidecar copies the line out, and `sidecar report` answers the request.
  test("answers the session_input the sidecar copied out", async () => {
    const ctx = await startShortDaemon();
    const sidecar = Bun.spawn(
      [process.execPath, CLI, "sidecar", "--sid", SID, "--pid", String(process.pid)],
      {
        env: { ...(process.env as Record<string, string>), ...ctx.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await readUntil(sidecar.stderr.getReader(), (t) => t.includes("\n"));
      const user = await connect(ctx.sock);
      await user.hello({ role: "user" });
      const reply = user.request({ op: "session_input", session_id: SID, text: "from the web" });
      const line = JSON.parse(await readUntil(sidecar.stdout.getReader(), (t) => t.includes("\n")));
      expect(line).toEqual({ kind: "prompt.fill", id: line.id, text: "from the web" });
      const report = Bun.spawn(
        [
          process.execPath,
          CLI,
          "sidecar",
          "report",
          "--sid",
          SID,
          "--id",
          line.id,
          "--outcome",
          "not_delivered",
          "--reason",
          "no_terminal",
        ],
        {
          env: { ...(process.env as Record<string, string>), ...ctx.env },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await report.exited).toBe(0);
      expect(await reply).toEqual({ ok: true, outcome: "not_delivered", reason: "no_terminal" });
      user.close();
    } finally {
      sidecar.kill("SIGTERM");
      await sidecar.exited;
      await stopTestDaemon(ctx);
    }
  });

  test("an unknown reason is refused before reaching the daemon", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        CLI,
        "sidecar",
        "report",
        "--sid",
        SID,
        "--id",
        "x",
        "--outcome",
        "not_delivered",
        "--reason",
        "bogus",
      ],
      { env: sidecarEnv(path.join(shortBase(), "s")), stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("--reason must be one of");
  });
});
