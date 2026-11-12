// The secrets the person handed to sessions from the webui, held in memory
// for a while each (DR-0052 §4). Nothing of it is written anywhere: a daemon
// that stops forgets them.
import { type HeldSecret, SECRET_TTL_MS } from "@ccmsg/protocol";

/** What a secret's value shows as wherever it is made into text. */
export const SECRET_REDACTED = "[secret]";

/** A secret's value as the daemon holds it (DR-0052 §8): every way of making
 * it into text (`String()`, a template string, `JSON.stringify`,
 * `Bun.inspect` / `console.log`) gives `[secret]`. The value itself comes out
 * only through `reveal`, which the reply to `secret_take` calls. */
export class SecretValue {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  /** The value as it was handed in. */
  reveal(): string {
    return this.#text;
  }

  toString(): string {
    return SECRET_REDACTED;
  }

  toJSON(): string {
    return SECRET_REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return SECRET_REDACTED;
  }
}

/** A timer that can be cancelled. */
export interface SecretTimer {
  cancel(): void;
}

/** What the store reads the time from and runs its expiries on, so a test
 * moves time instead of waiting it out. */
export interface SecretClock {
  now(): number;
  /** Run `fire` once after `ms`, without keeping the process alive. */
  after(ms: number, fire: () => void): SecretTimer;
}

export const realSecretClock: SecretClock = {
  now: Date.now,
  after(ms, fire) {
    const timer = setTimeout(fire, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

interface Held {
  readonly sid: string;
  readonly value: SecretValue;
  /** When it expires, on the store's clock. */
  readonly expiresAt: number;
  readonly chars: number;
  readonly timer: SecretTimer;
}

/** A secret just handed in: its id (what the notice names) and its length in
 * Unicode code points (what the webui says of it). */
export interface PutSecret {
  readonly id: string;
  readonly chars: number;
}

/** One seat a session (DR-0052 §4). A value handed in is staged under its
 * id at once, so it can be taken while its notice is on its way, and the
 * session's seated value stays takeable meanwhile too; once the notice comes
 * to its outcome the new one is either seated (it replaces what the session
 * held, whose id is then of no use) or dropped (the session keeps what it
 * held). */
export interface SecretStore {
  /** Hold `value` for session `sid` under a fresh id, until SECRET_TTL_MS
   * from now, without taking the session's seat yet. */
  stage(sid: string, value: SecretValue): PutSecret;
  /** Seat the staged `id` as its session's secret, dropping the one it
   * replaces. */
  seat(id: string): void;
  /** Drop the staged `id` (its notice did not arrive). */
  drop(id: string): void;
  /** The value held under `id`, or undefined when none is (expired,
   * replaced, discarded, dropped, never issued). Taking does not drop it. */
  take(id: string): SecretValue | undefined;
  /** Drop the secret seated for session `sid`; false when none is. */
  discard(sid: string): boolean;
  /** The secret seated for session `sid` as the webui counts it down (the
   * milliseconds left now, its length), or undefined when none is. */
  status(sid: string): HeldSecret | undefined;
  /** Drop everything and stop the expiries. */
  stop(): void;
}

/** The length of `text` in Unicode code points. */
export function codePointCount(text: string): number {
  return Array.from(text).length;
}

export function createSecretStore(
  clock: SecretClock = realSecretClock,
  newId: () => string = () => crypto.randomUUID(),
): SecretStore {
  const byId = new Map<string, Held>();
  /** The seated id of each session. */
  const seats = new Map<string, string>();
  const forget = (id: string): void => {
    const held = byId.get(id);
    if (held === undefined) return;
    held.timer.cancel();
    byId.delete(id);
    if (seats.get(held.sid) === id) seats.delete(held.sid);
  };
  return {
    stage(sid, value) {
      const id = newId();
      const chars = codePointCount(value.reveal());
      byId.set(id, {
        sid,
        value,
        expiresAt: clock.now() + SECRET_TTL_MS,
        chars,
        timer: clock.after(SECRET_TTL_MS, () => forget(id)),
      });
      return { id, chars };
    },
    seat(id) {
      const held = byId.get(id);
      if (held === undefined) return;
      const replaced = seats.get(held.sid);
      if (replaced !== undefined && replaced !== id) forget(replaced);
      seats.set(held.sid, id);
    },
    drop: forget,
    take(id) {
      return byId.get(id)?.value;
    },
    discard(sid) {
      const id = seats.get(sid);
      if (id === undefined) return false;
      forget(id);
      return true;
    },
    status(sid) {
      const id = seats.get(sid);
      const held = id === undefined ? undefined : byId.get(id);
      if (held === undefined) return undefined;
      return { ttl_ms: Math.max(0, held.expiresAt - clock.now()), chars: held.chars };
    },
    stop() {
      for (const held of byId.values()) held.timer.cancel();
      byId.clear();
      seats.clear();
    },
  };
}

/** The notice the session gets when a secret is handed to it (DR-0052 §5):
 * the first line as kawaz wrote it, the second the command with the id. */
export function secretNoticeText(id: string): string {
  return (
    "ユーザからシークレットを受け取りました (5分有効) 。値は表示せずパイプで利用してください。\n" +
    `ccmsg secret take ${id} | <コマンド>`
  );
}
