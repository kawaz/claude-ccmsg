// How a long walk shares the event loop (event-loop.ts): it holds the loop
// for a slice of time, then hands it a turn (DR-0029 「長い走査は時間で譲る」).
// The slice is time, not bytes or entries: what one line or one entry costs
// varies by orders of magnitude, so only time bounds how long another
// client's delivery waits behind the walk.
import { describe, expect, test } from "bun:test";
import { TURN_SLICE_MS, turnSlice } from "../src/event-loop.ts";

describe("turnSlice", () => {
  // 何を保証するか: 走査が作られてから slice の時間を握るまでは spent() が
  // false、握った時点から true。境界ちょうど (経過 = slice) を含めて true にする
  // のは、slice を「これより長くは握らない」上限にするため (経過が slice に
  // 届いた行の後で譲る)。時計は差し替えて、実時間に依らずに決める。
  test("is spent once the walk has held the loop for the slice, and not before", () => {
    let now = 100;
    const slice = turnSlice(8, () => now);
    expect(slice.spent()).toBe(false);
    now = 107.9;
    expect(slice.spent()).toBe(false);
    now = 108;
    expect(slice.spent()).toBe(true);
  });

  // 何を保証するか: pass() は event loop を 1 周させる (setImmediate)。先に
  // 積まれていた別の仕事 (WS への配送、別の op) が、pass() が解ける前に走る。
  // microtask で済ませる (await Promise.resolve()) と IO と timer の callback を
  // 通さないので、ここで other が false のまま解けて落ちる。
  // 次の slice は pass() が解けた時から数える (譲る前に握っていた時間を持ち
  // 越さない)。
  test("pass hands the loop a turn, and the next slice starts when it returns", async () => {
    let now = 0;
    const slice = turnSlice(8, () => now);
    now = 20;
    expect(slice.spent()).toBe(true);
    let other = false;
    setImmediate(() => {
      other = true;
    });
    await slice.pass();
    expect(other).toBe(true);
    expect(slice.spent()).toBe(false);
    now = 28;
    expect(slice.spent()).toBe(true);
  });

  // 何を保証するか: slice を指定しない走査は TURN_SLICE_MS (DR-0029 で計測から
  // 決めた値) で譲る。
  test("the slice is TURN_SLICE_MS unless given", () => {
    let now = 0;
    const slice = turnSlice(undefined, () => now);
    now = TURN_SLICE_MS - 0.1;
    expect(slice.spent()).toBe(false);
    now = TURN_SLICE_MS;
    expect(slice.spent()).toBe(true);
  });
});
