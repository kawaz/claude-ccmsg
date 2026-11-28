// agy's conversations through the tool `agy` (DR-0066): the daemon starts
// agy in stream-json, one process a conversation, writes each request on its
// standard input, reads its standard output from a file (§5) and delivers
// each request's response into the conversation that asked (§7), through
// `deliver` (server.ts: the module's `notice.append`, then the wake). The
// records live in `<stateDir>/agy/<agyid>/` (§4).
//
// What tells one process from another (its start time and argv, Q22), the
// other processes that hold a conversation (Q21, §6), where an abort's signal
// goes (Q23) and whether a process an earlier daemon started still runs
// (§10) are `AgyProcessView`'s, one function each: they change shape once agy
// runs in a container (the daemon starts a container command, and the agy in
// it is not in the host's process list).
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  AGY_ABORT_WAIT_MS,
  AGY_INIT_WAIT_MS,
  AGY_LIST_MAX,
  AGY_RESPONSE_INLINE_MAX_BYTES,
  AgyDirSchema,
  type AgyAbortResponse,
  type AgyDir,
  AgyEffortSchema,
  type AgyEndError,
  AgyEndErrorSchema,
  AgyErrorCode,
  type AgyResultView,
  type AgyRunMore,
  type AgyRunNew,
  type AgyRunResponse,
  type AgyStatusListResponse,
  type AgyStatusOneResponse,
  type AgyUsage,
  AgyUsageSchema,
  agyMark,
} from "@ccmsg/protocol/agy";
import { JsonValueSchema } from "@ccmsg/protocol/json-value";
import { errorText, jsonText, type Output, parseWith } from "@ccmsg/protocol/parse";
import type { AgyConfig } from "./config.ts";
import { withoutEnvPatterns } from "./env-patterns.ts";
import { userTempDir, withTmpdir } from "./user-temp-dir.ts";

/** A conversation's directory is removed this long after its last request or
 * result (§4, as the guidance's record, `hooks/guidance.ts`'s GUIDED_TTL_MS). */
export const AGY_CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A process's output is removed this long after the process ended (§4). */
export const AGY_OUTPUT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The tail of standard error and of the lines that are not JSON kept as what
 * a failure says (§5). */
const FAILURE_TEXT_MAX_BYTES = 4096;

// --- records (§4) ---------------------------------------------------------------

const ProcessRecordSchema = v.object({
  pid: v.number(),
  /** The start time the process view read, when it read one (Q22). */
  started_at: v.optional(v.string()),
  argv: v.array(v.string()),
  /** The run's directory name under the conversation's. */
  run: v.string(),
  /** How far stdout.jsonl has been read, in bytes. */
  offset: v.number(),
});
export type AgyProcessRecord = Output<typeof ProcessRecordSchema>;

const ConversationRecordSchema = v.object({
  agyid: v.string(),
  created_at: v.string(),
  created_by: v.string(),
  model: v.string(),
  effort: v.optional(AgyEffortSchema),
  cwd: v.string(),
  dirs: v.array(AgyDirSchema),
  usage_total: v.optional(AgyUsageSchema),
  last_at: v.string(),
  quota: v.optional(v.object({ text: v.string(), at: v.string() })),
  process: v.optional(ProcessRecordSchema),
  /** The runs whose process ended, and when: their output's lifetime (§4). */
  ended_runs: v.optional(v.record(v.string(), v.string())),
});
type ConversationRecord = Output<typeof ConversationRecordSchema>;

const ResultRecordSchema = v.object({
  at: v.string(),
  status: v.optional(v.string()),
  finished_reason: v.optional(v.string()),
  response: v.optional(v.string()),
  error: v.optional(v.string()),
  denied_actions: v.optional(v.array(JsonValueSchema)),
  /** The conversation's totals as `result` carries them (A18). */
  usage: v.optional(AgyUsageSchema),
  duration_seconds: v.optional(v.number()),
  /** The request's own usage: the difference from the result before (Q20). */
  usage_own: v.optional(AgyUsageSchema),
});

const RequestRecordSchema = v.object({
  seq: v.number(),
  received_at: v.string(),
  to: v.object({ sid: v.string(), agent_id: v.optional(v.string()) }),
  verbose: v.boolean(),
  prompt_bytes: v.number(),
  /** `yes` once the line was written whole; `no` between the record and the
   * write (§6, §10). */
  written: v.picklist(["no", "yes"]),
  written_at: v.optional(v.string()),
  result: v.optional(ResultRecordSchema),
  /** How it ended without a result, and what agy said then. */
  end: v.optional(AgyEndErrorSchema),
  end_text: v.optional(v.string()),
  delivered: v.optional(v.union([v.literal("yes"), v.object({ not: v.string() })])),
});
type RequestRecord = Output<typeof RequestRecordSchema>;

const ConversationRecordTextSchema = jsonText(ConversationRecordSchema);
const RequestRecordTextSchema = jsonText(RequestRecordSchema);

// --- agy's lines (§5) -------------------------------------------------------------

/** `init`, read for the conversation's id. Where agy puts the id in the line
 * (beside `event`, or under `init`) is read both ways: the measurements name
 * the field, not its place. */
const InitLineSchema = v.object({
  event: v.literal("init"),
  conversation_id: v.optional(v.string()),
  init: v.optional(v.object({ conversation_id: v.optional(v.string()) })),
});

const ResultLineSchema = v.object({
  event: v.literal("result"),
  result: v.object({
    conversation_id: v.optional(v.string()),
    status: v.optional(v.string()),
    response: v.optional(v.string()),
    error: v.optional(v.string()),
    finished_reason: v.optional(v.string()),
    denied_actions: v.optional(v.array(JsonValueSchema)),
    usage: v.optional(AgyUsageSchema),
    duration_seconds: v.optional(v.number()),
  }),
});
type ResultLine = Output<typeof ResultLineSchema>["result"];

const InitLineTextSchema = jsonText(InitLineSchema);
const ResultLineTextSchema = jsonText(ResultLineSchema);

/** agy started without a shell, its output into files and its own process
 * group (DR-0018 §3.5), standard input a pipe the daemon writes requests to. */
