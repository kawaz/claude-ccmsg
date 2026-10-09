// `ccmsg post <sid>` / `ccmsg reply <mid> --to <sid>` end to end (DR-0036 §1):
// the real CLI spawns the daemon, the recipients are fake harnesses
// (packages/daemon/test/peer-harness.ts), and what the CLI prints is checked
// against how the timeline and dump classify it.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  classifyCcmsgSendResult,
  directDeliveryReplyLine,
  parseCcmsgSendCommand,
  shellQuote,
} from "@ccmsg/protocol";
import { dumpSession } from "@ccmsg/daemon/session-dump";
import { connect, type TestClient } from "../../daemon/test/helpers.ts";
import {
  LAUNCHER,
  fakeHarness,
  parseEnvelope,
  type FakeHarness,
} from "../../daemon/test/peer-harness.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const T = 30000;
const A = "aaaaaaaa-2222-4333-8444-555555555555";
const B = "bbbbbbbb-2222-4333-8444-555555555555";
const NOBODY = "cccccccc-2222-4333-8444-555555555555";
const MID = "0123456789abcdef0123456789abcdef/1";

interface CliResult {
  out: string;
  err: string;
  code: number;
}

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function makeEnv(): { env: Record<string, string>; sock: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-direct-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const env = {
    // A CLI run inside a session announces that session's config dir in its
    // hello; never the developer's real one here.
    CLAUDE_CONFIG_DIR: path.join(base, "claude"),
    CCMSG_STATE_DIR: stateDir,
    CCMSG_CONFIG_DIR: path.join(dataDir, "config"),
    CCMSG_DATA_DIR: dataDir,
    CCMSG_NO_SELF_EXEC: "1",
  };
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  cleanups.push(() => runCli(["daemon", "stop"], env).catch(() => {}));
  return { env, sock: path.join(stateDir, "daemon.sock") };
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { out, err, code: await proc.exited };
}

function harness(sid: string): FakeHarness {
  const h = fakeHarness(sid);
  cleanups.push(() => h.dispose());
  return h;
}

/** Keep `sid` registered with `configDir` as its CLAUDE_CONFIG_DIR, the way a
 * session's own hello announces it. */
async function hold(sock: string, sid: string, configDir: string): Promise<TestClient> {
  const c = await connect(sock);
  cleanups.push(() => c.close());
  await c.request({
    op: "hello",
    protocol: PROTOCOL_VERSION,
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
    config_dir: configDir,
  });
  return c;
}

/** The words after the launcher in an envelope's reply line, with `<text>`
 * filled in, as the recipient runs it. The launcher is this working copy's
 * `bin/ccmsg`, which runs this CLI. */
function replyArgs(body: string, text: string): string[] {
  const line = body.slice(body.lastIndexOf("\n\n") + 2);
  const prefix = `Reply with: ${LAUNCHER} `;
  if (!line.startsWith(prefix) || !line.endsWith(" <text>"))
    throw new Error(`no reply line: ${line}`);
  return [...line.slice(prefix.length, -" <text>".length).split(" "), text];
}

