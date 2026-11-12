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
  /** A store on a clock the test moves. */
  function store() {
    const clock = manualClock();
    return { clock, secrets: createSecretStore(clock, ids()) };
  }

  test("a secret is held for SECRET_TTL_MS, taken any number of times until then, then forgotten", () => {
    const { clock, secrets } = store();
    const put = secrets.put("s1", new SecretValue(VALUE));
    expect(put).toEqual({ id: "id-1", chars: codePointCount(VALUE) });
    expect(secrets.status("s1")).toEqual({ ttl_ms: SECRET_TTL_MS, chars: codePointCount(VALUE) });

    clock.advance(SECRET_TTL_MS - 1);
    expect(secrets.take(put.id)?.reveal()).toBe(VALUE);
    expect(secrets.take(put.id)?.reveal()).toBe(VALUE);
    expect(secrets.status("s1")?.ttl_ms).toBe(1);

    clock.advance(1);
    expect(secrets.take(put.id)).toBeUndefined();
    expect(secrets.status("s1")).toBeUndefined();
  });

  // DR-0052 §4: one seat a session, taken as the new one is handed in.
  test("a new secret of a session replaces the old at once: the old id is of no use, and the time starts again", () => {
    const { clock, secrets } = store();
    const old = secrets.put("s1", new SecretValue("old"));
    clock.advance(60_000);
    const next = secrets.put("s1", new SecretValue("newer"));
    expect(secrets.take(old.id)).toBeUndefined();
    expect(secrets.take(next.id)?.reveal()).toBe("newer");
    expect(secrets.status("s1")).toEqual({ ttl_ms: SECRET_TTL_MS, chars: 5 });
    // The old one's expiry, when it would have come, takes nothing of the new.
    clock.advance(SECRET_TTL_MS - 60_000);
    expect(secrets.take(next.id)?.reveal()).toBe("newer");
  });

  // DR-0052 §5: the notice did not arrive.
  test("dropping a secret empties the session's seat, and what it replaced does not come back", () => {
    const { secrets } = store();
    const old = secrets.put("s1", new SecretValue("old"));
    const failed = secrets.put("s1", new SecretValue("failed"));
    secrets.drop(failed.id);
    expect(secrets.take(failed.id)).toBeUndefined();
    expect(secrets.take(old.id)).toBeUndefined();
    expect(secrets.status("s1")).toBeUndefined();
  });

  test("discard drops the session's seated secret and no other's; a session with none is false", () => {
    const { secrets } = store();
    const a = secrets.put("s1", new SecretValue("a"));
    secrets.put("s2", new SecretValue("b"));
    expect(secrets.discard("s1")).toBe(true);
    expect(secrets.discard("s1")).toBe(false);
    expect(secrets.take(a.id)).toBeUndefined();
    expect(secrets.status("s1")).toBeUndefined();
    expect(secrets.status("s2")?.chars).toBe(1);
  });

  test("stop forgets every secret", () => {
    const { secrets } = store();
    const put = secrets.put("s1", new SecretValue(VALUE));
    secrets.stop();
    expect(secrets.take(put.id)).toBeUndefined();
    expect(secrets.status("s1")).toBeUndefined();
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
