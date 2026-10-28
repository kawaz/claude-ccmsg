// How the module asks the daemon for something (DR-0046): one `POST /op`
// over the daemon's `<state dir>/http.sock`, the request with the hello it is
// asked under, answered with the wire's reply. No process is started, and no
// daemon: one that is not running stays so (the session's start brings one
// up, `ccmsg sidecar begin`).
import * as v from "valibot";
import type { RequestInput } from "@ccmsg/protocol";
import {
  DAEMON_SOCKET,
  OP_HTTP_PATH,
  OP_HTTP_SOCKET,
  type OpBody,
  type OpHello,
  stateDirOf,
} from "@ccmsg/protocol/module-op";
import { errorText, jsonText, parseWith } from "@ccmsg/protocol/parse";
import { PROTOCOL_VERSION } from "@ccmsg/protocol/protocol-version";
import type { Engine } from "./engine.ts";

/** What came of asking:
 *
 * - `answered`: the daemon's reply, as text, for the caller to read with its
 *   op's reply schema (a refusal reads as ErrorResponse)
 * - `no_daemon`: no daemon's socket in the state dir; nothing went out
 * - `outdated`: a daemon's wire socket but no `http.sock`: a daemon from
 *   before this way in; nothing went out
 * - `unanswered`: the request may have gone out and no reply came back
 *   (the fetch rejected, or something other than the endpoint answered) */
export type DaemonOpOutcome =
  | { readonly kind: "answered"; readonly text: string }
  | { readonly kind: "no_daemon" }
  | { readonly kind: "outdated" }
  | { readonly kind: "unanswered"; readonly reason: string };

/** The part of the plugin's package.json the hello reads: the version the
 * plugin's `ccmsg version` prints. */
const PackageVersionTextSchema = jsonText(v.object({ version: v.string() }));

/** What the module says of who asks: the session it means, the plugin's
 * build and the wire's generation. The daemon names the session by the
 * process the request comes from (this Claude Code process) and checks the
 * id against it.
 *
 * Design rationale: the build's version is read from package.json rather
 * than bundled, so a release's bump leaves the bundle as it is. */
async function helloOf($: Engine, asked: string | undefined): Promise<OpHello> {
  const [sid, version] = await Promise.all([asked ?? $.session.id(), pluginVersion($)]);
  return {
    sid,
    protocol: PROTOCOL_VERSION,
    ...(version !== undefined ? { client_version: version } : {}),
  };
}

/** The plugin's version, or undefined when package.json does not say it. */
async function pluginVersion($: Engine): Promise<string | undefined> {
  try {
    const read = parseWith(
      PackageVersionTextSchema,
      await $.fs.read(`${$.plugin.root}/package.json`),
    );
    if (read.ok) return read.value.version;
    $.ui.log(`ccmsg: the plugin's version is not read: ${read.failure.summary}`, { to: "debug" });
  } catch (e) {
    $.ui.log(`ccmsg: the plugin's version is not read: ${errorText(e)}`, { to: "debug" });
  }
  return undefined;
}

/** Whether `path` is there; a check that fails says nothing either way. */
async function exists($: Engine, path: string): Promise<boolean | undefined> {
  try {
    return await $.fs.exists(path);
  } catch {
    return undefined;
  }
}

/** Ask the daemon `request`. Whatever comes of the request is an outcome;
 * it rejects only when the engine refuses what the hello is read from (the
 * environment, the session id).
 *
 * The wait is bounded by the host, which gives up on a fetch with no
 * complete answer after 30 s, and by the op's own deadlines in the daemon.
 * `timeoutMs` bounds it further for a caller that holds something up (a
 * prompt): past it the outcome is `unanswered`. `sid` is the session the
 * request is asked as when it is not the session's id now: a reply to a
 * request that came under an earlier id (/clear, /resume). It must stay well inside a
 * hook's 10 s budget, which a timer's wait may count against.
 *
 * The state dir is found from `HOME` unless CCMSG_STATE_DIR or
 * XDG_STATE_HOME names it; a process without HOME finds no socket, which is
 * `no_daemon`. */
export async function daemonOp(
  $: Engine,
  request: RequestInput,
  options: { readonly timeoutMs?: number; readonly sid?: string } = {},
): Promise<DaemonOpOutcome> {
  const [stateHome, xdgStateHome, home] = await Promise.all([
    $.env.get("CCMSG_STATE_DIR"),
    $.env.get("XDG_STATE_HOME"),
    $.env.get("HOME"),
  ]);
  const stateDir = stateDirOf(
    { CCMSG_STATE_DIR: stateHome, XDG_STATE_HOME: xdgStateHome },
    home ?? "",
  );
  const socketPath = `${stateDir}/${OP_HTTP_SOCKET}`;
  const body: OpBody = { ...request, hello: await helloOf($, options.sid) };
  const fetching = $.http.fetch(`http://ccmsg${OP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    socketPath,
  });
  let fetched: Awaited<typeof fetching>;
  try {
    const { timeoutMs } = options;
    if (timeoutMs === undefined) {
      fetched = await fetching;
    } else {
      let timer: { cancel(): void } | undefined;
      const late = new Promise<undefined>((resolve) => {
        timer = $.clock.after(timeoutMs, () => resolve(undefined));
      });
      const first = await Promise.race([fetching, late]).finally(() => timer?.cancel());
      // The fetch goes on to its end, which nothing reads (the race has
      // taken its rejection, if any).
      if (first === undefined) {
        return { kind: "unanswered", reason: `no reply within ${String(timeoutMs / 1000)} s` };
      }
      fetched = first;
    }
  } catch (error) {
    if ((await exists($, socketPath)) === false) {
      return (await exists($, `${stateDir}/${DAEMON_SOCKET}`)) === true
        ? { kind: "outdated" }
        : { kind: "no_daemon" };
    }
    return { kind: "unanswered", reason: errorText(error) };
  }
  // 400 is the endpoint refusing a body it cannot read, with a reply.
  if (fetched.status === 200 || fetched.status === 400)
    return { kind: "answered", text: fetched.text };
  return { kind: "unanswered", reason: `the socket answered HTTP ${String(fetched.status)}` };
}
