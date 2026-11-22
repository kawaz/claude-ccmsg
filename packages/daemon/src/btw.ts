// btw (DR-0060): a side question or request put to a session from the webui,
// answered by a fork of the session that the btw command starts
// (docs/design/btw-command.md). This module holds the btws: it starts the
// command, reads the fork's stream-json into each btw's record, keeps the
// records in `<stateDir>/sessions/<sid>.btw.jsonl`, and pushes them to the
// tabs that follow the session's Timeline. Where the session is (its cwd,
// config dir, transcript) and what it runs as are the caller's to find.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  BTW_MAX_CONCURRENCY,
  BtwRecordLineSchema,
  btwPrompt,
  ErrorCode,
  errorText,
  jsonText,
  parseWith,
  type BtwCommandInput,
  type BtwRecord,
  type LaunchEffort,
  type Output,
} from "@ccmsg/protocol";
import { outputGist } from "./claude-update.ts";
import { defaultBtwCommand } from "./config.ts";
import { wireLine } from "./wire-line.ts";

/** How often the answer of one btw is pushed at most while it grows (DR-0060
 * §5): a push carries the whole record, so one per token would send the
 * answer's length squared. */
export const BTW_PUSH_INTERVAL_MS = 100;

/** How much of the btw command's standard error is kept, from its end: what
 * the failure's message quotes. */
const STDERR_KEEP_BYTES = 4096;

