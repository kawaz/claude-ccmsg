// Hooks module (Claude Mods, DR-0035): puts what a person wrote in the web UI
// into this session as their own prompt.
//
// The module is the plugin's one tie to Claude Code (DR-0039 §1): it hooks
// no classic event. When the session starts, and when it changes its id
// (/clear, /resume), it runs `ccmsg sidecar begin`, which writes the
// session's state file and brings the daemon up if none is running.
//
// At session.start it starts `ccmsg sidecar`, which binds this run's socket,
// names the run to the daemon, and copies each line the daemon writes there to
// its standard output. The run is named by what the module knows of itself —
// a run id drawn when it was loaded, the session's CLAUDE_CONFIG_DIR and
// HYOUI_SESSION_ID — and the daemon ties it to a harness process on its own. A line
// is a request naming an op (`{ v, op, id, args }`); every request with an id
// gets one reply (`{ id, ok, result }` or `{ id, ok: false, error }`), which
// goes back to the daemon through `ccmsg sidecar reply`. A line that is not a
// request this module runs is logged and not answered: the daemon, getting no
// reply, takes the request as unconfirmed at its deadline.
//
// `prompt.send` puts a person's text in: the module keeps the person's
// half-typed draft, fills the composer with the text, and presses Enter on its
// own terminal through hyoui, so the harness takes the prompt exactly as if it
// had been typed. The prompt counts as accepted when the prompt.submit of that
// text from the composer goes through (its `next` settles on anything but a
// drop). The draft is filled back right after the submit.
// `describe` says which ops the module has.
//
// The module also tells the daemon what it knows of its session through
// Claude Code itself and the transcript cannot tell (`session.facts`): the
// model as the session names it, `[1m]` kept, the effort, the context window
// the session runs with and its fill, whether its main thread is answering a
// turn (turn.start / turn.complete, idle from the session's start). It reads
// the model and the window at session.start, after /model, /clear and
// /resume (command.run), and takes the window and the fill again from each
// session.measure; the effort comes with each main-thread request
// (turn.step). Each time, it sends the whole of what it knows through `ccmsg sidecar facts`,
// which starts no daemon. The API error a turn ends on is not among them: the
// daemon reads it, with Claude Code's classification, off the transcript
// (DR-0039 §2). A daemon that comes up later asks for them with the
// `session.facts` request when the run's sidecar names the run. Sessions
// without a composer send them too: they have no sidecar, but the daemon
// still shows them.
//
// An agent uses ccmsg through three tools the module registers at
// session.start (DR-0039 §3): `send` (to other sessions, named by any of
// their id, directory, name and process, in any config home), `say` (to the
// person, by voice and in the webui) and `peers` (who `send` can reach). Each
// is answered here without `next`: `send` and `peers` through `ccmsg sidecar
// send-message` / `peer-list`, `say` through `ccmsg say`, the result always a
// text the model reads. SendMessage is left to the harness.
//
// A session without a composer (`-p`, the SDK) gets no sidecar. When the
// session changes its id (/clear, /resume) the module moves on a generation:
// a request that arrived under the old id is not put into the new session.
//
// Claude Code's module loader allows no imports that run, so this file is not
// what hooks.json names: `just build-hooks` bundles it, with valibot and the
// protocol's sidecar schemas it reads requests by, into the one file
// composer-fill.bundle.js, and `just check-hooks-bundle` (in `just ci` and
// GitHub CI) fails while that file is not this source's bundle. Every line
// from the sidecar is read once by the protocol's schema (`readSidecarRequest`)
// into a typed request or a failure, and every engine input a hook uses
// by a schema of the fields it reads. The module loader and `claude plugin
// validate` read the bundle statically: each call is spelled out as
// `$.noun.method(...)` with literal arguments where the engine requires them,
// each hook is a function literal, and `$` is passed only to functions
// declared at the top of the file.
import * as v from "valibot";
import { errorText, type Output, parseWith } from "@ccmsg/protocol/parse";
import {
  type CcmsgToolName,
  PeerListResponseTextSchema,
  SendMessageResponseTextSchema,
  PeersToolInputSchema,
  SayToolInputSchema,
  SendToolInputSchema,
} from "@ccmsg/protocol/peer-tools";
import {
  type AgentAppendResult,
  type DescribeResult,
  type FailedSidecarReply,
  type PromptSendResult,
  readSidecarRequest,
  type SessionFacts,
  type SessionFactsContext,
  type SessionFactsSubagent,
  type SessionFactsTurn,
  SIDECAR_OP_NAMES,
  SIDECAR_REQUEST_VERSION,
  type SidecarErrorCode,
  type SidecarReplyOf,
  type SidecarRequest,
  sidecarRunId,
} from "@ccmsg/protocol/sidecar";
import { toolInputSchemas } from "./tool-input-schemas.ts" with { type: "macro" };
import { peersText, sendResultText, UNCONFIRMED_ADVICE } from "@ccmsg/protocol/peer-tools-text";

/** A piece of a spawned child's output. */
export interface SpawnChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/** How a spawned child ended; undefined when the module ended the stream
 * itself (`return(undefined)`). */
export type SpawnEnd = { code: number | null; signal: string | null } | undefined;

/** The part of the engine interface this module uses, as the engine's
 * `claude-code.d.ts` states it. Declared here rather than imported from
 * `claude-code`, whose types exist only where the engine lays them beside a
 * loaded mod. */
export interface Engine {
  plugin: { root: string };
  session: {
    id(): Promise<string>;
    /** The session's project root, absolute: where it started, or where `/cd`
     * took it; a shell `cd` does not move it. */
    root(): Promise<string>;
    surfaces(): Promise<readonly string[]>;
    /** The model as `/model` names it, a launch-time `[1m]` kept. */
    model(): Promise<string>;
    usage(): Promise<{ context: { window: number; tokens?: number } }>;
    append(args: {
      message: { type: "user"; content: readonly { type: "text"; text: string }[] };
      /** The running subagent whose conversation the row joins; absent for
       * the main one. */
      agentId?: string;
    }): Promise<unknown>;
  };
  agent: {
    /** The session's subagents and teammates, `status` where each loop stands. */
    list(): Promise<readonly { id: string; description: string; type: string; status: string }[]>;
  };
  /** This plugin's key-value store, kept on disk under the config dir across
   * sessions, resumes and reloads. A value read back is outside data. */
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: object): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  prompt: {
    read(): Promise<{ text: string; cursor: number }>;
    fill(input: {
      text: string;
      mode?: "replace" | "append" | "insert";
    }): Promise<{ isFilled: boolean; refusal?: "no_composer" | "dialog"; text: string }>;
  };
  process: {
    run(
      argv: readonly string[],
      init?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    spawn(request: { argv: readonly string[] }): AsyncGenerator<SpawnChunk, SpawnEnd>;
  };
  tool: {
    register(spec: {
      name: string;
      description: string;
      inputSchema: object;
      isDeferred: boolean;
    }): Promise<void>;
  };
  env: { get(name: string): Promise<string | undefined> };
  clock: {
    now(): Promise<number>;
    after(ms: number, fn: () => void): { cancel(): void };
  };
  ui: { log(text: string, options?: { to?: "debug" }): void };
}

