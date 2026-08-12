// The fold open/closed state Timeline keeps outside its fold components, so
// that nav can open a fold whose body has never been rendered and so that the
// state outlives the component displaying it.
import { describe, expect, test } from "bun:test";
import { FoldOpenStore } from "../src/client/fold-open-store.ts";

describe("FoldOpenStore", () => {
  test("an untouched fold reports the caller's default", () => {
    const store = new FoldOpenStore();
    expect(store.isOpen("a", false)).toBe(false);
    expect(store.isOpen("a", true)).toBe(true);
  });

  test("an override wins over the default in both directions", () => {
    const store = new FoldOpenStore();
    store.set("a", true);
    expect(store.isOpen("a", false)).toBe(true);
    store.set("a", false);
    expect(store.isOpen("a", true)).toBe(false);
  });

  test("reset drops overrides so folds fall back to a changed default", () => {
    const store = new FoldOpenStore();
    store.set("a", false);
    store.reset();
    expect(store.isOpen("a", true)).toBe(true);
  });

  test("a body stays mounted after the fold is closed again", () => {
    // Re-closing must not discard what the reader can see inside: a translated
    // thinking segment, an item switched to jsonl.
    const store = new FoldOpenStore();
    expect(store.isBodyMounted("a")).toBe(false);
    store.set("a", true);
    store.set("a", false);
    expect(store.isBodyMounted("a")).toBe(true);
  });

  test("reset re-closes folds without discarding their bodies", () => {
    const store = new FoldOpenStore();
    store.set("a", true);
    store.reset();
    expect(store.isOpen("a", false)).toBe(false);
    expect(store.isBodyMounted("a")).toBe(true);
  });

  test("a fold that opened by default is latched too", () => {
    // Nothing calls set() on an auto-open group, so the component says so.
    const store = new FoldOpenStore();
    store.markMounted("a");
    expect(store.isBodyMounted("a")).toBe(true);
  });

  test("only the toggled fold's subscribers are notified", () => {
    // The whole point of per-key subscription: opening one fold must not
    // re-render the memoized rest of the timeline.
    const store = new FoldOpenStore();
    let a = 0;
    let b = 0;
    store.subscribe("a", () => (a += 1));
    store.subscribe("b", () => (b += 1));
    store.set("a", true);
    expect([a, b]).toEqual([1, 0]);
  });

  test("setting the state a fold is already in notifies no one", () => {
    const store = new FoldOpenStore();
    store.set("a", true);
    let calls = 0;
    store.subscribe("a", () => (calls += 1));
    store.set("a", true);
    expect(calls).toBe(0);
  });

  test("reset notifies every fold it changed, and nothing else", () => {
    const store = new FoldOpenStore();
    store.set("a", true);
    let a = 0;
    let untouched = 0;
    store.subscribe("a", () => (a += 1));
    store.subscribe("untouched", () => (untouched += 1));
    store.reset();
    expect([a, untouched]).toEqual([1, 0]);
    store.reset();
    expect(a).toBe(1);
  });

  test("unsubscribing stops the notifications", () => {
    const store = new FoldOpenStore();
    let calls = 0;
    const off = store.subscribe("a", () => (calls += 1));
    off();
    store.set("a", true);
    expect(calls).toBe(0);
  });

  test("the first mount of any body is announced once per fold", () => {
    // Nav that opened a fold resumes on this: the element it wants to scroll
    // to comes into existence with that render and not before.
    const store = new FoldOpenStore();
    let mounts = 0;
    store.subscribeMounted(() => (mounts += 1));
    store.set("a", true);
    store.set("a", false);
    store.set("a", true);
    expect(mounts).toBe(1);
    store.set("b", true);
    expect(mounts).toBe(2);
  });
});
