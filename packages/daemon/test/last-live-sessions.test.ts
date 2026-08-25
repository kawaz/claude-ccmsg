// "前回稼働中" (issue 2026-08-25-restart-recovery-last-live-sessions): the
// daemon records which sessions were connected, so a daemon that comes back
// after a crash or a machine reboot can still say what was running.
//
// The unit half covers the file itself (what is persisted, what a damaged file
// does); the integration half drives real daemons over UDS and bounces one the
// way a power cut would — kill(9), no graceful shutdown — because "the daemon
// died without warning" is the only situation this feature exists for.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LastLiveSession } from "@ccmsg/protocol";
import {
  readLastLiveSessions,
  withLaunchContext,
  writeLastLiveSessions,
} from "../src/last-live-sessions.ts";
import {
  connect,
  spawnDaemonProc,
  startTestDaemon,
  stopTestDaemon,
  waitConnectable,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

const silentLog = { info() {}, error() {} };

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-ll-"));
}

function entry(over: Partial<LastLiveSession> = {}): LastLiveSession {
  return {
    sid: "11111111-1111-4111-8111-111111111111",
    repo: "kawaz/claude-ccmsg",
    ws: "main",
    cwd: "/repos/claude-ccmsg/main",
    last_seen_at: "2026-08-25T10:00:00.000Z",
    ...over,
  };
}