/** The events this module observes and passes on. */
export type ObservedEvent =
  | "session.start"
  | "session.end"
  | "session.measure"
  | "session.compact"
  | "command.run"
  | "prompt.submit"
  | "turn.start"
  | "turn.complete";

/** The events this module hooks. */
export type HookedEvent = ObservedEvent | "turn.step" | "tool.call";

/** A hook: generic in the event's input and in its result, so all it can do
 * with either is read the input through a schema and pass both on as
 * received. */
export type Hook = <E, R>($: Engine, e: E, next: (e: E) => Promise<R>) => Promise<R>;
/** What a tool of this module answers its call with: the text the model
 * reads. */
export interface ToolAnswer {
  result: string;
}
/** A tool.call hook: it answers the call itself, without `next`. */
export type ToolHook = <E, R>(
  $: Engine,
  e: E,
  next: (e: E) => Promise<R>,
) => Promise<R | ToolAnswer>;
/** The turn.step hook: a streaming event, so the hook is a generator that
 * passes the stream beneath on as it comes (`yield* next(e)`). */
export type StepHook = <E, Y, R>(
  $: Engine,
  e: E,
  next: (e: E) => AsyncGenerator<Y, R>,
) => AsyncGenerator<Y, R>;
/** The hook each event takes. */
export interface HookOf extends Record<ObservedEvent, Hook> {
  "turn.step": StepHook;
  "tool.call": ToolHook;
}
/** The tools this module registers, as the model calls them: the plugin's
 * name is their prefix (plugin.json). */
export type ToolName = CcmsgToolName;
type HookOnly = { [K in Exclude<HookedEvent, "tool.call">]: [hook: HookOf[K]] };
/** What `on` takes after the event: the hook, and for tool.call first the
 * tool it answers. */
export interface HookArgs extends HookOnly {
  "tool.call": [matcher: { tool: ToolName }, hook: ToolHook];
}
/** `on(event, hook)`, `on("tool.call", { tool }, hook)`. What it returns has
 * one `.catch`, run in the hook's place when the hook throws or overruns its
 * budget. The engine's `next` there is replay-safe: after the hook called it,
 * it answers what that call settled to and runs nothing beneath again. */
export type On = <K extends HookedEvent>(
  event: K,
  ...args: HookArgs[K]
) => { catch(handler: HookOf[K]): void };

// The engine's input for each event, as far as this module reads it. The
// engine is another program, and its inputs change between its versions, so
// they are read like any data from outside (DR-0038 §1): the fields used, each
// one allowed to be absent, the rest let through. The shapes follow the
// engine's `claude-code.d.ts`.
const SessionStartInputSchema = v.looseObject({
  isInteractive: v.optional(v.boolean()),
  surface: v.optional(v.nullable(v.string())),
});
const SessionEndInputSchema = v.looseObject({ reason: v.optional(v.string()) });
const CommandRunInputSchema = v.looseObject({ command: v.optional(v.string()) });
const SessionCompactInputSchema = v.looseObject({});
const SessionMeasureInputSchema = v.looseObject({
  context: v.optional(
    v.looseObject({ window: v.optional(v.number()), tokens: v.optional(v.number()) }),
  ),
});
// The engine's turn events name the subagent whose loop they belong to
// (`agentId`), absent on the main thread. A request carries the effort it
// asks for (a level, or a number), absent for a model without effort.
const TurnStepInputSchema = v.looseObject({
  agentId: v.optional(v.string()),
  effort: v.optional(v.union([v.string(), v.number()])),
});
const TurnStartInputSchema = v.looseObject({ agentId: v.optional(v.string()) });
const TurnCompleteInputSchema = v.looseObject({ agentId: v.optional(v.string()) });
const PromptSubmitInputSchema = v.looseObject({
  text: v.optional(v.string()),
  origin: v.optional(v.looseObject({ kind: v.optional(v.string()) })),
});
/** What a prompt.submit settles on: the prompt that entered, or a `drop`. */
const PromptSubmitResultSchema = v.looseObject({ drop: v.optional(v.string()) });

/** What a hook of this module does with an event it observes: `before` runs
 * ahead of the event, `after` once the event went through, with what it
 * settled on. */
interface Observer<T, R> {
  before?: (e: T) => Promise<void> | void;
  after?: (e: T, result: R) => Promise<void> | void;
}

/** The body of a hook that observes `event`: pass it on exactly once, as
 * received. The input is read with `schema`; one that does not read is logged
 * and the event goes on without this module's part. A failure of `before`
 * lets the event go on as if this hook were not there; a failure of `after` is
 * logged and the event's result stands. Neither reaches the engine as a
 * failed hook, so the only thing that can make the hook throw is `next`
 * itself.
 *
 * The module loader and `claude plugin validate` follow `$` statically: each
 * `on(...)` spells its hook as a function literal that calls this, and `$`
 * goes only to functions declared at the top of the file, so `before` and
 * `after` take the input alone and reach `$` through the hook's literal. */
async function observe<E, R, S extends v.GenericSchema>(
  $: Engine,
  e: E,
  next: (e: E) => Promise<R>,
  event: ObservedEvent,
  schema: S,
  observer: Observer<Output<S>, R>,
): Promise<R> {
  const read = parseWith(schema, e);
  if (!read.ok) $.ui.log(`ccmsg: ${event} not read: ${read.failure.summary}`, { to: "debug" });
  const run = async (
    when: "before" | "after",
    part: ((e: Output<S>) => Promise<void> | void) | undefined,
  ): Promise<void> => {
    if (!read.ok || part === undefined) return;
    try {
      await part(read.value);
    } catch (error) {
      $.ui.log(`ccmsg: ${event} failed ${when} the event: ${errorText(error)}`, { to: "debug" });
    }
  };
  await run("before", observer.before);
  const result = await next(e);
  const after = observer.after;
  await run("after", after && ((input) => after(input, result)));
  return result;
}

/** `hyoui input` budget. One prompt.send costs at most
 * HYOUI_TIMEOUT_MS + ACCEPT_WAIT_MS + REPLY_TIMEOUT_MS (9 s), which fits the
 * daemon's 12 s deadline for a user_prompt with room for a second run's
 * quick answer. Enter itself takes tens of milliseconds; the margin
 * is hyoui's own lock when another client is mid-input. */
export const HYOUI_TIMEOUT_MS = 3_000;
/** How long after Enter the prompt.submit of the filled text may take to go
 * through. Measured at 9 to 15 ms for a prompt typed while a tool runs
 * (DR-0039 §2); the margin is for a loaded machine. */
