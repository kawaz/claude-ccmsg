// Insertion-ordered Map with a hard entry cap, for the webui's module-scope
// read-through caches (translated paragraphs, fetched ccmsg bodies, remembered
// scroll positions). Those caches all key off content the user happens to have
// looked at, which grows without bound over the lifetime of a tab that is
// never reloaded — a webui left open for days is the normal case here, so
// "the working set is small in practice" is not a bound.
//
// A JS Map already iterates in insertion order, so re-inserting a key on every
// write turns that order into recency: the first key `keys()` yields is the
// least recently written one, which is the one to drop.

/** Write `key` as the most recent entry and evict from the least recent end
 * until at most `limit` entries remain. Re-writing an existing key also
 * refreshes its recency, so a value that keeps being looked up and rewritten
 * survives; one that is only ever written once ages out. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
