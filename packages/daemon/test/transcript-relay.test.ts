// The reading of a session's jsonl on pushes (transcript-relay.ts, DR-0045
// §2 / §3): the wait for rows not written yet and its end, the catch-up of a
// live session's folds, and the uuids that wait for nothing. The wire side is
// in transcript.test.ts and the folds' own tests.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseWith, TranscriptStreamEventSchema } from "@ccmsg/protocol";
import { jsonText } from "@ccmsg/protocol/parse";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  createTranscriptRelayStore,
  RELAY_RETRY_MS,
  RELAY_WAIT_MS,
  relayCaughtUp,
  relayPushed,
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
  const folded: string[] = [];
  const restartedOn: (string | undefined)[] = [];
  const store = createTranscriptRelayStore(
    { info: (m) => logged.push(m), error: (m) => logged.push(m) },
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