function spawnAgy(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  out: number,
  err: number,
) {
  return Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: out, stderr: err, detached: true });
}
type AgyProcess = ReturnType<typeof spawnAgy>;

// --- the parts that depend on where agy runs ------------------------------------------

/** What the daemon reads of and does to agy's processes beyond its own
 * children's pipes and exits, each a function whose body follows where agy
 * runs (the host's process list, a container). */
export interface AgyProcessView {
  /** The start time of the process the daemon just started, for its record
   * (Q22); undefined when it is not read. */
  startedAt(pid: number): Promise<string | undefined>;
  /** Processes other than `own` that hold conversation `agyid` open, for the
   * check before a start and after its init (§6, K10, K13). */
  othersOf(agyid: string, own: number | undefined): Promise<readonly { pid: number }[]>;
  /** Stop the later of two processes of one conversation (K13): `own` is
   * whether it is the daemon's own child. */
  stopDuplicate(pid: number, own: boolean): Promise<void>;
  /** Send the abort's signal to the conversation's process (§9). `sent`
   * false says why nothing was sent. */
  interrupt(process: AgyProcessRecord): Promise<{ sent: true } | { sent: false; why: string }>;
  /** Whether a process an earlier daemon started still runs (§10). */
  survivor(process: AgyProcessRecord): Promise<"alive" | "gone" | "unknown">;
}

/** Whether process `pid` runs: one that is not ours (EPERM) runs too. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/** The view until where agy runs settles its shape: no other process is
 * looked for, no signal is sent by an abort, and a recorded process counts as
 * gone only when its pid is not there at all. */
export function placeholderProcessView(): AgyProcessView {
  return {
    startedAt: async () => undefined,
    othersOf: async () => [],
    stopDuplicate: async () => {},
    interrupt: async () => ({
      sent: false,
      why: "中断の信号の送り先がまだ入っていない (agy を動かす所の形に合わせて入れる)",
    }),
    survivor: async (process) => {
      try {
        globalThis.process.kill(process.pid, 0);
        return "unknown";
      } catch {
        return "gone";
      }
    },
  };
}

// --- what the daemon gives it -------------------------------------------------------

/** Where a response goes: the session, and the subagent / teammate when one
 * asked. */
export interface AgyTo {
  sid: string;
  agentId?: string;
}

export type AgyDelivery = { delivered: true } | { delivered: false; reason: string };

export interface AgyDeps {
  /** `<stateDir>/agy`. */
  dir: string;
  config: AgyConfig | undefined;
  baseEnv: Readonly<Record<string, string | undefined>>;
  now(): number;
  log: { info(msg: string): void; error(msg: string): void };
  /** Append `text` under `mark` into the conversation `to`, then wake it
   * (§7). */
  deliver(to: AgyTo, mark: string, text: string): Promise<AgyDelivery>;
  processes: AgyProcessView;
  initWaitMs?: number;
  abortWaitMs?: number;
}

export type AgyRefusal = { ok: false; code: string; msg: string };
export type AgyAnswer<T> = { ok: true; value: T } | AgyRefusal;

function refused(code: string, msg: string): AgyRefusal {
  return { ok: false, code, msg };
}

// --- one conversation in memory ------------------------------------------------------

/** A process this daemon started, whose standard input it holds. */
interface Live {
  proc: AgyProcess;
  /** The line is written once the start's init came. */
  ready: boolean;
  aborting: boolean;
  exited: Promise<number | null>;
}

interface Conversation {
  record: ConversationRecord;
  requests: Map<number, RequestRecord>;
  live?: Live;
  tail?: Tail;
  /** The run and abort of this conversation, one at a time (§6). */
  chain: Promise<void>;
}

/** How often a live process's output file is looked at for what it grew by
 * (§5).
 *
 * Design rationale: a timer rather than a change notification alone. agy
 * writes its output through the file it was started with and keeps it open;
 * on macOS, Bun's fs.watch reports no append made through another process's
 * open descriptor, only the file's close (measured: a child writing three
 * lines a second apart got no event until it exited, whether the file, its
 * directory or their real paths were watched). No other primitive Bun offers
 * reports such an append. The interval bounds how late a result is read: agy
 * writes a turn's lines as each step ends and its last response's pieces
 * about 50 ms apart (A19), and a turn takes seconds to tens of minutes, so a
 * fifth of a second adds little to a response's way, and one stat a fifth of
 * a second for each live process costs the daemon little. */
export const AGY_OUTPUT_READ_INTERVAL_MS = 200;

/** Reading a run's stdout.jsonl from where it was left: every
 * AGY_OUTPUT_READ_INTERVAL_MS, on each change the directory's watch reports
 * (a close), and once more when told the process ended (§5). */
class Tail {
  private watcher: fs.FSWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private partial = "";
  private reading: Promise<void> = Promise.resolve();
  constructor(
    private readonly file: string,
    public offset: number,
    private readonly onLine: (line: string, endOffset: number) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    const name = path.basename(this.file);
    this.watcher = fs.watch(path.dirname(this.file), (_event, changed) => {
      if (changed === null || changed === name) void this.read();
    });
    this.timer = setInterval(() => void this.read(), AGY_OUTPUT_READ_INTERVAL_MS);
    void this.read();
  }

  /** Read what is there now, after any read under way. */
  read(): Promise<void> {
    this.reading = this.reading.then(() => this.readOnce()).catch(this.onError);
    return this.reading;
  }

  /** The bytes read up to the last whole line: where a reader taking over
   * starts. */
  consumed(): number {
    return this.offset - Buffer.byteLength(this.partial);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves once the read under way, and the lines it hands on, are done. */
  idle(): Promise<void> {
    return this.reading;
  }

  private async readOnce(): Promise<void> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.file, "r");
    } catch {
      return;
    }
    try {
      const size = (await handle.stat()).size;
      if (size <= this.offset) return;
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      let at = this.offset - Buffer.byteLength(this.partial);
      const text = this.partial + buffer.subarray(0, bytesRead).toString("utf8");
      this.offset += bytesRead;
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      for (const line of lines) {
        at += Buffer.byteLength(line) + 1;
        if (line.trim() !== "") await this.onLine(line, at);
      }
    } finally {
      await handle.close();
    }
  }
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

