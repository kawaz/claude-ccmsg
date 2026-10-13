// The say records' memory (say-log.ts, DR-0036 §3): what is held, the read
// flag, and the bound. The wire side (who gets ev:"says", role gates, restart)
// is say.test.ts.
import { describe, expect, test } from "bun:test";
import { createSayLog } from "../src/say-log.ts";

function counter(): () => string {
  let n = 0;
  return () => `i/${++n}`;
}

describe("createSayLog", () => {
  // 何を保証するか: 記録は来た順に並び、未読で入る。read は当該 id だけを
  // 立て、二度目は "unchanged"、無い id は "missing" で区別できる (daemon は
  // missing を invalid_args にし、unchanged では push しない)。
  test("holds records in arrival order and marks one read by id", () => {
    const log = createSayLog(counter());
    const a = log.add("s1", "one", "t1");
    const b = log.add("s2", "two", "t2");
    expect(log.snapshot()).toEqual([
      { id: "i/1", sid: "s1", text: "one", ts: "t1", read: false },
      { id: "i/2", sid: "s2", text: "two", ts: "t2", read: false },
    ]);
    expect(log.markRead(a.id)).toBe("read");
    expect(log.markRead(a.id)).toBe("unchanged");
    expect(log.markRead("i/99")).toBe("missing");
    expect(log.snapshot().map((r) => [r.id, r.read])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
  });

  // 何を保証するか: daemon は何日も動くので記録には上限があり、超えた分は
  // 既読・未読を問わず古い方から落ちる。落ちた id への ack は "missing"。
  test("drops the oldest record once the limit is exceeded", () => {
    const log = createSayLog(counter(), 2);
    log.add("s1", "one", "t1");
    log.add("s1", "two", "t2");
    log.add("s1", "three", "t3");
    expect(log.snapshot().map((r) => r.text)).toEqual(["two", "three"]);
    expect(log.markRead("i/1")).toBe("missing");
  });
});