describe("last-live snapshot file", () => {
  test("書いたものがそのまま読める", () => {
    const dir = tmpdir();
    const file = path.join(dir, "last-live-sessions.json");
    const e = entry({
      transcript_path: "/t/a.jsonl",
      repo_root: "/repos/claude-ccmsg",
      branch: "main",
      title: "restart recovery",
      connected_at: "2026-08-25T09:00:00.000Z",
    });
    writeLastLiveSessions(file, [e], silentLog);
    expect(readLastLiveSessions(file, silentLog)).toEqual([e]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("model/effort は永続化されない (transcript から load 時に読み直す派生値)", () => {
    const dir = tmpdir();
    const file = path.join(dir, "last-live-sessions.json");
    writeLastLiveSessions(file, [entry({ model: "claude-opus-5", effort: "high" })], silentLog);
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain("claude-opus-5");
    expect(readLastLiveSessions(file, silentLog)[0]?.model).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("ファイルが無いのは空 (初回起動)", () => {
    const dir = tmpdir();
    expect(readLastLiveSessions(path.join(dir, "nope.json"), silentLog)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("壊れた JSON / 未知 version は空として扱い、起動を妨げない", () => {
    const dir = tmpdir();
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, '{"version":1,"sessions":[{"sid":"a"');
    expect(readLastLiveSessions(broken, silentLog)).toEqual([]);
    const future = path.join(dir, "future.json");
    fs.writeFileSync(future, JSON.stringify({ version: 99, sessions: [entry()] }));
    expect(readLastLiveSessions(future, silentLog)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("sid / cwd / last_seen_at を欠く record は落ちる (resume も表示もできない)", () => {
    const dir = tmpdir();
    const file = path.join(dir, "partial.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updated_at: "2026-08-25T10:00:00.000Z",
        sessions: [
          entry(),
          { ...entry({ sid: "s-nocwd" }), cwd: "" },
          { ...entry({ sid: "s-notime" }), last_seen_at: undefined },
          { repo: "r", ws: "w", cwd: "/tmp", last_seen_at: "2026-08-25T10:00:00.000Z" },
        ],
      }),
    );
    expect(readLastLiveSessions(file, silentLog).map((e) => e.sid)).toEqual([entry().sid]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("withLaunchContext", () => {
  test("transcript 末尾の assistant 行から model/effort を補う", async () => {
    const dir = tmpdir();
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-5" }, effort: "high" }),
      ].join("\n"),
    );
    const [filled] = await withLaunchContext([entry({ transcript_path: file })]);
    expect(filled?.model).toBe("claude-opus-5");
    expect(filled?.effort).toBe("high");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("transcript が無い entry はそのまま (launcher は自分の既定で開く)", async () => {
    const e = entry();
    expect(await withLaunchContext([e])).toEqual([e]);
  });
});

async function sessionHello(
  ctx: DaemonCtx,
  sid: string,
  over: Partial<{ repo: string; ws: string; cwd: string }> = {},
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "session",
    sid,
    repo: over.repo ?? "kawaz/claude-ccmsg",
    ws: over.ws ?? "main",
    cwd: over.cwd ?? "/tmp/main",
  });
  return c;
}

async function userConn(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "user" });
  return c;
}

/** Bounce the daemon the way a power cut does: SIGKILL, no graceful shutdown,
 *  then a fresh process on the same state/data dirs (broadcast.test.ts's
 *  restart idiom, minus the `shutdown` op — a snapshot that only survived a
 *  clean exit would miss the entire case this feature is for). */
async function crashRestart(ctx: DaemonCtx): Promise<void> {
  ctx.proc.kill(9);
  await ctx.proc.exited;
  try {
    fs.unlinkSync(ctx.sock);
  } catch {
    // a killed daemon never cleans up its socket; ignore if it somehow did
  }
  ctx.proc = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
  await waitConnectable(ctx.sock);
}

function snapshotSids(ctx: DaemonCtx): string[] {
  return readLastLiveSessions(path.join(ctx.stateDir, "last-live-sessions.json"), silentLog).map(
    (e) => e.sid,
  );
}

interface PeersReply {
  ok: true;
  peers: { sid: string }[];
  last_live?: LastLiveSession[];
}

describe("daemon restart recovery", () => {
  test(
    "接続中セッションが snapshot に書かれ、切断で消える",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // Both the connect and the disconnect are observed through the
        // ev:"peers" the daemon pushes for them — that push is emitted right
        // after the snapshot write, so waiting for it is what makes reading
        // the file deterministic (no sleep, and no guessing when a socket
        // close reached the daemon).
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const s = await sessionHello(ctx, "s-live");
        await u.readEventUntil<{ peers: { sid: string }[] }>(
          (e) => e.ev === "peers" && e.peers.length === 1,
        );
        expect(snapshotSids(ctx)).toEqual(["s-live"]);
        s.close();
        await u.readEventUntil<{ peers: unknown[] }>(
          (e) => e.ev === "peers" && e.peers.length === 0,
        );
        expect(snapshotSids(ctx)).toEqual([]);
        u.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "kill された daemon を起こし直すと、直前の接続が前回稼働中として出る",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await sessionHello(ctx, "s-crashed", { ws: "wt-1", cwd: "/tmp/wt-1" });
        s.close();
        await crashRestart(ctx);

        const u = await userConn(ctx);
        const peers = await u.request<PeersReply>({ op: "peers" });
        expect(peers.peers).toEqual([]);
        expect(peers.last_live?.map((e) => e.sid)).toEqual(["s-crashed"]);
        const entry0 = peers.last_live?.[0];
        expect(entry0?.cwd).toBe("/tmp/wt-1");
        expect(entry0?.ws).toBe("wt-1");
        expect(entry0?.repo).toBe("kawaz/claude-ccmsg");
        expect(typeof entry0?.last_seen_at).toBe("string");
        u.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "同じ sid が繋ぎ直すと前回稼働中から消え、その場で ev:peers が飛ぶ",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await sessionHello(ctx, "s-back");
        s.close();
        await crashRestart(ctx);

        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        expect((await u.request<PeersReply>({ op: "peers" })).last_live?.length).toBe(1);

        const back = await sessionHello(ctx, "s-back");
        // `e.peers.length === 1` rather than just `ev === "peers"`: a daemon
        // that started with a pending list pushes one frame of its own when
        // the startup launch-context fill settles, and that frame is not the
        // one this test is about.
        const { ev } = await u.readEventUntil<{ ev: string; last_live?: unknown[] }>(
          (e) => e.ev === "peers" && e.peers.length === 1,
        );
        expect(ev.last_live).toBeUndefined();
        const peers = await u.request<PeersReply>({ op: "peers" });
        expect(peers.peers.map((p) => p.sid)).toEqual(["s-back"]);
        expect(peers.last_live).toBeUndefined();
        expect(snapshotSids(ctx)).toEqual(["s-back"]);
        back.close();
        u.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "復旧しないまま二度落ちても前回稼働中は残る",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await sessionHello(ctx, "s-twice");
        s.close();
        await crashRestart(ctx);
        // Nobody resumed it; a second crash must not erase what the first one
        // recorded — the new daemon carries unrecovered entries into its own
        // snapshot. Drive one registry change so it writes at all.
        const filler = await sessionHello(ctx, "s-filler");
        expect(snapshotSids(ctx).sort()).toEqual(["s-filler", "s-twice"]);
        filler.close();
        await crashRestart(ctx);

        const u = await userConn(ctx);
        const peers = await u.request<PeersReply>({ op: "peers" });
        expect(peers.last_live?.map((e) => e.sid).sort()).toEqual(["s-filler", "s-twice"]);
        u.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "session role の peers には last_live を返さない (push を受け取れないため)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await sessionHello(ctx, "s-gone");
        s.close();
        await crashRestart(ctx);

        const other = await sessionHello(ctx, "s-asking");
        const peers = await other.request<PeersReply>({ op: "peers" });
        expect(peers.peers.map((p) => p.sid)).toEqual(["s-asking"]);
        expect(peers.last_live).toBeUndefined();
        other.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
