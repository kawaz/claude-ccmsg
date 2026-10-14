// Test harness: spawn a real daemon in a temp dir and talk to it over UDS.
// No blind sleeps — daemon readiness is confirmed by retrying the actual connect.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "bun";
import {
  ErrorResponseSchema,
  JsonObjectSchema,
  JsonTextSchema,
  JsonValueSchema,
  jsonText,
  parseWith,
  PROTOCOL_VERSION,
  readDaemonFrame,
  RESPONSE_SCHEMAS,
  type DaemonFrame,
  type DeliveredEvent,
  type ErrorResponse,
  type JsonObject,
  type JsonValue,
  type PushStreamEvent,
  type ReplyOf,
  type Request,
  type RequestInput,
  type RequestOp,
  type ResponseBody,
  type ResponseOf,
  type Response as WireReply,
  type StreamEvent,
} from "@ccmsg/protocol";

const DAEMON_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const spawnedDaemons = new Set<Bun.Subprocess>();

process.on("exit", () => {
  for (const proc of spawnedDaemons) {
    try {
      proc.kill();
    } catch {
      // The subprocess may have exited between registry lookup and signaling.
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export interface DaemonCtx {
  base: string;
  stateDir: string;
  configDir: string;
  dataDir: string;
  roomsDir: string;
  sock: string;
  proc: Bun.Subprocess;
  env: Record<string, string>;
}

/** Test daemons keep their config dir inside the temp data dir so that every
 * call site gets it from `dataDir` alone (restarts stay one-liners) and no test
 * can ever read or migrate into the developer's real ~/.config/ccmsg. */
export function testConfigDir(dataDir: string): string {
  return path.join(dataDir, "config");
}

export function spawnDaemonProc(
  stateDir: string,
  dataDir: string,
  extraEnv: Record<string, string> = {},
): Bun.Subprocess {
  const proc = Bun.spawn([process.execPath, DAEMON_ENTRY, "daemon", "run"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // HTTP off by default so parallel test daemons never fight over the fixed
    // default port (8642); tests that need HTTP pass CCMSG_HTTP_BIND explicitly
    // (typically 127.0.0.1:0 for an ephemeral port) via extraEnv, which wins below.
    env: {
      ...process.env,
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: testConfigDir(dataDir),
      CCMSG_DATA_DIR: dataDir,
      // Pin integration subprocesses to this working copy rather than PATH's install.
      CCMSG_NO_SELF_EXEC: "1",
      CCMSG_HTTP_BIND: "off",
      // No route-monitor child and no api-error folds per test daemon; tests
      // that exercise the wake drive createNetworkWatch directly.
      CCMSG_NETWORK_WATCH: "off",
      // No `claude agents` poll registering the machine's real sessions.
      CCMSG_AGENTS_POLL: "off",
      ...extraEnv,
    },
  });
  spawnedDaemons.add(proc);
  void proc.exited.then(() => spawnedDaemons.delete(proc));
  return proc;
}

export async function waitConnectable(sock: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const s = await Bun.connect({
        unix: sock,
        socket: { data() {}, close() {}, error() {} },
      });
      s.end();
      return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`daemon not connectable: ${sock}`);
    await sleep(25);
  }
}

export async function startTestDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonCtx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-t-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const env: Record<string, string> = {
    CCMSG_STATE_DIR: stateDir,
    CCMSG_CONFIG_DIR: testConfigDir(dataDir),
    CCMSG_DATA_DIR: dataDir,
    CCMSG_NO_SELF_EXEC: "1",
    CCMSG_HTTP_BIND: "off",
    CCMSG_NETWORK_WATCH: "off",
    CCMSG_AGENTS_POLL: "off",
    ...extraEnv,
  };
  const proc = spawnDaemonProc(stateDir, dataDir, extraEnv);
  const sock = path.join(stateDir, "daemon.sock");
  try {
    await waitConnectable(sock);
    return {
      base,
      stateDir,
      configDir: testConfigDir(dataDir),
      dataDir,
      roomsDir: path.join(dataDir, "rooms"),
      sock,
      proc,
      env,
    };
  } catch (error) {
    try {
      proc.kill();
    } catch {
      // The subprocess may have exited while readiness was being checked.
    }
    await proc.exited;
    fs.rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

export async function stopTestDaemon(ctx: DaemonCtx): Promise<void> {
  try {
    const c = await connect(ctx.sock);
    await c.request({ op: "shutdown" });
    c.close();
  } catch {
    // fall back to signal
  }
  try {
    ctx.proc.kill();
  } catch {
    // already gone
  }
  await ctx.proc.exited;
  try {
    fs.rmSync(ctx.base, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export async function connect(sock: string): Promise<TestClient> {
  const client = new TestClient();
  const socket = await Bun.connect({
    unix: sock,
    socket: {
      data(_s, chunk) {
        client.onData(chunk);
      },
      drain() {
        client.onDrain();
      },
      close() {
        client.onClose();
      },
      error() {
        client.onClose();
      },
    },
  });
  client.attach(socket);
  return client;
}

/** What a line of the readable stream is, read with the wire's schemas: a
 * push or delivered event, or a reply no in-flight `request` claimed (read as
 * the answer to the op of the request it names, with that `request_id`). */
export type StreamItem = StreamEvent | WireReply;

/** What names a stream item's kind: a delivered event's `type`, a push's
 * `ev`, or `"reply"` for a reply. */
export type StreamKind = DeliveredEvent["type"] | PushStreamEvent["ev"] | "reply";

/** The stream items of one kind. */
export type ItemOf<K extends StreamKind> =
  | Extract<DeliveredEvent, { readonly type: K }>
  | Extract<PushStreamEvent, { readonly ev: K }>
  | (K extends "reply" ? WireReply : never);

/** The kind a stream item is of: only a reply has `ok`, only a push `ev`. */
export function kindOf(item: StreamItem): StreamKind {
  if ("ok" in item) return "reply";
  return "ev" in item ? item.ev : item.type;
}

/** Whether a stream item is of `kind`: for picking one kind out of what a
 * test has seen. */
export function isKind<K extends StreamKind>(kind: K): (item: StreamItem) => item is ItemOf<K> {
  return (item): item is ItemOf<K> => kindOf(item) === kind;
}

/** `value`, which the test needs to be there: a lookup that found nothing
 * (`find`, an index past the end, a getter answering null) fails the test,
 * naming `what` was looked for, instead of an error thrown later from reading
 * a field of nothing. */
export function defined<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}, found none`);
  return value;
}

/** Whether a stream item is a delivered storage event: neither a reply
 * (`ok`) nor a push (`ev`). */
export function isDelivered(item: StreamItem): item is DeliveredEvent {
  return !("ok" in item) && !("ev" in item);
}

const JsonObjectTextSchema = jsonText(JsonObjectSchema);

/** A line of JSON text that has to be an object (a log row, a file the daemon
 * wrote), read as one; anything else is an error thrown. */
export function jsonObjectOf(line: string): JsonObject {
  const read = parseWith(JsonObjectTextSchema, line);
  if (!read.ok) throw new Error(`not a JSON object: ${read.failure.summary}: ${line}`);
  return read.value;
}

const JsonValueTextSchema = jsonText(JsonValueSchema);

/** A test value as JSON another program would send it: written out and read
 * back, so what a parser under test is given is JSON and nothing else (no
 * `undefined` fields, no class instances). */
export function throughJson<T>(value: T): JsonValue {
  const read = parseWith(JsonValueTextSchema, JSON.stringify(value));
  if (!read.ok) throw new Error(`not writable as JSON: ${read.failure.summary}`);
  return read.value;
}

/** A line the daemon wrote, read as a StreamItem, or why it is not what the
 * wire's schemas say it is. */
export type StreamItemRead =
  | { readonly ok: true; readonly item: StreamItem }
  | { readonly ok: false; readonly problem: string };

function withRequestId(reply: ResponseBody, requestId: string | undefined): WireReply {
  return requestId === undefined ? reply : { ...reply, request_id: requestId };
}

/** Read one line the daemon wrote. Every line a TestClient receives is read
 * here, so a reply or push the daemon sends outside its schema fails the test
 * that got it: a client reading it with the schema would not see it as sent.
 *
 * `op` is the op of the request a reply answers, when the client knows it.
 * Read with that op's schema, the reply has to come back whole — a field the
 * schema does not name would be left out by a client reading it. Without an
 * op the reply can only be an error, and it has to come back whole the same
 * way. */
export function readStreamItem(
  line: string,
  frame: DaemonFrame,
  op: RequestOp | undefined,
): StreamItemRead {
  if (frame.kind === "invalid") return { ok: false, problem: frame.failure.summary };
  const raw: unknown = JSON.parse(line);
  if (frame.kind === "event") {
    return Bun.deepEquals(frame.event, raw)
      ? { ok: true, item: frame.event }
      : { ok: false, problem: "fields outside its schema" };
  }
  if (op === undefined) {
    // A reply this client did not ask for under an op: only an error can be one.
    const read = frame.reply("ping");
    if (!read.ok || read.value.ok) {
      return { ok: false, problem: "a reply to no request this client named, and not an error" };
    }
    const item = withRequestId(read.value, frame.requestId);
    return Bun.deepEquals(item, raw)
      ? { ok: true, item }
      : { ok: false, problem: "as an error: fields outside its schema" };
  }
  const read = frame.reply(op);
  if (!read.ok) return { ok: false, problem: `as the answer to ${op}: ${read.failure.summary}` };
  const item = withRequestId(read.value, frame.requestId);
  return Bun.deepEquals(item, raw)
    ? { ok: true, item }
    : { ok: false, problem: `as the answer to ${op}: fields outside its schema` };
}

/** A line a daemon wrote to a subscriber unasked (a push or a delivered
 * event), read as a stream item; a line outside the wire's schemas is an
 * error thrown. */
export function streamItemOf(line: string): StreamItem {
  const read = readStreamItem(line, readDaemonFrame(line), undefined);
  if (!read.ok) throw new Error(`${read.problem}: ${line}`);
  return read.item;
}

/** A reply line read as the success reply to a request of `op`; a refusal,
 * or a reply that is not the op's answer, is an error thrown. */
export function servedReply<Op extends RequestOp>(op: Op, line: string): ResponseOf<Op> {
  const decoded = parseWith(JsonTextSchema, line);
  if (!decoded.ok) throw new Error(`the reply to ${op} is not JSON: ${line}`);
  const refusal = parseWith(ErrorResponseSchema, decoded.value);
  if (refusal.ok) {
    const { code, msg } = refusal.value.error;
    throw new Error(`${op} was refused: ${code}: ${msg}`);
  }
  const read = parseWith(RESPONSE_SCHEMAS[op], decoded.value);
  if (!read.ok) throw new Error(`the reply to ${op} is not its answer: ${read.failure.summary}`);
  return read.value;
}

const ErrorResponseTextSchema = jsonText(ErrorResponseSchema);

/** A reply line read as the refusal of what was `asked`; a reply that is not
 * an error is an error thrown. */
export function refusedReply(asked: string, line: string): ErrorResponse {
  const refusal = parseWith(ErrorResponseTextSchema, line);
  if (!refusal.ok) throw new Error(`${asked} was not refused: ${line}`);
  return refusal.value;
}

/** A line of the readable stream: as it came, and what it reads as. */
interface StreamLine {
  readonly line: string;
  readonly item: StreamItem;
}

export class TestClient {
  private socket: Socket | undefined;
  private decoder = new TextDecoder();
  private buf = "";
  private lines: StreamLine[] = [];
  private waiters: Array<(l: StreamLine | null) => void> = [];
  private ended = false;
  /** Settled once the socket has closed, from either side. */
  private socketClosed = Promise.withResolvers<void>();
  /** Stream items that arrived while `requestRaw` was waiting for a reply. */
  private eventBacklog: StreamItem[] = [];
  private nextRequestId = 0;
  /** In-flight `request` calls, keyed by the request_id each is waiting for. */
  private pendingReplies = new Map<string, (line: string | null) => void>();
  /** The op of every request this client wrote with an id, by that id. */
  private opsById = new Map<string, RequestOp>();
  /** Lines the daemon wrote that its schemas do not read, with why. */
  private invalidFrames: string[] = [];

  /** Fail when any line this client has received so far is not a frame of
   * the wire's schemas. Called wherever the client hands something to a test. */
  private assertFrames(): void {
    if (this.invalidFrames.length > 0) {
      throw new Error(
        `the daemon wrote lines outside the wire's schemas:\n${this.invalidFrames.join("\n")}`,
      );
    }
  }

  /** Lines the socket did not take yet, oldest first: Bun's `write` takes
   * what fits and keeps nothing, so a large request is finished on `drain`. */
  private unsent: Uint8Array[] = [];

  attach(socket: Socket): void {
    this.socket = socket;
  }
  onDrain(): void {
    const socket = this.socket;
    if (socket === undefined) return;
    for (let head = this.unsent[0]; head !== undefined; head = this.unsent[0]) {
      const taken = socket.write(head);
      if (taken < 0) {
        this.unsent = [];
        return;
      }
      if (taken < head.length) {
        this.unsent[0] = head.subarray(taken);
        return;
      }
      this.unsent.shift();
    }
  }
  onData(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const frame = readDaemonFrame(line);
      const rid = frame.kind === "reply" ? frame.requestId : undefined;
      const read = readStreamItem(
        line,
        frame,
        rid === undefined ? undefined : this.opsById.get(rid),
      );
      if (!read.ok) this.invalidFrames.push(`${read.problem}: ${line.slice(0, 400)}`);
      // A reply someone is waiting for goes straight to them; anything else
      // (stream events, replies nobody claimed) joins the readable stream.
      const claimant = rid === undefined ? undefined : this.pendingReplies.get(rid);
      if (rid !== undefined && claimant !== undefined) {
        this.pendingReplies.delete(rid);
        claimant(line);
      } else if (read.ok) this.lines.push({ line, item: read.item });
    }
    this.drain();
  }
  private drain(): void {
    for (;;) {
      if (this.waiters.length === 0 || this.lines.length === 0) return;
      const waiter = this.waiters.shift();
      const line = this.lines.shift();
      if (waiter !== undefined && line !== undefined) waiter(line);
    }
  }
  onClose(): void {
    this.ended = true;
    this.socketClosed.resolve();
    for (const waiter of this.waiters.splice(0)) waiter(null);
    for (const settle of this.pendingReplies.values()) settle(null);
    this.pendingReplies.clear();
  }
  private readStreamLine(): Promise<StreamLine | null> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.ended) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }
  /** The next line of the readable stream as the daemon wrote it. */
  async readLine(): Promise<string | null> {
    const next = await this.readStreamLine();
    return next === null ? null : next.line;
  }
  writeRaw(s: string): void {
    this.unsent.push(new TextEncoder().encode(s));
    this.onDrain();
  }
  /** Write a request as given, its reply left in the readable stream for
   * readEvent and read there as the answer to its op. */
  write(request: Request): void {
    this.opsById.set(request.request_id, request.op);
    this.writeRaw(`${JSON.stringify(request)}\n`);
  }
  /** Send an op and return its reply, pairing the way the real clients do: by
   * the `request_id` this stamps on the way out. Everything else on the socket
   * — stream events, and the replies to this connection's other in-flight
   * requests — keeps its place in the readable stream for readEvent. Several
   * requests may therefore be outstanding at once.
   *
   * The reply is read as the answer to the request's op — its success reply
   * or an error — and comes back without its correlation envelope, the same
   * shape the webui client hands its callers; a test that asserts the echo
   * itself reads the raw frame (write + readEvent) instead. */
  async request<B extends RequestInput>(body: B): Promise<ReplyOf<B["op"]>> {
    const frame = readDaemonFrame(await this.replyLine(body, body.op));
    if (frame.kind !== "reply") throw new Error(`the reply to ${body.op} is not a reply`);
    const read = frame.reply<B["op"]>(body.op);
    if (!read.ok) {
      throw new Error(`the reply to ${body.op} is not its answer: ${read.failure.summary}`);
    }
    return read.value;
  }
  /** `request`, for a request the test expects served: its success reply,
   * or an error thrown with the refusal. */
  async requestOk<B extends RequestInput>(body: B): Promise<ResponseOf<B["op"]>> {
    return servedReply<B["op"]>(body.op, await this.replyLine(body, body.op));
  }
  /** `request`, for a request the test expects refused: the error reply, or
   * an error thrown when it was served. */
  async requestError(body: RequestInput): Promise<ErrorResponse> {
    return refusedReply(body.op, await this.replyLine(body, body.op));
  }
  /** Send a value the daemon cannot read as a request of its op (a field of
   * another type, a field missing, an op it does not serve) under a
   * request_id of its own, and return the refusal that names it. */
  async requestRefusal(malformed: object): Promise<ErrorResponse> {
    return refusedReply("a malformed request", await this.replyLine(malformed, undefined));
  }
  /** Send `body` under a request_id of its own and wait for the reply that
   * names it, as the daemon wrote it. `op` is the op the reply is read as the
   * answer to; with none, the reply can only be an error. */
  private async replyLine(body: object, op: RequestOp | undefined): Promise<string> {
    const rid = `t${++this.nextRequestId}`;
    const line = await new Promise<string | null>((resolve) => {
      this.pendingReplies.set(rid, resolve);
      // Frames buffered before this request even went out cannot be its reply,
      // so only newly arriving ones are inspected (see onData).
      if (op !== undefined) this.opsById.set(rid, op);
      this.writeRaw(`${JSON.stringify({ ...body, request_id: rid })}\n`);
    });
    this.assertFrames();
    if (line === null) throw new Error("connection closed before response");
    return line;
  }
  /** Send a line the daemon cannot read as a request — exactly as given, no
   * request_id stamped — and return its refusal, the next reply on the
   * stream. Such a reply names no request, so it can only be an error. */
  async requestRaw(malformed: object): Promise<ErrorResponse> {
    this.writeRaw(`${JSON.stringify(malformed)}\n`);
    for (;;) {
      const next = await this.readStreamLine();
      this.assertFrames();
      if (next === null) throw new Error("connection closed before response");
      const item = next.item;
      if (!("ok" in item)) {
        this.eventBacklog.push(item);
        continue;
      }
      if (item.ok) throw new Error(`a malformed request was served: ${next.line}`);
      return item;
    }
  }
  /** The next stream item, or null once the connection has closed. Given a
   * kind, the next item has to be of it. */
  async readEvent(): Promise<StreamItem | null>;
  async readEvent<K extends StreamKind>(kind: K): Promise<ItemOf<K>>;
  async readEvent<K extends StreamKind>(kind?: K): Promise<StreamItem | null> {
    this.assertFrames();
    const buffered = this.eventBacklog.shift();
    const next = buffered ?? (await this.readStreamLine())?.item ?? null;
    this.assertFrames();
    if (kind === undefined) return next;
    if (next === null) throw new Error(`connection closed before a ${kind}`);
    if (!isKind(kind)(next)) throw new Error(`expected a ${kind}, got ${JSON.stringify(next)}`);
    return next;
  }
  /** Events already delivered to this socket, without waiting for more — for
   * asserting that a push was *not* addressed to this client. Only meaningful
   * after something else has ordered the stream past the moment in question
   * (e.g. a request round-trip). */
  async pendingEvents(): Promise<StreamItem[]> {
    this.assertFrames();
    const events = this.eventBacklog.splice(0);
    for (const next of this.lines.splice(0)) events.push(next.item);
    return events;
  }
  /** Read events until one of `kind` that `pred` accepts (or, given only a
   * predicate, any item it accepts) arrives, with every item seen on the way.
   * Relies on the expected event actually arriving; if it never does, the bun
   * test timeout fails the test. */
  async readEventUntil<K extends StreamKind>(
    kind: K,
    pred?: (ev: ItemOf<K>) => boolean,
  ): Promise<{ ev: ItemOf<K>; seen: StreamItem[] }>;
  async readEventUntil(
    pred: (ev: StreamItem) => boolean,
  ): Promise<{ ev: StreamItem; seen: StreamItem[] }>;
  async readEventUntil<K extends StreamKind>(
    kindOrPred: K | ((ev: StreamItem) => boolean),
    pred: (ev: ItemOf<K>) => boolean = () => true,
  ): Promise<{ ev: StreamItem; seen: StreamItem[] }> {
    const seen: StreamItem[] = [];
    for (;;) {
      const ev = await this.readEvent();
      if (ev === null) throw new Error(`connection closed; seen ${JSON.stringify(seen)}`);
      seen.push(ev);
      if (typeof kindOrPred === "string") {
        if (isKind(kindOrPred)(ev) && pred(ev)) return { ev, seen };
      } else if (kindOrPred(ev)) return { ev, seen };
    }
  }
  async hello(
    identity:
      | { role: "user" }
      | { role: "session"; sid: string; repo?: string; ws?: string; cwd?: string },
  ): Promise<ResponseOf<"hello">> {
    if (identity.role === "user")
      return this.requestOk({ op: "hello", role: "user", protocol: PROTOCOL_VERSION });
    return this.requestOk({
      op: "hello",
      role: "session",
      protocol: PROTOCOL_VERSION,
      sid: identity.sid,
      repo: identity.repo ?? "",
      ws: identity.ws ?? "",
      cwd: identity.cwd ?? "",
    });
  }
  close(): void {
    try {
      this.socket?.end();
    } catch {
      // already closing
    }
    this.assertFrames();
  }
  /** Close this side and wait for the daemon to close its side. The daemon
   * closes a connection that has ended only after its close handler has let
   * go of it, so whatever the daemon does on a closing connection is done when
   * this resolves — the ordering a test needs before asserting what a close
   * did not cause, or before a hello that has to come after the close. */
  async end(): Promise<void> {
    this.close();
    await this.socketClosed.promise;
  }
}
