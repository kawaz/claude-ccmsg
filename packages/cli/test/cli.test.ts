// End-to-end CLI: run the real `ccmsg` binary as a subprocess so ensure-daemon's
// spawn/connect path is exercised for real (DR-0002 §2).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseWith, type ResponseOf, SessionStateFileTextSchema, VERSION } from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { defined, jsonObjectOf, refusedReply } from "../../daemon/test/helpers.ts";
import { CliStatusSchema, printed, served } from "./cli-output.ts";
import { runCli, CLI } from "./run-cli.ts";

function makeEnv(): { env: Record<string, string>; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  return {
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: path.join(dataDir, "config"),
      CCMSG_DATA_DIR: dataDir,
      // Pin every spawned CLI to this working copy even if PATH has a newer install.
      CCMSG_NO_SELF_EXEC: "1",
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const MINIMAL_HELP = `Commands:
  dump <session-id> [--since <ts>]          セッション会話を圧縮 JSONL/text で回収
  peers [cwd(partial)]                      セッション一覧
  subscribe                                 Monitor常駐用
  notify --self --text <msg>                自セッション通知 (justfile等の組み込み用途)
  say [say-options] [text...]               say で発声 + どのセッションが喋ったか記録

Options:
  --help-full
`;

describe("ccmsg CLI end-to-end", () => {
  test("auto-spawns the daemon, does a round trip, and stops it", async () => {
    const { env, cleanup } = makeEnv();
    try {
      // status before anything: no daemon, and status must not spawn one
      const s0 = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(s0.running).toBe(false);

      // first real command auto-spawns the daemon (ensure-daemon). Identity = session S1,
      // which the round trip registers: peers lists it.
      const S1 = "50000001-0000-4000-8000-000000000000";
      const listed = served("peers", (await runCli(["--sid", S1, "peers"], env)).out);
      expect(listed.peers.some((p) => p.sid === S1)).toBe(true);

      // status now reports the live daemon at our version
      const s1 = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(s1.running).toBe(true);
      expect(s1.version).toBe(VERSION);

      // stop, then confirm it's gone
      const stopped = printed(CliStatusSchema, (await runCli(["daemon", "stop"], env)).out);
      expect(stopped.stopped).toBe(true);
      const s2 = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(s2.running).toBe(false);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: `daemon start` は無セッション状態からでも daemon をデタッチ
  // 起動でき (kawaz からの依頼「一つもセッションない状態からとりあえず daemon
  // だけ CLI から起動する方法」)、既に起動していれば再起動せず同じ pid の
  // status を返す (冪等)。
  test("daemon start は無から起動し、起動済みなら再起動せず status のみ返す", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const s0 = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(s0.running).toBe(false);

      const started = printed(CliStatusSchema, (await runCli(["daemon", "start"], env)).out);
      expect(started.ok).toBe(true);
      expect(started.running).toBe(true);
      expect(started.started).toBe(true);
      expect(started.version).toBe(VERSION);

      const again = printed(CliStatusSchema, (await runCli(["daemon", "start"], env)).out);
      expect(again.running).toBe(true);
      expect(again.started).toBe(false);
      expect(again.pid).toBe(started.pid); // same daemon, not respawned

      const s1 = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(s1.running).toBe(true);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: hooks module がセッションの開始 (と /clear・/resume で id が
  // 変わった時) に走らせる `sidecar begin` が、そのセッションの state file を書き、
  // daemon が無ければ起こす (DR-0039 §2)。2 回目は同じ daemon のまま (冪等、
  // hot reload でも走るため)。
  test("sidecar begin は state file を書き、daemon が無ければ起こす", async () => {
    const { env, cleanup } = makeEnv();
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-begin-")));
    const sid = "50000002-0000-4000-8000-000000000000";
    try {
      const begin = await runCli(["sidecar", "begin", "--sid", sid, "--cwd", cwd], env);
      expect(begin.code).toBe(0);
      const file = path.join(env.CCMSG_STATE_DIR, "sessions", `${sid}.json`);
      const stored = parseWith(SessionStateFileTextSchema, fs.readFileSync(file, "utf8"));
      if (!stored.ok) throw new Error(stored.failure.summary);
      // VCS の外なので repo/ws は無く、所在だけが書かれる。
      expect(stored.value.cwd).toBe(cwd);
      expect(stored.value.repo).toBeUndefined();
      const status = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(status.running).toBe(true);

      expect((await runCli(["sidecar", "begin", "--sid", sid, "--cwd", cwd], env)).code).toBe(0);
      const again = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(again.pid).toBe(status.pid);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  test("sidecar begin は session id と絶対パスの cwd が無ければ何もせず exit 2", async () => {
    const { env, cleanup } = makeEnv();
    const sid = "50000002-0000-4000-8000-000000000000";
    try {
      for (const args of [
        ["--sid", sid],
        ["--sid", sid, "--cwd", "relative/dir"],
        ["--sid", "not-a-sid", "--cwd", os.tmpdir()],
      ]) {
        const run = await runCli(["sidecar", "begin", ...args], env);
        expect(run.code).toBe(2);
        expect(run.err).toContain("usage: ccmsg sidecar begin");
      }
      expect(fs.existsSync(path.join(env.CCMSG_STATE_DIR, "sessions"))).toBe(false);
      expect(fs.existsSync(path.join(env.CCMSG_STATE_DIR, "daemon.sock"))).toBe(false);
    } finally {
      cleanup();
    }
  }, 30000);

  // 何を保証するか (default help のレール): 引数なしと通常の --help は
  // 指定されたコマンド + --help-full だけを byte-for-byte 表示する。隠した
  // コマンド・オプション・環境変数が混ざれば完全一致で検出する。
  test("default help shows only the minimal command rail", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const noArgs = await runCli([], env);
      const help = await runCli(["--help"], env);
      const commandHelp = await runCli(["dump", "--help"], env);
      expect(noArgs.out).toBe(MINIMAL_HELP);
      expect(help.out).toBe(MINIMAL_HELP);
      expect(commandHelp.out).toBe(MINIMAL_HELP);
      expect(noArgs.err).toBe("");
      expect(noArgs.code).toBe(0);
    } finally {
      cleanup();
    }
  }, 30000);

  // 何を保証するか (--help-full の退避先): default help から隠した全コマンド、
  // command/global options、環境変数は full help で引き続き発見できる。機能を
  // 消さず視界だけを絞る契約を固定する。
  test("--help-full retains the complete reference", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const help = await runCli(["--help-full"], env);
      expect(help.code).toBe(0);
      expect(help.err).toBe("");
      expect(help.out).toContain("Usage:");
      expect(help.out).toContain("dump <session-id>");
      expect(help.out).toContain("--until <timestamp|uuid>");
      expect(help.out).toContain("--format <format>");
      expect(help.out).toContain("--no-thinking");
      expect(help.out).toContain("--no-agent");
      expect(help.out).toContain("--agent <id|name>");
      expect(help.out).toContain("Rooms are read-only");
      // A session sends with the plugin's tools (DR-0039 §4): no command
      // sends to a session, and agents are not taught another way.
      expect(help.out).toContain("ccmsg plugin's tools (send / say / peers)");
      expect(help.out).not.toMatch(/^ {2}(post|reply) /m);
      expect(help.out).not.toContain("--addresses");
      expect(help.out).not.toContain("PushNotification");
      expect(help.out).not.toContain("SendMessage");
      expect(help.out).toContain("daemon run [--foreground]");
      expect(help.out).toContain("stop <session-id>");
      expect(help.out).toContain("Command Options:");
      expect(help.out).toContain("Global Options:");
      expect(help.out).toContain("Environment Variables:");
      expect(help.out).toContain("CCMSG_STATE_DIR");
      // u1 is implicitly delivered; advertising it as a --to value invites a
      // redundant rail departure, so even the full reference must not teach it.
      expect(help.out).not.toContain("u1,a2");
      expect(help.out).not.toContain("--to u1");
      expect(help.out).not.toContain("must include u1");
      expect(help.out).not.toContain("from + to + u1");
    } finally {
      cleanup();
    }
  }, 30000);

  test("dump emits compact jsonl by default and readable text on request", async () => {
    const { env, cleanup } = makeEnv();
    const sid = "11111111-2222-4333-8444-555555555555";
    try {
      const home = path.dirname(env.CCMSG_STATE_DIR);
      env.HOME = home;
      const projectDir = path.join(home, ".claude-test", "projects", "-repo");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, `${sid}.jsonl`),
        [
          userContentRow("hello", { timestamp: "2026-07-20T00:00:00Z" }),
          assistantContentRow([textBlock("line 1\nline 2")], {
            timestamp: "2026-07-20T00:00:01Z",
          }),
          assistantContentRow(
            [toolUseBlock("TaskCreate", { subject: "ship dump options" }, "todo-create-use")],
            { timestamp: "2026-07-20T00:00:02Z" },
          ),
          userContentRow([toolResultBlock("ok", { tool_use_id: "todo-create-use" })], {
            timestamp: "2026-07-20T00:00:03Z",
            toolUseResult: { task: { id: "1", subject: "ship dump options" } },
          }),
        ]
          .map(line)
          .join("\n") + "\n",
      );

      const jsonl = await runCli(["dump", sid], env);
      expect(jsonl.code).toBe(0);
      const jsonLines = jsonl.out.trim().split("\n").map(jsonObjectOf);
      expect(jsonLines[0]).toMatchObject({
        session: sid,
        since: "2026-07-20T00:00:00.000Z",
        until: null,
        format: "ccmsg-session-dump-v2",
      });
      // The second JSONL row is always the complete handoff context, even when
      // every other collection is empty; conversation entries retain their v1
      // shape. `todos` carries the one TaskCreate folded from the transcript.
      const { note, ...context } = defined(jsonLines[1], "the context row");
      expect(note).toContain("only when rewind or context clearing preserved");
      expect(context).toEqual({
        kind: "session-context",
        todos: [{ id: "1", subject: "ship dump options", status: "pending" }],
        agents: [],
        workflows: [],
        background: [],
        schedules: [],
        rooms: [],
      });
      expect(jsonLines.slice(2)).toMatchObject([
        { t: 0, kind: "user", from: "user", to: "self", text: "hello" },
        { t: 1000, kind: "assistant", from: "self", to: "user", text: "line 1\nline 2" },
      ]);
      expect(jsonLines.slice(2).every((entry) => "meta" in entry)).toBe(true);
      expect(jsonLines.slice(2).every((entry) => !("ts" in entry) && !("session" in entry))).toBe(
        true,
      );

      // --no-thinking / --no-agent are boolean: placed before the positional they
      // must not swallow the session id as their value (BOOL_FLAGS registration).
      const trimmed = await runCli(["dump", "--no-thinking", "--no-agent", sid], env);
      expect(trimmed.code).toBe(0);
      const trimmedContext = jsonObjectOf(trimmed.out.trim().split("\n")[1] ?? "");
      expect(trimmedContext).not.toHaveProperty("agents");
      expect(trimmedContext).not.toHaveProperty("workflows");
      expect(trimmedContext).toHaveProperty("todos");

      const text = await runCli(["dump", sid, "--format", "text"], env);
      expect(text.code).toBe(0);
      expect(text.out).toContain(`Session: ${sid}`);
      // The context is one pretty-printed JSON object under its heading,
      // closed by a "}" at the start of a line.
      const contextText = /\nSession context:\n(\{\n[\s\S]*?\n\})\n/.exec(text.out)?.[1];
      const textContext = jsonObjectOf(defined(contextText, "the text dump's session context"));
      expect(textContext).toHaveProperty("note");
      expect(textContext["background"]).toEqual([]);
      expect(textContext["schedules"]).toEqual([]);
      // todos render as one compact line each rather than inside the context
      // JSON (the JSON form spent several lines per task).
      expect(textContext).not.toHaveProperty("todos");
      expect(text.out).toContain("Todos (1):\n  [pending] #1 ship dump options");
      expect(text.out).toContain("[+0ms user user→self]\nhello");
      expect(text.out).toContain("[+1000ms assistant self→user]\nline 1\nline 2");
      expect(text.out).not.toContain("transcript_line");

      const invalid = await runCli(["dump", sid, "--format", "yaml"], env);
      expect(invalid.code).toBe(1);
      expect(invalid.err).toContain("--format must be 'jsonl' or 'text'");

      // An agent the dumped range never involves folds to one line. In text
      // that line is rendered flat rather than pretty-printed JSON — four lines
      // per agent would spend exactly what the fold saves.
      const subagentsDir = path.join(projectDir, sid, "subagents");
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(subagentsDir, "agent-apast-123456789012.meta.json"),
        JSON.stringify({ taskKind: "in_process_teammate", name: "past", description: "old job" }),
      );
      const folded = await runCli(["dump", sid, "--format", "text"], env);
      expect(folded.code).toBe(0);
      expect(folded.out).toContain(
        "Agents outside this range (1):\n  apast-123456789012 past — old job",
      );
      expect(folded.out).toContain(`Agent detail: ccmsg dump ${sid} --agent`);

      const missing = await runCli(["dump", sid, "--agent", "nobody"], env);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("no agent matches --agent nobody");
    } finally {
      cleanup();
    }
  }, 30000);

  // 何を保証するか (docs/issue/2026-07-12-prevent-u1-masquerade-on-missing-sid.md):
  // write 系 op は session identity が取れなければ error で exit 非零。
  // 旧挙動 (identity 無しで u1 名義に暗黙 fallback して post) を明示的に禁止
  // する回帰 test。stderr のエラーメッセージには sid の env 名も明示される。
  test("write 系 op は identity 無しで exit 非零 + stderr にエラーメッセージ", async () => {
    const { env, cleanup } = makeEnv();
    try {
      // env から sid を完全に排除する (test runner の CLAUDE_CODE_SESSION_ID
      // 継承事故を防ぐため空文字で上書き)。
      const bareEnv: Record<string, string> = {
        ...env,
        CCMSG_SID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "",
      };
      const S2 = "50000002-0000-4000-8000-000000000000";
      const cases: [string, string[]][] = [
        ["notify", ["notify", "--self", "--text", "hi"]],
        ["notify", ["notify", "--sid", S2, "--text", "hi"]],
      ];
      for (const [name, args] of cases) {
        const res = await runCli(args, bareEnv);
        expect(res.code).not.toBe(0);
        expect(res.err).toContain(`'${name}' requires a session identity`);
        expect(res.err).toContain("CCMSG_SID=");
        expect(res.err).toContain("CLAUDE_CODE_SESSION_ID=");
        expect(res.err).toContain("--as-session");
        // daemon には接続しない (=巻き添えで spawn しない) ことを追認: identity
        // ガードは request 送信の前段で走る。
        expect(res.out).toBe("");
      }
      // 追認: daemon は起動していない (identity ガードは runOnce の前で切る)
      const st = printed(CliStatusSchema, (await runCli(["status"], bareEnv)).out);
      expect(st.running).toBe(false);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: env の優先順位。CCMSG_SID > CLAUDE_CODE_SESSION_ID > null。
  // 旧 CLAUDE_SESSION_ID (実環境に存在しないデッド env) は削除済みで、値を
  // セットしても拾わない。
  test("CLAUDE_CODE_SESSION_ID から sid を自動採用する", async () => {
    const { env, cleanup } = makeEnv();
    try {
      // CLAUDE_CODE_SESSION_ID だけで notify が成功 (write op が identity ありと
      // 判定される)。
      const notified = await runCli(["notify", "--self", "--text", "hi"], {
        ...env,
        CLAUDE_CODE_SESSION_ID: "50000001-0000-4000-8000-000000000000",
        CCMSG_SID: "",
        CLAUDE_SESSION_ID: "",
      });
      expect(served("notify", notified.out).ok).toBe(true);
      // 呼び出し元 sid = S1 として hello した: peers に S1 が居る
      const listed = served(
        "peers",
        (await runCli(["peers"], { ...env, CCMSG_SID: "", CLAUDE_CODE_SESSION_ID: "" })).out,
      );
      expect(listed.peers.some((p) => p.sid === "50000001-0000-4000-8000-000000000000")).toBe(true);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: 旧 CLAUDE_SESSION_ID env は拾わない (削除済み)。値を
  // セットしても identity 無し扱いで write op は error になる。
  test("旧 CLAUDE_SESSION_ID env は sid として拾わない (write op は error)", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["notify", "--self", "--text", "hi"], {
        ...env,
        CCMSG_SID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "SHOULD_BE_IGNORED",
      });
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("requires a session identity");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: subscribe は identity 無しでも起動 (u1 fallback、DR-0003 §3)、
  // 起動直後の stderr に「subscribing as u1」警告が出る。stdout は pure jsonl のまま
  // (Monitor 経由の consumer を汚さない)。
  test("subscribe は sid 無しでも起動し stderr に u1 fallback 警告が出る", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const sub = Bun.spawn([process.execPath, CLI, "subscribe"], {
        env: {
          ...process.env,
          ...env,
          CCMSG_SID: "",
          CLAUDE_CODE_SESSION_ID: "",
          CLAUDE_SESSION_ID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // 警告は subscribe stream 開始前に main() が同期的に出すので、subprocess
      // 起動 → ensure-daemon 完了 (数百 ms 目安) を待って kill、それから stderr を
      // 全部読み切って assert する。stream 途中の race を避けるためこの手順が最も単純。
      await new Promise<void>((r) => setTimeout(r, 1500));
      sub.kill();
      await sub.exited;
      const errText = await new Response(sub.stderr).text();
      expect(errText).toContain("subscribing as the User (u1)");
      expect(errText).toContain("CCMSG_SID");
      expect(errText).toContain("CLAUDE_CODE_SESSION_ID");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // DR-0009: resolveIdentity picks up CCMSG_TRANSCRIPT_PATH from the process env
  // (the override knob) and sends it in hello; the daemon's own validation (transcript.test.ts) is what
  // decides whether it's actually adopted — here we just confirm a valid one
  // round-trips end to end into `peers`.
  test("CCMSG_TRANSCRIPT_PATH env はセッションの transcript_path として peers に現れる", async () => {
    const { env, cleanup } = makeEnv();
    const transcriptFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-tr-")),
      "50000001-0000-4000-8000-000000000000.jsonl",
    );
    fs.writeFileSync(transcriptFile, "");
    try {
      const peers = served(
        "peers",
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "50000001-0000-4000-8000-000000000000",
            CCMSG_TRANSCRIPT_PATH: transcriptFile,
          })
        ).out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.transcript_path).toBe(transcriptFile);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(path.dirname(transcriptFile), { recursive: true, force: true });
    }
  }, 30000);

  // peers は人の口。一覧の行は宛先の綴りを持たない (送信は plugin の send
  // tool で、宛先はその引数で書く、DR-0039 §3)。
  test("peers の行は宛先の綴りを持たない", async () => {
    const { env, cleanup } = makeEnv();
    const asSession = { ...env, CCMSG_SID: "50000003-0000-4000-8000-000000000000" };
    try {
      const plain = await runCli(["peers"], asSession);
      expect(plain.err).toBe("");
      // served() reads the whole line with the peers reply's schema, so a
      // field outside it fails here.
      const rows = served("peers", plain.out).peers;
      expect(rows.map((p) => p.sid)).toContain(asSession.CCMSG_SID);
      expect(plain.out).not.toContain("ccmsg:");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 空文字は「未指定」と同じ扱い (env が存在してしまうだけの CI/シェル環境事故を
  // transcript_path: "" として daemon に送りつけない、DR-0009)。
  test("CCMSG_TRANSCRIPT_PATH が空文字なら peers に transcript_path が出ない", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const peers = served(
        "peers",
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "50000001-0000-4000-8000-000000000000",
            CCMSG_TRANSCRIPT_PATH: "",
          })
        ).out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // session state file (`ccmsg sidecar begin` が書く <stateDir>/sessions/<sid>.json)
  // 経由の repo/ws が env 未設定時に peers へ反映される (2026-07-11 kawaz 裁定:
  // env 埋め込みから state file 経由に切替)。transcript は state file に無く、
  // daemon がセッションの名乗る config dir の projects/ から探す (DR-0039
  // Consequences。config dir は ~/.claude* に限らない)。
  test("session state file の repo/ws と、config dir 配下の transcript が peers に現れる", async () => {
    const { env, cleanup } = makeEnv();
    const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-cd-")));
    const projectDir = path.join(configDir, "projects", "-tmp-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptFile = path.join(projectDir, "50000001-0000-4000-8000-000000000000.jsonl");
    fs.writeFileSync(transcriptFile, "");
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({
        // 所在 (cwd/repo/ws/repo_root/branch) は 1 組で動くので、begin が書く形に
        // 合わせて cwd も入れる。cwd を名乗らない hello は repo/ws も述べない
        // (DR-0003 §3 「所在の正本」)。
        cwd: os.tmpdir(),
        repo: "claude-ccmsg",
        ws: "main",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = served(
        "peers",
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "50000001-0000-4000-8000-000000000000",
            CLAUDE_CONFIG_DIR: configDir,
          })
        ).out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.transcript_path).toBe(transcriptFile);
      expect(me.repo).toBe("claude-ccmsg");
      expect(me.ws).toBe("main");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }, 30000);

  // env が設定されていれば state file より優先される (override 用に env を存置)。
  test("CCMSG_REPO/CCMSG_WS env は session state file の値より優先される", async () => {
    const { env, cleanup } = makeEnv();
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({
        cwd: os.tmpdir(),
        repo: "from-file",
        ws: "from-file-ws",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = served(
        "peers",
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "50000001-0000-4000-8000-000000000000",
            CCMSG_REPO: "from-env",
            CCMSG_WS: "from-env-ws",
          })
        ).out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.repo).toBe("from-env");
      expect(me.ws).toBe("from-env-ws");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // session state file の branch が env 未設定なら peers に現れる (repo/ws と
  // 同じ latest-hello-wins の経路)。
  test("session state file の branch が env 未設定なら peers に現れる", async () => {
    const { env, cleanup } = makeEnv();
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({
        cwd: os.tmpdir(),
        branch: "feat/branch-label",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = served(
        "peers",
        (await runCli(["peers"], { ...env, CCMSG_SID: "50000001-0000-4000-8000-000000000000" }))
          .out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.branch).toBe("feat/branch-label");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // CCMSG_BRANCH env は session state file の branch より優先される
  // (CCMSG_REPO/CCMSG_WS/CCMSG_REPO_ROOT と同じ override パターン)。
  test("CCMSG_BRANCH env は session state file の branch より優先される", async () => {
    const { env, cleanup } = makeEnv();
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({
        cwd: os.tmpdir(),
        branch: "from-file",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = served(
        "peers",
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "50000001-0000-4000-8000-000000000000",
            CCMSG_BRANCH: "from-env",
          })
        ).out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.branch).toBe("from-env");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 空文字は「未指定」と同じ扱い (transcript_path の空文字ケースと同型)。
  test("CCMSG_BRANCH が空文字なら peers に branch が出ない", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const peers = served(
        "peers",
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "50000001-0000-4000-8000-000000000000",
            CCMSG_BRANCH: "",
          })
        ).out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.branch).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // session state file の repo_root (DR-0008 addendum, `ccmsg sidecar begin`
  // が worktree-name 非空のときだけ書く) が hello に載り、daemon の受理判定
  // (絶対 + realpath 可 + cwd の strict ancestor + not "/"/$HOME) を通れば
  // peers に現れる。ここでは daemon 側の受理条件を満たすよう、実在する
  // tmpdir ツリー ("<root>/<sub>" を cwd に、"<root>" を repo_root に) を使う。
  test("session state file の repo_root が daemon の受理判定を通れば peers に現れる", async () => {
    const { env, cleanup } = makeEnv();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-rr-"));
    const cwd = path.join(repoRoot, "main");
    fs.mkdirSync(cwd);
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({ cwd, repo_root: repoRoot, updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const proc = Bun.spawn([process.execPath, CLI, "peers"], {
        cwd,
        env: { ...process.env, ...env, CCMSG_SID: "50000001-0000-4000-8000-000000000000" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const peers = served("peers", out);
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.repo_root).toBe(fs.realpathSync(repoRoot));
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 30000);

  // CCMSG_REPO_ROOT env が設定されていれば session state file の repo_root より
  // 優先される (CCMSG_REPO/CCMSG_WS と同じ override パターン)。
  test("CCMSG_REPO_ROOT env は session state file の repo_root より優先される", async () => {
    const { env, cleanup } = makeEnv();
    const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-rrenv-"));
    const cwd = path.join(envRoot, "main");
    fs.mkdirSync(cwd);
    const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-rrfile-"));
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({ cwd, repo_root: fileRoot, updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const proc = Bun.spawn([process.execPath, CLI, "peers"], {
        cwd,
        env: {
          ...process.env,
          ...env,
          CCMSG_SID: "50000001-0000-4000-8000-000000000000",
          CCMSG_REPO_ROOT: envRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const peers = served("peers", out);
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.repo_root).toBe(fs.realpathSync(envRoot));
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(envRoot, { recursive: true, force: true });
      fs.rmSync(fileRoot, { recursive: true, force: true });
    }
  }, 30000);

  // repo_root が daemon の受理条件 (cwd の strict ancestor) を満たさなければ
  // (= cwd と無関係な tmpdir) 黙って不採用、peers には現れない (fail-open)。
  test("repo_root が cwd の ancestor でなければ peers に現れない", async () => {
    const { env, cleanup } = makeEnv();
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-rrbad-"));
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({ repo_root: unrelated, updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const peers = served(
        "peers",
        (await runCli(["peers"], { ...env, CCMSG_SID: "50000001-0000-4000-8000-000000000000" }))
          .out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.repo_root).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(unrelated, { recursive: true, force: true });
    }
  }, 30000);

  // 壊れた JSON の session state file は黙って無視される (未申告になるだけで
  // クラッシュしない — state file は optional enrichment、必須依存ではない)。
  test("session state file が壊れた JSON でもクラッシュせず未申告になる", async () => {
    const { env, cleanup } = makeEnv();
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      "{not valid json",
    );
    // VCS 配下でない cwd で走らせる: repo/ws が空であることが「CLI が未申告」の
    // 証拠であり続けるため (daemon は cwd を名乗る hello に対してだけ repo/ws を
    // 導出するので、導出値が紛れ込む余地を残さない)。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-novcs-"));
    try {
      const res = await runCli(
        ["peers"],
        { ...env, CCMSG_SID: "50000001-0000-4000-8000-000000000000" },
        outside,
      );
      expect(res.code).toBe(0);
      const peers = served("peers", res.out);
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.repo).toBe("");
      expect(me.ws).toBe("");
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30000);

  // session state file が指す transcript_path のファイルが実在しなければ
  // (rotate/削除済み等) 未申告になる — daemon 側はパス *形状* のみ検証し実在は
  // 見ないため、実在確認は CLI 側の責務 (指示どおり)。
  test("session state file の transcript_path が実在しなければ未申告になる", async () => {
    const { env, cleanup } = makeEnv();
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "50000001-0000-4000-8000-000000000000.json"),
      JSON.stringify({
        transcript_path: "/nonexistent/path/50000001-0000-4000-8000-000000000000.jsonl",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = served(
        "peers",
        (await runCli(["peers"], { ...env, CCMSG_SID: "50000001-0000-4000-8000-000000000000" }))
          .out,
      );
      const me = defined(
        peers.peers.find((p) => p.sid === "50000001-0000-4000-8000-000000000000"),
        "me",
      );
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);
});

describe("ccmsg CLI --version / version (DR-0007 §3)", () => {
  // 何を保証するか: 人間が PATH の ccmsg の版を確認する手段。daemon には触らない
  // (DR-0007 §3 の通り、自己更新の判定にはこの経路を使わない — ここは CLI 衛生のみ)。
  test("--version は daemon を起動せず VERSION 文字列だけを stdout に出す", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["--version"], env);
      expect(res.code).toBe(0);
      expect(res.out).toBe(`${VERSION}\n`);
      expect(res.err).toBe("");

      // daemon が起動していないことも確認 (= --version が ensure-daemon を通っていない)
      const status = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(status.running).toBe(false);
    } finally {
      cleanup();
    }
  });

  // `version` サブコマンドも同じ出力になる (フラグ形と併記される DR-0007 §3 の両方)。
  test("version サブコマンドも同じ出力", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["version"], env);
      expect(res.code).toBe(0);
      expect(res.out).toBe(`${VERSION}\n`);
    } finally {
      cleanup();
    }
  });

  // --version は他の位置引数より優先される (help と同格の早期リターン)。
  test("--version は他の positional より優先される", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["peers", "--version"], env);
      expect(res.code).toBe(0);
      expect(res.out).toBe(`${VERSION}\n`);
    } finally {
      cleanup();
    }
  });

  // 何を保証するか (DR-0039 §4): CLI にエージェントがセッションへメッセージを
  // 入れる口は無い。post / reply は他の知らないコマンドと同じく unknown
  // command として exit 非零になり、daemon に触れない。
  test("post / reply は unknown command になり、daemon を起こさない", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const S1 = "50000001-0000-4000-8000-000000000000";
      const S2 = "50000002-0000-4000-8000-000000000000";
      for (const args of [
        ["post", S2, "hi"],
        ["reply", "0123456789abcdef0123456789abcdef/1", "--to", S2, "hi"],
        ["post", "r1", "hi"],
        ["reply", "r1m2", "hi"],
      ]) {
        const res = await runCli(["--sid", S1, ...args], env);
        expect({ args, code: res.code }).toEqual({ args, code: 1 });
        expect(res.err).toBe(`ccmsg: unknown command '${args[0]}'\n\n`);
        expect(res.out).toBe(MINIMAL_HELP);
      }
      const st = printed(CliStatusSchema, (await runCli(["status"], env)).out);
      expect(st.running).toBe(false);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (DR-0036 §2): room を作る・読む・抜けるサブコマンドは無い。
  // 他の知らないコマンドと同じく unknown command として exit 非零になる。
  test("room のサブコマンドは unknown command になる", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const S1 = "50000001-0000-4000-8000-000000000000";
      for (const cmd of ["create-room", "next-room", "leave", "read", "rooms"]) {
        const res = await runCli(["--sid", S1, cmd, "r1"], env);
        expect({ cmd, code: res.code }).toEqual({ cmd, code: 1 });
        expect(res.err).toBe(`ccmsg: unknown command '${cmd}'\n\n`);
        expect(res.out).toBe(MINIMAL_HELP);
      }
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: help `peers [cwd(partial)]`
  // に合わせ、positional 引数を cwd 部分一致 filter として実装する。無指定時は
  // 全 peer が返ることを別 case で確認 (現状の非回帰)。フィルタの絞りは CLI 側
  // 完結 (webui の op:"peers" を汚さない)。
  test("peers の positional 引数が cwd 部分一致で絞る", async () => {
    const { env, cleanup } = makeEnv();
    // peers を叩く side は user role で走らせる。親環境の CLAUDE_CODE_SESSION_ID
    // が漏れて session hello されると自分自身が peer 一覧に紛れて test の
    // 3 peer 期待が壊れる — write op ではないので identity なしで OK。
    const readEnv: Record<string, string> = {
      ...env,
      CCMSG_SID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
    };
    try {
      // 3 session を立ててそれぞれ異なる cwd で subscribe を張っておく (peers は
      // 接続中 session を返すので、常駐 subscribe を noise なく差し込む)。
      // CLI が hello で名乗る所在は固定値 3 つからしか来ない (DR-0003 §3
      // 「所在の正本」) ので、各 peer の cwd は CCMSG_CWD で明示する。Bun.spawn
      // の cwd は実 dir が要る (作成しないと spawn が失敗する)。base dir 配下に mkdir。
      const peerBase = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-peers-"));
      const alphaOne = path.join(peerBase, "alpha", "one");
      const alphaTwo = path.join(peerBase, "alpha", "two");
      const betaThree = path.join(peerBase, "beta", "three");
      fs.mkdirSync(alphaOne, { recursive: true });
      fs.mkdirSync(alphaTwo, { recursive: true });
      fs.mkdirSync(betaThree, { recursive: true });
      const spawnPeer = (sid: string, cwd: string) =>
        Bun.spawn([process.execPath, CLI, "--sid", sid, "subscribe"], {
          cwd,
          env: { ...process.env, ...env, CCMSG_CWD: cwd },
          stdout: "pipe",
          stderr: "pipe",
        });
      const p1 = spawnPeer("9a000000-0000-4000-8000-000000000000", alphaOne);
      const p2 = spawnPeer("9b000000-0000-4000-8000-000000000000", alphaTwo);
      const p3 = spawnPeer("9c000000-0000-4000-8000-000000000000", betaThree);
      try {
        // subscribe が daemon に hello するまでの猶予: peers を polling で待つ。
        const waitPeers = async (): Promise<ResponseOf<"peers">> => {
          for (let i = 0; i < 40; i++) {
            const res = served("peers", (await runCli(["peers"], readEnv)).out);
            if (res.peers.length >= 3) return res;
            await new Promise((r) => setTimeout(r, 100));
          }
          throw new Error("timed out waiting for 3 peers");
        };
        const all = await waitPeers();
        expect(all.peers.map((p) => p.sid).sort()).toEqual([
          "9a000000-0000-4000-8000-000000000000",
          "9b000000-0000-4000-8000-000000000000",
          "9c000000-0000-4000-8000-000000000000",
        ]);

        // "/alpha/" 部分一致 → PA + PB のみ (peerBase 名衝突を避けるため /alpha/)
        const alpha = served("peers", (await runCli(["peers", "/alpha/"], readEnv)).out);
        expect(alpha.peers.map((p) => p.sid).sort()).toEqual([
          "9a000000-0000-4000-8000-000000000000",
          "9b000000-0000-4000-8000-000000000000",
        ]);

        // "/beta/" 部分一致 → PC のみ
        const beta = served("peers", (await runCli(["peers", "/beta/"], readEnv)).out);
        expect(beta.peers.map((p) => p.sid)).toEqual(["9c000000-0000-4000-8000-000000000000"]);

        // マッチしない substring → 0 件
        const none = served("peers", (await runCli(["peers", "no-such-cwd"], readEnv)).out);
        expect(none.peers).toEqual([]);
      } finally {
        p1.kill();
        p2.kill();
        p3.kill();
        fs.rmSync(peerBase, { recursive: true, force: true });
      }
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);
});

describe("ccmsg CLI stop <session-id> (DR-0028 session_kill wiring)", () => {
  test("usage error when no <session-id> is given", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["stop"], env);
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("session-id");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  test("unknown session-id resolves to not_found (same as webui's Status tab kill)", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["stop", "no-such-session-id"], env);
      const parsed = refusedReply("the command", res.err);
      expect(res.code).not.toBe(0);
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe("not_found");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  test("--force forwards through to the same not_found outcome (pid-reuse guard unaffected)", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["stop", "no-such-session-id", "--force"], env);
      const parsed = refusedReply("the command", res.err);
      expect(res.code).not.toBe(0);
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe("not_found");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  test("a session-role identity cannot self-kill via CLAUDE_CODE_SESSION_ID (user role gate)", async () => {
    // stop must hello as role "user" unconditionally — if it picked up
    // CLAUDE_CODE_SESSION_ID via resolveSessionIdentity it would hello as
    // role "session" and session_kill would reject with bad_request instead
    // of resolving the target sid at all. Asserting not_found (not
    // bad_request) here is the regression guard for that.
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["stop", "no-such-session-id"], {
        ...env,
        CLAUDE_CODE_SESSION_ID: "ca000000-0000-4000-8000-000000000000",
      });
      const parsed = refusedReply("the command", res.err);
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe("not_found");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);
});

// セッションの所在 (DR-0003 §3 「所在の正本」): hello の cwd は CCMSG_CWD →
// hook が書いた session state file → CLAUDE_PROJECT_DIR の順に固定値から取る。
// CLI が走っている場所 (= 直前の Bash ツールが cd した先) は出所にならない。
describe("hello が名乗る所在", () => {
  test("固定値だけから来て、CLI が走っている場所では動かない", async () => {
    const { env, cleanup } = makeEnv();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-loc-"));
    // 実在ディレクトリが要る (spawn の cwd に渡すため)。daemon は hello 時に
    // cwd を realpath するので、期待値も realpath で突き合わせる。
    const mk = (name: string): string => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      return fs.realpathSync(dir);
    };
    const drifted = mk("drifted");
    const stationed = mk("stationed");
    const project = mk("project");
    const override = mk("override");
    // state file は `ccmsg sidecar begin` が書くもの。ここでは begin を回す代わりに
    // 同じ形を直接置く (protocol の SessionStateFile)。
    fs.mkdirSync(path.join(env.CCMSG_STATE_DIR, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(env.CCMSG_STATE_DIR, "sessions", "10cf0000-0000-4000-8000-000000000000.json"),
      JSON.stringify({ cwd: stationed, updated_at: new Date().toISOString() }),
    );
    // 問い合わせ側は identity なし (自分が peer 一覧に紛れないように)。
    const readEnv: Record<string, string> = {
      ...env,
      CCMSG_SID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PROJECT_DIR: "",
    };
    // peer は全員 drifted で走らせる = CLI の process.cwd() は常に drifted。
    const spawnPeer = (sid: string, peerEnv: Record<string, string>) =>
      Bun.spawn([process.execPath, CLI, "--sid", sid, "subscribe"], {
        cwd: drifted,
        env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: "", ...peerEnv },
        stdout: "pipe",
        stderr: "pipe",
      });
    const procs = [
      spawnPeer("10cf0000-0000-4000-8000-000000000000", {}),
      spawnPeer("10ce0000-0000-4000-8000-000000000000", { CLAUDE_PROJECT_DIR: project }),
      spawnPeer("10c00000-0000-4000-8000-000000000000", {
        CLAUDE_PROJECT_DIR: project,
        CCMSG_CWD: override,
      }),
      spawnPeer("10cd0000-0000-4000-8000-000000000000", {}),
    ];
    try {
      const waitPeers = async (): Promise<ResponseOf<"peers">["peers"]> => {
        for (let i = 0; i < 40; i++) {
          const res = served("peers", (await runCli(["peers"], readEnv)).out);
          if (res.peers.length >= 4) return res.peers;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("timed out waiting for 4 peers");
      };
      const peers = await waitPeers();
      const cwdOf = (sid: string): string | undefined => peers.find((p) => p.sid === sid)?.cwd;
      expect(cwdOf("10cf0000-0000-4000-8000-000000000000")).toBe(stationed);
      expect(cwdOf("10ce0000-0000-4000-8000-000000000000")).toBe(project);
      // CCMSG_CWD は CLAUDE_PROJECT_DIR より強い明示指定。
      expect(cwdOf("10c00000-0000-4000-8000-000000000000")).toBe(override);
      // 出所が 1 つも無ければ何も名乗らない (drifted を名乗ってしまわない)。
      expect(cwdOf("10cd0000-0000-4000-8000-000000000000") ?? "").toBe("");
    } finally {
      for (const p of procs) p.kill();
      await runCli(["daemon", "stop"], readEnv).catch(() => {});
      fs.rmSync(base, { recursive: true, force: true });
      cleanup();
    }
  }, 30000);
});

describe("a daemon that does not start (DR-0038 §6)", () => {
  // The CLI spawns the daemon with its stderr going nowhere, so a daemon that
  // stops at startup over its configuration would otherwise leave only "did
  // not become reachable" after the retries ran out. The reasons it logged
  // reach the CLI's stderr instead, at once.
  test("a configuration that does not read is reported with its reasons", async () => {
    const { env, cleanup } = makeEnv();
    fs.mkdirSync(env.CCMSG_CONFIG_DIR, { recursive: true });
    const config = path.join(env.CCMSG_CONFIG_DIR, "config.json");
    fs.writeFileSync(config, JSON.stringify({ llm_usage_url: "ftp://gw.example" }));
    try {
      const { code, err } = await runCli(["peers"], env);
      expect(code).toBe(1);
      expect(err).toContain("daemon exited with code 1 while starting");
      expect(err).toContain(`config: ${config}: llm_usage_url: must be http:// or https://`);
    } finally {
      cleanup();
    }
  }, 30000);
});