describe("ccmsg post <sid> / reply <mid> --to <sid>", () => {
  test(
    "post reaches the session; running its reply line reaches the sender",
    async () => {
      const { env, sock } = makeEnv();
      expect((await runCli(["daemon", "start"], env)).code).toBe(0);
      const ha = harness(A);
      const hb = harness(B);
      await hold(sock, A, ha.configDir);
      await hold(sock, B, hb.configDir);

      // Each CLI runs inside its session, under that session's config dir.
      const asA = { ...env, CLAUDE_CONFIG_DIR: ha.configDir };
      const asB = { ...env, CLAUDE_CONFIG_DIR: hb.configDir };
      const posted = await runCli(["--sid", A, "post", `ccmsg:${B}`, "question"], asA);
      expect(posted.code).toBe(0);
      const sent = JSON.parse(posted.out) as { delivered: boolean; mid: string };
      expect(sent).toEqual({ delivered: true, mid: expect.stringMatching(/^[0-9a-f]{32}\/\d+$/) });
      expect(classifyCcmsgSendResult(posted.out, false)).toEqual({ status: "sent" });

      const received = parseEnvelope(await hb.nextContent());
      expect(received.attrs["ccmsg-mid"]).toBe(sent.mid);
      expect(received.attrs["ccmsg-from"]).toBe(A);

      const replied = await runCli(["--sid", B, ...replyArgs(received.body, "answer")], asB);
      expect({ code: replied.code, err: replied.err }).toEqual({ code: 0, err: "" });
      const answer = JSON.parse(replied.out) as { mid: string };
      const back = parseEnvelope(await ha.nextContent());
      expect(back.attrs["ccmsg-mid"]).toBe(answer.mid);
      expect(back.attrs["ccmsg-reply-to"]).toBe(sent.mid);
      expect(back.attrs["ccmsg-from"]).toBe(B);
      expect(back.body.startsWith("answer\n\nReply with: ")).toBe(true);
    },
    T,
  );

  test(
    "a message that did not arrive is a non-zero exit with why on stderr, never {ok:…}",
    async () => {
      const { env } = makeEnv();
      const res = await runCli(["--sid", A, "post", NOBODY, "hi"], env);
      expect(res.code).toBe(1);
      expect(res.out).toBe("");
      expect(res.err).toContain("届かなかった (session_not_found)");
      expect(res.err).toContain("ccmsg peers");
      // The Bash tool result the timeline and dump see for it.
      expect(classifyCcmsgSendResult(`Exit code 1\n${res.err}`, true)).toMatchObject({
        status: "failed",
      });
      expect(classifyCcmsgSendResult(res.err, false)).toMatchObject({ status: "failed" });
    },
    T,
  );

  test(
    "refused before the daemon: the person, a non-sid, --to on a direct post, reply without --to",
    async () => {
      const { env } = makeEnv();
      for (const to of ["user", "ccmsg:user"]) {
        const res = await runCli(["--sid", A, "post", to, "hi"], env);
        expect(res.code).toBe(1);
        expect(res.err).toContain("PushNotification");
      }
      const notSid = await runCli(["--sid", A, "post", "someone", "hi"], env);
      expect(notSid.code).toBe(1);
      expect(notSid.err).toContain("ccmsg:<sid>");
      const filtered = await runCli(["--sid", A, "post", B, "--to", "a2", "hi"], env);
      expect(filtered.code).toBe(1);
      expect(filtered.err).toContain("--to");
      const noTo = await runCli(["--sid", A, "reply", MID, "hi"], env);
      expect(noTo.code).toBe(1);
      expect(noTo.err).toContain("--to <送り主の sid>");
      const bad = await runCli(["--sid", A, "reply", "abc/1", "hi", "--to", B], env);
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("<instance id>/<n>");
      // None of these reached for a daemon.
      const status = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
      expect(status.running).toBe(false);
    },
    T,
  );
});

/** A launcher at `dir/bin/ccmsg` that records its arguments, one per line, to
 * `dir/args` — what a reply line ran, without running anything else. */