export const ACCEPT_WAIT_MS = 3_000;
/** A reply is one `ccmsg` process and one round trip to the daemon, measured
 * at about 0.3 s. `ccmsg version` for describe is the same process without
 * the round trip. */
export const REPLY_TIMEOUT_MS = 3_000;
/** `send` budget: the `ccmsg sidecar send-message` process, the daemon reading
 * the runs (within 1 s), and every run's write (2 s) and refusal window
 * (0.25 s), the runs in parallel — about 5 s at worst, with the rest left for
 * a daemon the command has to start. The wait is the process's, which the
 * hook's budget does not count (DR-0039 §3); past it the send is answered as
 * unconfirmed. */
export const SEND_TIMEOUT_MS = 10_000;
/** `peers` budget: the process and the daemon reading the runs. */
export const PEERS_TIMEOUT_MS = 5_000;
/** `say` budget: `ccmsg say` records the say and then speaks, and returns
 * when the speech ends, so a long text takes as long as it is to say. */
export const SAY_TIMEOUT_MS = 120_000;
/** Respawn delays for a sidecar that keeps dying young: doubled per death
 * from the first value up to the last, and back to the first once a sidecar
 * has lived STABLE_MS. */
export const RESPAWN_MIN_MS = 500;
export const RESPAWN_MAX_MS = 30_000;
export const STABLE_MS = 10_000;

/** The reply to one request this module runs. */
export type Reply =
  | SidecarReplyOf<"describe">
  | SidecarReplyOf<"prompt.send">
  | SidecarReplyOf<"session.facts">
  | SidecarReplyOf<"agent.append">;

/** A prompt.send, as the module queues it: under which session id and which
 * generation of it the line arrived. */
export interface QueuedSend {
  id: string;
  text: string;
  sid: string;
  generation: number;
}

function failed(id: string, code: SidecarErrorCode, message: string): FailedSidecarReply {
  return { id, ok: false, error: { code, message } };
}

/** `hyoui input` for one Enter on this session's terminal. The session id
 * alone names the terminal: hyoui ids are unique across the sessions it can
 * see, so nothing else goes with it. */
export function hyouiEnterArgv(hyouiSessionId: string): string[] {
  return ["hyoui", "input", hyouiSessionId, "key:Enter"];
}

/** Whether a submitted prompt is the filled text. The harness drops trailing
 * whitespace from a prompt before raising UserPromptSubmit (measured on
 * 2.1.293 with a trailing newline, spaces, a tab and an ideographic space,
 * the set `trimEnd` removes); leading whitespace, blank lines inside and tabs
 * inside reach it as filled. prompt.submit's text is held to the same
 * allowance, nothing more. */
export function samePrompt(submitted: string, filled: string): boolean {
  return submitted === filled || submitted === filled.trimEnd();
}

/** Split a stream of text pieces into lines; a piece may end mid-line. */
export function lineSplitter(onLine: (line: string) => void): (piece: string) => void {
  let rest = "";
  return (piece) => {
    const parts = (rest + piece).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) if (part.trim() !== "") onLine(part);
  };
}

const UNCONFIRMED: PromptSendResult = { outcome: "unconfirmed" };
const SESSION_CHANGED: PromptSendResult = { outcome: "not_delivered", reason: "session_changed" };

/** The module's state for one load. */
export interface ModuleState {
  /** The text whose submit from the composer is awaited, and who to tell. */
  awaiting?: { text: string; accept: () => void };
  /** The text whose submit puts the draft back, and the draft. */
  restoring?: { text: string; draft: string };
  /** The session id the module serves, and how many times it has changed
   * (/clear, /resume). A prompt.send belongs to the generation it arrived in. */
  sid?: string;
  generation: number;
  /** Whether the session has a composer to fill; undefined until known. */
  interactive?: boolean;
  /** prompt.sends run one at a time: two at once would trade drafts. */
  queue: Promise<void>;
  sidecar?: { sid: string; child: AsyncGenerator<SpawnChunk, SpawnEnd> };
  delay: number;
  /** Sidecar starts run one at a time, so a session.start and a command.run
   * arriving together cannot each start one. */
  starting: Promise<void>;
  /** This run, as every sidecar of this load names it: drawn when the first
   * sidecar starts, which is about when the harness started, and kept across
   * sidecars and session ids so the daemon sees one run. */
  run?: { id: string; startedAt: number };
  /** What the module knows of the session through Claude Code (session.facts):
   * each part once it has been read. */
  facts: {
    model?: string;
    effort?: string;
    context?: SessionFactsContext;
    turn?: SessionFactsTurn;
    subagents?: SessionFactsSubagent[];
  };
  /** Facts are sent one at a time; `queued` is whether a send waits its turn,
   * which then sends what the module knows when it starts, so any number of
   * changes meanwhile cost one send. */
  factsSend: { chain: Promise<void>; queued: boolean };
}

export function newState(): ModuleState {
  return {
    generation: 0,
    queue: Promise.resolve(),
    delay: RESPAWN_MIN_MS,
    starting: Promise.resolve(),
    facts: {},
    factsSend: { chain: Promise.resolve(), queued: false },
  };
}

/** The session moved to another id: what was waiting for the old one is
 * dropped, so nothing of it reaches the new session. */
function nextGeneration(state: ModuleState): void {
  state.generation += 1;
  state.awaiting = undefined;
}

/** Whether `request` still belongs to the session as it is now. */
async function stillCurrent($: Engine, state: ModuleState, request: QueuedSend): Promise<boolean> {
  if (request.generation !== state.generation || request.sid !== state.sid) return false;
  return (await $.session.id()) === request.sid;
}

/** Put the draft back if the composer still holds the filled text, which
 * means Enter never submitted it. True only when the text is known to be out
 * of the composer afterwards: the put-back fill went in and the composer no
 * longer holds the text. A refused put-back (a dialog opened meanwhile) leaves
 * the text there for a later Enter to send, which is not "not delivered".
 * A draft that itself contains the text also reads false: the two cannot be
 * told apart, and false is the side that does not risk a second copy. */
async function putBackUnsent($: Engine, text: string, draft: string): Promise<boolean> {
  const box = await $.prompt.read();
  if (box.text !== text) return false;
  const put = await $.prompt.fill({ text: draft, mode: "replace" });
  if (!put.isFilled) return false;
  return !(await $.prompt.read()).text.includes(text);
}

