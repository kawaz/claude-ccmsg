// Hooks module (Claude Mods, DR-0035): puts what a person wrote in the web UI
// into this session as their own prompt.
//
// At session.start it starts `ccmsg sidecar`, which binds this run's socket
// and copies each line the daemon writes there to its standard output. For a
// fill request the module keeps the person's half-typed draft, fills the
// composer with the text, and presses Enter on its own terminal through hyoui,
// so the harness takes the prompt exactly as if it had been typed. The prompt
// counts as accepted when classic.UserPromptSubmit fires for that text; the
// outcome goes back to the daemon through `ccmsg sidecar report`. The draft
// is filled back right after the submit.
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
      init?: { timeoutMs?: number },
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

/** `hyoui input` budget. One try of the module costs at most
 * HYOUI_TIMEOUT_MS + ACCEPT_WAIT_MS + REPORT_TIMEOUT_MS (9 s), which fits the
 * daemon's 12 s deadline for a session_input with room for a second run's
 * quick answer. Enter itself takes tens of milliseconds; the margin
 * is hyoui's own lock when another client is mid-input. */
export const HYOUI_TIMEOUT_MS = 3_000;
/** How long after Enter UserPromptSubmit may take. Measured at about 30 ms
 * idle and a few ms busy; the margin is for a loaded machine. */
export const ACCEPT_WAIT_MS = 3_000;
/** The report is one `ccmsg` process and one round trip to the daemon,
 * measured at about 0.3 s. */
export const REPORT_TIMEOUT_MS = 3_000;
/** Respawn delays for a sidecar that keeps dying young: doubled per death
 * from the first value up to the last, and back to the first once a sidecar
 * has lived STABLE_MS. */
export const RESPAWN_MIN_MS = 500;
export const RESPAWN_MAX_MS = 30_000;
export const STABLE_MS = 10_000;

export interface FillRequest {
  id: string;
  text: string;
}

/** A fill request as the module queues it: under which session id and which
 * generation of it the line arrived. */
export interface QueuedFill extends FillRequest {
  sid: string;
  generation: number;
}

/** One line of the sidecar's output as a fill request, or undefined for
 * anything else (another kind, a broken line). */
export function parseFillRequest(line: string): FillRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, id, text } = value as Record<string, unknown>;
  if (kind !== "prompt.fill" || typeof id !== "string" || id === "") return undefined;
  if (typeof text !== "string" || text.trim() === "") return undefined;
  return { id, text };
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

export type Report =
  | { outcome: "accepted" }
  | {
      outcome: "not_delivered";
      reason:
        | "dialog"
        | "no_composer"
        | "refused"
        | "no_terminal"
        | "not_submitted"
        | "enter_failed";
    };

/** The module's state for one load. */
export interface ModuleState {
  /** The text whose UserPromptSubmit is awaited, and who to tell. */
  awaiting?: { text: string; accept: () => void };
  /** The text whose submit puts the draft back, and the draft. */
  restoring?: { text: string; draft: string };
  /** The session id the module serves, and how many times it has changed
   * (/clear, /resume). A fill belongs to the generation it arrived in. */
  sid?: string;
  generation: number;
  /** Whether the session has a composer to fill; undefined until known. */
  interactive?: boolean;
  /** Fills run one at a time: two at once would trade drafts. */
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
async function stillCurrent($: Engine, state: ModuleState, request: QueuedFill): Promise<boolean> {
  if (request.generation !== state.generation || request.sid !== state.sid) return false;
  return (await $.session.id()) === request.sid;
}

/** Put the draft back if the composer still holds the filled text, which
 * means Enter never submitted it. True when it did so. */
async function putBackUnsent($: Engine, text: string, draft: string): Promise<boolean> {
  const box = await $.prompt.read();
  if (box.text !== text) return false;
  await $.prompt.fill({ text: draft, mode: "replace" });
  return true;
}

/** One fill request, start to finish. Undefined when nothing should be
 * reported: Enter went out but no UserPromptSubmit came and the composer no
 * longer holds the text, or the session changed its id under the request —
 * the daemon then answers unconfirmed. */
export async function handleFill(
  $: Engine,
  state: ModuleState,
  request: QueuedFill,
): Promise<Report | undefined> {
  const hyouiSessionId = await $.env.get("HYOUI_SESSION_ID");
  // Checked before the composer is touched: a session outside hyoui has no
  // terminal to press Enter on, and the person's draft is left as it is.
  if (!hyouiSessionId) return { outcome: "not_delivered", reason: "no_terminal" };
  const draft = (await $.prompt.read()).text;
  const filled = await $.prompt.fill({ text: request.text, mode: "replace" });
  if (!filled.isFilled) return { outcome: "not_delivered", reason: filled.refusal ?? "refused" };

  // The last moment the request can still be kept out of a session it was
  // not meant for.
  if (!(await stillCurrent($, state, request))) {
    await putBackUnsent($, request.text, draft);
    return undefined;
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
  if (request.generation !== state.generation) return undefined;
  if (isAccepted) return { outcome: "accepted" };
  if (state.restoring?.text === request.text) state.restoring = undefined;
  if (await putBackUnsent($, request.text, draft)) {
    return { outcome: "not_delivered", reason: entered ? "not_submitted" : "enter_failed" };
  }
  return undefined;
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

export function reportArgv(root: string, sid: string, id: string, report: Report): string[] {
  return [
    `${root}/bin/ccmsg`,
    "sidecar",
    "report",
    "--sid",
    sid,
    "--id",
    id,
    "--outcome",
    report.outcome,
    ...(report.outcome === "not_delivered" ? ["--reason", report.reason] : []),
  ];
}

async function serve($: Engine, state: ModuleState, request: QueuedFill): Promise<void> {
  if (request.generation !== state.generation || request.sid !== state.sid) {
    $.ui.log(`ccmsg: fill ${request.id} dropped: the session changed its id`, { to: "debug" });
    return;
  }
  let report: Report | undefined;
  try {
    report = await handleFill($, state, request);
  } catch (e) {
    $.ui.log(`ccmsg: fill ${request.id} failed: ${String(e)}`, { to: "debug" });
    return;
  }
  if (report === undefined) return;
  try {
    const done = await $.process.run(reportArgv($.plugin.root, request.sid, request.id, report), {
      timeoutMs: REPORT_TIMEOUT_MS,
    });
    if (done.exitCode !== 0) {
      $.ui.log(`ccmsg: report ${request.id} exited ${done.exitCode}: ${done.stderr.trim()}`, {
        to: "debug",
      });
    }
  } catch (e) {
    $.ui.log(`ccmsg: report ${request.id} failed: ${String(e)}`, { to: "debug" });
  }
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
    const request = parseFillRequest(line);
    if (request === undefined) return;
    const queued = { ...request, sid, generation: state.generation };
    state.queue = state.queue.then(() => serve($, state, queued));
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
