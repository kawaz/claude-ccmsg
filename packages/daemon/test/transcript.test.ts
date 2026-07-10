// transcript_read (DR-0009): hello-time transcript_path validation, and
// byte-offset paginated reads of the single validated file per sid. Each test
// spawns a real daemon over UDS and writes a real fixture file (distinct from
// the daemon's own state dir) to play the role of a session's transcript.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TRANSCRIPT_READ_MAX_BYTES } from "@ccmsg/protocol";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

function mkfixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-transcript-"));
}

/** Connect + hello as a session, optionally announcing a transcript_path. */
async function sessionHello(
  ctx: DaemonCtx,
  sid: string,
  opts: { cwd?: string; transcript_path?: string } = {},
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: opts.cwd ?? "/tmp",
    ...(opts.transcript_path ? { transcript_path: opts.transcript_path } : {}),
  });
  return c;
}

interface PeerLite {
  sid: string;
  transcript_path?: string;
}
interface TranscriptReadOk {
  ok: true;
  sid: string;
  lines: string[];
  start: number;
  end: number;
  size: number;
}
interface ErrLite {
  ok: false;
  error: { code: string };
}

describe("hello transcript_path validation (DR-0009)", () => {
  test(
    "正当なパス (絶対 + .jsonl + basename===sid.jsonl) は採用され peers に載る",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, "");
        const c = await sessionHello(ctx, sid, { transcript_path: file });
        const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === sid)!;
        expect(me.transcript_path).toBe(file);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "相対パスは無視される (peers に transcript_path が載らない)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const sid = "A";
        const c = await sessionHello(ctx, sid, { transcript_path: `${sid}.jsonl` });
        const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === sid)!;
        expect(me.transcript_path).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "basename が <sid>.jsonl と不一致なら無視される",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, "other.jsonl"); // basename mismatch: not "A.jsonl"
        fs.writeFileSync(file, "");
        const c = await sessionHello(ctx, sid, { transcript_path: file });
        const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === sid)!;
        expect(me.transcript_path).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "拡張子が .jsonl でなければ無視される",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.json`); // wrong extension
        fs.writeFileSync(file, "");
        const c = await sessionHello(ctx, sid, { transcript_path: file });
        const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === sid)!;
        expect(me.transcript_path).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "無効な transcript_path でも hello 自体は成功する (黙って不採用、失敗にしない)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await connect(ctx.sock);
        const res = await c.request<{ ok: boolean }>({
          op: "hello",
          role: "session",
          sid: "A",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          transcript_path: "relative/not-allowed.jsonl",
        });
        expect(res.ok).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // DR-0009 addendum: transcript_path is a preserve-on-omit exception to
  // "latest hello wins" (unlike repo/ws/cwd). A re-subscribe after the stream
  // died commonly hellos again with the same sid but without
  // CCMSG_TRANSCRIPT_PATH (e.g. the UserPromptSubmit nag's suggested command
  // before that hook also learned to include it) — that must not silently
  // kill the webui Timeline view for a session that never stopped having a
  // transcript.
  test(
    "transcript_path 申告済みの sid が、申告なしの再 hello 後も peers に残る (latest-hello-wins の対象外)",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, "");
        await sessionHello(ctx, sid, { transcript_path: file });

        // Re-hello as a second connection with the same sid, omitting
        // transcript_path entirely (as a bare `ccmsg subscribe` reconnect
        // would) — repo/ws/cwd still overwrite (latest-hello-wins), but
        // transcript_path must be preserved from the first hello.
        await sessionHello(ctx, sid, { cwd: "/tmp/other" });

        const peers = await (
          await connect(ctx.sock)
        ).request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === sid)!;
        expect(me.transcript_path).toBe(file);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "transcript_path 申告済みの sid が、別の有効な transcript_path での再 hello で更新される",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file1 = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file1, "");
        await sessionHello(ctx, sid, { transcript_path: file1 });

        const dir2 = mkfixtureDir();
        const file2 = path.join(dir2, `${sid}.jsonl`);
        fs.writeFileSync(file2, "");
        try {
          await sessionHello(ctx, sid, { transcript_path: file2 });

          const peers = await (
            await connect(ctx.sock)
          ).request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
          const me = peers.peers.find((p) => p.sid === sid)!;
          expect(me.transcript_path).toBe(file2);
        } finally {
          fs.rmSync(dir2, { recursive: true, force: true });
        }
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});

describe("transcript_read errors", () => {
  test(
    "hello_required: hello 前は拒否される",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await connect(ctx.sock);
        const res = await c.request<ErrLite>({ op: "transcript_read", sid: "whatever" });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("hello_required");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "session_not_found: 接続していない sid",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A");
        const res = await c.request<ErrLite>({ op: "transcript_read", sid: "no-such-sid" });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("session_not_found");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "not_found: sid は接続中だが transcript_path が未申告",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A"); // no transcript_path
        const res = await c.request<ErrLite>({ op: "transcript_read", sid: "A" });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("not_found");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "not_found: 採用済みだがファイルが消失している",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, "x\n");
        const c = await sessionHello(ctx, sid, { transcript_path: file });
        fs.rmSync(file);
        const res = await c.request<ErrLite>({ op: "transcript_read", sid });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("not_found");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "invalid_args: before が負数",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, "x\n");
        const c = await sessionHello(ctx, sid, { transcript_path: file });
        const res = await c.request<ErrLite>({ op: "transcript_read", sid, before: -1 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "invalid_args: max_bytes が 0 以下",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, "x\n");
        const c = await sessionHello(ctx, sid, { transcript_path: file });
        const res = await c.request<ErrLite>({ op: "transcript_read", sid, max_bytes: 0 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});

describe("transcript_read pagination", () => {
  // Fixture: 10 fixed-width lines "L0\n".."L9\n" (3 bytes each, 30 bytes total).
  // Fixed width makes every byte offset below arithmetically predictable, so
  // the line-boundary alignment behavior can be asserted exactly rather than
  // just "didn't crash".
  function fixedWidthContent(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += `L${i}\n`;
    return s;
  }

  test(
    "tail 読み (before 省略): 末尾の完全行群のみが返り、境界に落ちた先頭の空断片は行として現れない",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        const content = fixedWidthContent(10); // 30 bytes
        fs.writeFileSync(file, content);
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        // max_bytes=7: rawStart lands exactly on the '\n' ending "L7" (byte 23).
        // Design detail under test: that raw window's leading byte IS itself the
        // line terminator of the (excluded) prior line, so trimming it leaves an
        // empty leading fragment — not a spurious empty line in the output.
        const res = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          max_bytes: 7,
        });
        expect(res.ok).toBe(true);
        expect(res.lines).toEqual(["L8", "L9"]);
        expect(res.start).toBe(24);
        expect(res.end).toBe(30);
        expect(res.size).toBe(30);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "before ページング: 隣接ページが漏れ・重複なく連結でき、元の行順を再構成できる",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, fixedWidthContent(10)); // 30 bytes
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        // Page 1 (tail): max_bytes=13 -> rawStart=17, lands mid "L5\n" terminator.
        const page1 = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          max_bytes: 13,
        });
        expect(page1.lines).toEqual(["L6", "L7", "L8", "L9"]);
        expect(page1.start).toBe(18);
        expect(page1.end).toBe(30);

        // Page 2 (older): before = page1.start, generously large max_bytes so it
        // reaches all the way back to byte 0.
        const page2 = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          before: page1.start,
          max_bytes: 20,
        });
        expect(page2.lines).toEqual(["L0", "L1", "L2", "L3", "L4", "L5"]);
        expect(page2.start).toBe(0);
        expect(page2.end).toBe(page1.start); // adjacent: no gap, no overlap

        // Concatenated in chronological order reconstructs the full file exactly.
        expect([...page2.lines, ...page1.lines]).toEqual(
          Array.from({ length: 10 }, (_, i) => `L${i}`),
        );
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "before=0: 先頭より前を読もうとすると空ページ (start===end===0)",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, fixedWidthContent(10));
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        const res = await c.request<TranscriptReadOk>({ op: "transcript_read", sid, before: 0 });
        expect(res.lines).toEqual([]);
        expect(res.start).toBe(0);
        expect(res.end).toBe(0);
        expect(res.size).toBe(30);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "before がファイルサイズより大きい場合は size に clamp され、tail 読みと同じ結果になる",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, fixedWidthContent(10)); // size 30
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        const tail = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          max_bytes: 7,
        });
        const clamped = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          before: 999_999,
          max_bytes: 7,
        });
        expect(clamped).toEqual(tail);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "空ファイル: tail 読みは空ページ、size===0",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        fs.writeFileSync(file, "");
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        const res = await c.request<TranscriptReadOk>({ op: "transcript_read", sid });
        expect(res.lines).toEqual([]);
        expect(res.start).toBe(0);
        expect(res.end).toBe(0);
        expect(res.size).toBe(0);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "巨大ファイル (300KB+) で max_bytes が TRANSCRIPT_READ_MAX_BYTES に clamp される",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        // 40,000 lines * 11 bytes ("0123456789\n") = 440,000 bytes (> 300 KiB,
        // and > TRANSCRIPT_READ_MAX_BYTES which is 256 KiB).
        const lineCount = 40_000;
        fs.writeFileSync(file, "0123456789\n".repeat(lineCount));
        const size = lineCount * 11;
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        // Ask for more than the file's total size as max_bytes: without clamping
        // this would read the whole 440,000-byte file; TRANSCRIPT_READ_MAX_BYTES
        // (256 KiB = 262,144 bytes) must cap the actual window instead.
        const res = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          max_bytes: size, // 440,000 > TRANSCRIPT_READ_MAX_BYTES
        });
        expect(res.ok).toBe(true);
        expect(res.size).toBe(size);
        expect(res.end).toBe(size); // tail read
        expect(res.end - res.start).toBeLessThanOrEqual(TRANSCRIPT_READ_MAX_BYTES);
        expect(res.end - res.start).toBeGreaterThan(0);
        // Every returned line is a complete, unmangled "0123456789" (line-boundary
        // alignment held even under a large clamp).
        expect(res.lines.every((l) => l === "0123456789")).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "UTF-8 マルチバイト境界: clamp がマルチバイト文字の途中に落ちても壊れた文字は返らない",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        // Each line is 7 Japanese characters (3 bytes each in UTF-8) + "\n":
        // 22 bytes/line. 5 lines = 110 bytes total.
        const line = "こんにちは世界";
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for \n
        const lineCount = 5;
        fs.writeFileSync(file, `${line}\n`.repeat(lineCount));
        const size = lineBytes * lineCount;

        const c = await sessionHello(ctx, sid, { transcript_path: file });
        // max_bytes = size - 1: rawStart = 1, which lands one byte INTO the
        // first line's first multi-byte character (each Japanese char is 3
        // bytes; byte 0/1/2 are all part of the same character) — a naive
        // byte-boundary cut here would slice a UTF-8 character in half.
        const res = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          max_bytes: size - 1,
        });
        expect(res.ok).toBe(true);
        // Only the first (partial) line's fragment is dropped; the remaining
        // lines come back whole, correctly decoded, no replacement characters.
        expect(res.lines).toEqual(Array(lineCount - 1).fill(line));
        expect(res.lines.every((l) => !l.includes("�"))).toBe(true);
        expect(res.end).toBe(size);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "300KiB 超の単一行 (cap 超) をまたぐ before ページングが STUCK せず全行を返す (soft cap)",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        // giant line's body alone (300 KiB - 1 bytes of content + its own \n)
        // exceeds TRANSCRIPT_READ_MAX_BYTES (256 KiB): the bug this guards
        // against only shows up once a page boundary lands exactly at this
        // line's own end, so a small line follows it (page1 = tail read
        // picks up only that trailing small line, page2 = "older" from
        // page1.start is the exact repro window).
        const giantContent = "H".repeat(300 * 1024 - 1);
        fs.writeFileSync(file, `S0\n${giantContent}\nS1\n`);
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        const page1 = await c.request<TranscriptReadOk>({ op: "transcript_read", sid });
        expect(page1.ok).toBe(true);
        expect(page1.lines).toEqual(["S1"]);

        // Pre-fix this reproduced STUCK exactly: the window
        // [page1.start - cap, page1.start) sits entirely inside the giant
        // line's body, and its own trailing \n is the window's very last
        // byte — leading trim used to return an empty page anchored right
        // back at page1.start (start === before), so passing it back as the
        // next `before` never moved and looped forever.
        const page2 = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          before: page1.start,
        });
        expect(page2.ok).toBe(true);
        expect(page2.start).toBeLessThan(page1.start); // strict progress, no STUCK
        expect(page2.lines).toEqual([giantContent]); // whole line recovered, uncapped
        expect(page2.end).toBe(page1.start);

        const page3 = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          before: page2.start,
        });
        expect(page3.ok).toBe(true);
        expect(page3.start).toBeLessThan(page2.start); // strict progress
        expect(page3.start).toBe(0); // reached the true file start
        expect(page3.lines).toEqual(["S0"]);

        // Concatenated in chronological order, the three pages reconstruct
        // the file's three logical lines exactly — no loss, no duplication,
        // despite the middle line being far larger than the byte cap.
        expect([...page3.lines, ...page2.lines, ...page1.lines]).toEqual([
          "S0",
          giantContent,
          "S1",
        ]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "cap + 4MiB 走査上限を超える巨大行は soft cap 回収を諦めるが進行は保証する",
    async () => {
      const ctx = await startTestDaemon();
      const dir = mkfixtureDir();
      try {
        const sid = "A";
        const file = path.join(dir, `${sid}.jsonl`);
        // 5 MiB comfortably exceeds TRANSCRIPT_READ_MAX_BYTES (256 KiB) plus
        // transcript.ts's internal 4 MiB backward-scan budget (~4.25 MiB
        // combined) — the scan must give up rather than buffer this whole
        // line unbounded.
        const giantContent = "H".repeat(5 * 1024 * 1024 - 1);
        fs.writeFileSync(file, `S0\n${giantContent}\nS1\n`);
        const c = await sessionHello(ctx, sid, { transcript_path: file });

        const page1 = await c.request<TranscriptReadOk>({ op: "transcript_read", sid });
        expect(page1.lines).toEqual(["S1"]);

        const page2 = await c.request<TranscriptReadOk>({
          op: "transcript_read",
          sid,
          before: page1.start,
        });
        expect(page2.ok).toBe(true);
        // Gives up on the line's content (no unbounded buffering) but still
        // guarantees strict progress — start is neither stuck at page1.start
        // nor falsely claiming byte 0 (we only skipped ahead, didn't finish
        // scanning to the true file start).
        expect(page2.lines).toEqual([]);
        expect(page2.start).toBeLessThan(page1.start);
        expect(page2.start).toBeGreaterThan(0);
        expect(page2.end).toBe(page2.start);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});
