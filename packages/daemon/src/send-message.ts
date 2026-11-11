// send_message and peer_list (DR-0039 §3): the `send` and `peers` tools of a
// session's hooks module. A send names its recipient by the session's id;
// the daemon finds it among the live session runs read afresh
// (session-runs.ts liveRuns, the same source for the send and the list, so
// what `peers` shows is what `send` reaches), and writes the envelope into
// the peer socket of each of its runs when it has a hooks module
// (peer-inject.ts). A send that names an agent id goes to that subagent or
// teammate of the session instead, through the session's module
// (agent-send.ts). A notice (notify, and
// the daemon's own wake) goes to one session by id the same way, the sender's
// own session included (DR-0039 §9). Nothing is held for a later attempt
// (DR-0036 §3).
import {
  type PeerListEntry,
  type PeerListInput,
  type SendMessageReason,
  type SendMessageResult,
  type PeerTarget,
  renderAddressedDelivery,
  type SessionInputReadiness,
} from "@ccmsg/protocol";
import type { SessionRun } from "./session-runs.ts";
import type { InjectFrame, InjectResult } from "./peer-inject.ts";
import type { Serial } from "./serial.ts";
import type { AgentSendOutcome } from "./agent-send.ts";

/** One session among the live runs: its runs, the name its record gives and
 * its directory as a realpath. */
interface Peer {
  sid: string;
  name?: string;
  cwd?: string;
  runs: SessionRun[];
}

export interface PeerDeps {
  /** The live runs of every session the daemon can deliver to. */
  runs(): Promise<SessionRun[]>;
  /** `dir` as a realpath, or undefined when it does not resolve. */
  realpath(dir: string): Promise<string | undefined>;
  /** Whether a live run of `sid` has a hooks module (its sidecar is named). */
  hasModule(sid: string): boolean;
}

/** What a notice needs to reach a session's conversation. */
export interface NoticeDeps extends PeerDeps {
  /** What the daemon knows of a session no live run serves. */
  readiness(sid: string): SessionInputReadiness;
  issueMid(): string;
  /** Delivers to one session in the order deliver was called for it. */
  deliver(run: SessionRun, frame: InjectFrame): Promise<InjectResult>;
  /** The line every send and notice stands in, from reading the runs to
   * asking for its deliveries: one daemon's share one. */
  inOrder: Serial;
  log(line: string): void;
}

export interface SendMessageDeps extends NoticeDeps {
  /** Send `text` from session `from` to the subagent or teammate `agentId`
   * of session `sid`, through its module (agent.send). */
  sendToAgent(sid: string, agentId: string, text: string, from: string): Promise<AgentSendOutcome>;
}