/** Each field of `now` less the same field of `before` (Q20). */
function usageDifference(now: AgyUsage, before: AgyUsage | undefined): AgyUsage {
  if (before === undefined) return now;
  const own: Record<string, number> = {};
  for (const [key, value] of Object.entries(now)) own[key] = value - (before[key] ?? 0);
  return own;
}

/** The text the quota's refusal gives for when it comes back (A13). */
function quotaText(text: string): string | undefined {
  if (!text.includes("quota")) return undefined;
  return /Resets in [^\n.]+/.exec(text)?.[0] ?? text.split("\n")[0];
}

export class AgyConversations {
  private readonly conversations = new Map<string, Conversation>();
  private shuttingDown = false;
  private readonly initWaitMs: number;
  private readonly abortWaitMs: number;

  constructor(private readonly deps: AgyDeps) {
    this.initWaitMs = deps.initWaitMs ?? AGY_INIT_WAIT_MS;
    this.abortWaitMs = deps.abortWaitMs ?? AGY_ABORT_WAIT_MS;
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private convDir(agyid: string): string {
    return path.join(this.deps.dir, agyid);
  }

  private liveCount(): number {
    let n = 0;
    for (const c of this.conversations.values()) if (c.live !== undefined) n++;
    return n;
  }

  // --- the files ----------------------------------------------------------------

  /** The writes of each file under way, one after another. */
  private readonly writes = new Map<string, Promise<void>>();

  /** Replace `file` with `text` whole (through a temporary file and a
   * rename), after the writes of the same file asked before: a record saved
   * twice at once ends as the later save. The temporary file's name is the
   * write's own, so a write of another instance (the next daemon reading on
   * while this one records an end) never renames it away. */
  private writeFile(file: string, text: string): Promise<void> {
    const write = async (): Promise<void> => {
      // Beside the conversations rather than in one: a conversation's
      // directory holds its records alone, whenever it is read.
      const tmpDir = path.join(this.deps.dir, ".writing");
      await fs.promises.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const tmp = path.join(
        tmpDir,
        `${path.relative(this.deps.dir, file).replaceAll("/", "_")}.${String(process.pid)}-${randomBytes(4).toString("hex")}.tmp`,
      );
      await fs.promises.writeFile(tmp, text, { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    };
    const done = (this.writes.get(file) ?? Promise.resolve()).then(write, write);
    const settled = done.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(file, settled);
    void settled.then(() => {
      if (this.writes.get(file) === settled) this.writes.delete(file);
    });
    return done;
  }

  /** Remove the temporary files in `.writing` whose writer (the pid in the
   * name writeFile gives) is no longer running, and any not named so. */
  private async removeLeftWrites(): Promise<void> {
    const tmpDir = path.join(this.deps.dir, ".writing");
    let names: string[];
    try {
      names = await fs.promises.readdir(tmpDir);
    } catch {
      return;
    }
    for (const name of names) {
      const pid = Number(name.match(/\.(\d+)-[0-9a-f]+\.tmp$/)?.[1]);
      if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) continue;
      await fs.promises.rm(path.join(tmpDir, name), { force: true });
    }
  }

  private async saveConversation(c: Conversation): Promise<void> {
    await this.writeFile(
      path.join(this.convDir(c.record.agyid), "conversation.json"),
      JSON.stringify(c.record),
    );
  }

  private async saveRequest(c: Conversation, r: RequestRecord): Promise<void> {
    await this.writeFile(
      path.join(this.convDir(c.record.agyid), `request-${String(r.seq)}.json`),
      JSON.stringify(r),
    );
  }

  /** The conversations in the state dir, read at the daemon's start: the
   * records' expired directories and outputs removed (§4), and the processes
   * an earlier daemon started followed on (§10). */
  async load(): Promise<void> {
    let names: string[];
    // What a start left before its init named the conversation, and the
    // writes a daemon that fell left unrenamed. A write of a daemon that still
    // runs (the one this one takes over from, recording an end) is its own to
    // rename, so only the writes of processes gone are removed.
    await fs.promises.rm(path.join(this.deps.dir, ".starting"), { recursive: true, force: true });
    await this.removeLeftWrites();
    try {
      names = await fs.promises.readdir(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const c = await this.read(name);
      if (c === undefined) continue;
      if (await this.expired(c)) continue;
      this.conversations.set(c.record.agyid, c);
      if (c.record.process !== undefined) await this.followSurvivor(c, c.record.process);
    }
  }

  private async read(agyid: string): Promise<Conversation | undefined> {
    const dir = this.convDir(agyid);
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(dir, "conversation.json"), "utf8");
    } catch {
      return undefined;
    }
    const record = parseWith(ConversationRecordTextSchema, text);
    if (!record.ok) {
      this.deps.log.error(`agy: ${agyid}: record unreadable: ${record.failure.summary}`);
      return undefined;
    }
    const requests = new Map<number, RequestRecord>();
    for (const file of await fs.promises.readdir(dir)) {
      if (!/^request-\d+\.json$/.test(file)) continue;
      const read = parseWith(
        RequestRecordTextSchema,
        await fs.promises.readFile(path.join(dir, file), "utf8"),
      );
      if (read.ok) requests.set(read.value.seq, read.value);
      else this.deps.log.error(`agy: ${agyid}/${file} unreadable: ${read.failure.summary}`);
    }
    return { record: record.value, requests, chain: Promise.resolve() };
  }

  /** Remove what has outlived its lifetime (§4); true when the conversation
   * itself went. A conversation with a process is kept. */
  private async expired(c: Conversation): Promise<boolean> {
    const now = this.deps.now();
    const dir = this.convDir(c.record.agyid);
    if (
      c.record.process === undefined &&
      now - Date.parse(c.record.last_at) > AGY_CONVERSATION_TTL_MS
    ) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      this.deps.log.info(
        `agy: ${c.record.agyid}: removed after ${String(AGY_CONVERSATION_TTL_MS / 86_400_000)} days`,
      );
      return true;
    }
    const kept: Record<string, string> = {};
    for (const [run, at] of Object.entries(c.record.ended_runs ?? {})) {
      if (now - Date.parse(at) <= AGY_OUTPUT_TTL_MS) kept[run] = at;
      else await fs.promises.rm(path.join(dir, run), { recursive: true, force: true });
    }
    c.record = { ...c.record, ended_runs: kept };
    return false;
  }

