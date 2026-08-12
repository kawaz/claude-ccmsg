import { describe, expect, test } from "bun:test";
import { createNetworkWatch, type MonitorStop } from "../src/network-watch.ts";
import {
  createSessionWakeState,
  recordWoken,
  wakesForOnline,
  WAKE_TEXT,
} from "../src/session-wake.ts";

const quietLog = { info() {}, error() {} };

/** A watch whose event source and probe are both driven by the test: `fire()`
 * plays a routing message, `states` is the sequence the probe reports. */
function fakeWatch(states: boolean[], onOnline: () => void) {
  let fire!: () => void;
  let stopped = false;
  const probed: boolean[] = [];
  const watch = createNetworkWatch({
    log: quietLog,
    onOnline,
    debounceMs: 1,
    probeOnline: async () => {
      const next = states.shift() ?? false;
      probed.push(next);
      return next;
    },
    startMonitor: (onEvent): MonitorStop => {
      fire = onEvent;
      return () => {
        stopped = true;
      };
    },
  });
  return { watch, fire, probed, isStopped: () => stopped };
}

describe("network watch", () => {
  test("offline から online へ戻ったときだけ発火する", async () => {
    // 起動時が online でもそれは復旧ではない (初回 probe は状態を置くだけ)。
    let fired = 0;
    const f = fakeWatch([true, false, true], () => fired++);
    await f.watch.settled();
    expect(f.watch.online).toBe(true);
    expect(fired).toBe(0);

    f.fire();
    await f.watch.settled();
    expect(f.watch.online).toBe(false);
    expect(fired).toBe(0);

    f.fire();
    await f.watch.settled();
    expect(f.watch.online).toBe(true);
    expect(fired).toBe(1);
  });

  test("online のままの変化イベントでは発火しない", async () => {
    // 経路が入れ替わっただけの routing message で起こしに行かない。
    let fired = 0;
    const f = fakeWatch([true, true, true], () => fired++);
    await f.watch.settled();
    f.fire();
    await f.watch.settled();
    f.fire();
    await f.watch.settled();
    expect(fired).toBe(0);
  });

  test("連続した変化イベントは 1 回の probe にまとめる", async () => {
    // リンク復帰時は routing message が数ミリ秒間に何本も出る。
    const f = fakeWatch([false, true], () => {});
    await f.watch.settled();
    f.fire();
    f.fire();
    f.fire();
    await f.watch.settled();
    expect(f.probed).toEqual([false, true]);
  });

  test("stop 後は監視を止め、以降のイベントを無視する", async () => {
    let fired = 0;
    const f = fakeWatch([false, true], () => fired++);
    await f.watch.settled();
    f.watch.stop();
    expect(f.isStopped()).toBe(true);
    f.fire();
    await f.watch.settled();
    expect(fired).toBe(0);
  });

  test("monitor を張れない環境では inert になる", () => {
    // 非 macOS / route 不在。信号が無いことを黙って偽装しない。
    const watch = createNetworkWatch({
      log: quietLog,
      onOnline: () => {
        throw new Error("must not fire");
      },
      startMonitor: () => null,
    });
    expect(watch.enabled).toBe(false);
    expect(watch.online).toBeUndefined();
  });
});

describe("wake targets", () => {
  const err = (sid: string, timestamp: string, text = "API Error: 500") => ({
    sid,
    text,
    timestamp,
  });

  test("API エラーで止まっているセッションだけを対象にする", () => {
    const state = createSessionWakeState();
    const wakes = wakesForOnline(state, [err("A", "t1"), err("B", "t2")]);
    expect(wakes.map((w) => w.sid)).toEqual(["A", "B"]);
    expect(wakes[0]!.event).toEqual({ ev: "net_online", text: WAKE_TEXT, error_ts: "t1" });
    expect(wakesForOnline(state, [])).toEqual([]);
  });

  test("同じ停止に対しては 1 回しか通知しない", () => {
    // リンクがばたついても、同じ止まったターンを何度も突かない。
    const state = createSessionWakeState();
    for (const w of wakesForOnline(state, [err("A", "t1")])) recordWoken(state, w);
    expect(wakesForOnline(state, [err("A", "t1")])).toEqual([]);
  });

  test("同じセッションが別のエラーで止まり直したら再び通知する", () => {
    const state = createSessionWakeState();
    for (const w of wakesForOnline(state, [err("A", "t1")])) recordWoken(state, w);
    const again = wakesForOnline(state, [err("A", "t2")]);
    expect(again.map((w) => w.event.error_ts)).toEqual(["t2"]);
  });

  test("復帰したセッションは記録から落ちるので、次の停止で再び通知できる", () => {
    const state = createSessionWakeState();
    for (const w of wakesForOnline(state, [err("A", "t1")])) recordWoken(state, w);
    expect(wakesForOnline(state, [])).toEqual([]); // recovered / disconnected
    expect(wakesForOnline(state, [err("A", "t1")]).map((w) => w.sid)).toEqual(["A"]);
  });

  test("届けられなかった通知は未通知のまま残る", () => {
    // recordWoken を呼ぶのは実際に subscriber へ送れた時だけ。
    const state = createSessionWakeState();
    expect(wakesForOnline(state, [err("A", "t1")]).map((w) => w.sid)).toEqual(["A"]);
    expect(wakesForOnline(state, [err("A", "t1")]).map((w) => w.sid)).toEqual(["A"]);
  });
});
