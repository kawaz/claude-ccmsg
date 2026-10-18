// Async work one piece at a time, in the order handed over (serial.ts): what
// peer-inject's per-session order and send_message's arrival order stand on.
import { describe, expect, test } from "bun:test";
import { createKeyedSerial } from "../src/serial.ts";

describe("createKeyedSerial", () => {
  test("a task starts once the one handed over before it under its key has settled", async () => {
    const inTurn = createKeyedSerial<string>();
    const events: string[] = [];
    const first = Promise.withResolvers<void>();
    const a = inTurn("k", async () => {
      events.push("a starts");
      await first.promise;
      events.push("a ends");
      return "a";
    });
    const b = inTurn("k", async () => {
      events.push("b starts");
      return "b";
    });
    // b is behind a, so nothing of it runs while a waits; the round trip
    // through `other` orders this check after everything already queued.
    await inTurn("other", async () => {});
    expect(events).toEqual(["a starts"]);
    first.resolve();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(events).toEqual(["a starts", "a ends", "b starts"]);
  });

  test("a task that fails answers its failure and holds up nothing after it", async () => {
    const inTurn = createKeyedSerial<string>();
    const failing = inTurn("k", async () => {
      throw new Error("no");
    });
    const next = inTurn("k", async () => "next");
    expect(String(await failing.catch((e: unknown) => e))).toBe("Error: no");
    expect(await next).toBe("next");
  });

  test("tasks under different keys do not wait for each other", async () => {
    const inTurn = createKeyedSerial<string>();
    const held = Promise.withResolvers<void>();
    const slow = inTurn("a", () => held.promise.then(() => "a"));
    expect(await inTurn("b", async () => "b")).toBe("b");
    held.resolve();
    expect(await slow).toBe("a");
  });
});
