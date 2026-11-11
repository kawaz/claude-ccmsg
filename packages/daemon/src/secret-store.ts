// The secrets the person handed to sessions from the webui, held in memory
// for a while each (DR-0052 §4). Nothing of it is written anywhere: a daemon
// that stops forgets them.
import { SECRET_TTL_MS } from "@ccmsg/protocol";

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
  readonly value: SecretValue;
  readonly timer: SecretTimer;
}

/** A secret just handed in: its id (what the notice names) and its length in
 * Unicode code points (what the webui says of it). */
export interface PutSecret {
  readonly id: string;
  readonly chars: number;
}

export interface SecretStore {
  /** Hold `value` until SECRET_TTL_MS from now. */
  put(value: SecretValue): PutSecret;
  /** The value held under `id`, or undefined when none is (expired, dropped,
   * never issued). Taking does not drop it. */
  take(id: string): SecretValue | undefined;
  /** Drop the secret held under `id` (its notice did not arrive). */
  drop(id: string): void;
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
  const drop = (id: string): void => {
    byId.get(id)?.timer.cancel();
    byId.delete(id);
  };
  return {
    put(value) {
      const id = newId();
      byId.set(id, { value, timer: clock.after(SECRET_TTL_MS, () => drop(id)) });
      return { id, chars: codePointCount(value.reveal()) };
    },
    take(id) {
      return byId.get(id)?.value;
    },
    drop,
    stop() {
      for (const held of byId.values()) held.timer.cancel();
      byId.clear();
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
