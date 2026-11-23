// btw (DR-0060): a side question or request put to a session from the webui,
// answered by a fork of the session that the launch command starts as a print
// launch (DR-0064, docs/design/launch-command.md). This module holds the btws:
// it starts the command, reads the fork's stream-json into each btw's record,
// keeps the records in `<stateDir>/sessions/<sid>.btw.jsonl`, and pushes them
// to the tabs that follow the session's Timeline. Where the session is (its
// cwd, transcript) and what it runs as are the caller's to find.
import * as crypto from "node:crypto";
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
  launchModelFromTranscript,
  parseWith,
  spelledRunsAs,
  type BtwRecord,
  type LaunchCommandInput,
  type LaunchEffort,
  type ForkUsage,
  type Output,
  type SessionFacts,
} from "@ccmsg/protocol";
import type { BtwForkEnd } from "./btw-fork.ts";
import { outputGist } from "./claude-update.ts";
import { DEFAULT_LAUNCH_COMMAND_SCRIPT, defaultLaunchCommand } from "./config.ts";
import type { LaunchSettings } from "./project-auto-mode.ts";
import type { SessionLaunchContext } from "./session-search.ts";
import { wireLine } from "./wire-line.ts";

/** How often the answer of one btw is pushed at most while it grows (DR-0060
 * §5): a push carries the whole record, so one per token would send the
 * answer's length squared. */
export const BTW_PUSH_INTERVAL_MS = 100;

/** How much of the launch command's standard error is kept, from its end: what
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

/** The token counts of the `result` line's `usage` that daemon.log names
 * (DR-0060 §6): whether the fork read the session's prompt cache. Read apart
 * from the line's end, so a usage that does not read leaves the end as it is
 * and names no counts. */
const ResultUsageLineSchema = jsonText(
  v.looseObject({
    usage: v.looseObject({
      input_tokens: v.optional(v.number()),
      cache_read_input_tokens: v.optional(v.number()),
      cache_creation_input_tokens: v.optional(v.number()),
      output_tokens: v.optional(v.number()),
    }),
  }),
);

/** The fields of BtwUsage, in the order daemon.log names them. */
const USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

/** The token counts a fork's `result` line gave, each absent when it gave
 * none. */
export type BtwUsage = Partial<Record<(typeof USAGE_FIELDS)[number], number>>;

/** The counts of `usage` as `name=<n>` words for a log line, the absent ones
 * left out. */
export function usageLogFields(usage: BtwUsage | undefined): string[] {
  if (usage === undefined) return [];
  return USAGE_FIELDS.flatMap((name) => {
    const count = usage[name];
    return count === undefined ? [] : [`${name}=${String(count)}`];
  });
}

/** One model message of the fork's own conversation: its text blocks by
 * index, and whether the stream's deltas gave them (then the message's
 * `assistant` lines add nothing). */
interface AnswerMessage {
  id: string | undefined;
  blocks: Map<number, string>;
  streamed: boolean;
}

/** How the fork's run ended, as its `result` line says, with the token counts
 * of its `usage` when it read. */
export type BtwResult = ({ status: "done" } | { status: "failed"; error: string }) & {
  usage?: BtwUsage;
};

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
        const counted = parseWith(ResultUsageLineSchema, line);
        const usage: { usage?: BtwUsage } = counted.ok
          ? {
              usage: Object.fromEntries(
                USAGE_FIELDS.flatMap((name) => {
                  const count = counted.value.usage[name];
                  return count === undefined ? [] : [[name, count] as const];
                }),
              ),
            }
          : {};
        if (!read.value.is_error) return { status: "done", ...usage };
        const why = read.value.result?.trim();
        return {
          status: "failed",
          error: why !== undefined && why !== "" ? why : (read.value.subtype ?? "error"),
          ...usage,
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

// --- what the fork runs as (DR-0060 §2) ---

/** The context window of a session that runs on the 1M context, as the
 * module measures it (facts' `context.window`). */
const ONE_M_WINDOW = 1_000_000;

/** A model's family (`sonnet` of `claude-sonnet-5-5` and of `sonnet[1m]`), or
 * undefined for one outside the launch's vocabulary. */
function familyOf(model: string): string | undefined {
  return launchModelFromTranscript(model);
}

/** The model a btw's fork is started with: the model id the session's main
 * thread last answered as (`answered`, the transcript's `message.model`,
 * e.g. `claude-sonnet-5-5`), with `[1m]` when the session runs on the 1M
 * context (its own spelling, `spelled`, ends with `[1m]`, or the module
 * measured a 1M window). Claude Code reads a family name with `[1m]`
 * (`sonnet[1m]`) passed to `claude -p` as an unrecognized model and sends the
 * history without its thinking, which misses the session's prompt cache
 * (docs/findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md); the id
 * does not. The id is taken from the transcript, not from a table of the
 * names, which change with Claude Code's versions.
 *
 * When the transcript names no answer of the session's family (no answer
 * yet, or the session moved to another model since its last answer), the
 * session's own spelling goes as it is. */
export function btwModelOf(sources: {
  spelled: string | undefined;
  answered: string | undefined;
  window: number | undefined;
}): string | undefined {
  const { spelled, answered, window } = sources;
  const id = answered?.replace(/\[[^\]]*\]$/, "");
  const sameFamily =
    id !== undefined &&
    id.startsWith("claude-") &&
    (spelled === undefined ||
      familyOf(spelled) === undefined ||
      familyOf(spelled) === familyOf(id));
  if (!sameFamily) return spelled;
  const oneM = spelled?.endsWith("[1m]") === true || (window ?? 0) >= ONE_M_WINDOW;
  return oneM ? `${id}[1m]` : id;
}