/** The file of session `sid`'s btws in the state dir's per-session place. */
export function btwFile(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.btw.jsonl`);
}

// --- the fork's stream-json (claude --output-format stream-json --verbose
// --include-partial-messages), read for the answer alone ---

const StreamLineHeadSchema = jsonText(v.looseObject({ type: v.string() }));

/** Whose conversation a line is of: null (or absent) for the fork's own, a
 * tool_use id for a subagent's. */
const ParentEntries = { parent_tool_use_id: v.optional(v.nullable(v.string())) };

const StreamEventLineSchema = jsonText(
  v.looseObject({
    ...ParentEntries,
    event: v.looseObject({
      type: v.string(),
      index: v.optional(v.number()),
      message: v.optional(v.looseObject({ id: v.optional(v.string()) })),
      content_block: v.optional(v.looseObject({ type: v.string(), name: v.optional(v.string()) })),
      delta: v.optional(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
    }),
  }),
);

const AssistantLineSchema = jsonText(
  v.looseObject({
    ...ParentEntries,
    message: v.looseObject({
      id: v.optional(v.string()),
      content: v.array(
        v.looseObject({
          type: v.string(),
          text: v.optional(v.string()),
          name: v.optional(v.string()),
        }),
      ),
    }),
  }),
);

const ResultLineSchema = jsonText(
  v.looseObject({
    subtype: v.optional(v.string()),
    is_error: v.boolean(),
    result: v.optional(v.string()),
  }),
);

/** One model message of the fork's own conversation: its text blocks by
 * index, and whether the stream's deltas gave them (then the message's
 * `assistant` lines add nothing). */
interface AnswerMessage {
  id: string | undefined;
  blocks: Map<number, string>;
  streamed: boolean;
}

/** How the fork's run ended, as its `result` line says. */
export type BtwResult = { status: "done" } | { status: "failed"; error: string };

/** The answer as the fork's stream-json builds it (DR-0060 §4): the text
 * blocks of the fork's own conversation, in order, grown by the deltas and
 * filled from the `assistant` lines where no delta came; and the tool it runs
 * now. */
export class BtwAnswer {
  readonly #messages: AnswerMessage[] = [];
  #current: AnswerMessage | null = null;
  #tool: string | undefined;

  /** The answer's text so far: the non-empty blocks, a blank line between. */
  get text(): string {
    return this.#messages
      .flatMap((m) => [...m.blocks.entries()].toSorted(([a], [b]) => a - b).map(([, t]) => t))
      .filter((t) => t !== "")
      .join("\n\n");
  }

  get tool(): string | undefined {
    return this.#tool;
  }

  /** Take one line of the stream. Returns the run's end when the line is the
   * `result`, undefined otherwise. A line that does not read is passed over. */
  take(line: string): BtwResult | undefined {
    const head = parseWith(StreamLineHeadSchema, line);
    if (!head.ok) return undefined;
    switch (head.value.type) {
      case "stream_event": {
        const read = parseWith(StreamEventLineSchema, line);
        if (read.ok && (read.value.parent_tool_use_id ?? null) === null) {
          this.#takeEvent(read.value.event);
        }
        return undefined;
      }
      case "assistant": {
        const read = parseWith(AssistantLineSchema, line);
        if (read.ok && (read.value.parent_tool_use_id ?? null) === null) {
          this.#takeAssistant(read.value.message);
        }
        return undefined;
      }
      case "result": {
        const read = parseWith(ResultLineSchema, line);
        if (!read.ok) return undefined;
        this.#tool = undefined;
        if (!read.value.is_error) return { status: "done" };
        const why = read.value.result?.trim();
        return {
          status: "failed",
          error: why !== undefined && why !== "" ? why : (read.value.subtype ?? "error"),
        };
      }
      default:
        return undefined;
    }
  }

  #takeEvent(event: Output<typeof StreamEventLineSchema>["event"]): void {
    if (event.type === "message_start") {
      this.#current = { id: event.message?.id, blocks: new Map(), streamed: true };
      this.#messages.push(this.#current);
      return;
    }
    const message = this.#current;
    if (message === null || event.index === undefined) return;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "text") {
        message.blocks.set(event.index, "");
        this.#tool = undefined;
      } else if (block?.type === "tool_use" && block.name !== undefined) {
        this.#tool = block.name;
      }
      return;
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const held = message.blocks.get(event.index);
      if (held !== undefined) message.blocks.set(event.index, held + (event.delta.text ?? ""));
    }
  }

  #takeAssistant(message: Output<typeof AssistantLineSchema>["message"]): void {
    const streamed = this.#messages.find((m) => m.id !== undefined && m.id === message.id);
    for (const block of message.content) {
      if (block.type === "tool_use" && block.name !== undefined) this.#tool = block.name;
    }
    if (streamed?.streamed === true) return;
    // No delta gave this message (a command that streams no partial
    // messages): its text blocks are taken from the line, in order.
    let held = streamed;
    if (held === undefined) {
      held = { id: message.id, blocks: new Map(), streamed: false };
      this.#messages.push(held);
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text !== undefined)
        held.blocks.set(held.blocks.size, block.text);
    }
  }
}

// --- the anchor (DR-0060 §4) ---

/** Widening windows over the transcript's end: the last row with a uuid is
 * almost always in the first. */
const ANCHOR_WINDOWS = [64 * 1024, 1024 * 1024, 16 * 1024 * 1024] as const;

const AnchorRowSchema = jsonText(
  v.looseObject({ uuid: v.optional(v.string()), isSidechain: v.optional(v.boolean()) }),
);

/** The uuid of the last row of transcript `file` that has one and is not a
 * sidechain's: where in the session a btw asked now stands. Undefined when
 * the file does not read or holds no such row. */
export async function lastRowUuid(file: string): Promise<string | undefined> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return undefined;
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return undefined;
  }
  try {
    for (const window of ANCHOR_WINDOWS) {
      const start = Math.max(0, size - window);
      const length = size - start;
      if (length <= 0) return undefined;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const lines = buffer.toString("utf-8", 0, bytesRead).split("\n");
      // A window that starts mid-file opens inside a row.
      if (start > 0) lines.shift();
      for (const line of lines.toReversed()) {
        if (!line.includes('"uuid"')) continue;
        const row = parseWith(AnchorRowSchema, line);
        if (row.ok && row.value.uuid !== undefined && row.value.isSidechain !== true) {
          return row.value.uuid;
        }
      }
      if (start === 0) return undefined;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

// --- the store ---

/** Where a btw writes its pushes: a tab's connection. */
export interface BtwConn {
  write(line: string): void;
}

/** The btw command's process, as the store drives it. */
export interface BtwProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  /** Stop the command and what it started (its process group). */
  stop(): void;
}

/** Start the btw command with `input` on its standard input, in its `cwd`.
 * Throws when it cannot be started. */
export type BtwCommandStart = (input: BtwCommandInput) => BtwProcess;

export interface BtwStoreDeps {
  stateDir: string;
  start: BtwCommandStart;
  now(): Date;
  newId(): string;
  log: { info(msg: string): void; warn(msg: string): void };
  /** Run `fire` once after BTW_PUSH_INTERVAL_MS; the real clock's timer, a
   * test's own in tests. */
  afterPushInterval(fire: () => void): { cancel(): void };
}

/** Where and as what a btw's fork runs: the caller found it out. */
export interface BtwTarget {
  sessionId: string;
  cwd: string;
  configDir: string;
  /** As the session spells it, `[1m]` kept. */
  model: string | undefined;
  effort: string | undefined;
  /** The session's transcript, for the anchor. */
  transcript: string | undefined;
}

export type BtwAskOutcome =
  | { ok: true; btw: BtwRecord }
  | { ok: false; code: ErrorCode; msg: string };

interface BtwRun {
  record: BtwRecord;
  answer: BtwAnswer;
  process: BtwProcess;
  /** The push waiting to carry the answer's growth, while one waits. */
  push: { cancel(): void } | null;
  /** Why the run was stopped from here, once it was. */
  stoppedFor: string | null;
  /** Resolves once the run's last record is written. */
  done: Promise<void>;
}

/** The btws of the sessions: the running ones, the ones read from disk, and
 * the tabs that follow each session (DR-0060 §5, §9). */
export class BtwStore {
  readonly #deps: BtwStoreDeps;
  readonly #runs = new Map<string, BtwRun>();
  /** The records read from disk, by session, then by id; a session not
   * read yet has none here. */
  readonly #held = new Map<string, Map<string, BtwRecord>>();
  readonly #watchers = new Map<string, Set<BtwConn>>();
  /** Appends to one session's file, one after another. */
  readonly #writes = new Map<string, Promise<void>>();

  constructor(deps: BtwStoreDeps) {
    this.#deps = deps;
  }

  /** How many btws run now. */
  get running(): number {
    return this.#runs.size;
  }

  /** Start a btw of `target` asking `prompt` with `effort` (the person's
   * choice, else the session's). */
  ask(
    target: BtwTarget,
    prompt: string,
    effort: LaunchEffort | undefined,
    afterUuid: string | undefined,
  ): BtwAskOutcome {
    if (this.#runs.size >= BTW_MAX_CONCURRENCY) {
      return {
        ok: false,
        code: ErrorCode.btw_busy,
        msg: `${String(BTW_MAX_CONCURRENCY)} btws are running already; wait for one to end`,
      };
    }
    const chosenEffort = effort ?? target.effort;
    const input: BtwCommandInput = {
      cwd: target.cwd,
      config_dir: target.configDir,
      resume: target.sessionId,
      ...(target.model !== undefined ? { model: target.model } : {}),
      ...(chosenEffort !== undefined ? { effort: chosenEffort } : {}),
      prompt: btwPrompt(prompt),
    };
    let process: BtwProcess;
    try {
      process = this.#deps.start(input);
    } catch (e) {
      const msg = `the btw command could not be started in ${target.cwd}: ${errorText(e)}`;
      this.#deps.log.warn(
        `btw_ask: session_id=${target.sessionId} ${ErrorCode.btw_command_unavailable}: ${JSON.stringify(msg)}`,
      );
      return { ok: false, code: ErrorCode.btw_command_unavailable, msg };
    }
    const record: BtwRecord = {
      id: this.#deps.newId(),
      session_id: target.sessionId,
      ts: this.#deps.now().toISOString(),
      ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}),
      prompt,
      response: "",
      status: "running",
      ...(target.model !== undefined ? { model: target.model } : {}),
      ...(chosenEffort !== undefined ? { effort: chosenEffort } : {}),
    };
    this.#deps.log.info(
      `btw_ask: session_id=${target.sessionId} id=${record.id}` +
        ` model=${target.model ?? "-"} effort=${chosenEffort ?? "-"}` +
        ` prompt_bytes=${String(Buffer.byteLength(prompt))}`,
    );
    const run: BtwRun = {
      record,
      answer: new BtwAnswer(),
      process,
      push: null,
      stoppedFor: null,
      done: Promise.resolve(),
    };
    this.#runs.set(record.id, run);
    void this.#append(record);
    this.#broadcast(record);
    run.done = this.#follow(run);
    return { ok: true, btw: record };
  }

  /** Stop the btw `id`. False when no record has that id; one that ended is
   * left as it is. */
  async cancel(id: string): Promise<boolean> {
    const run = this.#runs.get(id);
    if (run !== undefined) {
      this.#stop(run, "取り消した");
      return true;
    }
    for (const records of this.#held.values()) {
      if (records.has(id)) return true;
    }
    return (await this.#findOnDisk(id)) !== undefined;
  }

  /** Resolves once every btw running now has ended by itself and its last
   * record is written. */
  async settled(): Promise<void> {
    await Promise.all([...this.#runs.values()].map((run) => run.done));
    await Promise.all(this.#writes.values());
  }

  /** Stop every running btw (the daemon stops) and wait for their last
   * records to be written. */
  async stopAll(): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const run of runs) this.#stop(run, "daemon が止まった");
    await Promise.all(runs.map((run) => run.done));
    await Promise.all(this.#writes.values());
  }

  /** `conn` follows session `sid`'s Timeline: it gets every btw of the
   * session now (ev:"btws") and each change from here (ev:"btw"). */
  async watch(sid: string, conn: BtwConn): Promise<void> {
    const watchers = this.#watchers.get(sid) ?? new Set();
    watchers.add(conn);
    this.#watchers.set(sid, watchers);
    const btws = await this.list(sid);
    if (!this.#watchers.get(sid)?.has(conn)) return;
    conn.write(wireLine({ ev: "btws", session_id: sid, btws }));
  }

  unwatch(sid: string, conn: BtwConn): void {
    const watchers = this.#watchers.get(sid);
    if (watchers === undefined) return;
    watchers.delete(conn);
    if (watchers.size === 0) this.#watchers.delete(sid);
  }

  /** `conn` closed. */
  unwatchAll(conn: BtwConn): void {
    for (const sid of this.#watchers.keys()) this.unwatch(sid, conn);
  }

  /** Every btw of session `sid`, oldest first: the kept ones and the running
   * ones. */
  async list(sid: string): Promise<BtwRecord[]> {
    const held = await this.#read(sid);
    const all = new Map(held);
    for (const run of this.#runs.values()) {
      if (run.record.session_id === sid) all.set(run.record.id, run.record);
    }
    return [...all.values()].toSorted((a, b) => a.ts.localeCompare(b.ts));
  }

  async #follow(run: BtwRun): Promise<void> {
    const stderr = collectTail(run.process.stderr);
    let result: BtwResult | undefined;
    try {
      for await (const line of readLines(run.process.stdout)) {
        const ended = run.answer.take(line);
        if (ended !== undefined) result = ended;
        this.#grew(run);
      }
    } catch (e) {
      this.#deps.log.warn(
        `btw ${run.record.id}: reading the command's output failed: ${errorText(e)}`,
      );
    }
    const exitCode = await run.process.exited;
    const errText = await stderr;
    run.push?.cancel();
    run.push = null;
    const { tool: _tool, ...rest } = run.record;
    const base = { ...rest, response: run.answer.text, ended_at: this.#deps.now().toISOString() };
    let record: BtwRecord;
    if (run.stoppedFor !== null) {
      record = { ...base, status: "canceled", error: run.stoppedFor };
    } else if (result?.status === "done") {
      record = { ...base, status: "done" };
    } else if (result?.status === "failed") {
      record = { ...base, status: "failed", error: result.error };
    } else {
      const gist = outputGist(errText);
      record = {
        ...base,
        status: "failed",
        error: `btw コマンドが答えの終わりの前に終わった (exit ${String(exitCode)})${gist !== "" ? `: ${gist}` : ""}`,
      };
    }
    run.record = record;
    this.#deps.log.info(
      `btw_end: id=${record.id} status=${record.status} exit_code=${String(exitCode)}` +
        ` response_bytes=${String(Buffer.byteLength(record.response))}`,
    );
    this.#broadcast(record);
    // The run is let go once its last record is on disk: a read of the file
    // in between would otherwise find it running with no run behind it.
    await this.#append(record);
    this.#runs.delete(record.id);
    this.#keep(record);
  }

  /** The answer may have grown: push it once the interval passes. */
  #grew(run: BtwRun): void {
    const tool = run.answer.tool;
    const response = run.answer.text;
    if (response === run.record.response && tool === run.record.tool) return;
    const { tool: _tool, ...rest } = run.record;
    run.record = { ...rest, response, ...(tool !== undefined ? { tool } : {}) };
    if (run.push !== null) return;
    run.push = this.#deps.afterPushInterval(() => {
      run.push = null;
      if (this.#runs.get(run.record.id) === run) this.#broadcast(run.record);
    });
  }

  #stop(run: BtwRun, why: string): void {
    if (run.stoppedFor !== null) return;
    run.stoppedFor = why;
    run.process.stop();
  }

  #keep(record: BtwRecord): void {
    this.#held.get(record.session_id)?.set(record.id, record);
  }

  #broadcast(record: BtwRecord): void {
    const watchers = this.#watchers.get(record.session_id);
    if (watchers === undefined || watchers.size === 0) return;
    const line = wireLine({ ev: "btw", btw: record });
    for (const conn of watchers) conn.write(line);
  }

  /** Append `record` to its session's file, after what is being appended
   * there. A failure is logged: the record stays in memory. */
  #append(record: BtwRecord): Promise<void> {
    const sid = record.session_id;
    const file = btwFile(this.#deps.stateDir, sid);
    const { tool: _tool, ...kept } = record;
    const previous = this.#writes.get(sid) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.appendFile(file, `${JSON.stringify(kept)}\n`);
      } catch (e) {
        this.#deps.log.warn(`btw ${record.id}: ${file} not written: ${errorText(e)}`);
      }
    });
    this.#writes.set(sid, next);
    void next.then(() => {
      if (this.#writes.get(sid) === next) this.#writes.delete(sid);
    });
    return next;
  }

  /** The kept records of session `sid`, read once from its file. A record
   * whose last line says it runs but that no run of this daemon holds ended
   * with the daemon that ran it: it is read as failed, and that is written. */
  async #read(sid: string): Promise<Map<string, BtwRecord>> {
    const held = this.#held.get(sid);
    if (held !== undefined) return held;
    const records = await readBtwFile(btwFile(this.#deps.stateDir, sid), (msg) =>
      this.#deps.log.warn(msg),
    );
    const already = this.#held.get(sid);
    if (already !== undefined) return already;
    const orphans: BtwRecord[] = [];
    for (const [id, record] of records) {
      if (record.status === "running" && !this.#runs.has(id)) {
        const { tool: _tool, ...rest } = record;
        const ended: BtwRecord = { ...rest, status: "failed", error: "daemon が止まった" };
        records.set(id, ended);
        orphans.push(ended);
      }
    }
    // A running one of this daemon is the run's, not the file's.
    for (const id of this.#runs.keys()) records.delete(id);
    this.#held.set(sid, records);
    for (const record of orphans) void this.#append(record);
    return records;
  }

  async #findOnDisk(id: string): Promise<BtwRecord | undefined> {
    const dir = path.join(this.#deps.stateDir, "sessions");
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!name.endsWith(".btw.jsonl")) continue;
      const records = await this.#read(name.slice(0, -".btw.jsonl".length));
      const found = records.get(id);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

/** The records of a btw file, by id, a later line over an earlier one of the
 * same id. A missing file is no records; a line that does not read is passed
 * over and logged. */
export async function readBtwFile(
  file: string,
  warn: (msg: string) => void,
): Promise<Map<string, BtwRecord>> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    return new Map();
  }
  const records = new Map<string, BtwRecord>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const read = parseWith(BtwRecordLineSchema, line);
    if (!read.ok) {
      warn(`btw: a line of ${file} does not read: ${read.failure.summary}`);
      continue;
    }
    records.set(read.value.id, read.value);
  }
  return records;
}

