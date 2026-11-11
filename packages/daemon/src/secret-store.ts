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
  readonly id: string;
  readonly value: SecretValue;
  readonly listed: HeldSecret;
  readonly timer: SecretTimer;
}

/** A secret just handed in: its id (what the notice names) and how the
 * webui lists it. */
export interface PutSecret {
  readonly id: string;
  readonly listed: HeldSecret;
}

export interface SecretStore {
  /** Hold `value` for session `sid` until SECRET_TTL_MS from now. */
  put(sid: string, value: SecretValue): PutSecret;
  /** The value held under `id` and how it is listed, or undefined when none
   * is (expired, discarded, never issued). Taking does not drop it. */
  take(id: string): { readonly value: SecretValue; readonly listed: HeldSecret } | undefined;
  /** Drop the secret listed as `key`; false when none is. */
  discard(key: string): boolean;
  /** Drop the secret held under `id` (its notice did not arrive). */
  drop(id: string): void;
  /** Every secret held, oldest first, as the webui lists them. */
  list(): HeldSecret[];
  /** Drop everything and stop the expiries. */
  stop(): void;
}

/** The length of `text` in Unicode code points, as the list shows it. */
export function codePointCount(text: string): number {
  return Array.from(text).length;
}

/** A store that calls `changed` after each change of what it holds (put,
 * discard, drop, expiry), for the push of the list. */
export function createSecretStore(
  changed: () => void,
  clock: SecretClock = realSecretClock,
  newId: () => string = () => crypto.randomUUID(),
): SecretStore {
  const byId = new Map<string, Held>();
  const remove = (held: Held): void => {
    held.timer.cancel();
    byId.delete(held.id);
    changed();
  };
  return {
    put(sid, value) {
      const id = newId();
      const receivedAt = clock.now();
      const listed: HeldSecret = {
        key: newId(),
        session_id: sid,
        received_at: receivedAt,
        expires_at: receivedAt + SECRET_TTL_MS,
        chars: codePointCount(value.reveal()),
      };
      const timer = clock.after(SECRET_TTL_MS, () => {
        const held = byId.get(id);
        if (held !== undefined) remove(held);
      });
      byId.set(id, { id, value, listed, timer });
      changed();
      return { id, listed };
    },
    take(id) {
      return byId.get(id);
    },
    discard(key) {
      for (const held of byId.values()) {
        if (held.listed.key !== key) continue;
        remove(held);
        return true;
      }
      return false;
    },
    drop(id) {
      const held = byId.get(id);
      if (held !== undefined) remove(held);
    },
    list() {
      return [...byId.values()].map((held) => held.listed);
    },
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
