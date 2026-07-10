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