/** What a btw's fork runs as when the person chose no effort: the model as
 * btwModelOf makes it, and the effort the session's main-thread requests go
 * with now (its session override's, else its own, else its transcript's last
 * answer's; `spelledRunsAs`, the one-shot override left out). */
export function btwRunsAs(
  facts: SessionFacts | undefined,
  answered: SessionLaunchContext,
): { model?: string; effort?: string } {
  const spelled = spelledRunsAs({
    session: facts?.request_override?.session,
    own: facts,
    answered,
  });
  const model = btwModelOf({
    spelled: spelled.model,
    answered: answered.model,
    window: facts?.context?.window,
  });
  return {
    ...(model !== undefined ? { model } : {}),
    ...(spelled.effort !== undefined ? { effort: spelled.effort } : {}),
  };
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

// --- the fork as a print launch, and its run ---

/** The print launch of a btw's fork (DR-0064 §2) asking `prompt` (the
 * question without the prefix) of `target`, at `effort` (the person's choice,
 * else the session's), with the settings file of the session's project's
 * autoMode when it has one (DR-0063 §8); and the model and effort it goes
 * with. The values of the print options are what followBtwFork reads
 * (stream-json with the partial messages) and what keeps the session's prompt
 * cache (no option that changes the tools, DR-0060 §2), so they are fixed
 * here. */
export function btwLaunchInput(
  target: BtwTarget,
  prompt: string,
  effort: LaunchEffort | undefined,
  settings: LaunchSettings | undefined,
): {
  input: LaunchCommandInput;
  model: string | undefined;
  effort: string | undefined;
} {
  // An empty spelling names nothing: the field is left out, as for none.
  const model = target.model === "" ? undefined : target.model;
  const chosenEffort = effort ?? (target.effort === "" ? undefined : target.effort);
  const input: LaunchCommandInput = {
    cwd: target.cwd,
    resume: target.sessionId,
    fork_session: true,
    session_id: crypto.randomUUID(),
    print: true,
    no_session_persistence: true,
    output_format: "stream-json",
    verbose: true,
    include_partial_messages: true,
    permission_prompts: "none",
    ...(model !== undefined ? { model } : {}),
    ...(chosenEffort !== undefined ? { effort: chosenEffort } : {}),
    ...(settings !== undefined ? { settings: settings.path } : {}),
    prompt: btwPrompt(prompt),
  };
  return { input, model, effort: chosenEffort };
}

/** How a fork's run came out: its `result` line's end (none when it ended
 * before one), its exit code, and the end of its standard error. */
export interface BtwPrintEnd {
  result: BtwResult | undefined;
  exitCode: number;
  stderr: string;
}

/** Read the fork's stream-json into `answer` until the command ends, calling
 * `grew` after each line. A read that fails is `warn`ed and ends the read. */
export async function followBtwFork(
  process: BtwProcess,
  answer: BtwAnswer,
  grew: () => void,
  warn: (msg: string) => void,
): Promise<BtwPrintEnd> {
  const stderr = collectTail(process.stderr);
  let result: BtwResult | undefined;
  try {
    for await (const line of readLines(process.stdout)) {
      const ended = answer.take(line);
      if (ended !== undefined) result = ended;
      grew();
    }
  } catch (e) {
    warn(`reading the command's output failed: ${errorText(e)}`);
  }
  const exitCode = await process.exited;
  return { result, exitCode, stderr: await stderr };
}

/** How a btw ended (DR-0060 §4): canceled when it was stopped from here
 * (`stoppedFor`, why), else as its `result` line says, else failed with the
 * command's exit code and the gist of its standard error. */
export function btwEndOf(
  end: BtwPrintEnd,
  stoppedFor: string | null,
): { status: "done" } | { status: "failed" | "canceled"; error: string } {
  if (stoppedFor !== null) return { status: "canceled", error: stoppedFor };
  if (end.result?.status === "done") return { status: "done" };
  if (end.result?.status === "failed") return { status: "failed", error: end.result.error };
  const gist = outputGist(end.stderr);
  return {
    status: "failed",
    error: `起動コマンドが答えの終わりの前に終わった (exit ${String(end.exitCode)})${gist !== "" ? `: ${gist}` : ""}`,
  };
}

/** The daemon's room for btws running at once (BTW_MAX_CONCURRENCY,
 * daemon-wide): a slot is held while a fork runs and given back as it ends.
 * A slot freed goes to the one that waited longest. */
export class BtwSlots {
  readonly #max: number;
  #taken = 0;
  readonly #waiting: ((release: () => void) => void)[] = [];

  constructor(max: number = BTW_MAX_CONCURRENCY) {
    this.#max = max;
  }

  /** How many slots are held now. */
  get running(): number {
    return this.#taken;
  }

  /** A slot now (the function gives it back), or null when every slot is
   * held or others wait for one. */
  tryTake(): (() => void) | null {
    if (this.#taken >= this.#max || this.#waiting.length > 0) return null;
    this.#taken += 1;
    return this.#releaser();
  }

  /** A slot as soon as one is free, after the ones that wait already;
   * `now` says whether it was free at once. */
  take(): { now: boolean; slot: Promise<() => void> } {
    const release = this.tryTake();
    if (release !== null) return { now: true, slot: Promise.resolve(release) };
    return {
      now: false,
      slot: new Promise((resolve) => {
        this.#waiting.push(resolve);
      }),
    };
  }

  #releaser(): () => void {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.#waiting.shift();
      if (next !== undefined) next(this.#releaser());
      else this.#taken -= 1;
    };
  }
}

// --- the store ---

/** Where a btw writes its pushes: a tab's connection. */
export interface BtwConn {
  write(line: string): void;
}

/** The process of a btw's launch command, as the store drives it. */
export interface BtwProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  /** Stop the command and what it started (its process group). */
  stop(): void;
}