/** One prompt.send, start to finish. */
export async function handlePromptSend(
  $: Engine,
  state: ModuleState,
  request: QueuedSend,
): Promise<PromptSendResult> {
  const hyouiSessionId = await $.env.get("HYOUI_SESSION_ID");
  // Checked before the composer is touched: a session outside hyoui has no
  // terminal to press Enter on, and the person's draft is left as it is.
  if (!hyouiSessionId) return { outcome: "not_delivered", reason: "no_terminal" };
  const draft = (await $.prompt.read()).text;
  const filled = await $.prompt.fill({ text: request.text, mode: "replace" });
  if (!filled.isFilled) return { outcome: "not_delivered", reason: filled.refusal ?? "refused" };

  // The last moment the request can still be kept out of a session it was
  // not meant for. With the text still in the composer and put back, no Enter
  // went out for it: it is known not to be in.
  if (!(await stillCurrent($, state, request))) {
    return (await putBackUnsent($, request.text, draft)) ? SESSION_CHANGED : UNCONFIRMED;
  }
  const accepted = Promise.withResolvers<boolean>();
  state.awaiting = { text: request.text, accept: () => accepted.resolve(true) };
  state.restoring = { text: request.text, draft };
  let entered: boolean;
  try {
    const run = await $.process.run(hyouiEnterArgv(hyouiSessionId), {
      timeoutMs: HYOUI_TIMEOUT_MS,
    });
    entered = run.exitCode === 0;
  } catch {
    entered = false;
  }
  // A failed `hyoui input` may still have delivered the key, so the event is
  // waited for either way.
  const timer = $.clock.after(ACCEPT_WAIT_MS, () => accepted.resolve(false));
  const isAccepted = await accepted.promise;
  timer.cancel();
  if (state.awaiting?.text === request.text) state.awaiting = undefined;
  // Enter went out under an id that is no longer the session's: whatever it
  // did, it is not this request's to report.
  if (request.generation !== state.generation) return UNCONFIRMED;
  if (isAccepted) return { outcome: "accepted" };
  if (state.restoring?.text === request.text) state.restoring = undefined;
  if (await putBackUnsent($, request.text, draft)) {
    return { outcome: "not_delivered", reason: entered ? "not_submitted" : "enter_failed" };
  }
  return UNCONFIRMED;
}

/** After a filled prompt went in: give the person their draft back, unless
 * they have started a new one meanwhile — what they are typing now is not
 * overwritten, and the old draft goes to the debug log instead. */
async function putBackDraft($: Engine, submitted: string, draft: string): Promise<void> {
  const box = await $.prompt.read();
  if (box.text !== "" && box.text !== submitted) {
    $.ui.log(`ccmsg: kept the newly typed text; the earlier draft was: ${draft}`, {
      to: "debug",
    });
    return;
  }
  await $.prompt.fill({ text: draft, mode: "replace" });
}

/** `ccmsg sidecar reply` for a reply to a request that arrived under `sid`.
 * The reply itself goes on standard input (see `sendReply`). */
export function replyArgv(root: string, sid: string): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", "reply", "--sid", sid];
}

/** Hand `reply` to the daemon. On standard input rather than as an argument:
 * a reply carries whatever its op returns, an argument is bounded in size and
 * shown to every user by `ps`, and `$.process.run` writes `stdin` once and
 * closes it, which is all one reply needs. */
async function sendReply($: Engine, sid: string, reply: Reply): Promise<void> {
  try {
    const done = await $.process.run(replyArgv($.plugin.root, sid), {
      stdin: JSON.stringify(reply),
      timeoutMs: REPLY_TIMEOUT_MS,
    });
    if (done.exitCode !== 0) {
      $.ui.log(`ccmsg: reply ${reply.id} exited ${done.exitCode}: ${done.stderr.trim()}`, {
        to: "debug",
      });
    }
  } catch (e) {
    $.ui.log(`ccmsg: reply ${reply.id} failed: ${errorText(e)}`, { to: "debug" });
  }
}

async function promptSend(
  $: Engine,
  state: ModuleState,
  request: QueuedSend,
): Promise<SidecarReplyOf<"prompt.send">> {
  // Nothing has touched the composer yet: the text is known not to be in.
  if (request.generation !== state.generation || request.sid !== state.sid) {
    $.ui.log(`ccmsg: prompt.send ${request.id} not filled: the session changed its id`, {
      to: "debug",
    });
    return { id: request.id, ok: true, result: SESSION_CHANGED };
  }
  return { id: request.id, ok: true, result: await handlePromptSend($, state, request) };
}

/** describe's result. The version is the one `ccmsg` beside this module
 * prints; left out when it cannot be had. `CCMSG_NO_SELF_EXEC` keeps that
 * launcher from handing over to a newer ccmsg on PATH, which would print its
 * own version rather than this plugin's. (`$.process.run`'s `env` is laid
 * over the session's environment, not in place of it.) */
async function describe($: Engine): Promise<DescribeResult> {
  const described: DescribeResult = { v: [SIDECAR_REQUEST_VERSION], ops: [...SIDECAR_OP_NAMES] };
  try {
    const run = await $.process.run([`${$.plugin.root}/bin/ccmsg`, "version"], {
      env: { CCMSG_NO_SELF_EXEC: "1" },
      timeoutMs: REPLY_TIMEOUT_MS,
    });
    const version = run.stdout.trim();
    if (run.exitCode === 0 && version !== "") return { ...described, version };
  } catch (e) {
    $.ui.log(`ccmsg: describe could not read the version: ${errorText(e)}`, { to: "debug" });
  }
  return described;
}

/** `ccmsg sidecar facts` for session `sid`. The facts go on standard input,
 * for the reason a reply does (see `sendReply`). */
export function factsArgv(root: string, sid: string): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", "facts", "--sid", sid];
}

/** The facts as the module knows them now. */
async function currentFacts($: Engine, state: ModuleState): Promise<SessionFacts> {
  return { at: Math.floor(await $.clock.now()), ...state.facts };
}

/** Send the facts to the daemon, behind any send still running. A send that
 * waits its turn already sends what the module will know by then, so no
 * second one is queued behind it. Never rejects: a failed send is logged, and
 * the next change or the daemon's `session.facts` request makes up for it. */
function sendFacts($: Engine, state: ModuleState): void {
  const send = state.factsSend;
  if (send.queued) return;
  send.queued = true;
  send.chain = send.chain
    .then(async () => {
      send.queued = false;
      const facts = await currentFacts($, state);
      const sid = await $.session.id();
      const done = await $.process.run(factsArgv($.plugin.root, sid), {
        stdin: JSON.stringify(facts),
        timeoutMs: REPLY_TIMEOUT_MS,
      });
      if (done.exitCode !== 0) {
        $.ui.log(`ccmsg: facts exited ${done.exitCode}: ${done.stderr.trim()}`, { to: "debug" });
      }
    })
    .catch((e: unknown) => {
      send.queued = false;
      $.ui.log(`ccmsg: facts not sent: ${errorText(e)}`, { to: "debug" });
    });
}

/** The window and the fill as the facts carry them: a fill Claude Code does
 * not report (before the first response, right after a compaction) is left
 * out. */
function contextFacts(
  context: { window: number; tokens?: number },
  at: number,
): SessionFactsContext {
  return {
    window: context.window,
    ...(context.tokens !== undefined ? { tokens: context.tokens } : {}),
    at,
  };
}

