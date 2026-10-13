// The `ccmsg:` addresses a session is reached at (DR-0037 §1): what an agent
// writes as SendMessage's `to`, what `ccmsg peers` lists, and what the daemon
// resolves to the session runs it delivers to.
//
//   ccmsg:<sid>          every live run of that session
//   ccmsg:<sid>.<pid>    the one run of that session in harness process <pid>
//   ccmsg:path:<dir>     every session working in <dir> (an absolute path),
//                        the sender aside
//
// The hooks module bundles this file, so it imports nothing.

/** The namespace a session is addressed in. The direct envelope's `from` /
 * `from-name` carry the sender in it, so a recipient's answer goes back to
 * what it read there. */
export const DIRECT_ADDRESS_PREFIX = "ccmsg:";

/** What follows the prefix in an address naming a working directory. */
const PATH_PREFIX = "path:";

/** A session id as it may become part of a socket name: a separator in it
 * would name a file outside the directory. */
const SID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionIdShape(sid: string): boolean {
  return SID_SHAPE.test(sid);
}

/** One address, read. */
export type CcmsgAddress =
  | { kind: "session"; sid: string }
  | { kind: "run"; sid: string; pid: number }
  | { kind: "path"; dir: string };

/** `address` read, or undefined when it is not one of the three spellings: a
 * sid that is not a session id, a pid that is not a positive integer, or a
 * directory that is not absolute (a relative one would be read against the
 * daemon's working directory, not the sender's). */
export function parseCcmsgAddress(address: string): CcmsgAddress | undefined {
  if (!address.startsWith(DIRECT_ADDRESS_PREFIX)) return undefined;
  const rest = address.slice(DIRECT_ADDRESS_PREFIX.length);
  if (rest.startsWith(PATH_PREFIX)) {
    const dir = rest.slice(PATH_PREFIX.length);
    return dir.startsWith("/") ? { kind: "path", dir } : undefined;
  }
  const dot = rest.indexOf(".");
  if (dot === -1) return isSessionIdShape(rest) ? { kind: "session", sid: rest } : undefined;
  const sid = rest.slice(0, dot);
  const pidText = rest.slice(dot + 1);
  if (!isSessionIdShape(sid) || !/^[1-9][0-9]*$/.test(pidText)) return undefined;
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) ? { kind: "run", sid, pid } : undefined;
}

/** The address spelled out: the inverse of parseCcmsgAddress. */
export function formatCcmsgAddress(address: CcmsgAddress): string {
  switch (address.kind) {
    case "session":
      return `${DIRECT_ADDRESS_PREFIX}${address.sid}`;
    case "run":
      return `${DIRECT_ADDRESS_PREFIX}${address.sid}.${String(address.pid)}`;
    case "path":
      return `${DIRECT_ADDRESS_PREFIX}${PATH_PREFIX}${address.dir}`;
  }
}

/** The addresses one session is reached at, as `ccmsg peers` lists them:
 * `ccmsg:<sid>`; then, when it runs in more than one harness process,
 * `ccmsg:<sid>.<pid>` for each; then `ccmsg:path:<cwd>` when its working
 * directory is known. The last reaches every other session working there too. */
export function sessionAddresses(session: {
  sid: string;
  cwd: string;
  pids: readonly number[];
}): string[] {
  const pids = [...new Set(session.pids)].toSorted((a, b) => a - b);
  const runs = pids.length > 1 ? pids : [];
  return [
    formatCcmsgAddress({ kind: "session", sid: session.sid }),
    ...runs.map((pid) => formatCcmsgAddress({ kind: "run", sid: session.sid, pid })),
    ...(session.cwd !== "" ? [formatCcmsgAddress({ kind: "path", dir: session.cwd })] : []),
  ];
}