/** The lines of `stream` as they come, without their line feeds. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    let at = carry.indexOf("\n");
    while (at >= 0) {
      yield carry.slice(0, at);
      carry = carry.slice(at + 1);
      at = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  if (carry !== "") yield carry;
}

/** The end of `stream`'s text, read from the start so a full pipe never
 * stops the command. */
async function collectTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for await (const chunk of stream) {
      tail += decoder.decode(chunk, { stream: true });
      if (tail.length > STDERR_KEEP_BYTES * 2) tail = tail.slice(-STDERR_KEEP_BYTES);
    }
  } catch {
    // A read that fails ends the collection with what arrived.
  }
  return tail.slice(-STDERR_KEEP_BYTES);
}

/** The btw command started as the daemon starts it: `argv` in `cwd`, in its
 * own process group (stopped as a whole), the input as JSON on its standard
 * input. */
export function spawnBtwCommand(
  argv: readonly string[],
  env: Record<string, string>,
  input: BtwCommandInput,
): BtwProcess {
  const proc = Bun.spawn([...argv], {
    cwd: input.cwd,
    env,
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    stop: () => {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // ESRCH: the group has ended.
      }
    },
  };
}

/** The btw command a daemon runs: the config's (`btw_command`), else the
 * built-in one. A daemon a test run started (CCMSG_TEST_LIFELINE in `env`)
 * whose test named none runs none (null): the built-in one would fork a real
 * session with a real model request. Same posture as sayCommandOf. */
export function btwCommandOf(
  btwCommand: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] | null {
  if (btwCommand !== undefined) return btwCommand;
  const lifeline = env.CCMSG_TEST_LIFELINE;
  if (lifeline !== undefined && lifeline !== "") return null;
  return defaultBtwCommand();
}

/** The CLAUDE_CONFIG_DIR a transcript lives in (`<config dir>/projects/<project>/<sid>.jsonl`),
 * or undefined for a path not of that shape. */
export function configDirOfTranscript(file: string): string | undefined {
  const projects = path.dirname(path.dirname(file));
  return path.basename(projects) === "projects" ? path.dirname(projects) : undefined;
}
