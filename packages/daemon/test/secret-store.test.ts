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
    let changes = 0;
    const store = createSecretStore(() => changes++, clock, ids());
    const put = store.put("s1", new SecretValue(VALUE));
    expect(put.listed).toEqual({
      key: "id-2",
      session_id: "s1",
      received_at: clock.now(),
      expires_at: clock.now() + SECRET_TTL_MS,
      chars: codePointCount(VALUE),
    });
    expect(changes).toBe(1);

    clock.advance(SECRET_TTL_MS - 1);
    expect(store.take(put.id)?.value.reveal()).toBe(VALUE);
    expect(store.take(put.id)?.value.reveal()).toBe(VALUE);
    expect(store.list()).toHaveLength(1);

    clock.advance(1);
    expect(store.take(put.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(changes).toBe(2);
  });

  test("discard by the listed key and drop by the id forget a secret at once; an unknown key is false", () => {
    const clock = manualClock();
    let changes = 0;
    const store = createSecretStore(() => changes++, clock, ids());
    const a = store.put("s1", new SecretValue("a"));
    const b = store.put("s2", new SecretValue("b"));
    expect(store.list().map((s) => s.session_id)).toEqual(["s1", "s2"]);

    expect(store.discard(a.listed.key)).toBe(true);
    expect(store.discard(a.listed.key)).toBe(false);
    expect(store.discard(a.id)).toBe(false);
    store.drop(b.id);
    expect(store.list()).toEqual([]);
    expect(changes).toBe(4);
    // Their expiries were cancelled with them: nothing changes later.
    clock.advance(SECRET_TTL_MS);
    expect(changes).toBe(4);
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
