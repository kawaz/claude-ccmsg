// The live Timeline's reading on pushes (transcript-relay.ts, DR-0045 §2):
// the wait for rows not written yet, and its end. The wire side is in
// transcript.test.ts.
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
  relayPushed,
  relaySubscribe,
  stopAllRelays,
} from "../src/transcript-relay.ts";

const tmpDir = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const EventTextSchema = jsonText(TranscriptStreamEventSchema);

/** A store whose clock the test moves, a session whose transcript is
 * `file`, and a tab that collects what it is sent. */
function setUp() {
  const file = path.join(tmpDir("relay-"), `${SID}.jsonl`);
  fs.writeFileSync(file, "");
  let now = 0;
  const logged: string[] = [];
  const store = createTranscriptRelayStore(
    { info: (m) => logged.push(m), error: (m) => logged.push(m) },
    undefined,
    () => now,
  );
  const sessions = new Map([[SID, { meta: { sid: SID, transcript_path: file } }]]);
  const sent: string[][] = [];
  const conn = {
    write: (line: string) => {
      const read = parseWith(EventTextSchema, line);
      if (read.ok) sent.push([...read.value.lines]);
    },
  };
  const subscribed = relaySubscribe(store, sessions, SID, conn);
  if (!subscribed.ok) throw new Error(subscribed.msg);
  return {
    file,
    store,
    sent,
    logged,
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
      relayPushed(t.store, SID, ["never-written-in-time"]);
      await ticks(2);
      expect(t.sent).toEqual([]);
      t.advance(RELAY_WAIT_MS);
      await ticks(3);
      expect(t.logged.some((m) => m.includes("gave up waiting"))).toBe(true);
      fs.appendFileSync(t.file, '{"uuid":"never-written-in-time"}\n');
      await ticks(3);
      // No wait is left, so nothing reads the file on its own.
      expect(t.sent).toEqual([]);
      relayPushed(t.store, SID, ["next"]);
      expect(t.sent).toEqual([['{"uuid":"never-written-in-time"}']]);
    } finally {
      stopAllRelays(t.store);
    }
  });

  // 何を保証するか: 待つ行が全部読めたら、読み直しをやめる。
  test("stops reading again once every pushed row is read", async () => {
    const t = setUp();
    try {
      relayPushed(t.store, SID, ["r1", "r2"]);
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
});
