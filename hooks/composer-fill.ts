// Hooks module (Claude Mods, DR-0035): puts what a person wrote in the web UI
// into this session as their own prompt.
//
// At session.start it starts `ccmsg sidecar`, which binds this run's socket
// and copies each line the daemon writes there to its standard output. A line
// is a request naming an op (`{ v, op, id, args }`); every request with an id
// gets one reply (`{ id, ok, result }` or `{ id, ok: false, error }`), which
// goes back to the daemon through `ccmsg sidecar reply`. An op this module does
// not have is answered `unknown_op` at once, so the daemon is not left waiting.
//
// `prompt.send` puts a person's text in: the module keeps the person's
// half-typed draft, fills the composer with the text, and presses Enter on its
// own terminal through hyoui, so the harness takes the prompt exactly as if it
// had been typed. The prompt counts as accepted when classic.UserPromptSubmit
// fires for that text. The draft is filled back right after the submit.
// `describe` says which ops the module has.
//
// A session without a composer (`-p`, the SDK) gets no sidecar. When the
// session changes its id (/clear, /resume) the module moves on a generation:
// a request that arrived under the old id is not put into the new session.
//
// This file is read by Claude Code's module loader, which allows no imports
// that run, and `claude plugin validate` reads every `$` call off the source:
// each call is spelled out as `$.noun.method(...)` with literal arguments
// where the engine requires them.

/** The part of the engine interface this module uses. Declared here rather
 * than imported from `claude-code`, whose types exist only where the engine
 * lays them beside a loaded mod. */
export interface Engine {
  plugin: { root: string };
  session: { id(): Promise<string>; surfaces(): Promise<readonly string[]> };
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
    spawn(request: {
      argv: readonly string[];
    }): AsyncGenerator<{ stream: "stdout" | "stderr"; text: string }, unknown>;
  };
  env: { get(name: string): Promise<string | undefined> };
  clock: {
    now(): Promise<number>;
    after(ms: number, fn: () => void): { cancel(): void };
  };
  ui: { log(text: string, options?: { to?: "debug" }): unknown };
}

type Next<E, R> = (e: E) => Promise<R>;
type Hook<E> = ($: Engine, e: E, next: Next<E, unknown>) => Promise<unknown>;
/** What `on(...)` returns: one `.catch`, whose answer stands for the hook's
 * when the hook throws or overruns its budget. */
interface Registration<E> {
  catch(handler: Hook<E>): void;
}
type SessionStartEvent = { isInteractive?: unknown; surface?: unknown };
type PromptSubmitEvent = { text?: unknown; origin?: { kind?: unknown } };
export interface On {
  (event: "session.start", hook: Hook<SessionStartEvent>): Registration<SessionStartEvent>;
  (event: "session.end", hook: Hook<{ reason?: unknown }>): Registration<{ reason?: unknown }>;
  (event: "classic.SessionStart", hook: Hook<unknown>): Registration<unknown>;
  (
    event: "classic.UserPromptSubmit",
    hook: Hook<{ prompt?: unknown }>,
  ): Registration<{ prompt?: unknown }>;
  (event: "prompt.submit", hook: Hook<PromptSubmitEvent>): Registration<PromptSubmitEvent>;
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
/** Respawn delays for a sidecar that keeps dying young: doubled per death
 * from the first value up to the last, and back to the first once a sidecar
 * has lived STABLE_MS. */
export const RESPAWN_MIN_MS = 500;
export const RESPAWN_MAX_MS = 30_000;
export const STABLE_MS = 10_000;

/** The request line version this module reads. */
export const REQUEST_VERSION = 1;
/** The ops this module runs, as describe tells them. */
export const OPS = ["describe", "prompt.send"] as const;

/** A request line as far as the module reads it before choosing the op: its
 * id, which a reply needs, and the rest unchecked. */
export interface RawRequest {
  id: string;
  v: unknown;
  op: unknown;
  args: unknown;
}

export type ErrorCode = "unknown_op" | "unsupported_version" | "invalid_args" | "internal";

export type Reply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: ErrorCode; message: string } };

/** A prompt.send, as the module queues it: under which session id and which
 * generation of it the line arrived. */
export interface QueuedSend {
  id: string;
  text: string;
  sid: string;
  generation: number;
}

