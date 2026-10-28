// transcript_read (DR-0009): hello-time transcript_path validation, and
// byte-offset paginated reads of the single validated file per sid. Each test
// starts a daemon in this process, talks to it over UDS, and writes a real
// fixture file (distinct from the daemon's own state dir) to play the role of
// a session's transcript.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TRANSCRIPT_READ_MAX_BYTES,
  TRANSCRIPT_READ_OLDER_MAX_BYTES,
  PROTOCOL_VERSION,
} from "@ccmsg/protocol";
import {
  connect,
  startInProcessDaemon,
  stopInProcessDaemon,
  defined,
  isKind,
  sayMarker,
  sessionConn,
  userConn,
  fixtureDir,
  type TestClient,
} from "./helpers.ts";

const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("hello transcript_path validation (DR-0009)", () => {
  test("正当なパス (絶対 + .jsonl + basename===sid.jsonl) は採用され peers に載る", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const c = await sessionConn(ctx, sid, { transcript_path: file });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.transcript_path).toBe(file);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("相対パスは無視される (peers に transcript_path が載らない)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const sid = SID_A;
      const c = await sessionConn(ctx, sid, { transcript_path: `${sid}.jsonl` });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("basename が <sid>.jsonl と不一致なら無視される", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, "other.jsonl"); // basename mismatch: not "A.jsonl"
      fs.writeFileSync(file, "");
      const c = await sessionConn(ctx, sid, { transcript_path: file });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("拡張子が .jsonl でなければ無視される", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.json`); // wrong extension
      fs.writeFileSync(file, "");
      const c = await sessionConn(ctx, sid, { transcript_path: file });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.transcript_path).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("無効な transcript_path でも hello 自体は成功する (黙って不採用、失敗にしない)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await connect(ctx.sock);
      const res = await c.request({
        op: "hello",
        protocol: PROTOCOL_VERSION,
        role: "session",
        sid: SID_A,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        transcript_path: "relative/not-allowed.jsonl",
      });
      expect(res.ok).toBe(true);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // DR-0009 addendum: transcript_path is a preserve-on-omit exception to
  // "latest hello wins" (unlike repo/ws/cwd). A re-subscribe after the stream
  // died commonly hellos again with the same sid but without
  // CCMSG_TRANSCRIPT_PATH (e.g. the UserPromptSubmit nag's suggested command
  // before that hook also learned to include it) — that must not silently
  // kill the webui Timeline view for a session that never stopped having a
  // transcript.
  test("transcript_path 申告済みの sid が、申告なしの再 hello 後も peers に残る (latest-hello-wins の対象外)", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      await sessionConn(ctx, sid, { transcript_path: file });

      // Re-hello as a second connection with the same sid, omitting
      // transcript_path entirely (as a bare `ccmsg subscribe` reconnect
      // would) — repo/ws/cwd still overwrite (latest-hello-wins), but
      // transcript_path must be preserved from the first hello.
      await sessionConn(ctx, sid, { cwd: "/tmp/other" });

      const peers = await (await connect(ctx.sock)).requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.transcript_path).toBe(file);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transcript_path 申告済みの sid が、別の有効な transcript_path での再 hello で更新される", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file1 = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file1, "");
      await sessionConn(ctx, sid, { transcript_path: file1 });

      const dir2 = fixtureDir("transcript");
      const file2 = path.join(dir2, `${sid}.jsonl`);
      fs.writeFileSync(file2, "");
      try {
        await sessionConn(ctx, sid, { transcript_path: file2 });

        const peers = await (await connect(ctx.sock)).requestOk({ op: "peers" });
        const me = defined(
          peers.peers.find((p) => p.sid === sid),
          `the peer ${sid}`,
        );
        expect(me.transcript_path).toBe(file2);
      } finally {
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("transcript_read errors", () => {
  test("hello_required: hello 前は拒否される", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await connect(ctx.sock);
      const res = await c.requestError({ op: "transcript_read", sid: "whatever" });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("hello_required");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("session_not_found: 接続していない sid", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, SID_A);
      const res = await c.requestError({ op: "transcript_read", sid: "no-such-sid" });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("session_not_found");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("not_found: sid は接続中だが transcript_path が未申告", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, SID_A); // no transcript_path
      const res = await c.requestError({ op: "transcript_read", sid: SID_A });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_found");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("not_found: 採用済みだがファイルが消失している", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "x\n");
      const c = await sessionConn(ctx, sid, { transcript_path: file });
      fs.rmSync(file);
      const res = await c.requestError({ op: "transcript_read", sid });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_found");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid_args: before が負数", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "x\n");
      const c = await sessionConn(ctx, sid, { transcript_path: file });
      const res = await c.requestError({ op: "transcript_read", sid, before: -1 });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid_args: max_bytes が 0 以下", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "x\n");
      const c = await sessionConn(ctx, sid, { transcript_path: file });
      const res = await c.requestError({ op: "transcript_read", sid, max_bytes: 0 });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
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

  test("tail 読み (before 省略): 末尾の完全行群のみが返り、境界に落ちた先頭の空断片は行として現れない", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      const content = fixedWidthContent(10); // 30 bytes
      fs.writeFileSync(file, content);
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      // max_bytes=7: rawStart lands exactly on the '\n' ending "L7" (byte 23).
      // Design detail under test: that raw window's leading byte IS itself the
      // line terminator of the (excluded) prior line, so trimming it leaves an
      // empty leading fragment — not a spurious empty line in the output.
      const res = await c.requestOk({
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
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("before ページング: 隣接ページが漏れ・重複なく連結でき、元の行順を再構成できる", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, fixedWidthContent(10)); // 30 bytes
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      // Page 1 (tail): max_bytes=13 -> rawStart=17, lands mid "L5\n" terminator.
      const page1 = await c.requestOk({
        op: "transcript_read",
        sid,
        max_bytes: 13,
      });
      expect(page1.lines).toEqual(["L6", "L7", "L8", "L9"]);
      expect(page1.start).toBe(18);
      expect(page1.end).toBe(30);

      // Page 2 (older): before = page1.start, generously large max_bytes so it
      // reaches all the way back to byte 0.
      const page2 = await c.requestOk({
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
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("before=0: 先頭より前を読もうとすると空ページ (start===end===0)", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, fixedWidthContent(10));
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      const res = await c.requestOk({ op: "transcript_read", sid, before: 0 });
      expect(res.lines).toEqual([]);
      expect(res.start).toBe(0);
      expect(res.end).toBe(0);
      expect(res.size).toBe(30);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("before がファイルサイズより大きい場合は size に clamp され、tail 読みと同じ結果になる", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, fixedWidthContent(10)); // size 30
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      const tail = await c.requestOk({
        op: "transcript_read",
        sid,
        max_bytes: 7,
      });
      const clamped = await c.requestOk({
        op: "transcript_read",
        sid,
        before: 999_999,
        max_bytes: 7,
      });
      expect(clamped).toEqual(tail);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("空ファイル: tail 読みは空ページ、size===0", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      const res = await c.requestOk({ op: "transcript_read", sid });
      expect(res.lines).toEqual([]);
      expect(res.start).toBe(0);
      expect(res.end).toBe(0);
      expect(res.size).toBe(0);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("巨大ファイル (300KB+) で max_bytes が TRANSCRIPT_READ_MAX_BYTES に clamp される", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      // 40,000 lines * 11 bytes ("0123456789\n") = 440,000 bytes (> 300 KiB,
      // and > TRANSCRIPT_READ_MAX_BYTES which is 256 KiB).
      const lineCount = 40_000;
      fs.writeFileSync(file, "0123456789\n".repeat(lineCount));
      const size = lineCount * 11;
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      // Ask for more than the file's total size as max_bytes: without clamping
      // this would read the whole 440,000-byte file; TRANSCRIPT_READ_MAX_BYTES
      // (256 KiB = 262,144 bytes) must cap the actual window instead.
      const res = await c.requestOk({
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
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The two clamps differ by what the read is for: the tail is what a viewer
  // renders on open (kept light), a `before` read is the reader paging back,
  // usually to search the history, so it moves more per request. 11-byte
  // lines make a full window land within one line of its clamp, so each test
  // tells "clamped at its own cap" apart from "clamped at the other one".
  test("before 無しの読み (tail) は TRANSCRIPT_READ_MAX_BYTES まで返す", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      const lineCount = Math.ceil((TRANSCRIPT_READ_OLDER_MAX_BYTES * 1.2) / 11);
      fs.writeFileSync(file, "0123456789\n".repeat(lineCount));
      const size = lineCount * 11;
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      for (const req of [{}, { max_bytes: size }]) {
        const res = await c.requestOk({ op: "transcript_read", sid, ...req });
        expect(res.end).toBe(size);
        expect(res.end - res.start).toBeLessThanOrEqual(TRANSCRIPT_READ_MAX_BYTES);
        expect(res.end - res.start).toBeGreaterThan(TRANSCRIPT_READ_MAX_BYTES - 11);
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("before 付きの読み (older) は TRANSCRIPT_READ_OLDER_MAX_BYTES まで返す", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      const lineCount = Math.ceil((TRANSCRIPT_READ_OLDER_MAX_BYTES * 1.2) / 11);
      fs.writeFileSync(file, "0123456789\n".repeat(lineCount));
      const size = lineCount * 11;
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      for (const req of [{}, { max_bytes: size }]) {
        const res = await c.requestOk({ op: "transcript_read", sid, before: size, ...req });
        expect(res.end).toBe(size);
        expect(res.end - res.start).toBeLessThanOrEqual(TRANSCRIPT_READ_OLDER_MAX_BYTES);
        expect(res.end - res.start).toBeGreaterThan(TRANSCRIPT_READ_OLDER_MAX_BYTES - 11);
        expect(res.lines.every((l) => l === "0123456789")).toBe(true);
      }
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("UTF-8 マルチバイト境界: clamp がマルチバイト文字の途中に落ちても壊れた文字は返らない", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      // Each line is 7 Japanese characters (3 bytes each in UTF-8) + "\n":
      // 22 bytes/line. 5 lines = 110 bytes total.
      const line = "こんにちは世界";
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for \n
      const lineCount = 5;
      fs.writeFileSync(file, `${line}\n`.repeat(lineCount));
      const size = lineBytes * lineCount;

      const c = await sessionConn(ctx, sid, { transcript_path: file });
      // max_bytes = size - 1: rawStart = 1, which lands one byte INTO the
      // first line's first multi-byte character (each Japanese char is 3
      // bytes; byte 0/1/2 are all part of the same character) — a naive
      // byte-boundary cut here would slice a UTF-8 character in half.
      const res = await c.requestOk({
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
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cap 超の単一行 (soft cap) をまたぐ before ページングが STUCK せず全行を返す", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      // giant line body must exceed the `before` read's cap
      // (TRANSCRIPT_READ_OLDER_MAX_BYTES; page2 is a `before` read): the bug this
      // guards against only shows up once a page boundary lands exactly at
      // this line's own end, so a small line follows it (page1 = tail read
      // picks up only that trailing small line, page2 = "older" from
      // page1.start is the exact repro window). Size derived from the
      // protocol constant so raising the cap (e.g. 256KB→2MB)
      // doesn't break this test's cap-crossing invariant.
      const giantContent = "H".repeat(TRANSCRIPT_READ_OLDER_MAX_BYTES + 1024 - 1);
      fs.writeFileSync(file, `S0\n${giantContent}\nS1\n`);
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      const page1 = await c.requestOk({ op: "transcript_read", sid });
      expect(page1.ok).toBe(true);
      expect(page1.lines).toEqual(["S1"]);

      // Pre-fix this reproduced STUCK exactly: the window
      // [page1.start - cap, page1.start) sits entirely inside the giant
      // line's body, and its own trailing \n is the window's very last
      // byte — leading trim used to return an empty page anchored right
      // back at page1.start (start === before), so passing it back as the
      // next `before` never moved and looped forever.
      const page2 = await c.requestOk({
        op: "transcript_read",
        sid,
        before: page1.start,
      });
      expect(page2.ok).toBe(true);
      expect(page2.start).toBeLessThan(page1.start); // strict progress, no STUCK
      expect(page2.lines).toEqual([giantContent]); // whole line recovered, uncapped
      expect(page2.end).toBe(page1.start);

      const page3 = await c.requestOk({
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
      expect([...page3.lines, ...page2.lines, ...page1.lines]).toEqual(["S0", giantContent, "S1"]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cap + 内部 backward scan 予算を超える巨大行は soft cap 回収を諦めるが進行は保証する", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      // Must comfortably exceed the `before` read's cap
      // (TRANSCRIPT_READ_OLDER_MAX_BYTES) + transcript.ts's
      // internal 4 MiB backward-scan budget — the scan must give up rather
      // than buffer this whole line unbounded. Size derived from the
      // protocol cap so raising it doesn't accidentally shrink the fixture below the scan-give-up threshold.
      const giantContent = "H".repeat(TRANSCRIPT_READ_OLDER_MAX_BYTES + 5 * 1024 * 1024 - 1);
      fs.writeFileSync(file, `S0\n${giantContent}\nS1\n`);
      const c = await sessionConn(ctx, sid, { transcript_path: file });

      const page1 = await c.requestOk({ op: "transcript_read", sid });
      expect(page1.lines).toEqual(["S1"]);

      const page2 = await c.requestOk({
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
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("transcript_read after (DR-0009 §3: 差分取得)", () => {
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `L${from + i}`);
  const content = (from: number, to: number) => lines(from, to).join("\n") + "\n";

  // One daemon and one transcript per test: `run` gets the session connection
  // and the file to grow.
  async function withTranscript(
    initial: string,
    run: (c: Awaited<ReturnType<typeof sessionConn>>, sid: string, file: string) => Promise<void>,
  ): Promise<void> {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, initial);
      const c = await sessionConn(ctx, SID_A, { transcript_path: file });
      await run(c, SID_A, file);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("after に前の読みの end を渡すと、その後に足された行だけが返る", async () => {
    await withTranscript(content(0, 5), async (c, sid, file) => {
      const tail = await c.requestOk({ op: "transcript_read", sid });
      fs.appendFileSync(file, content(5, 8));
      const next = await c.requestOk({ op: "transcript_read", sid, after: tail.end });
      expect(next.lines).toEqual(lines(5, 8));
      expect(next.start).toBe(tail.end);
      expect(next.end).toBe(next.size);
      expect(next.size).toBe(fs.statSync(file).size);
    });
  });

  // A cap smaller than what was appended returns a page; its end, passed on,
  // continues with no gap and no overlap until end reaches size.
  test("cap で区切られたページは end を次の after に渡して漏れ・重複なく続く", async () => {
    await withTranscript(content(0, 10), async (c, sid) => {
      const read: string[] = [];
      let after = 0;
      for (;;) {
        const page = await c.requestOk({ op: "transcript_read", sid, after, max_bytes: 7 });
        expect(page.start).toBe(after);
        read.push(...page.lines);
        if (page.end === page.size) break;
        expect(page.end).toBeGreaterThan(after);
        after = page.end;
      }
      expect(read).toEqual(lines(0, 10));
    });
  });

  test("after がファイルの末尾なら空ページ (start === end === after)", async () => {
    await withTranscript(content(0, 3), async (c, sid, file) => {
      const size = fs.statSync(file).size;
      const page = await c.requestOk({ op: "transcript_read", sid, after: size });
      expect(page.lines).toEqual([]);
      expect(page.start).toBe(size);
      expect(page.end).toBe(size);
    });
  });

  // The writer is mid-line: the unterminated tail is left for a later read,
  // so end stays on a line boundary and the next after picks the line up whole.
  test("書きかけの最後の行は返さず、書き終わった後の after で丸ごと返る", async () => {
    await withTranscript(content(0, 2), async (c, sid, file) => {
      const tail = await c.requestOk({ op: "transcript_read", sid });
      fs.appendFileSync(file, "L2\nL3-part");
      const partial = await c.requestOk({ op: "transcript_read", sid, after: tail.end });
      expect(partial.lines).toEqual(["L2"]);
      fs.appendFileSync(file, "ial\n");
      const rest = await c.requestOk({ op: "transcript_read", sid, after: partial.end });
      expect(rest.lines).toEqual(["L3-partial"]);
      expect(rest.end).toBe(rest.size);
    });
  });

  // An offset the file does not continue from — past its end (replaced or cut
  // short) or inside a line — reads as no lines anchored at the file's end, a
  // start other than after.
  test("続きにならない after は行を返さず、start をファイルの末尾に置く", async () => {
    await withTranscript(content(0, 3), async (c, sid, file) => {
      const size = fs.statSync(file).size;
      for (const after of [size + 10, 1]) {
        const page = await c.requestOk({ op: "transcript_read", sid, after });
        expect(page.lines).toEqual([]);
        expect(page.start).toBe(size);
        expect(page.end).toBe(size);
      }
    });
  });

  test("cap を超える 1 行はその行を丸ごと返す", async () => {
    const long = "X".repeat(40);
    await withTranscript(`S0\n${long}\nS1\n`, async (c, sid) => {
      const page = await c.requestOk({ op: "transcript_read", sid, after: 3, max_bytes: 8 });
      expect(page.lines).toEqual([long]);
      expect(page.start).toBe(3);
      expect(page.end).toBe(3 + long.length + 1);
    });
  });

  // Past the scan budget the line's content is not buffered: the read says
  // the file does not continue from after, and the reader reads the tail.
  test("cap と走査の予算を超える巨大行は続きにならないと答える", async () => {
    const giant = "H".repeat(TRANSCRIPT_READ_MAX_BYTES + 5 * 1024 * 1024 - 1);
    await withTranscript(`S0\n${giant}\nS1\n`, async (c, sid, file) => {
      const page = await c.requestOk({ op: "transcript_read", sid, after: 3 });
      expect(page.lines).toEqual([]);
      expect(page.start).toBe(fs.statSync(file).size);
    });
  });

  test("invalid_args: after が負数、before と同時", async () => {
    await withTranscript(content(0, 1), async (c, sid) => {
      for (const req of [
        { op: "transcript_read" as const, sid, after: -1 },
        { op: "transcript_read" as const, sid, after: 0, before: 3 },
      ]) {
        const res = await c.requestError(req);
        expect(res.error.code).toBe("invalid_args");
      }
    });
  });
});

describe("transcript live Timeline (DR-0045 §2 / §4)", () => {
  /** What the session's hooks module does as a row goes in: push it. The
   * daemon reads the jsonl on, as far as its complete lines go. */
  async function push(s: TestClient, uuid: string): Promise<void> {
    await s.requestOk({
      op: "transcript_push",
      rows: [{ uuid, door: "response", message: { type: "assistant", content: [] } }],
    });
  }

  test("session role からの transcript_subscribe / transcript_unsubscribe は bad_request (user role only)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, SID_A);
      const subRes = await c.requestError({ op: "transcript_subscribe", sid: SID_A });
      expect(subRes.ok).toBe(false);
      expect(subRes.error.code).toBe("bad_request");
      const unsubRes = await c.requestError({ op: "transcript_unsubscribe", sid: SID_A });
      expect(unsubRes.ok).toBe(false);
      expect(unsubRes.error.code).toBe("bad_request");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("session_not_found: 接続していない sid を subscribe しようとする", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const res = await u.requestError({ op: "transcript_subscribe", sid: "no-such-sid" });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("session_not_found");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("not_found: sid は接続中だが transcript_path が未申告", async () => {
    const ctx = await startInProcessDaemon();
    try {
      await sessionConn(ctx, SID_A); // no transcript_path
      const u = await userConn(ctx);
      const res = await u.requestError({ op: "transcript_subscribe", sid: SID_A });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("not_found");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("追記された完全な行が ev:'transcript' として届く (start/end/size が実際の追記と一致)", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "L0\n"); // 3 bytes already on disk before subscribing
      const s = await sessionConn(ctx, sid, { transcript_path: file });

      const u = await userConn(ctx);
      const sub = await u.requestOk({ op: "transcript_subscribe", sid });
      expect(sub.ok).toBe(true);
      expect(sub.size).toBe(3); // anchored at current size — pre-existing content is not replayed

      fs.appendFileSync(file, "L1\nL2\n"); // 6 bytes appended, both lines complete
      await push(s, "u1");
      const { ev } = await u.readEventUntil("transcript");
      expect(ev.sid).toBe(sid);
      expect(ev.lines).toEqual(["L1", "L2"]);
      expect(ev.start).toBe(3);
      expect(ev.end).toBe(9);
      expect(ev.size).toBe(9);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("行境界: 改行なしの部分書き込みだけでは配信されず、次の追記で完成した行としてまとめて届く", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await sessionConn(ctx, sid, { transcript_path: file });

      const u = await userConn(ctx);
      const sub = await u.requestOk({ op: "transcript_subscribe", sid });
      expect(sub.size).toBe(0);

      // Partial write with no trailing newline — must not surface as a line.
      fs.appendFileSync(file, "partial-no-newline-yet");
      // The row is pushed before its line is complete: the daemon reads
      // again while it waits for the row, and sends the line once whole.
      await push(s, "u-partial");
      // Complete the line, then append one more full line — the first event
      // must contain BOTH as whole, uncorrupted lines (proves the partial
      // fragment was deferred rather than dropped or split wrongly).
      fs.appendFileSync(file, " done\nsecond\n");

      const { ev } = await u.readEventUntil("transcript");
      expect(ev.lines).toEqual(["partial-no-newline-yet done", "second"]);
      expect(ev.start).toBe(0);
      expect(ev.end).toBe(fs.statSync(file).size);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("truncate 検知: サイズが縮んだら安全側で offset をリセットし、空 lines のイベントで新サイズを通知する", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "L0\nL1\nL2\n"); // 9 bytes
      const s = await sessionConn(ctx, sid, { transcript_path: file });

      const u = await userConn(ctx);
      const sub = await u.requestOk({ op: "transcript_subscribe", sid });
      expect(sub.size).toBe(9);

      // Simulate a log rotation / rewrite: file shrinks to 4 bytes.
      fs.writeFileSync(file, "X0\n\n"); // deliberately not a clean jsonl line, tests the reset itself
      await push(s, "u-shrunk");
      const { ev } = await u.readEventUntil("transcript");
      expect(ev.lines).toEqual([]); // safe-side reset never tries to diff stale content
      expect(ev.start).toBe(4);
      expect(ev.end).toBe(4);
      expect(ev.size).toBe(4);

      // Tail resumes correctly from the new offset for content appended after the reset.
      fs.appendFileSync(file, "Y0\n");
      await push(s, "u-after-reset");
      const { ev: ev2 } = await u.readEventUntil("transcript", (e) => e.lines.length > 0);
      expect(ev2.lines).toEqual(["Y0"]);
      expect(ev2.start).toBe(4);
      expect(ev2.end).toBe(7);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression (adversarial review, transcript.ts minor finding): a rewrite
  // via unlink+recreate at the same path (e.g. a compaction tool rewriting
  // the transcript) gets a NEW inode even when the new content is the same
  // size as, or larger than, what was there before — the size<lastEnd
  // truncate check alone can't see this case, only an inode check can.
  // Without it, tail would resume from the old (now-wrong) lastEnd offset
  // and read a corrupted mid-line fragment of the new content.
  test("inode 変化検知: unlink+recreate による書き換えは同サイズ/大きいサイズでも安全側リセットされる", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "L0\nL1\nL2\n"); // 9 bytes
      const s = await sessionConn(ctx, sid, { transcript_path: file });

      const u = await userConn(ctx);
      const sub = await u.requestOk({ op: "transcript_subscribe", sid });
      expect(sub.size).toBe(9);

      // Rewrite via unlink+recreate (NOT an in-place write) at the same
      // path — a fresh inode, with a LARGER size (12 bytes) than the old
      // lastEnd (9), so a size<lastEnd-only check would wrongly treat this
      // as ordinary growth and try to read [9, 12) of the new file.
      fs.rmSync(file);
      fs.writeFileSync(file, "Y0\nY1\nY2\nY3\n"); // 12 bytes, new inode
      await push(s, "u-replaced");
      const { ev } = await u.readEventUntil("transcript");
      expect(ev.lines).toEqual([]); // safe-side reset, no attempt to diff stale content
      expect(ev.start).toBe(12);
      expect(ev.end).toBe(12);
      expect(ev.size).toBe(12);

      // Tail resumes correctly from the new offset for content appended after the reset.
      fs.appendFileSync(file, "Y4\n");
      await push(s, "u-after-replace");
      const { ev: ev2 } = await u.readEventUntil("transcript", (e) => e.lines.length > 0);
      expect(ev2.lines).toEqual(["Y4"]);
      expect(ev2.start).toBe(12);
      expect(ev2.end).toBe(15);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transcript_path が変わったら、購読しているタブは新しいファイルをその末尾から追う", async () => {
    const ctx = await startInProcessDaemon();
    const dir1 = fixtureDir("transcript");
    const dir2 = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file1 = path.join(dir1, `${sid}.jsonl`);
      const file2 = path.join(dir2, `${sid}.jsonl`);
      fs.writeFileSync(file1, "old\n");
      fs.writeFileSync(file2, "new\n");
      await sessionConn(ctx, sid, { transcript_path: file1 });

      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      await u.requestOk({ op: "transcript_subscribe", sid });

      const s2 = await sessionConn(ctx, sid, { transcript_path: file2 });
      fs.appendFileSync(file2, "after-path-change\n");
      await push(s2, "u-new-file");
      const { ev } = await u.readEventUntil("transcript", (event) => event.lines.length > 0);
      expect(ev.lines).toEqual(["after-path-change"]);
      expect(ev.start).toBe(Buffer.byteLength("new\n"));
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("transcript_unsubscribe 後は追記してもイベントが届かない", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await sessionConn(ctx, sid, { transcript_path: file });

      const u = await userConn(ctx);
      // The push subscribe too (distinct from transcript_subscribe): the
      // marker say used below to gate "did a transcript event sneak in"
      // arrives only to daemon.subscribers, so without this the marker
      // itself would never reach `u` and the test would hang instead of
      // proving anything.
      await u.request({ op: "subscribe" });
      await u.requestOk({ op: "transcript_subscribe", sid });
      fs.appendFileSync(file, "L0\n");
      await push(s, "u0");
      await u.readEventUntil("transcript"); // confirm the Timeline really was live

      const unsub = await u.requestOk({
        op: "transcript_unsubscribe",
        sid,
      });
      expect(unsub.ok).toBe(true);

      fs.appendFileSync(file, "L1\n");
      await push(s, "u1");
      // Drive a distinguishable event through the SAME connection's stream (a
      // say from a fresh session) and confirm no "transcript" event snuck in
      // among the events collected while waiting for it.
      const s2 = await sessionConn(ctx, SID_B);
      const seen = await sayMarker(s2, u, "marker");
      expect(seen.some(isKind("transcript"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("接続の close で自動的に unsubscribe される (以降のイベントを購読しない)", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await sessionConn(ctx, sid, { transcript_path: file });

      const u1 = await userConn(ctx);
      await u1.requestOk({ op: "transcript_subscribe", sid });
      fs.appendFileSync(file, "L0\n");
      await push(s, "u0");
      await u1.readEventUntil("transcript");
      u1.close();

      // A second subscriber re-subscribing to the same sid after the first's
      // disconnect follows on from the file's end: the last subscriber
      // leaving drops the relay, and this subscribe opens it again.
      const u2 = await userConn(ctx);
      const sub2 = await u2.requestOk({ op: "transcript_subscribe", sid });
      expect(sub2.ok).toBe(true);
      fs.appendFileSync(file, "L1\n");
      await push(s, "u1");
      const { ev } = await u2.readEventUntil("transcript");
      expect(ev.lines).toEqual(["L1"]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 何を保証するか: 行は append より後に書かれる。push の時に jsonl にまだ
  // 無い行は、短い間隔で読み直して書かれた時に届く (常時の監視は持たない)。
  test("a row pushed before its line is written arrives once the line is written", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await sessionConn(ctx, sid, { transcript_path: file });
      const u = await userConn(ctx);
      await u.requestOk({ op: "transcript_subscribe", sid });

      await push(s, "late-row");
      const line = JSON.stringify({ type: "assistant", uuid: "late-row" });
      setTimeout(() => fs.appendFileSync(file, `${line}\n`), 150);
      const { ev } = await u.readEventUntil("transcript");
      expect(ev.lines).toEqual([line]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 何を保証するか: push が無ければ、ファイルが伸びても何も届かない (tail は
  // 持たない。module の無いセッションの Timeline はライブにならない)。
  test("nothing arrives for lines written with no push", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      await sessionConn(ctx, sid, { transcript_path: file });
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      await u.requestOk({ op: "transcript_subscribe", sid });
      fs.appendFileSync(file, "L0\n");
      const s2 = await sessionConn(ctx, SID_B);
      const seen = await sayMarker(s2, u, "marker");
      expect(seen.some(isKind("transcript"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 何を保証するか: transcript_push は session role だけ。queue の行と
  // subagent の行は読み直しの合図にしない (queue には jsonl の行が無く、
  // subagent の行は別のファイル)。
  test("transcript_push is the session's, and its queue and subagent rows read nothing", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("transcript");
    try {
      const sid = SID_A;
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await sessionConn(ctx, sid, { transcript_path: file });
      const u = await userConn(ctx);
      const refused = await u.requestError({
        op: "transcript_push",
        rows: [{ uuid: "x", door: "prompt", message: {} }],
      });
      expect(refused.error.code).toBe("bad_request");

      await u.request({ op: "subscribe" });
      await u.requestOk({ op: "transcript_subscribe", sid });
      fs.appendFileSync(file, "L0\n");
      await s.requestOk({
        op: "transcript_push",
        rows: [
          { uuid: "q", door: "queue", message: {} },
          { uuid: "a", door: "response", agent_id: "a0ea5ee99e172bc5c", message: {} },
        ],
      });
      const s2 = await sessionConn(ctx, SID_B);
      const seen = await sayMarker(s2, u, "marker");
      expect(seen.some(isKind("transcript"))).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
