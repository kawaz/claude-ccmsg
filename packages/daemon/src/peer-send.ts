// peer_send and peer_list (DR-0039 §3): the `send` and `peers` tools of a
// session's hooks module. A send names its recipients by any of a session's
// id, directory, name and process; the daemon matches them against the live
// session runs read afresh (address-send.ts liveRuns, the same source for the
// send and the list, so what `peers` shows is what `send` reaches), and
// writes the envelope into the peer socket of every matched session that has
// a hooks module (peer-inject.ts). Nothing is held for a later attempt
// (DR-0036 §3).
import {
  type PeerListEntry,
  type PeerListInput,
  type PeerSendReason,
  type PeerSendResult,
  type PeerTarget,
  renderAddressedDelivery,
  type SessionInputReadiness,
} from "@ccmsg/protocol";
import type { SessionRun } from "./address-send.ts";
import type { InjectFrame, InjectResult } from "./peer-inject.ts";

/** One session among the live runs: its runs, and how a target spells it —
 * the name its record gives and its directory as a realpath. */
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

export interface PeerSendDeps extends PeerDeps {
  /** What the daemon knows of a session no live run serves. */
  readiness(sid: string): SessionInputReadiness;
  issueMid(): string;
  deliver(run: SessionRun, frame: InjectFrame): Promise<InjectResult>;
  log(line: string): void;
}

/** The sessions of `runs`, each once, spelled as a target matches them. */
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

/** The sessions among `peers` that match every field `filter` gives, each
 * with only its runs the filter's `pid` names. A directory is compared as a
 * realpath, whole: a session in a subdirectory works elsewhere. */
async function matching(
  peers: readonly Peer[],
  filter: Partial<PeerTarget>,
  deps: PeerDeps,
): Promise<Peer[]> {
  const dir =
    filter.cwd !== undefined ? ((await deps.realpath(filter.cwd)) ?? filter.cwd) : undefined;
  return peers.flatMap((peer) => {
    if (filter.session_id !== undefined && peer.sid !== filter.session_id) return [];
    if (dir !== undefined && peer.cwd !== dir) return [];
    if (filter.name !== undefined && peer.name !== filter.name) return [];
    const runs =
      filter.pid !== undefined ? peer.runs.filter((run) => run.pid === filter.pid) : peer.runs;
    return runs.length > 0 ? [{ ...peer, runs }] : [];
  });
}

function spelled(peer: Peer): { sid: string; name?: string; cwd?: string } {
  return {
    sid: peer.sid,
    ...(peer.name !== undefined ? { name: peer.name } : {}),
    ...(peer.cwd !== undefined ? { cwd: peer.cwd } : {}),
  };
}

/** The sessions a send could go to, as peer_send matches them. */
export async function listPeers(
  from: string,
  filter: PeerListInput,
  deps: PeerDeps,
): Promise<PeerListEntry[]> {
  const peers = await matching(await peersOf(await deps.runs(), deps), filter, deps);
  return peers
    .map((peer) => ({
      ...spelled(peer),
      pids: peer.runs.map((run) => run.pid).sort((a, b) => a - b),
      module: deps.hasModule(peer.sid),
      self: peer.sid === from,
    }))
    .sort((a, b) => a.sid.localeCompare(b.sid));
}

/** Deliver `text` from session `from` to every session `to` picks out but
 * the sender, and say what came of it for each. */
export async function sendToPeers(
  message: { from: string; to: PeerTarget; text: string },
  deps: PeerSendDeps,
): Promise<PeerSendResult[]> {
  const { from, to, text } = message;
  const peers = await peersOf(await deps.runs(), deps);
  const matched = await matching(peers, to, deps);
  if (matched.length === 0) {
    // A session named by id that no live run serves: say why, rather than
    // that nobody matched. One that runs but differs in another field is no
    // match.
    const named = to.session_id;
    if (named === undefined || named === from || peers.some((peer) => peer.sid === named)) {
      return [];
    }
    const kind = deps.readiness(named).kind;
    return [
      {
        sid: named,
        outcome: "not_delivered",
        reason: kind === "session_changed" ? "session_changed" : "ended",
      },
    ];
  }
  const others = matched.filter((peer) => peer.sid !== from);
  if (others.length === 0) {
    return matched.map((peer) => ({ ...spelled(peer), outcome: "not_delivered", reason: "self" }));
  }
  const results = await Promise.all(others.map((peer) => sendToPeer(peer, from, text, deps)));
  return results.sort((a, b) => a.sid.localeCompare(b.sid));
}

async function sendToPeer(
  peer: Peer,
  from: string,
  text: string,
  deps: PeerSendDeps,
): Promise<PeerSendResult> {
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
        `peer-inject ${mid} -> ${run.sid}.${String(run.pid)} (peer_send): ${result.outcome}` +
          (result.outcome === "unavailable" ? ` (${result.cause})` : ""),
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
 * for different reasons: the first here that any run gave (address-send.ts's
 * order). */
const FAILURE_ORDER = ["refused", "unreachable", "no_status_socket", "no_peer_socket"] as const;

function failureOf(results: readonly InjectResult[]): PeerSendReason {
  const causes = new Set<PeerSendReason>(
    results.flatMap((r) =>
      r.outcome === "refused" ? ["refused"] : r.outcome === "unavailable" ? [r.cause] : [],
    ),
  );
  return FAILURE_ORDER.find((cause) => causes.has(cause)) ?? "unreachable";
}
