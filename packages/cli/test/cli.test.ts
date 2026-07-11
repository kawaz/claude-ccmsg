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
    env: { CCMSG_STATE_DIR: stateDir, CCMSG_DATA_DIR: dataDir },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

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
      const read = JSON.parse((await runCli(["read", room, "1"], env)).out) as {
        msgs: { msg: string }[];
      };
      expect(read.msgs[0]!.msg).toBe("hello");

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

  test("no args prints help; --as-user creates a room without a caller member row", async () => {
    const { env, cleanup } = makeEnv();
    try {
      // no args -> help to stdout (kawaz CLI convention)
      const help = await runCli([], env);
      expect(help.out).toContain("Usage:");
      expect(help.out).toContain("Environment Variables:");

      // --as-user: the User (id "u1") is implicit, so the created room's only member row is the listed peer Z
      const created = JSON.parse(
        (await runCli(["--as-user", "create-room", "--members", "Z"], env)).out,
      ) as {
        ok: boolean;
        room: string;
      };
      expect(created.ok).toBe(true);
      const rooms = JSON.parse((await runCli(["rooms"], env)).out) as {
        rooms: { members: { id: string; sid: string }[] }[];
      };
      expect(rooms.rooms[0]!.members.map((m) => m.sid)).toEqual(["Z"]);
      expect(rooms.rooms[0]!.members[0]!.id).toBe("a1");
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
});
