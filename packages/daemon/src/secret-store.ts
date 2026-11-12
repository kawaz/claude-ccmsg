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
  readonly listed: HeldSecret;
  readonly timer: SecretTimer;
}

/** A secret just handed in: its id (what the notice names) and its length in
 * Unicode code points (what the webui says of it). */
export interface PutSecret {
  readonly id: string;
  readonly chars: number;
}

/** One seat a session (DR-0052 §4). A value handed in is staged under its
 * id at once, so it can be taken while its notice is on its way; once the
 * notice comes to its outcome it is either seated (it replaces what the
 * session held, whose id is then of no use) or dropped (the session keeps
 * what it held). */
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
  /** The seated secret of each session that has one, as the webui shows
   * them. */
  list(): HeldSecret[];
  /** Drop everything and stop the expiries. */
  stop(): void;
}

/** The length of `text` in Unicode code points. */
export function codePointCount(text: string): number {
  return Array.from(text).length;
}

/** A store that calls `changed` after each change of the seats (a secret
 * seated, replaced, discarded or expired), for the push of the list. */
export function createSecretStore(
  changed: () => void,
  clock: SecretClock = realSecretClock,
  newId: () => string = () => crypto.randomUUID(),
): SecretStore {
  const byId = new Map<string, Held>();
  /** The seated id of each session. */
  const seats = new Map<string, string>();
  /** Forget `id`; true when it was its session's seat. */
  const forget = (id: string): boolean => {
    const held = byId.get(id);
    if (held === undefined) return false;
    held.timer.cancel();
    byId.delete(id);
    if (seats.get(held.sid) !== id) return false;
    seats.delete(held.sid);
    return true;
  };
  return {
    stage(sid, value) {
      const id = newId();
      const receivedAt = clock.now();
      const listed: HeldSecret = {
        session_id: sid,
        received_at: receivedAt,
        expires_at: receivedAt + SECRET_TTL_MS,
        chars: codePointCount(value.reveal()),
      };
      const timer = clock.after(SECRET_TTL_MS, () => {
        if (forget(id)) changed();
      });
      byId.set(id, { sid, value, listed, timer });
      return { id, chars: listed.chars };
    },
    seat(id) {
      const held = byId.get(id);
      if (held === undefined) return;
      const replaced = seats.get(held.sid);
      if (replaced === id) return;
      if (replaced !== undefined) forget(replaced);
      seats.set(held.sid, id);
      changed();
    },
    drop(id) {
      if (forget(id)) changed();
    },
    take(id) {
      return byId.get(id)?.value;
    },
    discard(sid) {
      const id = seats.get(sid);
      if (id === undefined) return false;
      forget(id);
      changed();
      return true;
    },
    list() {
      return [...seats.values()].flatMap((id) => {
        const held = byId.get(id);
        return held === undefined ? [] : [held.listed];
      });
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