/** Take the effort a main-thread request asks for, and send the facts when
 * it moved. A number (an effort given as a budget rather than a level) is
 * carried as its digits. */
function requestEffort($: Engine, state: ModuleState, effort: string | number | undefined): void {
  const level = typeof effort === "number" ? String(effort) : effort;
  if (level === undefined || level === "" || level === state.facts.effort) return;
  state.facts = { ...state.facts, effort: level };
  sendFacts($, state);
}

/** `ccmsg sidecar begin` for session `sid` working in `cwd`. */
export function beginArgv(root: string, sid: string, cwd: string): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", "begin", "--sid", sid, "--cwd", cwd];
}

/** `ccmsg sidecar begin` budget: the VCS lookup (1 s at most) and the daemon's
 * start, whose wait for the new daemon to listen is about 10 s at most and
 * twice that when a running daemon of another version is replaced. The
 * daemon itself is detached, so a begin cut short leaves it starting. */
export const BEGIN_TIMEOUT_MS = 25_000;

// --- the guidance (DR-0039 §5) ----------------------------------------------

/** What the model is told of ccmsg before its first turn: where to read how
 * (the plugin's skill), and nothing of the tools' use itself, which is the
 * skill's to say. */
export const GUIDANCE =
  'このセッションでは ccmsg が使える。別のセッションへの送信、届いた <cross-session-message from="ccmsg:…"> への返信、見ている人への知らせは、先に skill ccmsg-v1:ccmsg を読んでから行う。';

/** Whether a session's conversation holds the guidance, by session id in
 * `$.store`: a conversation's id outlives its process (`--resume`, an in-
 * session `/resume`), so a resumed one is not told again, and `/clear`
 * starts one under a new id, which is. `at` is when it was last set or
 * found, which the sweep goes by. */
const GuidedRecordSchema = v.object({ guided: v.boolean(), at: v.number() });
const GUIDED_PREFIX = "guided:";
function guidedKey(sid: string): string {
  return `${GUIDED_PREFIX}${sid}`;
}
/** How long a session's record outlives its last use: as long as ccmsg keeps
 * a session's state file. A conversation resumed after that is told again. */
export const GUIDED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How stale a record may get before a prompt that finds it in place sets
 * its time again: a write a day rather than one per prompt. */
const GUIDED_TOUCH_MS = 24 * 60 * 60 * 1000;

/** The session's record, or undefined when there is none (or one this
 * module does not read, which the next write replaces). */
async function guidedRecord(
  $: Engine,
  key: string,
): Promise<Output<typeof GuidedRecordSchema> | undefined> {
  const read = parseWith(GuidedRecordSchema, await $.store.get(key));
  return read.ok ? read.value : undefined;
}

/** Put the guidance into the conversation unless it holds it: once per
 * conversation, and again after a compaction, which summarizes it away. Not
 * for a session with no composer (`-p`, the SDK), which the tools are not
 * registered for either. Never rejects: without it the session runs as
 * before. */
async function guide($: Engine, state: ModuleState): Promise<void> {
  if (state.interactive !== true) return;
  try {
    const key = guidedKey(await $.session.id());
    const now = Math.floor(await $.clock.now());
    const held = await guidedRecord($, key);
    if (held?.guided === true) {
      if (now - held.at > GUIDED_TOUCH_MS) await $.store.set(key, { guided: true, at: now });
      return;
    }
    await $.session.append({
      message: { type: "user", content: [{ type: "text", text: GUIDANCE }] },
    });
    await $.store.set(key, { guided: true, at: now });
  } catch (e) {
    $.ui.log(`ccmsg: guidance not added: ${errorText(e)}`, { to: "debug" });
  }
}

/** A compaction summarized the guidance away: the next prompt adds it back
 * (appended during the compaction it would land before the boundary and be
 * dropped, DR-0039 §5). Never rejects. */
async function unguide($: Engine): Promise<void> {
  try {
    const key = guidedKey(await $.session.id());
    await $.store.set(key, { guided: false, at: Math.floor(await $.clock.now()) });
  } catch (e) {
    $.ui.log(`ccmsg: could not mark the guidance for after the compaction: ${errorText(e)}`, {
      to: "debug",
    });
  }
}

/** Remove the records of sessions not used for GUIDED_TTL_MS, and those this
 * module does not read. Never rejects. */
async function sweepGuided($: Engine): Promise<void> {
  try {
    const now = Math.floor(await $.clock.now());
    for (const key of await $.store.keys()) {
      if (!key.startsWith(GUIDED_PREFIX)) continue;
      const held = await guidedRecord($, key);
      if (held === undefined || now - held.at > GUIDED_TTL_MS) await $.store.delete(key);
    }
  } catch (e) {
    $.ui.log(`ccmsg: guidance records not swept: ${errorText(e)}`, { to: "debug" });
  }
}

// --- the tools (DR-0039 §3) ------------------------------------------------

/** The tools' input schemas for the model, derived from the schemas their
 * handlers read the inputs with when the module is bundled (a macro). */
const TOOL_INPUT_SCHEMAS = toolInputSchemas();

/** Register the tools. Deferred, with descriptions kept short: subagents and
 * teammates see them too, and how to use them is the plugin's skill's to say
 * (DR-0039 §3). A registration that fails is logged; the session goes on
 * without that tool. */
async function registerTools($: Engine): Promise<void> {
  const registered = await Promise.allSettled([
    $.tool.register({
      name: "send",
      description: "Send a message to other Claude Code sessions (see the ccmsg skill).",
      inputSchema: TOOL_INPUT_SCHEMAS.send,
      isDeferred: true,
    }),
    $.tool.register({
      name: "say",
      description: "Tell the person something by voice (see the ccmsg skill).",
      inputSchema: TOOL_INPUT_SCHEMAS.say,
      isDeferred: true,
    }),
    $.tool.register({
      name: "peers",
      description: "List the sessions send can reach (see the ccmsg skill).",
      inputSchema: TOOL_INPUT_SCHEMAS.peers,
      isDeferred: true,
    }),
  ]);
  for (const outcome of registered) {
    if (outcome.status === "rejected") {
      $.ui.log(`ccmsg: a tool was not registered: ${errorText(outcome.reason)}`, { to: "debug" });
    }
  }
}

/** `ccmsg sidecar send-message` / `peer-list` for session `sid`: the input goes
 * on standard input, for the reason a reply does (see `sendReply`). */
export function peerArgv(
  root: string,
  command: "send-message" | "peer-list",
  sid: string,
): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", command, "--sid", sid];
}

/** What a tool says when its input is not the tool's. */
function notTheInput(tool: string, summary: string): string {
  return `${tool} の入力が形に合わないので何もしていない: ${summary}`;
}

