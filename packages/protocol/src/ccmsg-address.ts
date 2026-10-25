// How a session is named in what ccmsg writes: a session id, and the
// `ccmsg:<sid>` an envelope's `from` carries its sender as (DR-0039 §3). The
// recipient tells a message sent through ccmsg from one sent another way by
// this prefix, and answers it with the `send` tool naming the sid after it.

/** The namespace an envelope's `from` / `from-name` carry the sender in. */
export const DIRECT_ADDRESS_PREFIX = "ccmsg:";

/** A session id as it may become part of a socket name: a separator in it
 * would name a file outside the directory. */
export const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionIdShape(sid: string): boolean {
  return SESSION_ID_SHAPE.test(sid);
}
