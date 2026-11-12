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
  /** A store on a clock the test moves, counting its changes. */
  function store() {
    const clock = manualClock();
    const counted = { changes: 0 };
    const secrets = createSecretStore(() => counted.changes++, clock, ids());
    return { clock, counted, secrets };
  }

  test("a seated secret is held for SECRET_TTL_MS, taken any number of times until then, then forgotten", () => {
    const { clock, counted, secrets } = store();
    const put = secrets.stage("s1", new SecretValue(VALUE));
    expect(put).toEqual({ id: "id-1", chars: codePointCount(VALUE) });
    secrets.seat(put.id);
    expect(secrets.list()).toEqual([
      {
        session_id: "s1",
        received_at: clock.now(),
        expires_at: clock.now() + SECRET_TTL_MS,
        chars: codePointCount(VALUE),
      },
    ]);
    expect(counted.changes).toBe(1);

    clock.advance(SECRET_TTL_MS - 1);
    expect(secrets.take(put.id)?.reveal()).toBe(VALUE);
    expect(secrets.take(put.id)?.reveal()).toBe(VALUE);

    clock.advance(1);
    expect(secrets.take(put.id)).toBeUndefined();
    expect(secrets.list()).toEqual([]);
    expect(counted.changes).toBe(2);
  });

  // DR-0052 §4: the session told may take it before its notice's outcome.
  test("a staged secret can be taken before it is seated, and is not listed until then", () => {
    const { counted, secrets } = store();
    const put = secrets.stage("s1", new SecretValue(VALUE));
    expect(secrets.take(put.id)?.reveal()).toBe(VALUE);
    expect(secrets.list()).toEqual([]);
    expect(counted.changes).toBe(0);
  });

  test("seating a new secret of a session replaces the old: the old id is of no use, and the time starts again", () => {
    const { clock, secrets } = store();
    const old = secrets.stage("s1", new SecretValue("old"));
    secrets.seat(old.id);
    clock.advance(60_000);
    const next = secrets.stage("s1", new SecretValue("new"));
    secrets.seat(next.id);
    expect(secrets.take(old.id)).toBeUndefined();
    expect(secrets.take(next.id)?.reveal()).toBe("new");
    expect(secrets.list().map((s) => s.expires_at)).toEqual([clock.now() + SECRET_TTL_MS]);
    // The old one's expiry, when it comes, takes nothing of the new one.
    clock.advance(SECRET_TTL_MS - 60_000);
    expect(secrets.take(next.id)?.reveal()).toBe("new");
  });

  test("dropping a staged secret leaves the session's seated one as it was", () => {
    const { secrets } = store();
    const held = secrets.stage("s1", new SecretValue("held"));
    secrets.seat(held.id);
    const failed = secrets.stage("s1", new SecretValue("failed"));
    secrets.drop(failed.id);
    expect(secrets.take(failed.id)).toBeUndefined();
    expect(secrets.take(held.id)?.reveal()).toBe("held");
    expect(secrets.list()).toHaveLength(1);
  });

  test("discard drops the session's seated secret; a session with none is false", () => {
    const { secrets } = store();
    const a = secrets.stage("s1", new SecretValue("a"));
    secrets.seat(a.id);
    const b = secrets.stage("s2", new SecretValue("b"));
    secrets.seat(b.id);
    expect(secrets.discard("s1")).toBe(true);
    expect(secrets.discard("s1")).toBe(false);
    expect(secrets.take(a.id)).toBeUndefined();
    expect(secrets.list().map((s) => s.session_id)).toEqual(["s2"]);
  });

  test("stop forgets every secret", () => {
    const { secrets } = store();
    const put = secrets.stage("s1", new SecretValue(VALUE));
    secrets.seat(put.id);
    secrets.stop();
    expect(secrets.take(put.id)).toBeUndefined();
    expect(secrets.list()).toEqual([]);
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