/** The `send` tool: send the text to the sessions the input names, and say
 * what came of it for each. Never rejects. */
async function sendTool<E>($: Engine, e: E): Promise<string> {
  const read = parseWith(SendToolInputSchema, e);
  if (!read.ok) return notTheInput("send", read.failure.summary);
  const { text, agent_id, ...to } = read.value;
  let run: { exitCode: number; stdout: string; stderr: string };
  try {
    run = await $.process.run(peerArgv($.plugin.root, "send-message", await $.session.id()), {
      stdin: JSON.stringify({ to, ...(agent_id !== undefined ? { agent_id } : {}), text }),
      timeoutMs: SEND_TIMEOUT_MS,
    });
  } catch (error) {
    $.ui.log(`ccmsg: send failed: ${errorText(error)}`, { to: "debug" });
    return `ccmsg sidecar send-message が ${String(SEND_TIMEOUT_MS / 1000)} 秒以内に終わらなかったか起動できず、届いたか確かめられなかった: ${errorText(error)}。${UNCONFIRMED_ADVICE}`;
  }
  const answered = parseWith(SendMessageResponseTextSchema, run.stdout);
  if (answered.ok) return sendResultText(answered.value.results);
  const said = run.stderr.trim().split("\n")[0] ?? "";
  $.ui.log(`ccmsg: send exited ${String(run.exitCode)}: ${run.stderr.trim()}`, { to: "debug" });
  // 3: no daemon could be had, so nothing went out.
  if (run.exitCode === 3) {
    return `ccmsg の daemon に繋がらず、送っていない: ${said}。少し置いて一度だけ送り直す`;
  }
  return `ccmsg が送信の結果を返さず、届いたか確かめられなかった${said !== "" ? `: ${said}` : ""}。${UNCONFIRMED_ADVICE}`;
}

/** The `say` tool: say the text to the person through `ccmsg say`, which
 * records it for the webui (📣) and speaks it. Never rejects. */
async function sayTool<E>($: Engine, e: E): Promise<string> {
  const read = parseWith(SayToolInputSchema, e);
  if (!read.ok) return notTheInput("say", read.failure.summary);
  try {
    const sid = await $.session.id();
    const run = await $.process.run([`${$.plugin.root}/bin/ccmsg`, "say", read.value.text], {
      env: { CCMSG_SID: sid },
      timeoutMs: SAY_TIMEOUT_MS,
    });
    if (run.exitCode === 0) return "伝えた (音声と webui の 📣)";
    return `say が失敗した (exit ${String(run.exitCode)}): ${run.stderr.trim().split("\n")[0] ?? ""}`;
  } catch (error) {
    return `say を起こせなかったか ${String(SAY_TIMEOUT_MS / 1000)} 秒以内に終わらなかった: ${errorText(error)}`;
  }
}

/** The `peers` tool: the sessions `send` can reach, spelled as it takes them.
 * Never rejects. */
async function peersTool<E>($: Engine, e: E): Promise<string> {
  const read = parseWith(PeersToolInputSchema, e);
  if (!read.ok) return notTheInput("peers", read.failure.summary);
  try {
    const run = await $.process.run(peerArgv($.plugin.root, "peer-list", await $.session.id()), {
      stdin: JSON.stringify(read.value),
      timeoutMs: PEERS_TIMEOUT_MS,
    });
    const answered = parseWith(PeerListResponseTextSchema, run.stdout);
    if (answered.ok) return peersText(answered.value.peers);
    return `一覧を返せなかった: ${run.stderr.trim().split("\n")[0] ?? ""}`;
  } catch (error) {
    return `一覧を返せなかった: ${errorText(error)}`;
  }
}

/** The session began under the id it has now (its start, /clear, /resume):
 * write its state file and bring the daemon up (DR-0039 §2). Run without
 * being awaited, so neither holds the session up; never rejects. */
async function sessionBegin($: Engine): Promise<void> {
  try {
    const sid = await $.session.id();
    const cwd = await $.session.root();
    const done = await $.process.run(beginArgv($.plugin.root, sid, cwd), {
      timeoutMs: BEGIN_TIMEOUT_MS,
    });
    if (done.exitCode !== 0) {
      $.ui.log(`ccmsg: begin exited ${done.exitCode}: ${done.stderr.trim()}`, { to: "debug" });
    }
  } catch (e) {
    $.ui.log(`ccmsg: begin failed: ${errorText(e)}`, { to: "debug" });
  }
}

/** Read the model and the context window off the session, and send the
 * facts. Never rejects. */
async function readModelAndWindow($: Engine, state: ModuleState): Promise<void> {
  try {
    const model = await $.session.model();
    const { context } = await $.session.usage();
    const at = Math.floor(await $.clock.now());
    state.facts = { ...state.facts, model, context: contextFacts(context, at) };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the model and the window: ${errorText(e)}`, { to: "debug" });
  }
  sendFacts($, state);
}

/** A session began (its start, or /clear): no turn is running, and the
 * model and the window are read. Never rejects. */
async function sessionBegan($: Engine, state: ModuleState): Promise<void> {
  try {
    const since = Math.floor(await $.clock.now());
    state.facts = { ...state.facts, turn: { state: "idle", since } };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the clock: ${errorText(e)}`, { to: "debug" });
  }
  await readSubagents($, state);
  await readModelAndWindow($, state);
}

// --- the subagents (DR-0039 §6) --------------------------------------------

/** Read the subagents running now off the session (`$.agent.list()`): what
 * the module knows when it has seen none start (it was loaded meanwhile, or
 * the session changed its id). When their turns started is not known, so it
 * is left out. Sends nothing; never rejects. */
