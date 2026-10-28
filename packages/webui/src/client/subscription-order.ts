// The order one connection's subscribe / unsubscribe of a per-sid stream go out
// in (session_status_subscribe / _unsubscribe).
//
// The daemon keeps such a subscription per connection as a set: a subscribe
// of a sid the connection already follows changes nothing (beyond re-checking
// what the fold is built from), and an unsubscribe drops the sid whoever on
// this connection asked for it. It also answers a connection's requests
// concurrently, so two of these in flight for the same sid can be acted on in
// either order. What the connection ends up following is therefore decided by
// the order the requests are acted on, and only this client sees every caller
// of that one connection, so the order is kept here rather than by each
// caller:
//
// - a request for a sid is written only once the previous one for that sid has
//   been answered (or failed), so the daemon acts on them in the order they
//   were made;
// - an unsubscribe still waiting for its turn when a subscribe of the same sid
//   is made is never written. Unsubscribe-then-subscribe leaves the connection
//   following the sid, which the subscribe alone also does — and writing both
//   would make the daemon drop the fold when its last subscriber left and
//   rebuild it by scanning the whole transcript again.

/** The two requests of one per-sid subscription, as sent on the wire. */
export interface SubscriptionRequests<Sub, Unsub> {
  subscribe(sid: string): Promise<Sub>;
  unsubscribe(sid: string): Promise<Unsub>;
  /** What an unsubscribe resolves with when a later subscribe of the same sid
   * took its place before it was written: the caller's own hold on the sid is
   * released, though the connection goes on following it for the later one. */
  superseded(sid: string): Unsub;
}

/** The ordered subscribe / unsubscribe of a stream (see the file comment). */
export function orderSubscriptions<Sub, Unsub>(
  requests: SubscriptionRequests<Sub, Unsub>,
): Pick<SubscriptionRequests<Sub, Unsub>, "subscribe" | "unsubscribe"> {
  interface Waiting {
    /** Set by a subscribe made while this unsubscribe was waiting. */
    superseded: boolean;
  }
  interface SidOrder {
    /** Settles when the latest request made for the sid has been answered;
     * never rejects, so the next request waits on it either way. */
    last: Promise<void>;
    /** The unsubscribe that has not been written yet, if any. */
    waiting: Waiting | null;
  }
  const bySid = new Map<string, SidOrder>();

  function enqueue<T>(sid: string, order: SidOrder, run: () => Promise<T>): Promise<T> {
    const result = order.last.then(run);
    const settled = result.then(
      () => {},
      () => {},
    );
    order.last = settled;
    void settled.then(() => {
      if (order.last === settled) bySid.delete(sid);
    });
    return result;
  }

  function orderOf(sid: string): SidOrder {
    const known = bySid.get(sid);
    if (known) return known;
    const order: SidOrder = { last: Promise.resolve(), waiting: null };
    bySid.set(sid, order);
    return order;
  }

  return {
    subscribe(sid) {
      const order = orderOf(sid);
      if (order.waiting) {
        order.waiting.superseded = true;
        order.waiting = null;
      }
      return enqueue(sid, order, () => requests.subscribe(sid));
    },
    unsubscribe(sid) {
      const order = orderOf(sid);
      const waiting: Waiting = { superseded: false };
      order.waiting = waiting;
      return enqueue(sid, order, () => {
        if (waiting.superseded) return Promise.resolve(requests.superseded(sid));
        if (order.waiting === waiting) order.waiting = null;
        return requests.unsubscribe(sid);
      });
    },
  };
}
