// Drive one request through handleRequest on a connection that only records
// what the daemon writes, for the op tests that stub the daemon around one op.
// Every line written is read as a frame of the wire's schemas, as the
// TestClient does, and a line that does not read fails the request.
import * as path from "node:path";
import {
  readDaemonFrame,
  resolvePaths,
  VERSION,
  type ErrorResponse,
  type Request,
  type RequestOp,
  type ResponseOf,
} from "@ccmsg/protocol";
import { createAgentsPoller } from "../src/agents.ts";
import { createMidIssuer } from "../src/direct-send.ts";
import { createForkOriginCache } from "../src/fork-origin.ts";
import { LlmRequestCache } from "../src/llm-events.ts";
import { Logger } from "../src/log.ts";
import { PeerInjector } from "../src/peer-inject.ts";
import { createSandboxGrants } from "../src/sandbox.ts";
import { handleRequest, type Conn, type Daemon } from "../src/server.ts";
import { createSessionErrorsStore } from "../src/session-errors.ts";
import { createSessionStatusStore } from "../src/session-status.ts";
import { createSessionUserInputStore } from "../src/session-user-input.ts";
import { createSessionWakeState } from "../src/session-wake.ts";
import { createSayLog } from "../src/say-log.ts";
import { RunPids, SidecarReplies } from "../src/sidecar-call.ts";
import { TraceWriter } from "../src/trace.ts";
import { createTranscriptTailStore } from "../src/transcript.ts";
import { createTranslateService } from "../src/translate-helper.ts";
import { readStreamItem, refusedReply, servedReply, type StreamItem } from "./helpers.ts";

/** A Logger that writes nothing: the op tests read what a request is
 * answered with, not what the daemon logs on the way. */
class SilentLogger extends Logger {
  override log(): void {}
}

/** A daemon in memory for driving one op with `handleRequest`: nothing is
 * listening, polling or locked, and `fields` sets what the op under test
 * reads. Its paths name `base`, which nothing here creates or writes; a test
 * whose op writes files passes a directory of its own. */
export function stubDaemon(fields: Partial<Daemon> = {}, base = "/nonexistent/ccmsg-stub"): Daemon {
  const paths = resolvePaths({
    CCMSG_STATE_DIR: path.join(base, "s"),
    CCMSG_CONFIG_DIR: path.join(base, "c"),
    CCMSG_DATA_DIR: path.join(base, "d"),
  });
  const trace = new TraceWriter(paths.trace);
  return {
    paths,
    config: {},
    version: VERSION,
    startTime: Date.now(),
    rooms: new Map(),
    dedupIndex: new Map(),
    connections: new Set(),
    sessions: new Map(),
    subscribers: new Set(),
    log: new SilentLogger(paths.log),
    lock: { fd: -1, release() {} },
    server: null,
    httpListeners: [],
    httpAllow: [],
    dedupWindowMs: 0,
    shuttingDown: false,
    agentsPoller: createAgentsPoller(),
    agentsSeen: new Map(),
    transcriptTail: createTranscriptTailStore(trace),
    trace,
    sessionStatus: createSessionStatusStore(),
    sessionErrors: createSessionErrorsStore(),
    sessionUserInputs: createSessionUserInputStore(),
    sessionErrorsSnapshot: "",
    networkWatch: null,
    sessionWake: createSessionWakeState(),
    sandboxGrants: createSandboxGrants(),
    sandboxOrigin: null,
    forkOrigins: createForkOriginCache(),
    translator: createTranslateService(),
    peersSnapshot: "",
    staleClients: new Map(),
    llmRequests: new LlmRequestCache(),
    llmStatusRefresher: null,
    webhooks: new Map(),
    peerInjector: new PeerInjector(),
    launcher: "/nonexistent/ccmsg",
    issueDirectMid: createMidIssuer(),
    says: createSayLog(createMidIssuer()),
    sidecarReplies: new SidecarReplies(),
    runPids: new RunPids(),
    ...fields,
  };
}

/** A line the daemon wrote back: as it came, and what it reads as. */
interface WrittenLine {
  readonly line: string;
  readonly item: StreamItem;
}

/** Write `line` as a request and resolve once `count` lines (replies and
 * pushes, in write order) have been written back; reject at the first line
 * outside the wire's schemas. `op` is the op a reply answers, when the line
 * names a request_id to answer under. */
function driveLine(
  daemon: Daemon,
  identity: Conn["identity"],
  line: string,
  op: RequestOp | undefined,
  count: number,
): Promise<WrittenLine[]> {
  return new Promise((resolve, reject) => {
    const written: WrittenLine[] = [];
    const conn: Conn = {
      identity,
      subscribed: false,
      write(raw) {
        const back = raw.trimEnd();
        const read = readStreamItem(back, readDaemonFrame(back), op);
        if (!read.ok) {
          reject(new Error(`${read.problem}: ${raw}`));
          return;
        }
        written.push({ line: back, item: read.item });
        if (written.length === count) resolve(written);
      },
    };
    // Register like the real transports do.
    daemon.connections.add(conn);
    handleRequest(daemon, conn, line);
  });
}

/** The line one request is answered with first. */
async function firstLine(
  daemon: Daemon,
  identity: Conn["identity"],
  line: string,
  op: RequestOp | undefined,
): Promise<string> {
  const [first] = await driveLine(daemon, identity, line, op, 1);
  if (first === undefined) throw new Error("no line was written back");
  return first.line;
}

/** Resolve once `count` lines (replies and pushes, in write order) have been
 * written back for `request`, each read as a stream item; reject at the first
 * line outside the wire's schemas. */
export async function requestFrames(
  daemon: Daemon,
  identity: Conn["identity"],
  request: Request,
  count: number,
): Promise<StreamItem[]> {
  const written = await driveLine(daemon, identity, JSON.stringify(request), request.op, count);
  return written.map((back) => back.item);
}

/** The success reply one request is answered with; a refusal is an error
 * thrown. */
export async function requestOk<R extends Request>(
  daemon: Daemon,
  identity: Conn["identity"],
  request: R,
): Promise<ResponseOf<R["op"]>> {
  const line = await firstLine(daemon, identity, JSON.stringify(request), request.op);
  return servedReply<R["op"]>(request.op, line);
}

/** The refusal one request is answered with; a success reply is an error
 * thrown. */
export async function requestError(
  daemon: Daemon,
  identity: Conn["identity"],
  request: Request,
): Promise<ErrorResponse> {
  const line = await firstLine(daemon, identity, JSON.stringify(request), request.op);
  return refusedReply(request.op, line);
}

/** Write a value the daemon cannot read as a request and return its refusal,
 * with the request_id it is answered under when the value named one. Such a
 * reply answers no request of a known op, so it can only be an error. */
export async function requestRefusal(
  daemon: Daemon,
  identity: Conn["identity"],
  malformed: object,
): Promise<ErrorResponse & { readonly request_id?: string }> {
  const [first] = await driveLine(daemon, identity, JSON.stringify(malformed), undefined, 1);
  const item = first?.item;
  if (item === undefined || !("ok" in item) || item.ok) {
    throw new Error(`a malformed request was not refused: ${first?.line}`);
  }
  return item;
}