async function readSubagents($: Engine, state: ModuleState): Promise<void> {
  try {
    const running = (await $.agent.list()).filter((agent) => agent.status === "running");
    state.facts = {
      ...state.facts,
      subagents: running.map((agent) => subagentFacts(agent.id, agent)),
    };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the subagents: ${errorText(e)}`, { to: "debug" });
  }
}

function subagentFacts(
  id: string,
  agent: { description: string; type: string } | undefined,
  since?: number,
): SessionFactsSubagent {
  return {
    id,
    ...(agent !== undefined && agent.description !== "" ? { description: agent.description } : {}),
    ...(agent !== undefined && agent.type !== "" ? { type: agent.type } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

/** A subagent's loop started a turn: it is running, and a message can be
 * added to its conversation until the turn ends. Never rejects. */
async function subagentStarted($: Engine, state: ModuleState, id: string): Promise<void> {
  try {
    const since = Math.floor(await $.clock.now());
    const agent = (await $.agent.list()).find((a) => a.id === id);
    const others = (state.facts.subagents ?? []).filter((a) => a.id !== id);
    state.facts = { ...state.facts, subagents: [...others, subagentFacts(id, agent, since)] };
  } catch (e) {
    $.ui.log(`ccmsg: could not take the subagent ${id}: ${errorText(e)}`, { to: "debug" });
  }
  sendFacts($, state);
}

/** A subagent's turn ended: nothing can be added to its conversation now. */
function subagentEnded($: Engine, state: ModuleState, id: string): void {
  const held = state.facts.subagents;
  if (held === undefined || !held.some((a) => a.id === id)) return;
  state.facts = { ...state.facts, subagents: held.filter((a) => a.id !== id) };
  sendFacts($, state);
}

/** What a subagent reads of a message: marked as the person's through ccmsg,
 * or as from the session `from` that sent it with `send` (DR-0039 §3), so the
 * model takes it as a word from outside its task, not a tool's output. */
export function agentMessage(text: string, from?: string): string {
  const mark = from !== undefined ? `ccmsg:${from} から:` : "ユーザから (ccmsg 経由):";
  return `${mark}\n${text}`;
}

/** agent.append: add the text to the running subagent's conversation.
 * Claude Code refuses an id no loop runs under with "no running loop is
 * <id>". */
async function appendToAgent(
  $: Engine,
  args: { agentId: string; from?: string; text: string },
): Promise<AgentAppendResult> {
  try {
    await $.session.append({
      message: {
        type: "user",
        content: [{ type: "text", text: agentMessage(args.text, args.from) }],
      },
      agentId: args.agentId,
    });
    return { outcome: "appended" };
  } catch (e) {
    const why = errorText(e);
    $.ui.log(`ccmsg: agent.append to ${args.agentId} refused: ${why}`, { to: "debug" });
    return {
      outcome: "not_delivered",
      reason: why.includes("no running loop") ? "not_running" : "refused",
    };
  }
}

/** The main thread is answering a turn now, or not; the facts are sent.
 * Never rejects. */
async function turnState(
  $: Engine,
  state: ModuleState,
  turn: SessionFactsTurn["state"],
): Promise<void> {
  try {
    const since = Math.floor(await $.clock.now());
    state.facts = { ...state.facts, turn: { state: turn, since } };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the clock: ${errorText(e)}`, { to: "debug" });
  }
  sendFacts($, state);
}

/** The reply to one request: the op's, or `internal` when anything is thrown
 * on the way, so every request is answered. */
async function replyTo(
  $: Engine,
  state: ModuleState,
  sid: string,
  generation: number,
  request: SidecarRequest,
): Promise<Reply> {
  const { id } = request;
  try {
    switch (request.op) {
      case "describe":
        return { id, ok: true, result: await describe($) };
      case "prompt.send": {
        const queued: QueuedSend = { id, text: request.args.text, sid, generation };
        // One at a time: two at once would trade drafts. A failed one does not
        // hold up the next.
        const result = state.queue.then(() => promptSend($, state, queued));
        state.queue = result.then(
          () => undefined,
          () => undefined,
        );
        return await result;
      }
      case "session.facts":
        return { id, ok: true, result: await currentFacts($, state) };
      case "agent.append":
        return { id, ok: true, result: await appendToAgent($, request.args) };
    }
  } catch (e) {
    $.ui.log(`ccmsg: request ${id} failed: ${errorText(e)}`, { to: "debug" });
    return failed(id, "internal", errorText(e));
  }
}

/** Run one request line that arrived under `sid` in `generation`, and reply.
 * A line that is not a request this module runs is logged and not answered.
 * Never rejects: a reply that cannot be sent is logged. */
export function answer(
  $: Engine,
  state: ModuleState,
  sid: string,
  generation: number,
  line: string,
): Promise<void> {
  const read = readSidecarRequest(line);
  if (!read.ok) {
    $.ui.log(
      `ccmsg sidecar: dropped a line that is not a request this module runs (${read.failure.summary}): ${line.slice(0, 200)}`,
      { to: "debug" },
    );
    return Promise.resolve();
  }
  const { id } = read.value;
  // sendReply catches its own failures; this catches anything else, so the
  // promise never rejects for the caller that drops it.
  return replyTo($, state, sid, generation, read.value)
    .then((r) => sendReply($, sid, r))
    .catch((e: unknown) => {
      $.ui.log(`ccmsg: request ${id} not answered: ${errorText(e)}`, { to: "debug" });
    });
}

/** `ccmsg sidecar` for `sid` in run `run`. The config dir and the terminal
 * are read through `$.env.get` here, as prompt.send reads the terminal, so
 * what the daemon is told the run has is what the module will use. */
async function sidecarArgv(
  $: Engine,
  sid: string,
  run: { id: string; startedAt: number },
): Promise<string[]> {
  const configDir = await $.env.get("CLAUDE_CONFIG_DIR");
  const hyouiSessionId = await $.env.get("HYOUI_SESSION_ID");
  return [
    `${$.plugin.root}/bin/ccmsg`,
    "sidecar",
    "--sid",
    sid,
    "--run",
    run.id,
    "--started-at",
    String(run.startedAt),
    ...(configDir ? ["--config-dir", configDir] : []),
    ...(hyouiSessionId ? ["--hyoui-session-id", hyouiSessionId] : []),
  ];
}

/** Run one sidecar for `sid` until it ends, then start the next one unless it
 * was replaced. The next start goes through `$.clock.after`, which a module
 * unload cancels: the unload kills the child, and this is what keeps that
 * death from being answered with a new one. */
async function runSidecar(
  $: Engine,
  state: ModuleState,
  sid: string,
  run: { id: string; startedAt: number },
): Promise<void> {
  const child = $.process.spawn({ argv: await sidecarArgv($, sid, run) });
  const mine = { sid, child };
  state.sidecar = mine;
  const startedAt = await $.clock.now();
  const onLine = lineSplitter((line) => {
    void answer($, state, sid, state.generation, line);
  });
  try {
    for await (const piece of child) {
      if (piece.stream === "stdout") onLine(piece.text);
      else $.ui.log(`ccmsg sidecar: ${piece.text.trimEnd()}`, { to: "debug" });
    }
  } catch (e) {
    $.ui.log(`ccmsg sidecar: ${errorText(e)}`, { to: "debug" });
  }
  if (state.sidecar !== mine) return;
  state.sidecar = undefined;
  const lived = (await $.clock.now()) - startedAt;
  if (lived >= STABLE_MS) state.delay = RESPAWN_MIN_MS;
  const wait = state.delay;
  state.delay = Math.min(state.delay * 2, RESPAWN_MAX_MS);
  $.clock.after(wait, () => {
    if (state.sidecar === undefined) startSidecar($, state);
  });
}

function startSidecar($: Engine, state: ModuleState): void {
  state.starting = state.starting
    .then(() => replaceSidecar($, state))
    .catch((e: unknown) => {
      $.ui.log(`ccmsg sidecar: start failed: ${errorText(e)}`, { to: "debug" });
    });
}

/** Keep one sidecar, bound under the session's current id. A session that
 * changed its id (/clear, /resume) is written to under the new one, and the
 * old sidecar would never be asked again. */