  // --- run (§6) --------------------------------------------------------------------

  /** Take a run from session `sid` (`agentId` when its subagent / teammate
   * asked); `sessionCwd` is the session's project directory, the default of
   * `cwd` and `dirs`. */
  async run(
    sid: string,
    run: AgyRunNew | AgyRunMore,
    agentId: string | undefined,
    sessionCwd: string | undefined,
  ): Promise<AgyAnswer<AgyRunResponse>> {
    const config = this.deps.config;
    if (config === undefined)
      return refused(AgyErrorCode.agy_not_configured, "config に agy の節が無い");
    if (this.shuttingDown) return refused(AgyErrorCode.agy_shutting_down, "daemon is stopping");
    const to: AgyTo = { sid, ...(agentId !== undefined ? { agentId } : {}) };
    if (!("agyid" in run)) return await this.runNew(config, to, run, sessionCwd);
    const c = this.conversations.get(run.agyid);
    if (c === undefined) {
      return refused(AgyErrorCode.agy_unknown_conversation, `agyid ${run.agyid}`);
    }
    return await this.serially(c, () => this.runMore(config, c, to, run));
  }

  private serially<T>(c: Conversation, act: () => Promise<T>): Promise<T> {
    const done = c.chain.then(act);
    c.chain = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  private async runNew(
    config: AgyConfig,
    to: AgyTo,
    run: AgyRunNew,
    sessionCwd: string | undefined,
  ): Promise<AgyAnswer<AgyRunResponse>> {
    const unkept = (run.dirs ?? []).findIndex((d) => !d.write || d.containerpath !== undefined);
    if (unkept >= 0) {
      return refused(
        AgyErrorCode.agy_dirs_unsupported,
        `dirs[${String(unkept)}] (write: false か containerpath)`,
      );
    }
    const cwd = run.cwd ?? sessionCwd;
    if (cwd === undefined)
      return refused("invalid_args", "cwd が無く、呼んだセッションの cwd も分からない");
    const dirs: AgyDir[] = run.dirs !== undefined ? [...run.dirs] : [{ path: cwd, write: true }];
    for (const dir of [cwd, ...dirs.map((d) => d.path)]) {
      const stat = await fs.promises.stat(dir).catch(() => undefined);
      if (stat?.isDirectory() !== true)
        return refused("invalid_args", `${dir} はディレクトリでない`);
    }
    const settings = {
      model: run.model,
      ...(run.effort !== undefined ? { effort: run.effort } : {}),
      cwd,
      dirs,
    };
    const started = await this.start(config, settings, undefined);
    if (!started.ok) return started;
    const { agyid, live, tail, runName, pid, startedAt, argv } = started.value;
    const now = this.iso();
    const c: Conversation = {
      record: {
        agyid,
        created_at: now,
        created_by: to.sid,
        ...settings,
        last_at: now,
        process: {
          pid,
          ...(startedAt !== undefined ? { started_at: startedAt } : {}),
          argv,
          run: runName,
          offset: tail.offset,
        },
      },
      requests: new Map(),
      live,
      tail,
      chain: Promise.resolve(),
    };
    this.conversations.set(agyid, c);
    this.watchExit(c, live, runName);
    await fs.promises.mkdir(this.convDir(agyid), { recursive: true, mode: 0o700 });
    await this.adoptRunDir(agyid, runName);
    await this.saveConversation(c);
    return await this.serially(c, () => this.write(c, to, run.prompt, run.verbose === true));
  }

  private async runMore(
    config: AgyConfig,
    c: Conversation,
    to: AgyTo,
    run: AgyRunMore,
  ): Promise<AgyAnswer<AgyRunResponse>> {
    if (c.live === undefined && c.record.process !== undefined) {
      return refused(
        AgyErrorCode.agy_conversation_busy,
        `pid ${String(c.record.process.pid)}、${this.pending(c) > 0 ? "ターン中" : "ターン中でない"}`,
      );
    }
    if (c.live === undefined) {
      const others = await this.deps.processes.othersOf(c.record.agyid, undefined);
      if (others.length > 0) {
        return refused(
          AgyErrorCode.agy_conversation_busy,
          `ccmsg の外のプロセス (pid ${others.map((o) => String(o.pid)).join(", ")})`,
        );
      }
      const started = await this.start(config, c.record, c.record.agyid);
      if (!started.ok) return started;
      const { live, tail, runName, pid, startedAt, argv } = started.value;
      c.live = live;
      c.tail = tail;
      c.record = {
        ...c.record,
        process: {
          pid,
          ...(startedAt !== undefined ? { started_at: startedAt } : {}),
          argv,
          run: runName,
          offset: tail.offset,
        },
      };
      this.watchExit(c, live, runName);
      await this.adoptRunDir(c.record.agyid, runName);
      await this.saveConversation(c);
    }
    return await this.write(c, to, run.prompt, run.verbose === true);
  }

  /** The requests of the conversation with no result yet, in order. */
  private open(c: Conversation): RequestRecord[] {
    return [...c.requests.values()]
      .filter((r) => r.result === undefined && r.end === undefined)
      .sort((a, b) => a.seq - b.seq);
  }

  private pending(c: Conversation): number {
    return this.open(c).length;
  }

  /** Record the request, write its line, record that it was written (§6). */
  private async write(
    c: Conversation,
    to: AgyTo,
    prompt: string,
    verbose: boolean,
  ): Promise<AgyAnswer<AgyRunResponse>> {
    const live = c.live;
    if (live === undefined)
      return refused(AgyErrorCode.agy_not_started, "process ended before the write");
    const ahead = this.pending(c);
    const seq = Math.max(0, ...c.requests.keys()) + 1;
    const r: RequestRecord = {
      seq,
      received_at: this.iso(),
      to: { sid: to.sid, ...(to.agentId !== undefined ? { agent_id: to.agentId } : {}) },
      verbose,
      prompt_bytes: Buffer.byteLength(prompt),
      written: "no",
    };
    c.requests.set(seq, r);
    await this.saveRequest(c, r);
    try {
      await live.proc.stdin.write(
        `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
      );
      await live.proc.stdin.flush();
    } catch (e) {
      c.requests.delete(seq);
      await fs.promises.rm(path.join(this.convDir(c.record.agyid), `request-${String(seq)}.json`), {
        force: true,
      });
      return refused(AgyErrorCode.agy_not_started, `agy に書けなかった: ${errorText(e)}`);
    }
    const writtenAt = this.iso();
    const written: RequestRecord = { ...r, written: "yes", written_at: writtenAt };
    c.requests.set(seq, written);
    c.record = { ...c.record, last_at: writtenAt };
    await this.saveRequest(c, written);
    await this.saveConversation(c);
    this.deps.log.info(
      `agy_run: ${to.sid}${to.agentId !== undefined ? ` agent ${to.agentId}` : ""} ${c.record.agyid} seq ${String(seq)} prompt ${String(r.prompt_bytes)} bytes, ${String(ahead)} ahead`,
    );
    return { ok: true, value: { ok: true, agyid: c.record.agyid, seq, ahead } };
  }

  /** agy's arguments for a conversation of `settings` (§2). */
  private argv(
    config: AgyConfig,
    settings: { model: string; effort?: string; cwd: string; dirs: readonly AgyDir[] },
    agyid: string | undefined,
  ): string[] {
    return [
      ...config.command,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--model",
      settings.model,
      ...(settings.effort !== undefined ? ["--effort", settings.effort] : []),
      ...settings.dirs.filter((d) => d.path !== settings.cwd).flatMap((d) => ["--add-dir", d.path]),
      ...(agyid !== undefined ? ["--conversation", agyid] : []),
    ];
  }

  /** Start agy and wait for its init (§6): the conversation's id it gives,
   * or why it did not start. `agyid` is the conversation it resumes. */
  private async start(
    config: AgyConfig,
    settings: { model: string; effort?: string; cwd: string; dirs: readonly AgyDir[] },
    agyid: string | undefined,
  ): Promise<
    AgyAnswer<{
      agyid: string;
      live: Live;
      tail: Tail;
      runName: string;
      pid: number;
      startedAt: string | undefined;
      argv: string[];
    }>
  > {
    const runName = `run-${String(this.deps.now())}-${String(Math.floor(Math.random() * 1e6))}`;
    // Until the init names the conversation, a new one's run lives in the
    // state dir's own directory; adoptRunDir moves it under the conversation.
    const runDir = path.join(this.deps.dir, ".starting", runName);
    await fs.promises.mkdir(runDir, { recursive: true, mode: 0o700 });
    const stdoutFile = path.join(runDir, "stdout.jsonl");
    const stderrFile = path.join(runDir, "stderr");
    const argv = this.argv(config, settings, agyid);
    const out = fs.openSync(stdoutFile, "a", 0o600);
    const err = fs.openSync(stderrFile, "a", 0o600);
    let proc: AgyProcess;
    try {
      // Its output goes into files, which it goes on writing after this
      // daemon is gone (§5).
      proc = spawnAgy(
        argv,
        settings.cwd,
        withTmpdir(
          withoutEnvPatterns(this.deps.baseEnv, config.clean_env, config.keep_env),
          userTempDir(),
        ),
        out,
        err,
      );
    } catch (e) {
      await fs.promises.rm(runDir, { recursive: true, force: true });
      return refused(AgyErrorCode.agy_not_started, `agy を起こせなかった: ${errorText(e)}`);
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
    const live: Live = {
      proc,
      ready: false,
      aborting: false,
      exited: proc.exited.then((code) => code),
    };
    const init = Promise.withResolvers<
      { kind: "init"; id: string } | { kind: "failed"; text: string }
    >();
    const tail = new Tail(
      stdoutFile,
      0,
      async (line) => {
        if (live.ready) return;
        const id = parseWith(InitLineTextSchema, line);
        if (id.ok) {
          const found = id.value.conversation_id ?? id.value.init?.conversation_id;
          init.resolve(
            found !== undefined && found !== ""
              ? { kind: "init", id: found }
              : { kind: "failed", text: "init に conversation_id が無い" },
          );
          return;
        }
        // A result before the init: agy did not start (A23, A24).
        const result = parseWith(ResultLineTextSchema, line);
        if (result.ok)
          init.resolve({ kind: "failed", text: result.value.result.error ?? "init の前に result" });
      },
      (e) => this.deps.log.error(`agy: reading a start's output failed: ${errorText(e)}`),
    );
    tail.start();
    this.deps.log.info(
      `agy: started pid ${String(proc.pid)} (${String(this.liveCount() + 1)} live)`,
    );
    const timer = setTimeout(
      () =>
        init.resolve({
          kind: "failed",
          text: `init が ${String(this.initWaitMs / 1000)} 秒の内に出なかった`,
        }),
      this.initWaitMs,
    );
    void live.exited.then(async (code) => {
      await tail.read();
      const said = await fs.promises.readFile(stdoutFile, "utf8").catch(() => "");
      init.resolve({
        kind: "failed",
        text: `init の前に終わった (終了コード ${String(code)}${said.trim() !== "" ? `、標準出力: ${utf8Tail(said.trim(), FAILURE_TEXT_MAX_BYTES)}` : ""})`,
      });
    });
    const got = await init.promise;
    clearTimeout(timer);
    if (got.kind === "failed" || (agyid !== undefined && got.id !== agyid)) {
      tail.stop();
      this.stopGroup(proc.pid, live);
      const stderr = await fs.promises.readFile(stderrFile, "utf8").catch(() => "");
      // Answered once the start is gone (SIGKILL follows within 500 ms), so a
      // refused run leaves no process and no output behind.
      await live.exited;
      await this.removeStart(runDir);
      if (got.kind === "init") {
        return refused(AgyErrorCode.agy_conversation_mismatch, `init の ID が ${got.id}`);
      }
      const said = utf8Tail(stderr.trim(), FAILURE_TEXT_MAX_BYTES);
      return refused(AgyErrorCode.agy_not_started, said !== "" ? `${got.text}: ${said}` : got.text);
    }
    const others = await this.deps.processes.othersOf(got.id, proc.pid);
    if (others.length > 0) {
      // K13 needs start times, which the process view does not read yet: the
      // daemon's own, which it has not written to, is the one stopped.
      await this.deps.processes.stopDuplicate(proc.pid, true);
      tail.stop();
      void live.exited.then(() => this.removeStart(runDir));
      return refused(
        AgyErrorCode.agy_duplicate_stopped,
        `相手は pid ${others.map((o) => String(o.pid)).join(", ")}`,
      );
    }
    live.ready = true;
    return {
      ok: true,
      value: {
        agyid: got.id,
        live,
        tail,
        runName,
        pid: proc.pid,
        startedAt: await this.deps.processes.startedAt(proc.pid),
        argv,
      },
    };
  }

  /** Remove a start's run directory, and the starts' directory once no
   * other start is in it. */
  private async removeStart(runDir: string): Promise<void> {
    await fs.promises.rm(runDir, { recursive: true, force: true });
    await fs.promises.rmdir(path.dirname(runDir)).catch(() => {
      // Another start's run is in it, or it is gone already.
    });
  }

  /** SIGTERM to a start's process group, SIGKILL 500 ms after (§6). */
  private stopGroup(pid: number, live: Live): void {
    const signal = (s: NodeJS.Signals): void => {
      try {
        process.kill(-pid, s);
      } catch {
        // ESRCH: the group is gone.
      }
    };
    signal("SIGTERM");
    const kill = setTimeout(() => signal("SIGKILL"), 500);
    void live.exited.then(() => clearTimeout(kill));
  }

  /** Move a run's directory under its conversation once the init named it. */
  private async adoptRunDir(agyid: string, runName: string): Promise<void> {
    const from = path.join(this.deps.dir, ".starting", runName);
    const to = path.join(this.convDir(agyid), runName);
    await fs.promises.mkdir(this.convDir(agyid), { recursive: true, mode: 0o700 });
    // The open files go on writing to the moved inode; the tail reads the
    // file by its new name from then on.
    await fs.promises.rename(from, to);
    const c = this.conversations.get(agyid);
    if (c?.tail !== undefined && c.live !== undefined) {
      const offset = c.tail.consumed();
      c.tail.stop();
      c.tail = new Tail(
        path.join(to, "stdout.jsonl"),
        offset,
        (line, end) => this.onLine(c, line, end),
        this.reportError(c),
      );
      c.tail.start();
    }
  }

  // --- reading results (§5, §7) ------------------------------------------------------

  private exitWatched = new WeakSet<Live>();

  /** Once the process the daemon started ends: read the rest, and end the
   * requests left without a result (§7). */
  /** What a failure in reading or recording a conversation's output says,
   * in the daemon's log: the work goes on in the background, with no asker
   * to answer. */
  private reportError(c: Conversation): (error: unknown) => void {
    return (e) => this.deps.log.error(`agy: ${c.record.agyid}: ${errorText(e)}`);
  }

  /** The ends of processes being recorded (watchExit). */
  private readonly ending = new Set<Promise<void>>();

  /** The responses being delivered and recorded (deliverBody). */
  private readonly delivering = new Set<Promise<void>>();

  /** Resolves once the output reads under way are done, the ends of the
   * processes that have exited are recorded and delivered, the responses
   * being delivered are recorded, and the
   * records being written are on disk (for tests: the records read back after
   * a process ended, the state dir removed after). Waits again while any of
   * them started another (a delivery's record, the conversation's record
   * saved after it), until none is under way. */
  async endsRecorded(): Promise<void> {
    // The output reads under way, and what they hand on.
    await Promise.allSettled(
      [...this.conversations.values()].flatMap((c) =>
        c.tail !== undefined ? [c.tail.idle()] : [],
      ),
    );
    for (;;) {
      const under = [...this.ending, ...this.delivering, ...this.writes.values()];
      if (under.length === 0) return;
      await Promise.allSettled(under);
    }
  }

  private watchExit(c: Conversation, live: Live, runName: string): void {
    if (this.exitWatched.has(live)) return;
    this.exitWatched.add(live);
    const ending = live.exited
      .then(async (code) => {
        await c.tail?.read();
        c.tail?.stop();
        const stderr = await fs.promises
          .readFile(path.join(this.convDir(c.record.agyid), runName, "stderr"), "utf8")
          .catch(() => "");
        await this.ended(c, live.aborting ? "aborted_unstarted" : "no_response", code, stderr);
        if (c.live === live) c.live = undefined;
        this.deps.log.info(
          `agy: ${c.record.agyid} pid ${String(live.proc.pid)} exited ${String(code)} (${String(this.liveCount())} live)`,
        );
      })
      .catch(this.reportError(c));
    this.ending.add(ending);
    void ending.finally(() => this.ending.delete(ending));
  }

  /** The process is gone: the requests left without a result end as `end`. */
  private async ended(
    c: Conversation,
    end: AgyEndError,
    code: number | null | undefined,
    stderr: string,
  ): Promise<void> {
    const said = utf8Tail(stderr.trim(), FAILURE_TEXT_MAX_BYTES);
    const quota = quotaText(said);
    if (quota !== undefined) c.record = { ...c.record, quota: { text: quota, at: this.iso() } };
    for (const open of this.open(c)) {
      const r: RequestRecord = {
        ...open,
        end: open.written === "no" ? "unconfirmed_write" : end,
        end_text: `${code === undefined ? "終了コード不明" : `終了コード ${String(code)}`}${said !== "" ? `: ${said}` : ""}`,
      };
      c.requests.set(r.seq, r);
      await this.saveRequest(c, r);
      await this.deliverEnd(c, r);
    }
    const { process: gone, ...rest } = c.record;
    c.record = {
      ...rest,
      ...(gone !== undefined ? { ended_runs: { ...rest.ended_runs, [gone.run]: this.iso() } } : {}),
      last_at: this.iso(),
    };
    await this.saveConversation(c);
  }

  /** One line of the conversation's output: a result is the oldest open
   * request's, delivered before the read point moves past it (§7: a daemon
   * that falls between delivers it again rather than lose it). */
  private async onLine(c: Conversation, line: string, endOffset: number): Promise<void> {
    const read = parseWith(ResultLineTextSchema, line);
    if (read.ok) await this.onResult(c, read.value.result, endOffset);
    else this.advance(c, endOffset);
  }

  private advance(c: Conversation, endOffset: number): void {
    const process = c.record.process;
    if (process !== undefined)
      c.record = { ...c.record, process: { ...process, offset: endOffset } };
  }

  private async onResult(c: Conversation, result: ResultLine, endOffset: number): Promise<void> {
    const open = this.open(c)[0];
    if (open === undefined) {
      this.deps.log.error(`agy: ${c.record.agyid}: a result with no request open`);
      return;
    }
    const at = this.iso();
    const usage = result.usage;
    const r: RequestRecord = {
      ...open,
      result: {
        at,
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.finished_reason !== undefined
          ? { finished_reason: result.finished_reason }
          : {}),
        ...(result.response !== undefined ? { response: result.response } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.denied_actions !== undefined ? { denied_actions: result.denied_actions } : {}),
        ...(usage !== undefined
          ? { usage, usage_own: usageDifference(usage, c.record.usage_total) }
          : {}),
        ...(result.duration_seconds !== undefined
          ? { duration_seconds: result.duration_seconds }
          : {}),
      },
    };
    c.requests.set(r.seq, r);
    const quota = result.error !== undefined ? quotaText(result.error) : undefined;
    c.record = {
      ...c.record,
      ...(usage !== undefined ? { usage_total: usage } : {}),
      ...(quota !== undefined ? { quota: { text: quota, at } } : {}),
      last_at: at,
    };
    await this.saveRequest(c, r);
    await this.deliverResult(c, r);
    this.advance(c, endOffset);
    await this.saveConversation(c);
  }

  /** The response's text as delivered and shown: inline, or the file it is
   * kept in when it is long (§7, Q7). */
  private async responseText(c: Conversation, r: RequestRecord): Promise<string | undefined> {
    const response = r.result?.response;
    if (response === undefined) return undefined;
    const bytes = Buffer.byteLength(response);
    if (bytes < AGY_RESPONSE_INLINE_MAX_BYTES) return response;
    const file = path.join(this.convDir(c.record.agyid), `response-${String(r.seq)}.txt`);
    if (!fs.existsSync(file)) await this.writeFile(file, response);
    return `output is ${String(bytes)} bytes, file: ${file}`;
  }

  /** A request's result as status and the delivered body say it (§7, §8). */
  private async resultView(
    c: Conversation,
    r: RequestRecord,
    verbose: boolean,
  ): Promise<AgyResultView> {
    const result = r.result;
    const response = await this.responseText(c, r);
    const own =
      verbose && result?.at !== undefined && r.written_at !== undefined
        ? (Date.parse(result.at) - Date.parse(r.written_at)) / 1000
        : undefined;
    return {
      seq: r.seq,
      at: result?.at ?? r.received_at,
      ...(result?.status !== undefined ? { status: result.status } : {}),
      ...(result?.finished_reason !== undefined ? { finished_reason: result.finished_reason } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(result?.error !== undefined
        ? { error: result.error }
        : r.end !== undefined
          ? { error: endText(r) }
          : {}),
      ...(verbose && result?.usage_own !== undefined ? { usage: result.usage_own } : {}),
      ...(own !== undefined ? { duration_seconds: own } : {}),
      ...(verbose && result?.denied_actions !== undefined
        ? { denied_actions: result.denied_actions }
        : {}),
    };
  }

  private async deliverResult(c: Conversation, r: RequestRecord): Promise<void> {
    const view = await this.resultView(c, r, r.verbose);
    const body =
      r.verbose && c.record.usage_total !== undefined
        ? { ...view, usage_total: c.record.usage_total }
        : view;
    await this.deliverBody(c, r, JSON.stringify(body));
  }

  private async deliverEnd(c: Conversation, r: RequestRecord): Promise<void> {
    await this.deliverBody(c, r, JSON.stringify({ seq: r.seq, error: endText(r) }));
  }

  /** A response's delivery and the record of it, kept while it runs
   * (endsRecorded waits for them). */
  private async deliverBody(c: Conversation, r: RequestRecord, body: string): Promise<void> {
    const delivering = this.deliverAndRecord(c, r, body);
    this.delivering.add(delivering);
    try {
      await delivering;
    } finally {
      this.delivering.delete(delivering);
    }
  }

  private async deliverAndRecord(c: Conversation, r: RequestRecord, body: string): Promise<void> {
    const to: AgyTo = {
      sid: r.to.sid,
      ...(r.to.agent_id !== undefined ? { agentId: r.to.agent_id } : {}),
    };
    let got: AgyDelivery;
    try {
      got = await this.deps.deliver(to, agyMark(c.record.agyid), body);
    } catch (e) {
      got = { delivered: false, reason: errorText(e) };
    }
    const delivered: RequestRecord = {
      ...r,
      delivered: got.delivered ? "yes" : { not: got.reason },
    };
    c.requests.set(r.seq, delivered);
    await this.saveRequest(c, delivered);
    this.deps.log.info(
      `agy: ${c.record.agyid} seq ${String(r.seq)} ${r.result?.status ?? r.end ?? "?"} to ${to.sid}${to.agentId !== undefined ? ` agent ${to.agentId}` : ""}: ${got.delivered ? "delivered" : `not delivered (${got.reason})`}`,
    );
  }

  // --- an earlier daemon's process (§10) --------------------------------------------

  private async followSurvivor(c: Conversation, record: AgyProcessRecord): Promise<void> {
    const file = path.join(this.convDir(c.record.agyid), record.run, "stdout.jsonl");
    const tail = new Tail(
      file,
      record.offset,
      (line, end) => this.onLine(c, line, end),
      this.reportError(c),
    );
    c.tail = tail;
    const state = await this.deps.processes.survivor(record);
    if (state === "gone") {
      await tail.read();
      const stderr = await fs.promises
        .readFile(path.join(this.convDir(c.record.agyid), record.run, "stderr"), "utf8")
        .catch(() => "");
      await this.ended(c, "no_response", undefined, stderr);
      c.tail = undefined;
      return;
    }
    // Alive, or not known to be gone: its results are read as they come; its
    // end is the process view's to tell (§10).
    tail.start();
  }

  // --- status (§8) ------------------------------------------------------------------

  async status(
    sid: string,
    asked: { agyid: string; seq?: number; verbose?: boolean } | null,
  ): Promise<AgyAnswer<AgyStatusOneResponse | AgyStatusListResponse>> {
    if (this.deps.config === undefined)
      return refused(AgyErrorCode.agy_not_configured, "config に agy の節が無い");
    if (asked === null) {
      const conversations = [...this.conversations.values()]
        .filter((c) => c.record.created_by === sid)
        .sort((a, b) => b.record.created_at.localeCompare(a.record.created_at))
        .slice(0, AGY_LIST_MAX)
        .map((c) => ({
          agyid: c.record.agyid,
          created_at: c.record.created_at,
          pending: this.pending(c),
        }));
      return { ok: true, value: { ok: true, conversations } };
    }
    const c = this.conversations.get(asked.agyid);
    if (c === undefined)
      return refused(AgyErrorCode.agy_unknown_conversation, `agyid ${asked.agyid}`);
    const verbose = asked.verbose === true;
    const done = [...c.requests.values()]
      .filter((r) => r.result !== undefined || r.end !== undefined)
      .sort((a, b) => a.seq - b.seq);
    const target = asked.seq !== undefined ? c.requests.get(asked.seq) : done.at(-1);
    if (asked.seq !== undefined && target === undefined) {
      return refused("not_found", `seq ${String(asked.seq)} はこの会話に無い`);
    }
    const lastResult = done.at(-1)?.result?.at;
    const record = c.record;
    return {
      ok: true,
      value: {
        ok: true,
        agyid: record.agyid,
        process: record.process !== undefined ? "running" : "none",
        pending: this.pending(c),
        undelivered: [...c.requests.values()]
          .filter((r) => typeof r.delivered === "object")
          .map((r) => r.seq)
          .sort((a, b) => a - b),
        ...(target !== undefined ? { result: await this.resultView(c, target, verbose) } : {}),
        ...(verbose
          ? {
              model: record.model,
              ...(record.effort !== undefined ? { effort: record.effort } : {}),
              cwd: record.cwd,
              dirs: record.dirs,
              created_at: record.created_at,
              ...(record.usage_total !== undefined ? { usage_total: record.usage_total } : {}),
              ...(lastResult !== undefined
                ? { idle_seconds: Math.round((this.deps.now() - Date.parse(lastResult)) / 1000) }
                : {}),
              ...(record.quota !== undefined ? { quota: record.quota } : {}),
            }
          : {}),
      },
    };
  }

  // --- abort (§9) --------------------------------------------------------------------

  async abort(agyid: string): Promise<AgyAnswer<AgyAbortResponse>> {
    if (this.deps.config === undefined)
      return refused(AgyErrorCode.agy_not_configured, "config に agy の節が無い");
    if (this.shuttingDown) return refused(AgyErrorCode.agy_shutting_down, "daemon is stopping");
    const c = this.conversations.get(agyid);
    if (c === undefined) return refused(AgyErrorCode.agy_unknown_conversation, `agyid ${agyid}`);
    return await this.serially(c, async () => {
      const record = c.record.process;
      if (record === undefined || this.pending(c) === 0) {
        return { ok: true, value: { ok: true, outcome: "no_turn" } };
      }
      const live = c.live;
      if (live !== undefined) live.aborting = true;
      const sent = await this.deps.processes.interrupt(record);
      if (!sent.sent) {
        if (live !== undefined) live.aborting = false;
        return {
          ok: true,
          value: { ok: true, outcome: "unconfirmed", detail: `止めていない: ${sent.why}` },
        };
      }
      if (live === undefined) {
        return {
          ok: true,
          value: {
            ok: true,
            outcome: "unconfirmed",
            detail: "信号は送ったが、止まったかをこの daemon は見届けられない",
          },
        };
      }
      const timer = Promise.withResolvers<"late">();
      const t = setTimeout(() => timer.resolve("late"), this.abortWaitMs);
      const got = await Promise.race([live.exited.then(() => "ended" as const), timer.promise]);
      clearTimeout(t);
      return got === "ended"
        ? { ok: true, value: { ok: true, outcome: "aborted" } }
        : {
            ok: true,
            value: {
              ok: true,
              outcome: "unconfirmed",
              detail: `信号は送ったが ${String(this.abortWaitMs / 1000)} 秒の内に止まったと確かめられなかった`,
            },
          };
    });
  }

  // --- the daemon's end (§10) ---------------------------------------------------------

  /** Refuse new runs and aborts, and close every process's standard input:
   * a turn under way goes on to its end, and the next daemon reads it. No
   * signal, no wait. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const c of this.conversations.values()) {
      c.tail?.stop();
      const live = c.live;
      if (live === undefined) continue;
      try {
        await live.proc.stdin.end();
      } catch {
        // Already closed: the process ended.
      }
      await this.saveConversation(c);
    }
  }

  /** The processes the daemon holds the standard input of (for tests and the
   * log). */
  livePids(): number[] {
    const pids: number[] = [];
    for (const c of this.conversations.values())
      if (c.live !== undefined) pids.push(c.live.proc.pid);
    return pids;
  }
}

/** What a request that ended without a result says (§7, §10). */
function endText(r: RequestRecord): string {
  const why =
    r.end === "unconfirmed_write"
      ? "agy に書けたか確かめられなかった。会話の最後の応答を status で見てから、要れば run し直す (同じ依頼が 2 度頼まれることになりうる)"
      : r.end === "aborted_unstarted"
        ? "abort で処理されなかった"
        : "応答せずに終わった";
  return r.end_text !== undefined ? `${why} (${r.end_text})` : why;
}
