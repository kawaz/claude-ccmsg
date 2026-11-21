// The reading of a session's jsonl on pushes (transcript-relay.ts, DR-0045
// §2 / §3): the wait for rows not written yet and its end, the catch-up of a
// live session's folds and what waits for it to land (§6), and the uuids that
// wait for nothing. The wire side is
// in transcript.test.ts and the folds' own tests.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseWith, TranscriptStreamEventSchema } from "@ccmsg/protocol";
import { jsonText } from "@ccmsg/protocol/parse";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import type { TurnSlice } from "../src/event-loop.ts";
import {
  CATCH_UP_LIMIT,
  createTranscriptRelayStore,
  RELAY_RETRY_MS,
  RELAY_WAIT_MS,
  relayAfterCatchUp,
  relayCaughtUp,
  relayHasRead,
  relayPushed,
  relayRefold,
  relaysCaughtUp,
  relaySubscribe,
  stopAllRelays,
  syncLiveRelays,
  type LineFold,
} from "../src/transcript-relay.ts";

const tmpDir = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const EventTextSchema = jsonText(TranscriptStreamEventSchema);

/** A fold that writes down what the relay handed it, in order, and the file
 * each restart named. */
function recordingFold(record: string[], files: (string | undefined)[]): LineFold {
  return {
    restart: (file) => {
      files.push(file);
      record.push("restart");
    },
    take: (line) => record.push(line),
    settle: () => record.push("settle"),
    close: () => record.push("close"),
  };
}

/** A store whose clock the test moves and whose sessions each get a
 * recording fold, a session whose transcript is `file` (holding `initial`),
 * and a tab that collects what it is sent. */
function setUp(initial = "", options: { tab?: boolean; transcript?: boolean } = {}) {
  const file = path.join(tmpDir("relay-"), `${SID}.jsonl`);
  fs.writeFileSync(file, initial);
  let now = 0;
  const logged: string[] = [];
  const warned: string[] = [];
  const folded: string[] = [];
  const restartedOn: (string | undefined)[] = [];
  const store = createTranscriptRelayStore(
    {
      debug: (m) => logged.push(m),
      info: (m) => logged.push(m),
      warn: (m) => warned.push(m),
      error: (m) => logged.push(m),
    },
    { folds: [() => recordingFold(folded, restartedOn)], now: () => now },
  );
  const meta: { sid: string; transcript_path?: string } = { sid: SID };
  if (options.transcript !== false) meta.transcript_path = file;
  const sessions = new Map([[SID, { meta }]]);
  const sent: string[][] = [];
  const conn = {
    write: (line: string) => {
      const read = parseWith(EventTextSchema, line);
      if (read.ok) sent.push([...read.value.lines]);
    },
  };
  if (options.tab !== false) {
    const subscribed = relaySubscribe(store, sessions, SID, conn);
    if (!subscribed.ok) throw new Error(subscribed.msg);
  }
  return {
    file,
    meta,
    store,
    sessions,
    sent,
    logged,
    warned,
    folded,
    restartedOn,
    push: (uuids: string[]) => relayPushed(store, sessions, SID, uuids),
    live: (live: boolean) => syncLiveRelays(store, sessions, live ? [SID] : []),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function ticks(n: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_MS * n));
}

