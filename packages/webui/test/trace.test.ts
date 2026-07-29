// ブラウザ側のレイテンシトレース収集。ws_receive → store_dispatch → dom_commit を
// (sid, start, end) で束ね、報告するかどうかを決める部分の単体テスト。
import { describe, expect, test } from "bun:test";
import type { ClientTraceRequest } from "@ccmsg/protocol";
import {
  createTraceCollector,
  HEALTHY_SAMPLE_EVERY,
  shouldReportTrace,
  SLOW_DELIVERY_MS,
} from "../src/client/trace.ts";

/** 時刻を明示的に進めながら collector を駆動するためのハーネス。 */
function harness(opts: { slowMs?: number; sampleEvery?: number } = {}) {
  const posted: ClientTraceRequest[] = [];
  let clock = 1_000_000;
  const collector = createTraceCollector({
    post: (req) => posted.push(req),
    now: () => clock,
    ...opts,
  });
  return {
    posted,
    collector,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("shouldReportTrace", () => {
  // 遅い配信こそがこの計器の存在理由なので、サンプリングで落としてはいけない。
  test("閾値を超えた配信は seq に関係なく必ず報告する", () => {
    expect(shouldReportTrace(SLOW_DELIVERY_MS + 1, 7)).toBe(true);
    expect(shouldReportTrace(5000, 13)).toBe(true);
  });

  // 境界: 「超えた」ときだけ全件対象。ちょうど 1000ms は健全側の間引きに従う。
  test("閾値ちょうどは全件対象にせず通常の間引きに従う", () => {
    expect(shouldReportTrace(SLOW_DELIVERY_MS, 1)).toBe(false);
    expect(shouldReportTrace(SLOW_DELIVERY_MS, 0)).toBe(true); // 0 は間引きの当たり番
  });

  // 健全時は 1/20。比較用の分布は要るが、毎件 WS 往復を足すと観測対象を歪める。
  test("健全な配信は sampleEvery 件に 1 件だけ報告する", () => {
    const reported = [];
    for (let seq = 0; seq < HEALTHY_SAMPLE_EVERY * 3; seq++) {
      if (shouldReportTrace(10, seq)) reported.push(seq);
    }
    expect(reported).toEqual([0, HEALTHY_SAMPLE_EVERY, HEALTHY_SAMPLE_EVERY * 2]);
  });
});

describe("createTraceCollector", () => {
  // 1 配信の全境界が 1 バッチに揃い、相関キー (sid,start,end) が daemon 側の
  // wire_write 行とそのまま突き合わせられること。
  test("3 つの境界を 1 バッチにまとめて報告する", () => {
    const h = harness({ sampleEvery: 1 });
    h.collector.noteWsReceive("s1", 100, 200, 200);
    h.advance(5);
    h.collector.noteStoreDispatch("s1", 200);
    h.advance(20);
    h.collector.noteDomCommit("s1", 200);

    expect(h.posted).toHaveLength(1);
    const req = h.posted[0]!;
    expect(req.op).toBe("client_trace");
    expect([req.sid, req.start, req.end, req.size]).toEqual(["s1", 100, 200, 200]);
    expect(req.elapsed_ms).toBe(25);
    expect(req.points.map((p) => p.kind)).toEqual(["ws_receive", "store_dispatch", "dom_commit"]);
    expect(req.points.every((p) => p.comp === "webui")).toBe(true);
    expect(h.collector.pendingCount()).toBe(0);
  });

  // レンダラは連続 tail を 1 コミットに畳む。end は累積オフセットなので、
  // その値以下の未完了配信はすべて同じコミット時刻で閉じる (取りこぼし防止)。
  test("1 回の DOM コミットが、その位置までの未完了配信をすべて閉じる", () => {
    const h = harness({ sampleEvery: 1 });
    h.collector.noteWsReceive("s1", 0, 100, 100);
    h.advance(10);
    h.collector.noteWsReceive("s1", 100, 250, 250);
    h.advance(10);
    h.collector.noteDomCommit("s1", 250);

    expect(h.posted.map((r) => r.end)).toEqual([100, 250]);
    expect(h.posted[0]!.elapsed_ms).toBe(20);
    expect(h.posted[1]!.elapsed_ms).toBe(10);
    expect(h.collector.pendingCount()).toBe(0);
  });

  // まだ描画されていない先の配信を、手前のコミットで閉じてはいけない
  // (閉じると「速かった」と誤記録される)。
  test("コミット位置より先の配信は未完了のまま残す", () => {
    const h = harness({ sampleEvery: 1 });
    h.collector.noteWsReceive("s1", 0, 100, 100);
    h.collector.noteWsReceive("s1", 100, 250, 250);
    h.collector.noteDomCommit("s1", 100);

    expect(h.posted.map((r) => r.end)).toEqual([100]);
    expect(h.collector.pendingCount()).toBe(1);
  });

  // 別セッションの Timeline のコミットが、こちらの配信を閉じない。
  test("sid が違う配信は閉じない", () => {
    const h = harness({ sampleEvery: 1 });
    h.collector.noteWsReceive("s1", 0, 100, 100);
    h.collector.noteDomCommit("s2", 999);

    expect(h.posted).toHaveLength(0);
    expect(h.collector.pendingCount()).toBe(1);
  });

  test("遅い配信は間引き対象でも必ず報告される", () => {
    const h = harness({ sampleEvery: 1000, slowMs: 100 });
    h.collector.noteWsReceive("s1", 0, 100, 100);
    h.advance(101);
    h.collector.noteDomCommit("s1", 100);

    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.sampled).toBe(true);
    expect(h.posted[0]!.elapsed_ms).toBe(101);
  });

  test("健全な配信は間引かれ、報告されない", () => {
    const h = harness({ sampleEvery: 1000, slowMs: 100 });
    for (let i = 1; i <= 5; i++) {
      h.collector.noteWsReceive("s1", i * 10, i * 10 + 10, i * 10 + 10);
      h.collector.noteDomCommit("s1", i * 10 + 10);
    }
    // seq 0 は当たり番なので 1 件だけ通り、残り 4 件は間引かれる
    expect(h.posted).toHaveLength(1);
  });

  // 非表示 / アンマウント中の Timeline は永久にコミットしないため、
  // 未完了エントリが無制限に溜まらないことを確認する。
  test("コミットが来ない配信が溜まっても上限で頭打ちになる", () => {
    const h = harness({ sampleEvery: 1 });
    for (let i = 0; i < 500; i++) h.collector.noteWsReceive("s1", i, i + 1, i + 1);
    expect(h.collector.pendingCount()).toBeLessThanOrEqual(64);
  });

  // store_dispatch だけ届かない (reducer が握り潰した等) 場合でも、
  // 残る 2 点で「受信 → DOM」の全体像は残す。
  test("store_dispatch を欠いても報告は落とさない", () => {
    const h = harness({ sampleEvery: 1 });
    h.collector.noteWsReceive("s1", 0, 100, 100);
    h.collector.noteDomCommit("s1", 100);
    expect(h.posted[0]!.points.map((p) => p.kind)).toEqual(["ws_receive", "dom_commit"]);
  });

  // 対応する ws_receive を持たないコミット (静的ロード直後など) は無視する。
  test("未知の配信に対する store_dispatch / dom_commit は何もしない", () => {
    const h = harness({ sampleEvery: 1 });
    expect(() => {
      h.collector.noteStoreDispatch("s1", 100);
      h.collector.noteDomCommit("s1", 100);
    }).not.toThrow();
    expect(h.posted).toHaveLength(0);
  });
});
