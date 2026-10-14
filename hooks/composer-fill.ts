// Hooks module (Claude Mods, DR-0035): puts what a person wrote in the web UI
// into this session as their own prompt.
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
// had been typed. The prompt counts as accepted when classic.UserPromptSubmit
// fires for that text. The draft is filled back right after the submit.
// `describe` says which ops the module has.
//
// The module also tells the daemon what it knows of its session through
// Claude Code itself and the transcript cannot tell (`session.facts`): the
// model as the session names it, `[1m]` kept, the effort, the context window
// the session runs with and its fill, and the API error its latest
// main-thread turn ended on. It reads the model and the window at
// session.start, after a model switch and after /clear, and takes the window
// and the fill again from each session.measure; the effort comes with the end
// of each main-thread turn (classic.Stop, classic.StopFailure), the API error
// with classic.StopFailure and turn.complete. Each time, it sends the whole of what it knows through `ccmsg sidecar facts`,
// which starts no daemon. A daemon that comes up later asks for them with the
// `session.facts` request when the run's sidecar names the run. Sessions
// without a composer send them too: they have no sidecar, but the daemon
// still shows them.
//
// A SendMessage to a `ccmsg:` address (DR-0037) is taken over at
// session.send: harness SendMessage reaches only the sessions of its own
// config home, so the module hands the message to the daemon through `ccmsg
// sidecar send`, which delivers it to the sessions the address names in any
// config home. The hook answers with the send's result and never throws: a
// throwing session.send hook has the harness look the address up as an agent
// name of its own, which hides why the message did not go. Any other
// SendMessage goes on to the harness untouched.
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
import { DIRECT_ADDRESS_PREFIX } from "@ccmsg/protocol/address";
import { errorText, type Output, parseWith } from "@ccmsg/protocol/parse";
import {
  type DescribeResult,
  type FailedSidecarReply,
  type PromptSendResult,
  readSidecarRequest,
  type SessionFacts,
  type SessionFactsApiError,
  type SessionFactsContext,
  type SendMessageResult,
  SendMessageResultTextSchema,
  SIDECAR_OP_NAMES,
  SIDECAR_REQUEST_VERSION,
  type SidecarErrorCode,
  type SidecarReplyOf,
  type SidecarRequest,
  sidecarRunId,
} from "@ccmsg/protocol/sidecar";

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
    surfaces(): Promise<readonly string[]>;
    /** The model as `/model` names it, a launch-time `[1m]` kept. */
    model(): Promise<string>;
    usage(): Promise<{ context: { window: number; tokens?: number } }>;
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
  | "classic.SessionStart"
  | "classic.PostModelSwitch"
  | "classic.Stop"
  | "classic.StopFailure"
  | "classic.UserPromptSubmit"
  | "prompt.submit"
  | "turn.complete";

/** The events this module hooks. */
export type HookedEvent = ObservedEvent | "session.send";

/** A hook: generic in the event's input and in its result, so all it can do
 * with either is read the input through a schema and pass both on as
 * received. */
export type Hook = <E, R>($: Engine, e: E, next: (e: E) => Promise<R>) => Promise<R>;
/** The session.send hook: it passes the event on, or settles it with a
 * result of its own instead (DR-0037 §2). */
export type SendHook = <E, R>(
  $: Engine,
  e: E,
  next: (e: E) => Promise<R>,
) => Promise<R | SendMessageResult>;
/** What `on(...)` returns: one `.catch`, run in the hook's place when the
 * hook throws or overruns its budget. The engine's `next` there is
 * replay-safe: after the hook called it, it answers what that call settled
 * to and runs nothing beneath again. */