/** Start the launch command with the btw's print launch `input` on its
 * standard input, in its `cwd`. Throws when it cannot be started. */
export type BtwLaunchStart = (input: LaunchCommandInput) => BtwProcess;

/** Ask the fork of a btw of session `sid` with `prompt` (the btw's whole
 * prompt) at `effort` (absent for the session's own level), and wait for its
 * end; once `stop` aborts the fork is stopped (askBtwFork). */
export type BtwForkAsk = (
  sid: string,
  prompt: string,
  effort: LaunchEffort | undefined,
  stop: AbortSignal,
) => Promise<BtwForkEnd>;

export interface BtwStoreDeps {
  stateDir: string;
  fork: BtwForkAsk;
  now(): Date;
  newId(): string;
  log: { info(msg: string): void; warn(msg: string): void };
}

/** How a btw ended: its fork's end, or stopped from here (`canceled`, why). */
export type BtwEnd = BtwForkEnd | { status: "canceled"; error: string };

/** Wait for `fork`'s end, or for `stopped` (resolved with why the btw was
 * stopped from here), whichever comes first: the fork is stopped in the
 * session too, and what it ends with after the stop is dropped. */
export function btwEndOrStop(fork: Promise<BtwForkEnd>, stopped: Promise<string>): Promise<BtwEnd> {
  return Promise.race([fork, stopped.then((why): BtwEnd => ({ status: "canceled", error: why }))]);
}

/** The fields of a btw's last record its end gives: the answer's text, how
 * it ended, why it did not answer, what it cost, the effort it ran at. */
export function btwEndFields(end: BtwEnd): {
  text: string;
  status: "done" | "failed" | "canceled";
  error?: string;
  usage?: ForkUsage;
  effort?: string;
} {
  if (end.status === "done") {
    return {
      text: end.text,
      status: "done",
      usage: end.usage,
      ...(end.effort !== undefined ? { effort: end.effort } : {}),
    };
  }
  if (end.status === "canceled") return { text: "", status: "canceled", error: end.error };
  return {
    text: "",
    status: "failed",
    error: end.error,
    ...(end.usage !== undefined ? { usage: end.usage } : {}),
    ...(end.effort !== undefined ? { effort: end.effort } : {}),
  };
}

/** The words of a btw's end for its log line: why it failed, and what it
 * cost (whether the fork read the session's prompt cache, DR-0060 §6). */
export function btwEndLogFields(end: BtwEnd, startedAt: number, now: number): string[] {
  return [
    ...(end.status === "failed" ? [`reason=${end.reason}`] : []),
    `elapsed_ms=${String(Math.max(0, now - startedAt))}`,
    ...(end.status !== "canceled" && end.effort !== undefined ? [`ran_effort=${end.effort}`] : []),
    ...usageLogFields(end.status === "canceled" ? undefined : end.usage),
  ];
}