/** The sessions of `runs`, each once. */
async function peersOf(runs: readonly SessionRun[], deps: PeerDeps): Promise<Peer[]> {
  const bySid = new Map<string, SessionRun[]>();
  for (const run of runs) bySid.set(run.sid, [...(bySid.get(run.sid) ?? []), run]);
  return Promise.all(
    [...bySid].map(async ([sid, own]) => {
      const name = own.find((run) => run.name !== undefined)?.name;
      const dir = own.find((run) => run.cwd !== undefined)?.cwd;
      const cwd = dir !== undefined ? ((await deps.realpath(dir)) ?? dir) : undefined;
      return {
        sid,
        ...(name !== undefined ? { name } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        runs: own,
      };
    }),
  );
}

function spelled(peer: Peer): { sid: string; name?: string; cwd?: string } {
  return {
    sid: peer.sid,
    ...(peer.name !== undefined ? { name: peer.name } : {}),
    ...(peer.cwd !== undefined ? { cwd: peer.cwd } : {}),
  };
}

/** `prefix` as a realpath, keeping a trailing `/` (which says "under this
 * directory", not "a name starting so"); the text as given when it does not
 * resolve (a partial name). */
async function realPrefix(prefix: string, deps: PeerDeps): Promise<string> {
  const real = await deps.realpath(prefix);
  if (real === undefined) return prefix;
  return prefix.endsWith("/") && !real.endsWith("/") ? `${real}/` : real;
}

/** Whether a session working in `cwd` is under `prefix`: `cwd` starts with
 * it, or is the directory `prefix` names with its trailing `/`. */
function underPrefix(cwd: string, prefix: string): boolean {
  return cwd.startsWith(prefix) || `${cwd}/` === prefix;
}

/** The sessions a send could go to, those whose directory starts with
 * `cwd_prefix`. */
export async function listPeers(
  from: string,
  filter: PeerListInput,
  deps: PeerDeps,
): Promise<PeerListEntry[]> {
  const prefix =
    filter.cwd_prefix !== undefined ? await realPrefix(filter.cwd_prefix, deps) : undefined;
  const peers = (await peersOf(await deps.runs(), deps)).filter(
    (peer) => prefix === undefined || (peer.cwd !== undefined && underPrefix(peer.cwd, prefix)),
  );
  return peers
    .map((peer) => ({
      ...spelled(peer),
      module: deps.hasModule(peer.sid),
      self: peer.sid === from,
    }))
    .sort((a, b) => a.sid.localeCompare(b.sid));
}

/** Deliver `text` from session `from` to the session `to` names unless it is
 * the sender — or, given `agentId`, to that subagent or teammate of it, the
 * sender's own included — and say what came of it. */
export async function sendToPeers(
  message: { from: string; to: PeerTarget; agentId?: string; text: string },
  deps: SendMessageDeps,
): Promise<SendMessageResult[]> {
  // Matched and set going in the order the sends were asked for, so the
  // deliveries of a send asked for first are asked for first whatever its
  // reads take (deliver keeps that order from there on); the deliveries
  // themselves finish outside the line. Wrapped, because a promise resolved
  // with a promise would wait for it.
  const { results } = await deps.inOrder(async () => {
    const peer = (await peersOf(await deps.runs(), deps)).find(
      (p) => p.sid === message.to.session_id,
    );
    return { results: startSend(message, peer, deps) };
  });
  return await results;
}

/** Ask for every delivery the send to `peer`, the live session it names
 * (undefined when no live run serves it), calls for, all before the first
 * await. */
async function startSend(
  message: { from: string; to: PeerTarget; agentId?: string; text: string },
  peer: Peer | undefined,
  deps: SendMessageDeps,
): Promise<SendMessageResult[]> {
  const { from, to, agentId, text } = message;
  if (peer === undefined) {
    // A session no live run serves: say why. A send to the sender's own id
    // is not told as one to a session that ended.
    return to.session_id === from ? [] : [notRunning(to.session_id, deps)];
  }
  if (agentId !== undefined) return [await sendToAgentOf(peer, agentId, from, text, deps)];
  if (peer.sid === from) return [{ ...spelled(peer), outcome: "not_delivered", reason: "self" }];
  return [await sendToPeer(peer, from, text, "send_message", deps)];
}

/** What a session named by id that no live run serves is answered with. */
function notRunning(sid: string, deps: NoticeDeps): SendMessageResult {
  const kind = deps.readiness(sid).kind;
  return {
    sid,
    outcome: "not_delivered",
    reason: kind === "session_changed" ? "session_changed" : "ended",
  };
}

/** Put `text` from `from` into the conversation of session `sid`, in the
 * envelope a send's message comes in, and say what came of it (DR-0039 §9).
 * `from` is the sender's sid, or the word for a sender that is no session
 * (DIRECT_DELIVERY_DAEMON_SENDER); the session may be the sender's own. In
 * line with the sends, as a send's deliveries are. */
export async function sendNotice(
  notice: { from: string; sid: string; text: string },
  deps: NoticeDeps,
): Promise<SendMessageResult> {
  // Wrapped, as sendToPeers' results are.
  const { result } = await deps.inOrder(async () => {
    const peer = (await peersOf(await deps.runs(), deps)).find((p) => p.sid === notice.sid);
    return {
      result:
        peer !== undefined
          ? sendToPeer(peer, notice.from, notice.text, "notify", deps)
          : Promise.resolve(notRunning(notice.sid, deps)),
    };
  });
  return await result;
}

/** Send `text` to the agent `agentId` of `peer`. The agent's own session is
 * not the sender's self: its agents are other loops. */
async function sendToAgentOf(
  peer: Peer,
  agentId: string,
  from: string,
  text: string,
  deps: SendMessageDeps,
): Promise<SendMessageResult> {
  if (!deps.hasModule(peer.sid)) {
    return { ...spelled(peer), outcome: "not_delivered", reason: "no_module" };
  }
  const sent = await deps.sendToAgent(peer.sid, agentId, text, from);
  deps.log(
    `agent-send ${peer.sid} ${agentId} (send_message from ${from}): ${sent.outcome}` +
      (sent.outcome === "not_delivered" ? ` (${sent.reason})` : ""),
  );
  switch (sent.outcome) {
    case "delivered":
      return { ...spelled(peer), outcome: "delivered" };
    case "unconfirmed":
      return { ...spelled(peer), outcome: "unconfirmed" };
    case "not_delivered":
      return { ...spelled(peer), outcome: "not_delivered", reason: sent.reason };
  }
}

/** `op` names the request the delivery is for in the log. */
async function sendToPeer(
  peer: Peer,
  from: string,
  text: string,
  op: "send_message" | "notify",
  deps: NoticeDeps,
): Promise<SendMessageResult> {
  if (!deps.hasModule(peer.sid)) {
    return { ...spelled(peer), outcome: "not_delivered", reason: "no_module" };
  }
  // A mid per run: the refusal a run may answer names the mid it refuses,
  // and runs sharing one would take each other's.
  const delivered = await Promise.all(
    peer.runs.map(async (run) => {
      const mid = deps.issueMid();
      const content = renderAddressedDelivery({ mid, from, text });
      const result = await deps.deliver(run, { mid, content });
      deps.log(
        `peer-inject ${mid} -> ${run.sid}.${String(run.pid)} (${op}): ${result.outcome}` +
          (result.outcome === "unavailable"
            ? ` (${result.cause}${result.cause === "no_peer_socket" ? `: ${result.lookup}` : ""})`
            : ""),
      );
      return result;
    }),
  );
  if (delivered.some((r) => r.outcome === "delivered")) {
    return { ...spelled(peer), outcome: "delivered" };
  }
  if (delivered.some((r) => r.outcome === "unconfirmed")) {
    return { ...spelled(peer), outcome: "unconfirmed" };
  }
  return { ...spelled(peer), outcome: "not_delivered", reason: failureOf(delivered) };
}

/** Which failure a session whose runs all failed reports when they failed
 * for different reasons: the first here that any run gave — a refusal, then
 * a socket that took nothing, then this side's status socket, then a run
 * with no socket. */
const FAILURE_ORDER = ["refused", "unreachable", "no_status_socket", "no_peer_socket"] as const;

function failureOf(results: readonly InjectResult[]): SendMessageReason {
  const causes = new Set<SendMessageReason>(
    results.flatMap((r) =>
      r.outcome === "refused" ? ["refused"] : r.outcome === "unavailable" ? [r.cause] : [],
    ),
  );
  return FAILURE_ORDER.find((cause) => causes.has(cause)) ?? "unreachable";
}