export interface Registration {
  catch(handler: Hook): void;
}
export interface On {
  (event: "session.send", hook: SendHook): Registration;
  (event: ObservedEvent, hook: Hook): Registration;
}

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
const ClassicSessionStartInputSchema = v.looseObject({});
const SessionMeasureInputSchema = v.looseObject({
  context: v.optional(
    v.looseObject({ window: v.optional(v.number()), tokens: v.optional(v.number()) }),
  ),
});
const PostModelSwitchInputSchema = v.looseObject({});
// A classic hook's input names the subagent it fired in (`agent_id`); the
// engine's turn events name it `agentId`. Absent on the main thread. A classic
// hook of a turn carries the turn's effort (`effort.level`) on a model that
// takes one.
const TurnEffortSchema = v.optional(v.looseObject({ level: v.optional(v.string()) }));
const StopInputSchema = v.looseObject({
  agent_id: v.optional(v.string()),
  effort: TurnEffortSchema,
});
const StopFailureInputSchema = v.looseObject({
  effort: TurnEffortSchema,
  error: v.optional(v.string()),
  error_details: v.optional(v.string()),
  last_assistant_message: v.optional(v.string()),
  agent_id: v.optional(v.string()),
});
const TurnCompleteInputSchema = v.looseObject({
  reason: v.optional(v.string()),
  agentId: v.optional(v.string()),
});
const UserPromptSubmitInputSchema = v.looseObject({ prompt: v.optional(v.string()) });
const PromptSubmitInputSchema = v.looseObject({
  text: v.optional(v.string()),
  origin: v.optional(v.looseObject({ kind: v.optional(v.string()) })),
});
const SessionSendInputSchema = v.looseObject({ to: v.string(), text: v.string() });

/** What a hook of this module does with an event it observes: `before` runs
 * ahead of the event, `after` once the event went through. */
interface Observer<T> {
  before?: (e: T) => void;
  after?: (e: T) => Promise<void> | void;
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
  observer: Observer<Output<S>>,
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
  await run("after", observer.after);
  return result;
}

/** `hyoui input` budget. One prompt.send costs at most
 * HYOUI_TIMEOUT_MS + ACCEPT_WAIT_MS + REPLY_TIMEOUT_MS (9 s), which fits the
 * daemon's 12 s deadline for a session_input with room for a second run's
 * quick answer. Enter itself takes tens of milliseconds; the margin
 * is hyoui's own lock when another client is mid-input. */
export const HYOUI_TIMEOUT_MS = 3_000;
/** How long after Enter UserPromptSubmit may take. Measured at about 30 ms
 * idle and a few ms busy; the margin is for a loaded machine. */
export const ACCEPT_WAIT_MS = 3_000;
/** A reply is one `ccmsg` process and one round trip to the daemon, measured
 * at about 0.3 s. `ccmsg version` for describe is the same process without
 * the round trip. */
export const REPLY_TIMEOUT_MS = 3_000;
/** `ccmsg sidecar send` budget, for the whole SendMessage: the process, the
 * daemon resolving the address (its state files read within 1 s), and every
 * run's write (2 s) and refusal window (0.25 s), the runs in parallel — about
 * 5 s at worst, with the rest left for a daemon the command has to start. The
 * harness shows the turn as running meanwhile; past this the send is answered
 * as unconfirmed rather than hit `$.process.run`'s own 30 s, which throws. */
export const SEND_TIMEOUT_MS = 10_000;
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
  | SidecarReplyOf<"session.facts">;

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
 * inside reach it as filled. That one change is allowed for, nothing else. */
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
  /** The text whose UserPromptSubmit is awaited, and who to tell. */
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
  /** Sidecar starts run one at a time, so session.start and
   * classic.SessionStart arriving together cannot each start one. */
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
    api_error?: SessionFactsApiError;
  };
  /** Whether a StopFailure of the main thread came in the turn now ending:
   * its error is the one the turn ended on. */
  failedThisTurn: boolean;
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
    failedThisTurn: false,
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

/** `ccmsg sidecar send` for one SendMessage of session `sid` to `to`. The
 * text goes on standard input, named to the command as `/dev/stdin` (see
 * `sendToAddress`). */
export function sendArgv(root: string, sid: string, to: string): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", "send", "--sid", sid, "--to", to, "/dev/stdin"];
}

/** The text of a send whose arrival cannot be told. */
const SEND_UNCONFIRMED_ADVICE = "送り直すと二重に届くかもしれないので、まず相手の返事を待つ";