function recordingLauncher(dir: string): { launcher: string; args: () => string[] } {
  const launcher = path.join(dir, "bin", "ccmsg");
  const record = path.join(dir, "args");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${shellQuote(record)}\n`,
    { mode: 0o755 },
  );
  return { launcher, args: () => fs.readFileSync(record, "utf8").split("\n").slice(0, -1) };
}

/** Run a reply line the way a recipient does: `<text>` replaced by its text
 * as one quoted word, the whole line handed to `sh -c`. */
async function runReplyLine(
  line: string,
  text: string,
  env: Record<string, string> = {},
  cwd?: string,
): Promise<{ command: string } & CliResult> {
  const command = line.replace(/^Reply with: /, "").replace(/ <text>$/, ` ${shellQuote(text)}`);
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { command, out, err, code: await proc.exited };
}

/** A directory name a shell would act on if it were spliced in unquoted. */
const HOSTILE_DIR = `my dir; touch PWNED-semi $(touch PWNED-sub) \`touch PWNED-tick\` it's`;

describe("the reply line is one shell command whatever its words hold", () => {
  test(
    "a launcher path and a sid with shell syntax run as words: nothing injected, the intended reply",
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-replyline-"));
      cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
      const { launcher, args } = recordingLauncher(path.join(base, HOSTILE_DIR));
      const sid = "x; touch PWNED-sid; #";
      const mid = "0123456789abcdef0123456789abcdef/3";
      const line = directDeliveryReplyLine(mid, sid, launcher);
      const ran = await runReplyLine(line, "it's $(done)", {}, base);
      expect({ code: ran.code, err: ran.err }).toEqual({ code: 0, err: "" });
      expect(args()).toEqual(["reply", mid, "--to", sid, "it's $(done)"]);
      expect(fs.readdirSync(base).filter((name) => name.startsWith("PWNED"))).toEqual([]);
      expect(fs.readdirSync(path.join(base, HOSTILE_DIR)).sort()).toEqual(["args", "bin"]);
    },
    T,
  );

  test(
    "a quoted launcher: the reply arrives, and the timeline and dump read the call as sent",
    async () => {
      const { env, sock } = makeEnv();
      expect((await runCli(["daemon", "start"], env)).code).toBe(0);
      const ha = harness(A);
      const hb = harness(B);
      await hold(sock, A, ha.configDir);
      await hold(sock, B, hb.configDir);
      const asA = { ...env, CLAUDE_CONFIG_DIR: ha.configDir };
      const asB = { ...env, CLAUDE_CONFIG_DIR: hb.configDir };
      const sent = JSON.parse((await runCli(["--sid", A, "post", B, "question"], asA)).out) as {
        mid: string;
      };
      expect(parseEnvelope(await hb.nextContent()).attrs["ccmsg-mid"]).toBe(sent.mid);

      // This CLI, reached through a path that needs quoting.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-"));
      cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
      const launcher = path.join(home, HOSTILE_DIR, "bin", "ccmsg");
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.writeFileSync(
        launcher,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`,
        { mode: 0o755 },
      );
      const line = directDeliveryReplyLine(sent.mid, A, launcher);
      expect(line.startsWith(`Reply with: '${home}/my dir; `)).toBe(true);

      const ran = await runReplyLine(line, "answer", { ...asB, CCMSG_SID: B }, home);
      expect({ code: ran.code, err: ran.err }).toEqual({ code: 0, err: "" });
      expect(fs.readdirSync(home).filter((name) => name.startsWith("PWNED"))).toEqual([]);
      const back = parseEnvelope(await ha.nextContent());
      expect(back.attrs["ccmsg-reply-to"]).toBe(sent.mid);
      expect(back.attrs["ccmsg-from"]).toBe(B);

      // What the timeline and the dump take from the Bash call and its result.
      expect(parseCcmsgSendCommand(ran.command)).toEqual({
        verb: "reply",
        replyTo: sent.mid,
        to: A,
        text: "answer",
      });
      expect(classifyCcmsgSendResult(ran.out, false)).toEqual({ status: "sent" });
      const configDir = path.join(home, ".claude-test");
      const projectDir = path.join(configDir, "projects", "-repo");
      const dataDir = path.join(home, "data");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(path.join(dataDir, "rooms"), { recursive: true });
      const rows = [
        {
          type: "assistant",
          timestamp: "2026-10-09T10:00:00Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "Bash", input: { command: ran.command } },
            ],
          },
        },
        {
          type: "user",
          timestamp: "2026-10-09T10:00:01Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: ran.out }],
          },
        },
      ];
      fs.writeFileSync(
        path.join(projectDir, `${B}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      const { entries } = await dumpSession(B, { dataDir, configDirs: [configDir] });
      expect(entries.filter((entry) => entry.kind === "ccmsg-sent")).toMatchObject([
        { to: A, text: "answer", meta: { op: "reply", reply_to: sent.mid, status: "sent" } },
      ]);
    },
    T,
  );

  test(
    "the CLI refuses an identity that is not a session id, before reaching for a daemon",
    async () => {
      const { env } = makeEnv();
      for (const [args, extra] of [
        [["--sid", "x; printf PWNED >&2; #", "post", B, "hi"], {}],
        [["post", B, "hi"], { CCMSG_SID: "S1" }],
        [
          [
            "--as-session",
            A.toUpperCase(),
            "reply",
            "0123456789abcdef0123456789abcdef/1",
            "hi",
            "--to",
            B,
          ],
          {},
        ],
      ] as [string[], Record<string, string>][]) {
        const res = await runCli(args, { ...env, ...extra });
        expect({ args, code: res.code }).toEqual({ args, code: 1 });
        expect(res.err).toContain("lowercase UUID");
        expect(res.err).not.toContain("PWNED\n");
      }
      const status = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
      expect(status.running).toBe(false);
    },
    T,
  );
});
