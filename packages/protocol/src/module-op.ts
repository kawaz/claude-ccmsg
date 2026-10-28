// How a hooks module asks the daemon for something (DR-0046): one HTTP
// request, `POST /op` over the daemon's `<state dir>/http.sock`, whose body is
// a request of the wire with the `hello` it is asked under, and whose answer
// is the wire's reply to it.
//
// The hooks module bundles this file, so it imports nothing at run time.
import type { RequestInput } from "./request.ts";

/** The socket the daemon speaks the wire on, in the state dir. */
export const DAEMON_SOCKET = "daemon.sock";

/** The socket the daemon answers `POST /op` on, beside DAEMON_SOCKET. Not
 * longer than it, so a state dir that takes that socket takes this one. */
export const OP_HTTP_SOCKET = "http.sock";

/** The one path of the socket. */
export const OP_HTTP_PATH = "/op";

/** What a request says of who asks, besides the process it comes from (the
 * daemon names the session by that process): the session id it means, which
 * the daemon checks against the process's, the build that asks, and the
 * wire's generation. */
export interface OpHello {
  readonly sid: string;
  readonly client_version?: string;
  readonly protocol?: number;
}

/** The body of `POST /op`: a request of the wire (no `request_id`, which the
 * daemon gives it) and what it says of who asks. */
export type OpBody = RequestInput & { readonly hello: OpHello };

/** The variables the state dir is found from. An empty value is as unset. */
export interface StateDirEnv {
  readonly CCMSG_STATE_DIR?: string | undefined;
  readonly XDG_STATE_HOME?: string | undefined;
}

/** The daemon's state dir (DR-0002 §1) for `env`, with `home` as the user's
 * home directory: `$CCMSG_STATE_DIR`, or `ccmsg` under
 * `${XDG_STATE_HOME:-<home>/.local/state}`. The daemon binds its sockets
 * there and a hooks module, which has no `node:path`, finds them there, by
 * this one rule. */
export function stateDirOf(env: StateDirEnv, home: string): string {
  if (env.CCMSG_STATE_DIR) return env.CCMSG_STATE_DIR;
  const base = env.XDG_STATE_HOME || `${home.replace(/\/+$/u, "")}/.local/state`;
  return `${base.replace(/\/+$/u, "")}/ccmsg`;
}