describe("relayPushed", () => {
  // 何を保証するか: 待つ行が上限 (RELAY_WAIT_MS) までに書かれなければ、最後に
  // 1 回読んで待ちをやめる。後から書かれた行は、次の push の読みで届く
  // (読み終わりの位置から続きを読むので抜けない)。
  test("stops waiting at the deadline, and the next push reads what came after", async () => {
    const t = setUp();
    try {
      t.push(["never-written-in-time"]);
      await ticks(2);
      expect(t.sent).toEqual([]);
      t.advance(RELAY_WAIT_MS);
      await ticks(3);
      expect(t.logged.some((m) => m.includes("gave up waiting"))).toBe(true);
      fs.appendFileSync(t.file, '{"uuid":"never-written-in-time"}\n');
      await ticks(3);
      // No wait is left, so nothing reads the file on its own.
      expect(t.sent).toEqual([]);
      t.push(["next"]);
      expect(t.sent).toEqual([['{"uuid":"never-written-in-time"}']]);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: Claude Code は 1 つの response の行を stream の終わりに
  // まとめて書き、block は完了ごとに push する (docs/findings/2026-11-05-relay-gave-up.md)。
  // 後ろに長い block が続く block は上限を過ぎてから書かれ、待ちは止まるが、
  // response の最後の block の push の読みで先の行も、欠けも重複も無く、
  // ファイルの順に届く。待ちが止まっても、読んだ行の uuid は読んだままで残る。
  test("a block written past the wait arrives with the response's last block, once and in order", async () => {
    const t = setUp();
    try {
      fs.appendFileSync(t.file, '{"uuid":"prompt"}\n');
      t.push(["prompt"]);
      t.push(["thinking"]);
      await ticks(2);
      t.advance(RELAY_WAIT_MS);
      await ticks(3);
      expect(t.logged.some((m) => m.includes("gave up waiting") && m.includes("thinking"))).toBe(
        true,
      );
      expect(relayHasRead(t.store, SID, "prompt")).toBe(true);
      fs.appendFileSync(t.file, '{"uuid":"thinking"}\n{"uuid":"text"}\n');
      t.push(["text"]);
      await ticks(3);
      expect(t.sent).toEqual([['{"uuid":"prompt"}'], ['{"uuid":"thinking"}', '{"uuid":"text"}']]);
      expect(relayHasRead(t.store, SID, "thinking")).toBe(true);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: 待つ行が全部読めたら、読み直しをやめる。
  test("stops reading again once every pushed row is read", async () => {
    const t = setUp();
    try {
      t.push(["r1", "r2"]);
      fs.appendFileSync(t.file, '{"uuid":"r1"}\n');
      await ticks(3);
      fs.appendFileSync(t.file, '{"uuid":"r2"}\n');
      await ticks(3);
      expect(t.sent).toEqual([['{"uuid":"r1"}'], ['{"uuid":"r2"}']]);
      fs.appendFileSync(t.file, '{"uuid":"r3"}\n');
      await ticks(3);
      expect(t.sent).toHaveLength(2);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: 既に読んだ行の uuid がもう一度 push されても (compaction が
  // 残した行を同じ uuid で送り直す、DR-0045 §2)、その行を待たない。待てば上限
  // まで読み直しが続き、諦めの log が出る。
  test("a row pushed again after it was read waits for nothing", async () => {
    const t = setUp();
    try {
      fs.appendFileSync(t.file, '{"uuid":"kept"}\n');
      t.push(["kept"]);
      expect(t.sent).toEqual([['{"uuid":"kept"}']]);
      t.push(["kept"]);
      t.advance(RELAY_WAIT_MS);
      await ticks(3);
      expect(t.logged.some((m) => m.includes("gave up waiting"))).toBe(false);
      expect(t.sent).toHaveLength(1);
    } finally {
      stopAllRelays(t.store);
    }
  });
});

describe("live sessions (DR-0045 §3)", () => {
  // 何を保証するか: live になったセッションの fold は、ファイルの頭からの 1 回の
  // 読みで追いつき (restart → 全行 → settle)、以後は push の読みの行を受ける。
  // 追いつきの行はタブには送らない (タブは transcript_read で読んでいる)。
  test("a session that becomes live catches its folds up, and the tabs get only what follows", async () => {
    const t = setUp('{"uuid":"a"}\n{"uuid":"b"}\n');
    try {
      t.live(true);
      await relayCaughtUp(t.store, SID);
      expect(t.folded).toEqual(["restart", '{"uuid":"a"}', '{"uuid":"b"}', "settle"]);
      expect(t.sent).toEqual([]);

      fs.appendFileSync(t.file, '{"uuid":"c"}\n');
      t.push(["c"]);
      expect(t.folded.slice(4)).toEqual(['{"uuid":"c"}', "settle"]);
      expect(t.sent).toEqual([['{"uuid":"c"}']]);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: 追いつきの読みと push が重なっても (追いつきが読んだ行が
  // push でも来る)、fold は各行を 1 度だけ受け、その行を待たない。追いつきの
  // 間の push は、追いつきが終わってから続きを読む。
  test("rows pushed during the catch-up are read once, after it", async () => {
    const t = setUp('{"uuid":"a"}\n');
    try {
      t.live(true);
      fs.appendFileSync(t.file, '{"uuid":"b"}\n');
      t.push(["a", "b"]);
      await relayCaughtUp(t.store, SID);
      expect(t.folded).toEqual(["restart", '{"uuid":"a"}', "settle", '{"uuid":"b"}', "settle"]);
      t.advance(RELAY_WAIT_MS);
      await ticks(3);
      expect(t.logged.some((m) => m.includes("gave up waiting"))).toBe(false);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: relayAfterCatchUp は、追いつきの無い時はその場で走らせ、
  // 追いつきの最中なら追いつきがファイルを読み終わった時に頼まれた順で走らせる。
  // その時の読み済みは追いつきが読んだ分 (live になった時のファイル) の全部で、
  // その後に書かれた行はまだ含まない (続きの読みはその後)。追いつきが別の追い
  // つきに置き換わっても (fold の分類の根が変わった)、置き換えた方の着地で走る。
  test("what waits for the catch-up runs when it lands, in order, against all it read and nothing after", async () => {
    const t = setUp('{"uuid":"a"}\n');
    try {
      const ran: string[] = [];
      relayAfterCatchUp(t.store, SID, () => ran.push("not live"));
      expect(ran).toEqual(["not live"]);
      t.live(true);
      fs.appendFileSync(t.file, '{"uuid":"b"}\n');
      t.push(["a", "b"]);
      const seen = (name: string) => () =>
        ran.push(
          `${name} a=${String(relayHasRead(t.store, SID, "a"))} b=${String(relayHasRead(t.store, SID, "b"))}`,
        );
      relayAfterCatchUp(t.store, SID, seen("first"));
      relayRefold(t.store, SID);
      relayAfterCatchUp(t.store, SID, seen("second"));
      expect(ran).toEqual(["not live"]);
      await relayCaughtUp(t.store, SID);
      expect(ran).toEqual(["not live", "first a=true b=false", "second a=true b=false"]);
      expect(relayHasRead(t.store, SID, "b")).toBe(true);
      relayAfterCatchUp(t.store, SID, () => ran.push("after"));
      expect(ran.at(-1)).toBe("after");
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: 追いつきを待っていたものの 1 つが着地で失敗しても (発声や
  // 知らせの 1 件の失敗)、残りは走り、着地の後の続きの読みも止まらない (その後に
  // 書かれた行がタブに届く)。失敗は warn で 1 行 (sid と理由) 書く。
  test("one of what waits for the catch-up that throws is logged, and the rest and the reading on go on", async () => {
    const t = setUp('{"uuid":"a"}\n');
    try {
      const ran: string[] = [];
      t.live(true);
      fs.appendFileSync(t.file, '{"uuid":"b"}\n');
      t.push(["b"]);
      relayAfterCatchUp(t.store, SID, () => {
        throw new Error("no voice");
      });
      relayAfterCatchUp(t.store, SID, () => ran.push("second"));
      await relayCaughtUp(t.store, SID);
      expect(ran).toEqual(["second"]);
      expect(t.sent).toEqual([['{"uuid":"b"}']]);
      expect(t.warned).toEqual([
        `transcript relay: what waited for the catch-up failed sid=${SID}: Error: no voice`,
      ]);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: 追いつきがファイルを読めずに終わった時と、追いつきの最中に
  // セッションが live でなくなった時は、待っていたものを走らせずに捨てる (読み
  // 済みが全部でないので見分けられない)。捨てたものは後の追いつきの着地でも
  // 走らない。捨てたことは log に 1 行書く。
  test("a catch-up that fails, or a session that leaves during it, drops what waits for it", async () => {
    const t = setUp('{"uuid":"a"}\n', { tab: false });
    const ran: string[] = [];
    try {
      fs.chmodSync(t.file, 0o000);
      t.live(true);
      relayAfterCatchUp(t.store, SID, () => ran.push("failed"));
      await relayCaughtUp(t.store, SID);
      fs.chmodSync(t.file, 0o600);
      expect(t.logged.filter((m) => m.includes("dropped 1 held for the catch-up"))).toEqual([
        `transcript relay: dropped 1 held for the catch-up sid=${SID}: the catch-up failed`,
      ]);

      t.live(false);
      t.live(true);
      relayAfterCatchUp(t.store, SID, () => ran.push("left"));
      t.live(false);
      t.live(true);
      await relayCaughtUp(t.store, SID);
      expect(ran).toEqual([]);
      expect(t.logged.some((m) => m.endsWith(": the session is no longer live"))).toBe(true);
    } finally {
      fs.chmodSync(t.file, 0o600);
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: live でないセッション (module の run が無い) には fold が
  // 無く、push の行はタブにだけ届く。live でなくなったら fold を閉じ、以後は
  // 何も渡さない。
  test("a session that is not live has no folds, and leaving closes them", async () => {
    const t = setUp();
    try {
      fs.appendFileSync(t.file, '{"uuid":"a"}\n');
      t.push(["a"]);
      expect(t.folded).toEqual([]);
      expect(t.sent).toEqual([['{"uuid":"a"}']]);

      t.live(true);
      await relayCaughtUp(t.store, SID);
      t.live(false);
      expect(t.folded.at(-1)).toBe("close");
      const before = t.folded.length;
      fs.appendFileSync(t.file, '{"uuid":"b"}\n');
      t.push(["b"]);
      expect(t.folded).toHaveLength(before);
      expect(t.sent).toEqual([['{"uuid":"a"}'], ['{"uuid":"b"}']]);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: ファイルが縮んだら (書き換え)、タブには空の event で新しい
  // size を伝え、fold は新しいファイルの頭から追いつき直す。
  test("a file that shrank starts the folds over", async () => {
    const t = setUp('{"uuid":"old-1"}\n{"uuid":"old-2"}\n');
    try {
      t.live(true);
      await relayCaughtUp(t.store, SID);
      t.folded.length = 0;
      fs.writeFileSync(t.file, '{"uuid":"new"}\n');
      t.push(["new"]);
      await relayCaughtUp(t.store, SID);
      expect(t.folded).toEqual(["restart", '{"uuid":"new"}', "settle"]);
      expect(t.sent).toEqual([[]]);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: transcript を名乗る前 (最初の prompt の前) に live になった
  // セッションは、最初の push で fold をそのファイルで始め直し、ファイルを頭から
  // 読む (行を落とさない)。ファイル無しで始めた fold のまま行を渡すと、ファイル
  // に依る fold (Status) は行を畳めない。
  test("a session live before it names a transcript reads it from its first byte", async () => {
    const t = setUp("", { tab: false, transcript: false });
    try {
      t.live(true);
      await relayCaughtUp(t.store, SID);
      expect(t.folded).toEqual(["restart", "settle"]);
      fs.writeFileSync(t.file, '{"uuid":"first"}\n');
      t.meta.transcript_path = t.file;
      t.push(["first"]);
      expect(t.folded.slice(2)).toEqual(["restart", "settle", '{"uuid":"first"}', "settle"]);
      expect(t.restartedOn).toEqual([undefined, t.file]);
    } finally {
      stopAllRelays(t.store);
    }
  });
});

describe("catch-up reads at once (DR-0029 「長い走査は時間で譲る」)", () => {
  // 何を保証するか: 読み直し (live になったセッションの fold の追いつき) は同時に
  // CATCH_UP_LIMIT 本までしか走らず、待つものは小さい (読むバイトが少ない)
  // ものから走る。
  // 上限の理由: 走っている読み直しはそれぞれ 1 ターンに slice まで event loop を
  // 握り、それらのターンは続けて回るので、ほかの op は「走っている本数 × slice」
  // 待つ。読み直しは 1 本のスレッドの CPU 仕事なので、同時に走らせても全体は
  // 早く終わらない (計測は docs/findings/2026-11-20-catch-up-yield-by-time.md)。
  // 順の理由: どの読み直しも先に走るものの後に着地するので、短いものを先に
  // すれば短いものが長いものの後ろで待たない (DR-0029 の head-of-line blocking
  // を避ける)。1 度に頼まれた分 (一緒に live になったセッション) は、どれかが
  // 走り出す前に全体で並べる。
  //
  // CATCH_UP_LIMIT + 2 のセッションを大きい順に live にする。各読み直しは最初の
  // 1 行を fold に渡した後で譲り、譲った所で test がその読み直しを止めておく
  // (読み直しごとの gate。譲る直前に最後に行を渡したセッションが、その読み直しの
  // セッション)。止めたまま 1 本ずつ放して、次に誰が走り出すかを段ごとに見る:
  //   1. 最初に止まるのは小さい CATCH_UP_LIMIT 本だけ (ほかは枠が無く始まらない)
  //   2. 一番小さいものを放すと、それが着地して枠が 1 つ空き、待っていた中で
  //      一番小さいものだけが走り出して止まる
  //   3. 次に小さいものを放すと、残りの一番大きいもの (最初に頼まれた) が走り出す
  // 段ごとに比べるのは「どれが最初の 1 行を渡したか」の集まりで、渡した順では
  // ない。同時に走る 2 本の最初の 1 行の順は、それぞれのファイルを開いて読む
  // IO の終わる順で決まり、負荷の下では入れ替わる (全体の実行の中で、2 段目と
  // 3 段目で走り出した 2 本の最初の 1 行の順が逆になって落ちたことがある。
  // 枠を渡す順そのものは小さい順で崩れていなかった)。どの段でも、ほかが止まって
  // いる間に走り出せるのは 1 本だけなので、集まりの比べは決定的になる。
  // 走っている本数は、slice が作られた数 (走り出しで 1 本 1 つ) から着地
  // (settle) の数を引いて数える。走り出しは読み直しの始まりの同じ microtask で
  // 起きるので、上限が無ければ全部が一度に数えられて落ちる。
  test("runs at most CATCH_UP_LIMIT at once, smallest first", async () => {
    const dir = tmpDir("relay-limit-");
    const count = CATCH_UP_LIMIT + 2;
    // Asked largest first: sids[0] reads the most lines.
    const sids = Array.from(
      { length: count },
      (_, i) => `aaaaaaaa-0000-4000-8000-${String(count - i).padStart(12, "0")}`,
    );
    const sessions = new Map<string, { meta: { sid: string; transcript_path: string } }>();
    for (const [i, sid] of sids.entries()) {
      const file = path.join(dir, `${sid}.jsonl`);
      fs.writeFileSync(file, `{"uuid":"${sid}"}\n`.repeat((count - i) * 5));
      sessions.set(sid, { meta: { sid, transcript_path: file } });
    }
    const bySize = [...sids].reverse();
    let running = 0;
    let mostRunning = 0;
    let lastTaken = "";
    const firstTaken: string[] = [];
    const settled: string[] = [];
    const releases = new Map<string, () => void>();
    let held = 0;
    let heldWaiter: { count: number; resolve: () => void } | null = null;
    /** Resolves once `n` reads are (or have been) held after their first line. */
    const untilHeld = (n: number): Promise<void> => {
      if (held >= n) return Promise.resolve();
      const waiter = Promise.withResolvers<void>();
      heldWaiter = { count: n, resolve: waiter.resolve };
      return waiter.promise;
    };
    /** Let the read of the `rank`-th smallest (0 the smallest) go on. */
    const release = (rank: number): void => {
      const sid = bySize[rank];
      const go = sid === undefined ? undefined : releases.get(sid);
      if (go === undefined) throw new Error(`not held: the ${String(rank)}-th smallest`);
      go();
    };
    /** Not spent before the first line, spent before every other; the first
     * pass is held until the test releases that read, the later ones are not. */
    const heldSlice = (): TurnSlice => {
      let asked = 0;
      let passed = false;
      return {
        spent: () => asked++ > 0,
        pass: async () => {
          if (passed) return;
          passed = true;
          const sid = lastTaken;
          const gate = Promise.withResolvers<void>();
          releases.set(sid, gate.resolve);
          held += 1;
          if (heldWaiter !== null && held >= heldWaiter.count) {
            heldWaiter.resolve();
            heldWaiter = null;
          }
          await gate.promise;
        },
      };
    };
    const store = createTranscriptRelayStore(
      { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      {
        folds: [
          (sid) => {
            let taken = 0;
            return {
              restart: () => {},
              take: () => {
                lastTaken = sid;
                if (taken++ === 0) firstTaken.push(sid);
              },
              settle: () => {
                running -= 1;
                settled.push(sid);
              },
              close: () => {},
            };
          },
        ],
        slice: () => {
          running += 1;
          mostRunning = Math.max(mostRunning, running);
          return heldSlice();
        },
      },
    );
    const smallest = (n: number): Set<string> => new Set(bySize.slice(0, n));
    try {
      syncLiveRelays(store, sessions, sids);
      await untilHeld(CATCH_UP_LIMIT);
      expect(new Set(firstTaken)).toEqual(smallest(CATCH_UP_LIMIT));
      expect(running).toBe(CATCH_UP_LIMIT);

      release(0);
      await untilHeld(CATCH_UP_LIMIT + 1);
      expect(new Set(firstTaken)).toEqual(smallest(CATCH_UP_LIMIT + 1));
      expect(settled).toEqual(bySize.slice(0, 1));
      expect(running).toBe(CATCH_UP_LIMIT);

      release(1);
      await untilHeld(CATCH_UP_LIMIT + 2);
      // The largest, asked first, is the last to start.
      expect(new Set(firstTaken)).toEqual(new Set(sids));
      expect(running).toBe(CATCH_UP_LIMIT);

      for (const go of releases.values()) go();
      await relaysCaughtUp(store);
      expect(mostRunning).toBe(CATCH_UP_LIMIT);
      expect(new Set(settled)).toEqual(new Set(sids));
    } finally {
      stopAllRelays(store);
      // A failed expectation leaves reads held: let them see they were
      // stopped and close their files.
      for (const go of releases.values()) go();
      await relaysCaughtUp(store);
    }
  });
});