/** Send `text` to the `ccmsg:` address `to` through the daemon, and settle
 * the SendMessage with how it went. Never rejects: whatever fails is a
 * not-delivered result saying so, since a session.send hook that throws has
 * the harness send to `to` as an agent name of its own.
 *
 * The text goes on standard input rather than as an argument: a message may
 * be long, an argument is bounded in size and shown to every user by `ps`,
 * and `$.process.run` writes `stdin` once and closes it. The command takes it
 * from a file named by path, as its other users do, and `/dev/stdin` is that
 * file here. */
export async function sendToAddress(
  $: Engine,
  to: string,
  text: string,
): Promise<SendMessageResult> {
  try {
    return await sendThroughDaemon($, to, text);
  } catch (e) {
    return {
      isDelivered: false,
      reason: `送信の途中で失敗し、届いたか確かめられなかった: ${errorText(e)}。${SEND_UNCONFIRMED_ADVICE}`,
    };
  }
}

async function sendThroughDaemon($: Engine, to: string, text: string): Promise<SendMessageResult> {
  const sid = await $.session.id();
  let run: { exitCode: number; stdout: string; stderr: string };
  try {
    run = await $.process.run(sendArgv($.plugin.root, sid, to), {
      stdin: text,
      timeoutMs: SEND_TIMEOUT_MS,
    });
  } catch (e) {
    $.ui.log(`ccmsg: send to ${to} failed: ${errorText(e)}`, { to: "debug" });
    return {
      isDelivered: false,
      reason: `ccmsg sidecar send が ${String(SEND_TIMEOUT_MS / 1000)} 秒以内に終わらなかったか起動できず、届いたか確かめられなかった: ${errorText(e)}。${SEND_UNCONFIRMED_ADVICE}`,
    };
  }
  const result = parseWith(SendMessageResultTextSchema, run.stdout);
  if (result.ok) return result.value;
  const said = run.stderr.trim().split("\n")[0] ?? "";
  $.ui.log(
    `ccmsg: send to ${to} exited ${String(run.exitCode)} without a result (${result.failure.summary}): ${run.stderr.trim()}`,
    { to: "debug" },
  );
  return {
    isDelivered: false,
    reason: `ccmsg が送信の結果を返さず、届いたか確かめられなかった${said !== "" ? `: ${said}` : ""}。${SEND_UNCONFIRMED_ADVICE}`,
  };
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

/** Take the effort a main-thread turn ran at, and send the facts when it
 * moved. */
function turnEffort($: Engine, state: ModuleState, level: string | undefined): void {
  if (level === undefined || level === "" || level === state.facts.effort) return;
  state.facts = { ...state.facts, effort: level };
  sendFacts($, state);
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
    return;
  }
  sendFacts($, state);
}

/** The facts without an API error. */
function withoutApiError(facts: ModuleState["facts"]): ModuleState["facts"] {
  const { api_error: _cleared, ...rest } = facts;
  return rest;
}

/** A main-thread turn ended. One that ended on an API error with no
 * StopFailure before it is an error of kind `unknown`; one that answered (or
 * was refused, which is the model's answer) clears the error. An interrupted
 * turn leaves it as it was: nothing answered since. */