/** One line of the sidecar's output as a request, or undefined for a line
 * that names no request id (broken, or not a request) and so cannot be
 * answered. */
export function parseRequest(line: string): RawRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { id, v, op, args } = value as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return undefined;
  return { id, v, op, args };
}

function failed(id: string, code: ErrorCode, message: string): Reply {
  return { id, ok: false, error: { code, message } };
}

/** The text a prompt.send's args carry, or undefined when they carry none. */
export function promptSendText(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const { text } = args as Record<string, unknown>;
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
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
export function samePrompt(submitted: unknown, filled: string): boolean {
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

/** What a prompt.send that ran says. `session_changed` is a request the
 * module kept out because the session changed its id (/clear, /resume) before
 * Enter. `unconfirmed` is the module not knowing whether the text went in:
 * Enter went out but no UserPromptSubmit came and the composer no longer holds
 * the text, or the id changed after Enter, or after the fill with the composer
 * no longer holding the text. */
export type PromptSendResult =
  | { outcome: "accepted" }
  | {
      outcome: "not_delivered";
      reason:
        | "dialog"
        | "no_composer"
        | "refused"
        | "no_terminal"
        | "not_submitted"
        | "enter_failed"
        | "session_changed";
    }
  | { outcome: "unconfirmed" };

const UNCONFIRMED: PromptSendResult = { outcome: "unconfirmed" };
const SESSION_CHANGED: PromptSendResult = { outcome: "not_delivered", reason: "session_changed" };

/** `value` as text for a message, whatever it is: a request is parsed JSON,
 * but a thrown value or an object whose `toString` is not a function would
 * make `String` itself throw. */
export function shown(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    // An Error's fields are not its own enumerable ones: JSON would say {}.
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

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
  sidecar?: { sid: string; child: AsyncGenerator<unknown, unknown> };
  delay: number;
  /** Sidecar starts run one at a time, so session.start and
   * classic.SessionStart arriving together cannot each start one. */
  starting: Promise<void>;
}

export function newState(): ModuleState {
  return {
    generation: 0,
    queue: Promise.resolve(),
    delay: RESPAWN_MIN_MS,
    starting: Promise.resolve(),
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
    $.ui.log(`ccmsg: reply ${reply.id} failed: ${shown(e)}`, { to: "debug" });
  }
}

async function promptSend($: Engine, state: ModuleState, request: QueuedSend): Promise<Reply> {
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
async function describe($: Engine): Promise<{ v: number[]; ops: string[]; version?: string }> {
  const described = { v: [REQUEST_VERSION], ops: [...OPS] };
  try {
    const run = await $.process.run([`${$.plugin.root}/bin/ccmsg`, "version"], {
      env: { CCMSG_NO_SELF_EXEC: "1" },
      timeoutMs: REPLY_TIMEOUT_MS,
    });
    const version = run.stdout.trim();
    if (run.exitCode === 0 && version !== "") return { ...described, version };
  } catch (e) {
    $.ui.log(`ccmsg: describe could not read the version: ${shown(e)}`, { to: "debug" });
  }
  return described;
}

/** Whether `args` is `{}`, all describe takes. */
function isEmptyArgs(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    Object.keys(args).length === 0
  );
}

/** The reply to one request: the op's, or `ok:false` when it could not run.
 * Anything thrown on the way is `internal`, so every request is answered. */
async function replyTo(
  $: Engine,
  state: ModuleState,
  sid: string,
  generation: number,
  request: RawRequest,
): Promise<Reply> {
  const { id } = request;
  try {
    if (request.v !== REQUEST_VERSION) {
      return failed(
        id,
        "unsupported_version",
        `request version ${shown(request.v)} is not read here; this module reads ${REQUEST_VERSION}`,
      );
    }
    if (request.op === "describe") {
      if (!isEmptyArgs(request.args)) return failed(id, "invalid_args", "describe takes args {}");
      return { id, ok: true, result: await describe($) };
    }
    if (request.op === "prompt.send") {
      const text = promptSendText(request.args);
      if (text === undefined) {
        return failed(
          id,
          "invalid_args",
          "prompt.send takes args { text } with text other than whitespace",
        );
      }
      const queued: QueuedSend = { id, text, sid, generation };
      // One at a time: two at once would trade drafts. A failed one does not
      // hold up the next.
      const result = state.queue.then(() => promptSend($, state, queued));
      state.queue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    }
    return failed(
      id,
      "unknown_op",
      `no op ${shown(request.op)}; this module has ${OPS.join(", ")}`,
    );
  } catch (e) {
    $.ui.log(`ccmsg: request ${id} failed: ${shown(e)}`, { to: "debug" });
    return failed(id, "internal", shown(e));
  }
}

/** Run one request line that arrived under `sid` in `generation`, and reply.
 * Never rejects: a request that cannot be answered is logged. */
export function answer(
  $: Engine,
  state: ModuleState,
  sid: string,
  generation: number,
  line: string,
): Promise<void> {
  const request = parseRequest(line);
  if (request === undefined) {
    $.ui.log(`ccmsg sidecar: dropped a line that names no request id: ${line.slice(0, 200)}`, {
      to: "debug",
    });
    return Promise.resolve();
  }
  // sendReply catches its own failures; this catches anything else, so the
  // promise never rejects for the caller that drops it.
  return replyTo($, state, sid, generation, request)
    .then((reply) => sendReply($, sid, reply))
    .catch((e: unknown) => {
      $.ui.log(`ccmsg: request ${request.id} not answered: ${shown(e)}`, { to: "debug" });
    });
}

/** Run one sidecar for `sid` until it ends, then start the next one unless it
 * was replaced. The next start goes through `$.clock.after`, which a module
 * unload cancels: the unload kills the child, and this is what keeps that
 * death from being answered with a new one. */
async function runSidecar($: Engine, state: ModuleState, sid: string): Promise<void> {
  const child = $.process.spawn({
    argv: [`${$.plugin.root}/bin/ccmsg`, "sidecar", "--sid", sid],
  });
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
    $.ui.log(`ccmsg sidecar: ${String(e)}`, { to: "debug" });
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
      $.ui.log(`ccmsg sidecar: start failed: ${String(e)}`, { to: "debug" });
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
  const old = state.sidecar;
  state.sidecar = undefined;
  if (old !== undefined) await old.child.return(undefined);
  void runSidecar($, state, sid);
}

export function register(on: On): ModuleState {
  const state = newState();
  // Every hook here observes and passes the event on; if one fails, the
  // event goes on as if it were not there.
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    // No composer to fill (`-p`, the SDK): no sidecar to keep (DR-0035 §3).
    state.interactive = e.isInteractive !== false && e.surface !== null;
    startSidecar($, state);
    return started;
  }).catch(async (_$, e, next) => next(e));
  on("session.end", async (_$, e, next) => {
    if (e.reason === "clear" && state.sid !== undefined) {
      nextGeneration(state);
      state.sid = undefined;
    }
    return next(e);
  }).catch(async (_$, e, next) => next(e));
  on("classic.SessionStart", async ($, e, next) => {
    const started = await next(e);
    startSidecar($, state);
    return started;
  }).catch(async (_$, e, next) => next(e));
  on("classic.UserPromptSubmit", async ($, e, next) => {
    const awaiting = state.awaiting;
    if (awaiting !== undefined) {
      if (samePrompt(e.prompt, awaiting.text)) {
        state.awaiting = undefined;
        awaiting.accept();
      } else {
        $.ui.log(
          `ccmsg: UserPromptSubmit ${JSON.stringify(e.prompt)} is not the filled ${JSON.stringify(awaiting.text)}`,
          { to: "debug" },
        );
      }
    }
    return next(e);
  }).catch(async (_$, e, next) => next(e));
  on("prompt.submit", async ($, e, next) => {
    const submitted = await next(e);
    const restoring = state.restoring;
    if (
      restoring !== undefined &&
      e.origin?.kind === "composer" &&
      samePrompt(e.text, restoring.text)
    ) {
      state.restoring = undefined;
      // The prompt is in by now; a failed put-back must not read as a failed
      // hook on a submit that went through.
      if (restoring.draft !== "") {
        try {
          await putBackDraft($, restoring.text, restoring.draft);
        } catch (error) {
          $.ui.log(`ccmsg: draft put-back failed: ${String(error)}`, { to: "debug" });
        }
      }
    }
    return submitted;
  }).catch(async (_$, e, next) => next(e));
  return state;
}
