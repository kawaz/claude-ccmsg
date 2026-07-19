// End-to-end CLI: run the real `ccmsg` binary as a subprocess so ensure-daemon's
// spawn/connect path is exercised for real (DR-0002 §2).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "@ccmsg/protocol";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

interface CliResult {
  out: string;
  err: string;
  code: number;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

function makeEnv(): { env: Record<string, string>; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  return {
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_DATA_DIR: dataDir,
      // Pin every spawned CLI to this working copy even if PATH has a newer install.
      CCMSG_NO_SELF_EXEC: "1",
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const MINIMAL_HELP = `Commands:
  reply <rNmN> <msg>                        返信用
  post <room> [--to <aN[,aN...]>] <msg>     新規メッセージ用
  read <rNmN[,mN...]>                       メッセージ全文取得 (msg_via 指示時など)
  dump <session-id> [--since <ts>]          セッション会話を圧縮 JSONL/text で回収
  peers [cwd(partial)]                      セッション一覧取得
  create-room --members <sid[,sid...]> <title>  ルーム作成
  subscribe                                 Monitor常駐用
  notify --self --text <msg>                自セッション通知 (justfile等の組み込み用途)

Options:
  --help-full
`;

describe("ccmsg CLI end-to-end", () => {
  test("auto-spawns the daemon, does a round trip, and stops it", async () => {
    const { env, cleanup } = makeEnv();
    try {
      // status before anything: no daemon, and status must not spawn one
      const s0 = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
      expect(s0.running).toBe(false);

      // first real command auto-spawns the daemon (ensure-daemon). Identity = session S1.
      const created = JSON.parse((await runCli(["--sid", "S1", "create-room"], env)).out) as {
        ok: boolean;
        room: string;
      };
      expect(created.ok).toBe(true);
      const room = created.room;

      // session identity was applied: the room's sole member is S1 (id "a1")
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { id: string; members: { id: string; sid: string }[] }[];
      };
      expect(rooms.rooms.length).toBe(1);
      expect(rooms.rooms[0]!.members[0]).toMatchObject({ id: "a1", sid: "S1" });

      // post + read round trip
      const posted = JSON.parse(
        (await runCli(["--sid", "S1", "post", room, "hello"], env)).out,
      ) as { mid: number };
      expect(posted.mid).toBe(1);
      const read = JSON.parse((await runCli(["read", `${room}m1`], env)).out) as {
        msgs: { msg: string }[];
      };
      expect(read.msgs[0]!.msg).toBe("hello");
      const readLegacy = JSON.parse((await runCli(["read", room, "1"], env)).out) as {
        msgs: { msg: string }[];
      };
      expect(readLegacy.msgs[0]!.msg).toBe("hello");
      const posted2 = JSON.parse(
        (await runCli(["--sid", "S1", "post", room, "world"], env)).out,
      ) as { mid: number };
      const readMany = JSON.parse(
        (await runCli(["read", `${room}m${posted.mid},m${posted2.mid}`], env)).out,
      ) as { msgs: { msg: string }[] };
      expect(readMany.msgs.map((m) => m.msg)).toEqual(["hello", "world"]);

      // status now reports the live daemon at our version
      const s1 = JSON.parse((await runCli(["status"], env)).out) as {
        running: boolean;
        version: string;
      };
      expect(s1.running).toBe(true);
      expect(s1.version).toBe(VERSION);

      // stop, then confirm it's gone
      const stopped = JSON.parse((await runCli(["daemon", "stop"], env)).out) as {
        stopped?: boolean;
      };
      expect(stopped.stopped).toBe(true);
      const s2 = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
      expect(s2.running).toBe(false);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (default help のレール): 引数なしと通常の --help は
  // 指定された 6 コマンド + --help-full だけを byte-for-byte 表示する。隠した
  // コマンド・オプション・環境変数が混ざれば完全一致で検出する。
  test("default help shows only the minimal command rail", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const noArgs = await runCli([], env);
      const help = await runCli(["--help"], env);
      const commandHelp = await runCli(["post", "--help"], env);
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
      expect(help.out).toContain("read <rNmN[,mN...]");
      expect(help.out).toContain("read <room> <mids>");
      expect(help.out).toContain("dump <session-id>");
      expect(help.out).toContain("--until <timestamp>");
      expect(help.out).toContain("--format <format>");
      expect(help.out).toContain("next-room <room>");
      expect(help.out).toContain("daemon run [--foreground]");
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
      const home = path.dirname(env.CCMSG_STATE_DIR!);
      env.HOME = home;
      const projectDir = path.join(home, ".claude-test", "projects", "-repo");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, `${sid}.jsonl`),
        [
          JSON.stringify({
            timestamp: "2026-07-20T00:00:00Z",
            type: "user",
            message: { role: "user", content: "hello" },
          }),
          JSON.stringify({
            timestamp: "2026-07-20T00:00:01Z",
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "line 1\nline 2" }] },
          }),
        ].join("\n") + "\n",
      );

      const jsonl = await runCli(["dump", sid], env);
      expect(jsonl.code).toBe(0);
      const jsonLines = jsonl.out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(jsonLines[0]).toMatchObject({
        session: sid,
        since: "2026-07-20T00:00:00.000Z",
        until: null,
        format: "ccmsg-session-dump-v1",
      });
      expect(jsonLines.slice(1)).toMatchObject([
        { t: 0, kind: "user", from: "user", to: "self", text: "hello" },
        { t: 1000, kind: "assistant", from: "self", to: "user", text: "line 1\nline 2" },
      ]);
      expect(jsonLines.slice(1).every((entry) => "meta" in entry)).toBe(true);
      expect(jsonLines.slice(1).every((entry) => !("ts" in entry) && !("session" in entry))).toBe(
        true,
      );

      const text = await runCli(["dump", sid, "--format", "text"], env);
      expect(text.code).toBe(0);
      expect(text.out).toContain(`Session: ${sid}`);
      expect(text.out).toContain("[+0ms user user→self]\nhello");
      expect(text.out).toContain("[+1000ms assistant self→user]\nline 1\nline 2");
      expect(text.out).not.toContain("transcript_line");

      const invalid = await runCli(["dump", sid, "--format", "yaml"], env);
      expect(invalid.code).toBe(1);
      expect(invalid.err).toContain("--format must be 'jsonl' or 'text'");
    } finally {
      cleanup();
    }
  }, 30000);

  // 何を保証するか (DR-0003 §3 revision): create-room は呼び出し元 session を
  // members の先頭に自動 include する。指示から「呼び出し元 sid を毎回書かせる」
  // 冗長さを消し、S1 が S2 と 1:1 room を張る時に `--members S2` だけで済む。
  test("create-room は呼び出し元 session を members 先頭に自動 include する", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const created = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--members", "S2"], env)).out,
      ) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { members: { id: string; sid: string }[] }[];
      };
      // 順序は S1 (呼び出し元、a1) → S2 (a2)
      expect(rooms.rooms[0]!.members.map((m) => m.sid)).toEqual(["S1", "S2"]);
      expect(rooms.rooms[0]!.members.map((m) => m.id)).toEqual(["a1", "a2"]);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: --exclude-self を渡すと呼び出し元は自動 include されない
  // (観測用途 room のセットアップ経路)。protocol の include_self:false 経路を
  // 経由することを確認する。
  test("create-room --exclude-self は呼び出し元を自動 include しない", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const created = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--members", "S2", "--exclude-self"], env))
          .out,
      ) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { members: { id: string; sid: string }[] }[];
      };
      expect(rooms.rooms[0]!.members.map((m) => m.sid)).toEqual(["S2"]);
      expect(rooms.rooms[0]!.members[0]!.id).toBe("a1");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: u1 は暗黙参加 (DR-0006 §2) なので、--members に "u1" を
  // 書くのは仕様上の誤り。CLI が daemon に投げる前に reject して「u1 という
  // 名の sid で room が作られる」誤動作を防ぐ。
  test("create-room --members に u1 が含まれると reject される", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["--sid", "S1", "create-room", "--members", "S2,u1"], env);
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("u1 is always implicitly a member");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (docs/issue/2026-07-12-prevent-u1-masquerade-on-missing-sid.md):
  // write 系 5 op は session identity が取れなければ error で exit 非零。
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
      const cases: [string, string[]][] = [
        ["post", ["post", "r1", "hi"]],
        ["create-room", ["create-room", "--members", "S2"]],
        ["next-room", ["next-room", "r1"]],
        ["leave", ["leave", "r1"]],
        ["notify", ["notify", "--self", "--text", "hi"]],
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
      const st = JSON.parse((await runCli(["status"], bareEnv)).out) as { running: boolean };
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
      // CLAUDE_CODE_SESSION_ID だけで post が成功 (write op が identity ありと
      // 判定される)。
      const createdRes = await runCli(["create-room", "--members", "PEER"], {
        ...env,
        CLAUDE_CODE_SESSION_ID: "S1",
        CCMSG_SID: "",
        CLAUDE_SESSION_ID: "",
      });
      const created = JSON.parse(createdRes.out) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      // 呼び出し元 sid = S1 が member に入っている
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { members: { sid: string }[] }[];
      };
      expect(rooms.rooms[0]!.members.map((m) => m.sid)).toEqual(["S1", "PEER"]);
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
      const res = await runCli(["create-room", "--members", "PEER"], {
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

  test("leave: a member session leaves a room and disappears from its member list", async () => {
    const { env, cleanup } = makeEnv();
    try {
      // S1 creates a room with S2 as a peer member
      const created = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--members", "S2"], env)).out,
      ) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      const room = created.room;

      // register S2 as a resolvable session so its member row exists (create-room adds it eagerly)
      const before = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { members: { sid: string }[] }[];
      };
      expect(before.rooms[0]!.members.map((m) => m.sid)).toEqual(["S1", "S2"]);

      // S2 leaves: the room's present-member list must drop S2 but keep S1
      const left = JSON.parse((await runCli(["--sid", "S2", "leave", room], env)).out) as {
        ok: boolean;
        room: string;
      };
      expect(left.ok).toBe(true);
      expect(left.room).toBe(room);

      const after = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { members: { sid: string }[] }[];
      };
      expect(after.rooms[0]!.members.map((m) => m.sid)).toEqual(["S1"]);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // DR-0009: resolveIdentity picks up CCMSG_TRANSCRIPT_PATH from the process env
  // (the SessionStart hook's suggested prefix, see hooks/session-start.ts) and
  // sends it in hello; the daemon's own validation (transcript.test.ts) is what
  // decides whether it's actually adopted — here we just confirm a valid one
  // round-trips end to end into `peers`.
  test("CCMSG_TRANSCRIPT_PATH env はセッションの transcript_path として peers に現れる", async () => {
    const { env, cleanup } = makeEnv();
    const transcriptFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-tr-")),
      "S1.jsonl",
    );
    fs.writeFileSync(transcriptFile, "");
    try {
      const peers = JSON.parse(
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "S1",
            CCMSG_TRANSCRIPT_PATH: transcriptFile,
          })
        ).out,
      ) as { peers: { sid: string; transcript_path?: string }[] };
      const me = peers.peers.find((p) => p.sid === "S1")!;
      expect(me.transcript_path).toBe(transcriptFile);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(path.dirname(transcriptFile), { recursive: true, force: true });
    }
  }, 30000);

  // 空文字は「未指定」と同じ扱い (env が存在してしまうだけの CI/シェル環境事故を
  // transcript_path: "" として daemon に送りつけない、DR-0009)。
  test("CCMSG_TRANSCRIPT_PATH が空文字なら peers に transcript_path が出ない", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const peers = JSON.parse(
        (await runCli(["peers"], { ...env, CCMSG_SID: "S1", CCMSG_TRANSCRIPT_PATH: "" })).out,
      ) as { peers: { sid: string; transcript_path?: string }[] };
      const me = peers.peers.find((p) => p.sid === "S1")!;
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // session state file (hooks/session-start.ts が書く <stateDir>/sessions/<sid>.json)
  // 経由の transcript_path/repo/ws が env 未設定時に peers へ反映される
  // (2026-07-11 kawaz 裁定: env 埋め込みから state file 経由に切替)。
  test("session state file の transcript_path/repo/ws が env 未設定なら peers に現れる", async () => {
    const { env, cleanup } = makeEnv();
    const transcriptFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cli-sf-")),
      "S1.jsonl",
    );
    fs.writeFileSync(transcriptFile, "");
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({
        transcript_path: transcriptFile,
        repo: "claude-ccmsg",
        ws: "main",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = JSON.parse((await runCli(["peers"], { ...env, CCMSG_SID: "S1" })).out) as {
        peers: { sid: string; transcript_path?: string; repo?: string; ws?: string }[];
      };
      const me = peers.peers.find((p) => p.sid === "S1")!;
      expect(me.transcript_path).toBe(transcriptFile);
      expect(me.repo).toBe("claude-ccmsg");
      expect(me.ws).toBe("main");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
      fs.rmSync(path.dirname(transcriptFile), { recursive: true, force: true });
    }
  }, 30000);

  // env が設定されていれば state file より優先される (override 用に env を存置)。
  test("CCMSG_REPO/CCMSG_WS env は session state file の値より優先される", async () => {
    const { env, cleanup } = makeEnv();
    const sessionsDir = path.join(env.CCMSG_STATE_DIR, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({
        repo: "from-file",
        ws: "from-file-ws",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = JSON.parse(
        (
          await runCli(["peers"], {
            ...env,
            CCMSG_SID: "S1",
            CCMSG_REPO: "from-env",
            CCMSG_WS: "from-env-ws",
          })
        ).out,
      ) as { peers: { sid: string; repo?: string; ws?: string }[] };
      const me = peers.peers.find((p) => p.sid === "S1")!;
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
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({ branch: "feat/branch-label", updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const peers = JSON.parse((await runCli(["peers"], { ...env, CCMSG_SID: "S1" })).out) as {
        peers: { sid: string; branch?: string }[];
      };
      const me = peers.peers.find((p) => p.sid === "S1")!;
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
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({ branch: "from-file", updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const peers = JSON.parse(
        (await runCli(["peers"], { ...env, CCMSG_SID: "S1", CCMSG_BRANCH: "from-env" })).out,
      ) as { peers: { sid: string; branch?: string }[] };
      const me = peers.peers.find((p) => p.sid === "S1")!;
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
      const peers = JSON.parse(
        (await runCli(["peers"], { ...env, CCMSG_SID: "S1", CCMSG_BRANCH: "" })).out,
      ) as { peers: { sid: string; branch?: string }[] };
      const me = peers.peers.find((p) => p.sid === "S1")!;
      expect(me.branch).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // session state file の repo_root (DR-0008 addendum, hooks/session-start.ts
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
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({ repo_root: repoRoot, updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const proc = Bun.spawn([process.execPath, CLI, "peers"], {
        cwd,
        env: { ...process.env, ...env, CCMSG_SID: "S1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const peers = JSON.parse(out) as { peers: { sid: string; repo_root?: string }[] };
      const me = peers.peers.find((p) => p.sid === "S1")!;
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
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({ repo_root: fileRoot, updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const proc = Bun.spawn([process.execPath, CLI, "peers"], {
        cwd,
        env: { ...process.env, ...env, CCMSG_SID: "S1", CCMSG_REPO_ROOT: envRoot },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const peers = JSON.parse(out) as { peers: { sid: string; repo_root?: string }[] };
      const me = peers.peers.find((p) => p.sid === "S1")!;
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
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({ repo_root: unrelated, updated_at: "2026-07-11T00:00:00.000Z" }),
    );
    try {
      const peers = JSON.parse((await runCli(["peers"], { ...env, CCMSG_SID: "S1" })).out) as {
        peers: { sid: string; repo_root?: string }[];
      };
      const me = peers.peers.find((p) => p.sid === "S1")!;
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
    fs.writeFileSync(path.join(sessionsDir, "S1.json"), "{not valid json");
    try {
      const res = await runCli(["peers"], { ...env, CCMSG_SID: "S1" });
      expect(res.code).toBe(0);
      const peers = JSON.parse(res.out) as {
        peers: { sid: string; repo?: string; ws?: string; transcript_path?: string }[];
      };
      const me = peers.peers.find((p) => p.sid === "S1")!;
      expect(me.repo).toBe("");
      expect(me.ws).toBe("");
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
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
      path.join(sessionsDir, "S1.json"),
      JSON.stringify({
        transcript_path: "/nonexistent/path/S1.jsonl",
        updated_at: "2026-07-11T00:00:00.000Z",
      }),
    );
    try {
      const peers = JSON.parse((await runCli(["peers"], { ...env, CCMSG_SID: "S1" })).out) as {
        peers: { sid: string; transcript_path?: string }[];
      };
      const me = peers.peers.find((p) => p.sid === "S1")!;
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);
});

describe("ccmsg CLI create-room --kind broadcast (DR-0013)", () => {
  // 何を保証するか (§4.3 + §2.1): `--kind broadcast` を渡すと broadcast room が
  // 開設され、rooms 出力に kind:"broadcast" が返る (通常 room は kind 省略)。
  // 呼び出し元 sid の member 保持は long-running session 前提なので (CLI 単発は
  // exit 時に auto-leave が走る = §2.2)、ここでは検証せず daemon 側 test に譲る。
  test("--kind broadcast は broadcast room を開設し rooms に kind が現れる", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const created = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--kind", "broadcast"], env)).out,
      ) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { id: string; kind?: string }[];
      };
      const room = rooms.rooms.find((r) => r.id === created.room)!;
      expect(room.kind).toBe("broadcast");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (§2.9 「明示 `--members` は 無視 + stderr warning で受理」):
  // --members を broadcast と一緒に渡すと reject にはならず、無視 + JSON の
  // warning フィールド + stderr の 1 行 (CLI の output() が echo する)。
  test("--kind broadcast + --members は無視 + stderr に warning が echo される", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(
        ["--sid", "S1", "create-room", "--kind", "broadcast", "--members", "S2,S3"],
        env,
      );
      expect(res.code).toBe(0); // 非致命的 warning、exit は 0
      const created = JSON.parse(res.out) as { ok: boolean; room: string; warning?: string };
      expect(created.ok).toBe(true);
      expect(created.warning).toBe(
        "--members is ignored for broadcast rooms (members are auto-populated)",
      );
      expect(res.err).toContain("--members is ignored for broadcast rooms");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか: `--kind` の値検証は CLI 側で早期に落とす (typo で "boadcast"
  // 等が silently normal room を立てる回帰を防ぐ)。daemon には接続しない。
  test("--kind に不正値を渡すと exit 非零 + stderr に案内", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(
        ["--sid", "S1", "create-room", "--kind", "boadcast"], // typo
        env,
      );
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("--kind must be 'normal', 'broadcast', or '1on1'");
      expect(res.out).toBe("");
      // daemon には接続しないこと (前段で早期 reject)
      const st = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
      expect(st.running).toBe(false);
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
      const status = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
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
      const res = await runCli(["rooms", "--version"], env);
      expect(res.code).toBe(0);
      expect(res.out).toBe(`${VERSION}\n`);
    } finally {
      cleanup();
    }
  });

  // rooms のデフォルトは active のみ (kawaz r17 mid=23、2026-07-15): AI
  // セッションが rooms を叩くたびに archive 済み全件が context に乗るのは
  // 無駄。--all で全件のオプトイン。絞った時は archived_omitted で「見えて
  // いない room がある」ことを機械可読に示す — 「見えない = 存在しない」と
  // 誤認して重複 room を作る事故の予防。
  // 何を保証するか (DR-0017 §2.1-2.2 e2e): reply <rNmN> <msg> が rNmN を
  // パースして op:"reply" に写り、daemon 構成の to (元 from + u1) で届き、
  // storage に reply_to が残る。CLI 層の positional 慣習 (post と同型) の
  // 回帰 guard。
  test("reply <rNmN> <msg> が daemon 構成の宛先で返信を投稿する", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const created = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--members", "S2"], env)).out,
      ) as { room: string };
      const posted = JSON.parse(
        (await runCli(["--sid", "S1", "post", created.room, "question"], env)).out,
      ) as { mid: number };

      const replied = JSON.parse(
        (await runCli(["--sid", "S2", "reply", `${created.room}m${posted.mid}`, "answer"], env))
          .out,
      ) as { ok: boolean; mid: number; to: string[] };
      expect(replied.ok).toBe(true);
      // to = 元 from (S1 = a1) + u1、返信者 S2 (a2) は含まれない
      expect(replied.to).toEqual(["u1", "a1"]);

      const read = JSON.parse(
        (await runCli(["read", created.room, String(replied.mid)], env)).out,
      ) as { msgs: { msg: string; reply_to?: string }[] };
      expect(read.msgs[0]!.msg).toBe("answer");
      expect(read.msgs[0]!.reply_to).toBe(`${created.room}m${posted.mid}`);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (DR-0017 §2.1 の引数検証): rNmN 形でない参照は daemon に
  // 投げる前に usage error で弾く (typo が room_not_found のような遠い error
  // になって原因を探させない)。
  test("reply の rNmN パース失敗は usage error で exit 非零", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = await runCli(["--sid", "S1", "reply", "r7-m10", "text"], env);
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("r<N>m<M>");
    } finally {
      cleanup();
    }
  }, 30000);

  // reply_via is the single response instruction channel. subscribe emits the
  // daemon's JSONL frame unchanged and never appends an extra prose line.
  test("subscribe emits reply_via in pure JSONL without an extra instruction line", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const created = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--members", "S2"], env)).out,
      ) as { room: string };

      const runSub = async (extra: string[]): Promise<string[]> => {
        const sub = Bun.spawn([process.execPath, CLI, "subscribe", ...extra], {
          env: { ...process.env, ...env, CCMSG_SID: "S2" },
          stdout: "pipe",
          stderr: "pipe",
        });
        // --since replay (呼び出し側が渡す) に S1 の既存 post が載って指示文行が付く。
        // 起動 → backlog 受信を待って kill、stdout を読み切る。
        await new Promise<void>((r) => setTimeout(r, 1500));
        sub.kill();
        await sub.exited;
        const out = await new Response(sub.stdout).text();
        return out.split("\n").filter((l) => l !== "");
      };

      const posted = JSON.parse(
        (await runCli(["--sid", "S1", "post", created.room, "need reply"], env)).out,
      ) as { mid: number };

      // subscribe's bare default no longer replays backlog (issue
      // 2026-07-17-subscribe-no-backlog-default) — `--since '{"<room>":0}'` is the
      // explicit opt-in this test needs to see S1's pre-existing post.
      const sinceAll = JSON.stringify({ [created.room]: 0 });
      const lines = await runSub(["--since", sinceAll]);
      const msgLine = lines.find((l) => l.includes('"need reply"'));
      expect(msgLine).toBeDefined();
      expect(JSON.parse(msgLine!) as Record<string, unknown>).toMatchObject({
        reply_via: `Use \`ccmsg reply ${created.room}m${posted.mid} <msg>\``,
      });
      for (const line of lines) JSON.parse(line);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  test("rooms は archived を省き --all で全件 (省略数は archived_omitted で申告)", async () => {
    const { env, sock, cleanup } = (() => {
      const made = makeEnv();
      return { ...made, sock: path.join(made.env.CCMSG_STATE_DIR!, "daemon.sock") };
    })();
    try {
      // member set を変えて 2 room 作る (同一 set は create-room の dedup で
      // 同じ room が返るため、S2 入りで区別する)。
      const r1 = JSON.parse((await runCli(["--sid", "S1", "create-room"], env)).out) as {
        room: string;
      };
      const r2 = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--members", "S2"], env)).out,
      ) as {
        room: string;
      };
      // CLI に archive コマンドは無い (webui 専用操作) ので、daemon socket に
      // 直接 archive_room を送って r1 を archive 状態にする。
      await new Promise<void>((resolve, reject) => {
        const chunks: string[] = [];
        let replies = 0;
        void Bun.connect({
          unix: sock,
          socket: {
            open(s) {
              s.write(`${JSON.stringify({ op: "hello", role: "user" })}\n`);
              s.write(`${JSON.stringify({ op: "archive_room", room: r1.room, archived: true })}\n`);
            },
            data(s, chunk) {
              chunks.push(new TextDecoder().decode(chunk));
              replies = chunks.join("").split("\n").filter(Boolean).length;
              if (replies >= 2) {
                s.end();
                resolve();
              }
            },
            error(_s, e) {
              reject(e);
            },
          },
        });
      });

      // デフォルト: active の r2 だけ + archived_omitted=1
      const dflt = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { id: string }[];
        archived_omitted?: number;
      };
      expect(dflt.rooms.map((r) => r.id)).toEqual([r2.room]);
      expect(dflt.archived_omitted).toBe(1);

      // --all: 両方見える (archived room には archived:true が付く)
      const all = JSON.parse((await runCli(["rooms", "--all"], env)).out) as {
        rooms: { id: string; archived?: boolean }[];
        archived_omitted?: number;
      };
      expect(all.rooms.map((r) => r.id).sort()).toEqual([r1.room, r2.room].sort());
      expect(all.rooms.find((r) => r.id === r1.room)?.archived).toBe(true);
      expect(all.archived_omitted).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (RL-Q2 kawaz r26 mid=104、裁定=a): minimal help の
  //   `create-room --members <sid[,sid...]> <title>`
  // に合わせ、positional <title> を room title として受理する。現状 args[0]
  // は silent drop だったため、CLI 呼び出し実態 (help に沿って書いた kawaz が
  // title を渡したつもりで無視される) と help 文面が齟齬していたのを合わせる。
  test("create-room の positional <title> が room title として反映される", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const created = JSON.parse(
        (await runCli(["--sid", "S1", "create-room", "--members", "S2", "positional-title"], env))
          .out,
      ) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { id: string; title?: string }[];
      };
      const r = rooms.rooms.find((x) => x.id === created.room)!;
      expect(r.title).toBe("positional-title");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (RL-Q2 の precedence 側): positional <title> と --title の
  // 両方が渡された場合、明示 flag (= --title) が勝つ。positional は help 由来の
  // shorthand で明示指定を上書きしないことを固定する。
  test("create-room で --title と positional 両方指定時は --title 優先", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const created = JSON.parse(
        (
          await runCli(
            [
              "--sid",
              "S1",
              "create-room",
              "--members",
              "S2",
              "positional-title",
              "--title",
              "explicit-title",
            ],
            env,
          )
        ).out,
      ) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { id: string; title?: string }[];
      };
      const r = rooms.rooms.find((x) => x.id === created.room)!;
      expect(r.title).toBe("explicit-title");
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  // 何を保証するか (RL-Q2 kawaz r26 mid=104、裁定=a): help `peers [cwd(partial)]`
  // に合わせ、positional 引数を cwd 部分一致 filter として実装する。無指定時は
  // 全 peer が返ることを別 case で確認 (現状の非回帰)。フィルタの絞りは CLI 側
  // 完結 (webui の op:"peers" を汚さない、rooms と同型の方針)。
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
      // CLI は hello の cwd に process.cwd() を送るため、Bun.spawn の cwd で
      // 実 dir を渡す (作成しないと spawn が失敗する)。base dir 配下に mkdir。
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
          env: { ...process.env, ...env },
          stdout: "pipe",
          stderr: "pipe",
        });
      const p1 = spawnPeer("PA", alphaOne);
      const p2 = spawnPeer("PB", alphaTwo);
      const p3 = spawnPeer("PC", betaThree);
      try {
        // subscribe が daemon に hello するまでの猶予: peers を polling で待つ。
        const waitPeers = async (): Promise<{ peers: { sid: string; cwd?: string }[] }> => {
          for (let i = 0; i < 40; i++) {
            const res = JSON.parse((await runCli(["peers"], readEnv)).out) as {
              peers?: { sid: string; cwd?: string }[];
            };
            if (Array.isArray(res.peers) && res.peers.length >= 3) {
              return res as { peers: { sid: string; cwd?: string }[] };
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          throw new Error("timed out waiting for 3 peers");
        };
        const all = await waitPeers();
        expect(all.peers.map((p) => p.sid).sort()).toEqual(["PA", "PB", "PC"]);

        // "/alpha/" 部分一致 → PA + PB のみ (peerBase 名衝突を避けるため /alpha/)
        const alpha = JSON.parse((await runCli(["peers", "/alpha/"], readEnv)).out) as {
          peers: { sid: string; cwd?: string }[];
        };
        expect(alpha.peers.map((p) => p.sid).sort()).toEqual(["PA", "PB"]);

        // "/beta/" 部分一致 → PC のみ
        const beta = JSON.parse((await runCli(["peers", "/beta/"], readEnv)).out) as {
          peers: { sid: string; cwd?: string }[];
        };
        expect(beta.peers.map((p) => p.sid)).toEqual(["PC"]);

        // マッチしない substring → 0 件
        const none = JSON.parse((await runCli(["peers", "no-such-cwd"], readEnv)).out) as {
          peers: { sid: string }[];
        };
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