async function replaceSidecar($: Engine, state: ModuleState): Promise<void> {
  // A command.run can be the first to arrive after a reload; whether the
  // session draws a composer is then asked of the session itself.
  state.interactive ??= (await $.session.surfaces()).length > 0;
  if (!state.interactive) return;
  const sid = await $.session.id();
  if (state.sid !== undefined && state.sid !== sid) nextGeneration(state);
  state.sid = sid;
  if (state.sidecar?.sid === sid) return;
  if (state.run === undefined) {
    const startedAt = await $.clock.now();
    state.run = { id: sidecarRunId(startedAt, Math.random()), startedAt };
  }
  const old = state.sidecar;
  state.sidecar = undefined;
  if (old !== undefined) await old.child.return(undefined);
  void runSidecar($, state, sid, state.run);
}

export function register(on: On): ModuleState {
  const state = newState();
  // Every hook here observes the event and passes it on once (`observe`). The
  // `.catch` covers what is left, `next` failing or the budget running out:
  // the engine's `next` there runs nothing beneath twice.
  //
  // session.start also runs on a hot reload, with the session as it was:
  // begin is idempotent, and the sidecar of the same id is kept.
  on("session.start", async ($, e, next) =>
    observe($, e, next, "session.start", SessionStartInputSchema, {
      after: async (input) => {
        // No composer to fill (`-p`, the SDK): no sidecar to keep (DR-0035 §3).
        state.interactive = input.isInteractive !== false && input.surface !== null;
        void sessionBegin($);
        startSidecar($, state);
        void sessionBegan($, state);
        void sweepGuided($);
        // Awaited, so the tools are listed by the first turn. `-p` and the SDK
        // get none: talking with other sessions from there is not a use ccmsg
        // serves (DR-0039 §3). Registrations outlive /clear and
        // /resume, so this is the one place.
        if (state.interactive) await registerTools($);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // The old id's requests go no further from here: the session after /clear
  // or /resume is another.
  on("session.end", async ($, e, next) =>
    observe($, e, next, "session.end", SessionEndInputSchema, {
      before: (input) => {
        if (input.reason !== "clear" && input.reason !== "resume") return;
        if (state.sid !== undefined) {
          nextGeneration(state);
          state.sid = undefined;
        }
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // /clear and /resume start no session.start: once the command went
  // through, the session's id is the new one (DR-0039 §2). /model raises no
  // session.measure, so the model and the window are read again after it.
  on("command.run", async ($, e, next) =>
    observe($, e, next, "command.run", CommandRunInputSchema, {
      after: (input) => {
        if (input.command === "clear" || input.command === "resume") {
          void sessionBegin($);
          startSidecar($, state);
          void sessionBegan($, state);
        } else if (input.command === "model") {
          void readModelAndWindow($, state);
        }
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("session.compact", async ($, e, next) =>
    observe($, e, next, "session.compact", SessionCompactInputSchema, {
      after: async () => {
        await unguide($);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // session.measure says the window each main-thread turn.
  on("session.measure", async ($, e, next) =>
    observe($, e, next, "session.measure", SessionMeasureInputSchema, {
      after: async (input) => {
        const window = input.context?.window;
        if (window === undefined) return;
        const at = Math.floor(await $.clock.now());
        const tokens = input.context?.tokens;
        state.facts = {
          ...state.facts,
          context: contextFacts({ window, ...(tokens !== undefined ? { tokens } : {}) }, at),
        };
        sendFacts($, state);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // The effort is known when the request is made, before any of its answer;
  // a subagent's request is not the session's.
  on("turn.step", async function* ($, e, next) {
    const read = parseWith(TurnStepInputSchema, e);
    if (!read.ok) {
      $.ui.log(`ccmsg: turn.step not read: ${read.failure.summary}`, { to: "debug" });
    } else if (read.value.agentId === undefined) {
      requestEffort($, state, read.value.effort);
    }
    return yield* next(e);
  }).catch(async function* (_$, e, next) {
    return yield* next(e);
  });
  on("turn.start", async ($, e, next) =>
    observe($, e, next, "turn.start", TurnStartInputSchema, {
      before: (input) => {
        if (input.agentId === undefined) void turnState($, state, "responding");
        else void subagentStarted($, state, input.agentId);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("turn.complete", async ($, e, next) =>
    observe($, e, next, "turn.complete", TurnCompleteInputSchema, {
      after: async (input) => {
        if (input.agentId === undefined) await turnState($, state, "idle");
        else subagentEnded($, state, input.agentId);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // A filled prompt is accepted once its submit from the composer went
  // through: `next` settles when the prompt entered the session or was queued
  // behind the running turn, on a drop when it did not enter. The person gets
  // their draft back then.
  on("prompt.submit", async ($, e, next) =>
    observe($, e, next, "prompt.submit", PromptSubmitInputSchema, {
      // Before the prompt goes in, so its request carries the guidance.
      before: async () => {
        await guide($, state);
      },
      after: async (input, result) => {
        if (input.origin?.kind !== "composer" || input.text === undefined) return;
        const settled = parseWith(PromptSubmitResultSchema, result);
        const entered = settled.ok && settled.value.drop === undefined;
        const awaiting = state.awaiting;
        if (awaiting !== undefined) {
          if (entered && samePrompt(input.text, awaiting.text)) {
            state.awaiting = undefined;
            awaiting.accept();
          } else {
            $.ui.log(
              `ccmsg: prompt.submit ${JSON.stringify(input.text)} ${entered ? "is not" : "dropped, not"} the filled ${JSON.stringify(awaiting.text)}`,
              { to: "debug" },
            );
          }
        }
        const restoring = state.restoring;
        if (!entered || restoring === undefined || !samePrompt(input.text, restoring.text)) return;
        state.restoring = undefined;
        if (restoring.draft !== "") await putBackDraft($, restoring.text, restoring.draft);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // The tools answer without `next`, which would only reach core's "no
  // tool.call hook answered". A handler settles every failure as a text; the
  // `.catch` answers one that overran its budget the same way.
  on("tool.call", { tool: "mcp__ccmsg-v1__send" }, async ($, e) => ({
    result: await sendTool($, e),
  })).catch(async () => ({
    result: `ccmsg の send が途中で止まり、届いたか確かめられなかった。${UNCONFIRMED_ADVICE}`,
  }));
  on("tool.call", { tool: "mcp__ccmsg-v1__say" }, async ($, e) => ({
    result: await sayTool($, e),
  })).catch(async () => ({ result: "ccmsg の say が途中で止まった。伝わったかは分からない" }));
  on("tool.call", { tool: "mcp__ccmsg-v1__peers" }, async ($, e) => ({
    result: await peersTool($, e),
  })).catch(async () => ({ result: "ccmsg の peers が途中で止まり、一覧を返せなかった" }));
  return state;
}
