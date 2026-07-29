import { describe, expect, test } from "bun:test";
import {
  emptyLineMapCache,
  mapLinesIncrementally,
  type LineMapCache,
} from "../src/client/incremental-line-map.ts";

/** Records which lines were actually recomputed, so a test can assert reuse
 * rather than just that the output is correct (an implementation that reuses
 * nothing still produces the right values). */
function tracker() {
  const computed: string[] = [];
  return {
    computed,
    compute: (line: string) => {
      computed.push(line);
      return line.length;
    },
  };
}

const [a, b, c, d] = ["alpha", "bravo", "charlie", "delta"] as const;

function seeded(): LineMapCache<number> {
  return mapLinesIncrementally(emptyLineMapCache<number>(), [a, b], (line) => line.length);
}

describe("incremental per-line map", () => {
  test("computes every line on a cold cache", () => {
    const t = tracker();
    const cache = mapLinesIncrementally(emptyLineMapCache<number>(), [a, b], t.compute);
    expect(cache.values).toEqual([5, 5]);
    expect(t.computed).toEqual([a, b]);
  });

  test("a live-tail append only computes the appended lines", () => {
    const t = tracker();
    const next = mapLinesIncrementally(seeded(), [a, b, c, d], t.compute);
    expect(next.values).toEqual([5, 5, 7, 5]);
    expect(t.computed).toEqual([c, d]);
  });

  test("a load-older prepend only computes the prepended lines", () => {
    const t = tracker();
    const next = mapLinesIncrementally(seeded(), [c, d, a, b], t.compute);
    expect(next.values).toEqual([7, 5, 5, 5]);
    expect(t.computed).toEqual([c, d]);
  });

  test("a replace read of unchanged content still reuses", () => {
    const t = tracker();
    // A `mode:"replace"` re-read arrives as fresh string objects off the
    // socket. Lines are matched by content, not object identity, so a tail
    // that has not changed since the last read costs a comparison rather than
    // a re-parse. `compute` being pure is what makes that sound.
    const reread = ["alpha", "bravo"].map((s) => `${s}`);
    const next = mapLinesIncrementally(seeded(), reread, t.compute);
    expect(next.values).toEqual([5, 5]);
    expect(t.computed).toEqual([]);
  });

  test("an edit in the middle reuses both ends", () => {
    const t = tracker();
    const seed = mapLinesIncrementally(
      emptyLineMapCache<number>(),
      [a, b, c, d],
      (line) => line.length,
    );
    const next = mapLinesIncrementally(seed, [a, `${b}!`, c, d], t.compute);
    expect(next.values).toEqual([5, 6, 7, 5]);
    expect(t.computed).toEqual(["bravo!"]);
  });

  test("a line is never reused as both prefix and suffix when the window shrinks", () => {
    const t = tracker();
    const seed = mapLinesIncrementally(
      emptyLineMapCache<number>(),
      [a, b, c],
      (line) => line.length,
    );
    const next = mapLinesIncrementally(seed, [a], t.compute);
    expect(next.values).toEqual([5]);
    expect(t.computed).toEqual([]);
  });

  test("re-passing the identical array returns the same cache untouched", () => {
    const t = tracker();
    const seed = seeded();
    const next = mapLinesIncrementally(seed, seed.lines, t.compute);
    expect(next).toBe(seed);
    expect(t.computed).toEqual([]);
  });

  test("an emptied window keeps no values", () => {
    const t = tracker();
    const next = mapLinesIncrementally(seeded(), [], t.compute);
    expect(next.values).toEqual([]);
    expect(t.computed).toEqual([]);
  });
});
