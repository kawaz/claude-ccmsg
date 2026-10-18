// Async work run one piece at a time, in the order it was handed over: each
// piece starts once every piece handed over before it under the same key has
// settled, however it settled. Nothing but the pieces' own promises orders
// them.

/** Runs `task` after every task handed over before it under `key`, and
 * answers what `task` does. The place in line is taken when this is called,
 * not when it is awaited. */
export type KeyedSerial<K> = <T>(key: K, task: () => Promise<T>) => Promise<T>;

/** Runs `task` after every task handed over before it. */
export type Serial = <T>(task: () => Promise<T>) => Promise<T>;

export function createKeyedSerial<K>(): KeyedSerial<K> {
  // The last task in line per key, settled either way; a key whose line has
  // emptied is let go.
  const tails = new Map<K, Promise<void>>();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export function createSerial(): Serial {
  const keyed = createKeyedSerial<null>();
  return (task) => keyed(null, task);
}