async function turnEnded($: Engine, state: ModuleState, reason: string | undefined): Promise<void> {
  const failed = state.failedThisTurn;
  state.failedThisTurn = false;
  if (reason === "error" && !failed) {
    const at = Math.floor(await $.clock.now());
    state.facts = { ...state.facts, api_error: { kind: "unknown", at } };
    sendFacts($, state);
    return;
  }
  if ((reason === "answer" || reason === "refusal") && state.facts.api_error !== undefined) {
    state.facts = withoutApiError(state.facts);
    sendFacts($, state);
  }
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
  // classic.SessionStart can be the first to arrive after a reload; whether
  // the session draws a composer is then asked of the session itself.
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
  on("session.start", async ($, e, next) =>
    observe($, e, next, "session.start", SessionStartInputSchema, {
      after: (input) => {
        // No composer to fill (`-p`, the SDK): no sidecar to keep (DR-0035 §3).
        state.interactive = input.isInteractive !== false && input.surface !== null;
        startSidecar($, state);
        void readModelAndWindow($, state);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("session.end", async ($, e, next) =>
    observe($, e, next, "session.end", SessionEndInputSchema, {
      before: (input) => {
        if (input.reason !== "clear") return;
        // The session after /clear has answered nothing: no error of the
        // old one's turns is its.
        state.facts = withoutApiError(state.facts);
        state.failedThisTurn = false;
        if (state.sid !== undefined) {
          nextGeneration(state);
          state.sid = undefined;
        }
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("classic.SessionStart", async ($, e, next) =>
    observe($, e, next, "classic.SessionStart", ClassicSessionStartInputSchema, {
      // After /clear the facts belong to the new id: session.start does not
      // run for it.
      after: () => {
        startSidecar($, state);
        void readModelAndWindow($, state);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // session.measure says the window each main-thread turn; a model switch
  // raises none, so the window is read again after one.
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
  // The API error a main-thread turn ends on, as Claude Code classified it,
  // and its end: the transcript says the same only once the error row is
  // written, and has no kind.
  on("classic.StopFailure", async ($, e, next) =>
    observe($, e, next, "classic.StopFailure", StopFailureInputSchema, {
      after: async (input) => {
        if (input.agent_id !== undefined) return;
        turnEffort($, state, input.effort?.level);
        const at = Math.floor(await $.clock.now());
        const text = input.last_assistant_message ?? input.error_details;
        const api_error = {
          kind: input.error ?? "unknown",
          ...(text !== undefined ? { text } : {}),
          at,
        };
        state.failedThisTurn = true;
        state.facts = { ...state.facts, api_error };
        sendFacts($, state);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("classic.Stop", async ($, e, next) =>
    observe($, e, next, "classic.Stop", StopInputSchema, {
      after: (input) => {
        if (input.agent_id === undefined) turnEffort($, state, input.effort?.level);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("turn.complete", async ($, e, next) =>
    observe($, e, next, "turn.complete", TurnCompleteInputSchema, {
      after: async (input) => {
        if (input.agentId === undefined) await turnEnded($, state, input.reason);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("classic.PostModelSwitch", async ($, e, next) =>
    observe($, e, next, "classic.PostModelSwitch", PostModelSwitchInputSchema, {
      after: () => {
        void readModelAndWindow($, state);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("classic.UserPromptSubmit", async ($, e, next) =>
    observe($, e, next, "classic.UserPromptSubmit", UserPromptSubmitInputSchema, {
      before: (input) => {
        const awaiting = state.awaiting;
        if (awaiting === undefined) return;
        if (input.prompt !== undefined && samePrompt(input.prompt, awaiting.text)) {
          state.awaiting = undefined;
          awaiting.accept();
          return;
        }
        $.ui.log(
          `ccmsg: UserPromptSubmit ${JSON.stringify(input.prompt ?? null)} is not the filled ${JSON.stringify(awaiting.text)}`,
          { to: "debug" },
        );
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  on("prompt.submit", async ($, e, next) =>
    observe($, e, next, "prompt.submit", PromptSubmitInputSchema, {
      // The prompt is in by now: the person gets their draft back.
      after: async (input) => {
        const restoring = state.restoring;
        if (
          restoring === undefined ||
          input.origin?.kind !== "composer" ||
          input.text === undefined ||
          !samePrompt(input.text, restoring.text)
        ) {
          return;
        }
        state.restoring = undefined;
        if (restoring.draft !== "") await putBackDraft($, restoring.text, restoring.draft);
      },
    }),
  ).catch(async (_$, e, next) => next(e));
  // No `.catch` here: the hook does not throw (sendToAddress settles every
  // failure as a result), and a `.catch` passing the event on to `next` would
  // send a `ccmsg:` address to the harness as an agent name (DR-0037 §4).
  on("session.send", async ($, e, next) => {
    const read = parseWith(SessionSendInputSchema, e);
    if (!read.ok || !read.value.to.startsWith(DIRECT_ADDRESS_PREFIX)) return next(e);
    return sendToAddress($, read.value.to, read.value.text);
  });
  return state;
}
