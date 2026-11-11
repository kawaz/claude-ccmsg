// The daemon's hold of the secrets (DR-0052 §4, §8), on a clock the test
// moves: a secret is held for five minutes and then forgotten, can be taken
// any number of times until then, and its value comes out as text only
// through `reveal`.
import { describe, expect, test } from "bun:test";
import { SECRET_TTL_MS } from "@ccmsg/protocol";
import {
  codePointCount,
  createSecretStore,
  SECRET_REDACTED,
  type SecretClock,
  SecretValue,
  secretNoticeText,
} from "../src/secret-store.ts";

const VALUE = "test-secret-0123\n";

/** A clock whose time moves only when the test says, running what falls due. */
function manualClock(): SecretClock & { advance(ms: number): void } {
  let now = 1_793_000_000_000;
  const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    after(ms, fire) {
      const timer = { at: now + ms, fire, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    advance(ms) {
      now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue;
        if (timer.at <= now) timer.fire();
        else timers.push(timer);
      }
    },
  };
}

function ids(): () => string {
  let n = 0;
  return () => `id-${String(++n)}`;
}

describe("SecretValue", () => {
  test("every way of making it into text gives [secret]; reveal gives the value", () => {
    const secret = new SecretValue(VALUE);
    expect(String(secret)).toBe(SECRET_REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${SECRET_REDACTED}"}`);
    expect(Bun.inspect(secret)).toBe(SECRET_REDACTED);
    expect(Bun.inspect({ secret })).not.toContain("test-secret");
    expect(secret.reveal()).toBe(VALUE);
  });
});

describe("createSecretStore", () => {
  test("a secret is held for SECRET_TTL_MS, taken any number of times until then, then forgotten", () => {
    const clock = manualClock();
    const store = createSecretStore(clock, ids());
    const put = store.put(new SecretValue(VALUE));
    expect(put).toEqual({ id: "id-1", chars: codePointCount(VALUE) });

    clock.advance(SECRET_TTL_MS - 1);
    expect(store.take(put.id)?.reveal()).toBe(VALUE);
    expect(store.take(put.id)?.reveal()).toBe(VALUE);

    clock.advance(1);
    expect(store.take(put.id)).toBeUndefined();
  });

  test("each secret has an id of its own; drop forgets one at once and leaves the others", () => {
    const clock = manualClock();
    const store = createSecretStore(clock, ids());
    const a = store.put(new SecretValue("a"));
    const b = store.put(new SecretValue("b"));
    expect(a.id).not.toBe(b.id);

    store.drop(a.id);
    expect(store.take(a.id)).toBeUndefined();
    expect(store.take(b.id)?.reveal()).toBe("b");
  });

  test("stop forgets every secret", () => {
    const store = createSecretStore(manualClock(), ids());
    const put = store.put(new SecretValue(VALUE));
    store.stop();
    expect(store.take(put.id)).toBeUndefined();
  });

  test("the length is counted in code points", () => {
    expect(codePointCount("鍵🔑a")).toBe(3);
  });
});

describe("secretNoticeText", () => {
  test("the first line as kawaz wrote it, the second the command with the id", () => {
    expect(secretNoticeText("ID")).toBe(
      "ユーザからシークレットを受け取りました (5分有効) 。値は表示せずパイプで利用してください。\nccmsg secret take ID | <コマンド>",
    );
  });
});