/** Where and as what a btw's fork runs: the caller found it out. */
export interface BtwTarget {
  sessionId: string;
  /** The session's cwd, a realpath. */
  cwd: string;
  /** The id the session answered as, `[1m]` kept (btwModelOf). */
  model: string | undefined;
  /** The effort the session runs at, as it spells it (DR-0060 §2). */
  effort: string | undefined;
  /** The session's transcript, for the anchor. */
  transcript: string | undefined;
}

export type BtwAskOutcome =
  | { ok: true; btw: BtwRecord }
  | { ok: false; code: ErrorCode; msg: string };

interface BtwRun {
  record: BtwRecord;
  /** The fork's end, as the session's module says. */
  fork: Promise<BtwForkEnd>;
  /** Resolved with why, once the run is stopped from here. */
  stopped: PromiseWithResolvers<string>;
  /** Why the run was stopped from here, once it was. */
  stoppedFor: string | null;
  /** When it was asked, epoch ms. */
  startedAt: number;
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
   * choice; absent, the fork runs at the session's own level). Every btw is
   * asked at once: forks of a session run side by side. */
  ask(
    target: BtwTarget,
    prompt: string,
    effort: LaunchEffort | undefined,
    afterUuid: string | undefined,
  ): BtwAskOutcome {
    const model = target.model === "" ? undefined : target.model;
    const runsAt = effort ?? (target.effort === "" ? undefined : target.effort);
    const record: BtwRecord = {
      id: this.#deps.newId(),
      session_id: target.sessionId,
      ts: this.#deps.now().toISOString(),
      ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}),
      prompt,
      response: "",
      status: "running",
      ...(model !== undefined ? { model } : {}),
      ...(runsAt !== undefined ? { effort: runsAt } : {}),
    };
    this.#deps.log.info(
      `btw_ask: session_id=${target.sessionId} id=${record.id}` +
        ` model=${model ?? "-"} effort=${effort ?? "-"} runs_at=${runsAt ?? "-"}` +
        ` prompt_bytes=${String(Buffer.byteLength(prompt))}`,
    );
    const stopper = new AbortController();
    const run: BtwRun = {
      record,
      fork: this.#deps.fork(target.sessionId, btwPrompt(prompt), effort, stopper.signal),
      stopped: Promise.withResolvers<string>(),
      stoppedFor: null,
      startedAt: this.#deps.now().getTime(),
      done: Promise.resolve(),
    };
    this.#runs.set(record.id, run);
    void run.stopped.promise.then(() => stopper.abort());
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
    const end = await btwEndOrStop(run.fork, run.stopped.promise);
    const { tool: _tool, ...rest } = run.record;
    const { text, ...fields } = btwEndFields(end);
    const record: BtwRecord = {
      ...rest,
      response: text,
      ended_at: this.#deps.now().toISOString(),
      ...fields,
    };
    run.record = record;
    this.#deps.log.info(
      [
        `btw_end: id=${record.id} session_id=${record.session_id} status=${record.status}`,
        `response_bytes=${String(Buffer.byteLength(record.response))}`,
        ...btwEndLogFields(end, run.startedAt, this.#deps.now().getTime()),
      ].join(" "),
    );
    this.#broadcast(record);
    // The run is let go once its last record is on disk: a read of the file
    // in between would otherwise find it running with no run behind it.
    await this.#append(record);
    this.#runs.delete(record.id);
    this.#keep(record);
  }

  #stop(run: BtwRun, why: string): void {
    if (run.stoppedFor !== null) return;
    run.stoppedFor = why;
    run.stopped.resolve(why);
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

/** The launch command started for a btw as the daemon starts it (DR-0064
 * §4): `argv` in the input's `cwd`, in its own process group (stopped as a
 * whole), the input as JSON on its standard input. Unlike a launch, no
 * deadline and no cap on the output: the answer is read as it comes, until
 * the fork ends or the btw is stopped. */
export function spawnBtwLaunch(
  argv: readonly string[],
  env: Record<string, string>,
  input: LaunchCommandInput,
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

/** The launch command a btw's fork is started through (DR-0064 §4): the
 * config's `session_launcher.launch_command` (the built-in one when the
 * section names none), else the built-in one when there is no section. A
 * daemon a test run started (CCMSG_TEST_LIFELINE in `env`) runs no built-in
 * one (null): it would fork a real session with a real model request. Same
 * posture as sayCommandOf. */
export function btwLaunchCommandOf(
  launchCommand: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] | null {
  const argv = launchCommand ?? defaultLaunchCommand();
  const lifeline = env.CCMSG_TEST_LIFELINE;
  const underTest = lifeline !== undefined && lifeline !== "";
  // The section's launch_command left out reads as the built-in one, so the
  // built-in is told by its script rather than by the field's absence.
  if (underTest && argv.at(-1) === DEFAULT_LAUNCH_COMMAND_SCRIPT) return null;
  return argv;
}
