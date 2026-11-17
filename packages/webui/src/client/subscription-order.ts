// The order one connection's subscribe / unsubscribe of a per-sid stream go out
// in (transcript_subscribe / _unsubscribe, session_status_subscribe /
// _unsubscribe).
//
// The daemon keeps such a subscription per connection as a set: a subscribe
// of a sid the connection already follows changes nothing (beyond re-checking
// what a status fold is built from), and an unsubscribe drops the sid whoever
// on this connection asked for it. It also answers a connection's requests
// concurrently, so two of these in flight for the same sid can be acted on in
// either order. What the connection ends up following is therefore decided by
// the order the requests are acted on, and only this client sees every caller
// of that one connection, so the order is kept here rather than by each
// caller:
//
// - a request for a sid is written only once the previous one for that sid has
//   been answered (or failed), so the daemon acts on them in the order they
//   were made. A subscribe of a sid with nothing in flight is written at once;
// - an unsubscribe is written no earlier than after the promise jobs already
//   queued, and one still waiting for its turn when a subscribe of the same
//   sid is made is never written. Unsubscribe-then-subscribe leaves the
//   connection following the sid, which the subscribe alone also does — and
//   writing both would make the daemon drop the stream when its last
//   subscriber left and set it up again (for a status fold, by scanning the
//   whole transcript). The wait is what lets a Preact effect's cleanup and its
//   re-run, which happen in one commit, collapse into the re-run's subscribe.

/** The two requests of one subscription, as sent on the wire. `Target` is
 * what one subscription follows: a sid, or a sid with more that tells apart
 * two streams of the same sid (an agent's Timeline beside the session's). */
export interface SubscriptionRequests<Sub, Unsub, Target = string> {
  subscribe(target: Target): Promise<Sub>;
  unsubscribe(target: Target): Promise<Unsub>;
  /** What an unsubscribe resolves with when a later subscribe of the same
   * target took its place before it was written: the caller's own hold on it
   * is released, though the connection goes on following it for the later
   * one. */
  superseded(target: Target): Unsub;
}

/** The ordered subscribe / unsubscribe of a stream (see the file comment).
 * The order is kept per `keyOf(target)`: the targets the daemon keeps as one
 * subscription share a key. */
export function orderSubscriptions<Sub, Unsub, Target = string>(
  requests: SubscriptionRequests<Sub, Unsub, Target>,
  keyOf: (target: Target) => string,
): Pick<SubscriptionRequests<Sub, Unsub, Target>, "subscribe" | "unsubscribe"> {
  interface Waiting {
    /** Set by a subscribe made while this unsubscribe was waiting. */
    superseded: boolean;
  }
  interface SidOrder {
    /** Settles when the latest request made for the target has been
     * answered; never rejects, so the next request waits on it either way. */
    last: Promise<void>;
    /** The unsubscribe that has not been written yet, if any. */
    waiting: Waiting | null;
  }
  /** Only the targets with a request made and not yet settled, by key. */
  const bySid = new Map<string, SidOrder>();

  /** Track `result` as the target's latest request. */
  function track<T>(key: string, order: SidOrder, result: Promise<T>): Promise<T> {
    const settled = result.then(
      () => {},
      () => {},
    );
    order.last = settled;
    void settled.then(() => {
      if (order.last === settled) bySid.delete(key);
    });
    return result;
  }

  function orderOf(key: string): SidOrder {
    const known = bySid.get(key);
    if (known) return known;
    const order: SidOrder = { last: Promise.resolve(), waiting: null };
    bySid.set(key, order);
    return order;
  }

  return {
    subscribe(target) {
      const key = keyOf(target);
      const known = bySid.get(key);
      if (!known) return track(key, orderOf(key), requests.subscribe(target));
      if (known.waiting) {
        known.waiting.superseded = true;
        known.waiting = null;
      }
      return track(
        key,
        known,
        known.last.then(() => requests.subscribe(target)),
      );
    },
    unsubscribe(target) {
      const key = keyOf(target);
      const order = orderOf(key);
      const waiting: Waiting = { superseded: false };
      order.waiting = waiting;
      return track(
        key,
        order,
        order.last.then(() => {
          if (waiting.superseded) return requests.superseded(target);
          if (order.waiting === waiting) order.waiting = null;
          return requests.unsubscribe(target);
        }),
      );
    },
  };
}
