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
// This file is read by Claude Code's module loader, which allows no imports
// that run, and `claude plugin validate` reads every `$` call off the source:
// each call is spelled out as `$.noun.method(...)` with literal arguments
// where the engine requires them.

/** The part of the engine interface this module uses. Declared here rather
 * than imported from `claude-code`, whose types exist only where the engine
 * lays them beside a loaded mod. */
export interface Engine {
  plugin: { root: string };
  session: { id(): Promise<string> };
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
export interface On {
  (event: "session.start", hook: Hook<unknown>): void;
  (event: "classic.SessionStart", hook: Hook<unknown>): void;
  (event: "classic.UserPromptSubmit", hook: Hook<{ prompt?: unknown }>): void;
  (event: "prompt.submit", hook: Hook<{ text?: unknown; origin?: { kind?: unknown } }>): void;
}

/** `hyoui input` budget, the same as the daemon's rename: hyoui serializes
 * input holders, and an Enter that cannot get through in this window is
 * better reported than waited on. */
export const HYOUI_TIMEOUT_MS = 5_000;
/** How long after Enter UserPromptSubmit may take. Measured at about 30 ms
 * idle and a few ms busy; the margin is for a loaded machine. */
export const ACCEPT_WAIT_MS = 3_000;
/** The report is one `ccmsg` process and one round trip to the daemon. */
export const REPORT_TIMEOUT_MS = 10_000;
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

/** `hyoui input` for one Enter on this session's terminal. Without a
 * namespace of its own the option is left out and hyoui uses its default,
 * as the daemon's rename does. */
export function hyouiEnterArgv(hyouiSessionId: string, namespace: string | undefined): string[] {
  return [
    "hyoui",
    "input",
    ...(namespace ? [`--namespace=${namespace}`] : []),
    hyouiSessionId,
    "key:Enter",
  ];
}

/** Whether a submitted prompt is the filled text. The harness may trim what
 * it hands on, so surrounding whitespace is not held against it. */
export function samePrompt(submitted: unknown, filled: string): boolean {
  return typeof submitted === "string" && submitted.trim() === filled.trim();
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

/** What the module keeps between a fill and the events it waits for. */
export interface FillState {
  /** The text whose UserPromptSubmit is awaited, and who to tell. */
  awaiting?: { text: string; accept: () => void };
  /** The text whose submit puts the draft back, and the draft. */
  restoring?: { text: string; draft: string };
}

/** Put the draft back if the composer still holds the filled text, which
 * means Enter never submitted it. True when it did so. */
async function putBackUnsent($: Engine, text: string, draft: string): Promise<boolean> {
  const box = await $.prompt.read();
  if (box.text !== text) return false;
  await $.prompt.fill({ text: draft, mode: "replace" });
  return true;
}

/** One fill request, start to finish. Undefined when nothing decisive can be
 * said: Enter went out, no UserPromptSubmit came, and the composer no longer
 * holds the text — the daemon then answers unconfirmed. */
export async function handleFill(
  $: Engine,
  state: FillState,
  request: FillRequest,
): Promise<Report | undefined> {
  const hyouiSessionId = await $.env.get("HYOUI_SESSION_ID");
  const namespace = await $.env.get("HYOUI_NAMESPACE");
  // Checked before the composer is touched: a session outside hyoui has no
  // terminal to press Enter on, and the person's draft is left as it is.
  if (!hyouiSessionId) return { outcome: "not_delivered", reason: "no_terminal" };
  const draft = (await $.prompt.read()).text;
  const filled = await $.prompt.fill({ text: request.text, mode: "replace" });
  if (!filled.isFilled) return { outcome: "not_delivered", reason: filled.refusal ?? "refused" };

  const accepted = Promise.withResolvers<boolean>();
  state.awaiting = { text: request.text, accept: () => accepted.resolve(true) };
  state.restoring = { text: request.text, draft };
  let entered: boolean;
  try {
    const run = await $.process.run(hyouiEnterArgv(hyouiSessionId, namespace), {
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
  if (isAccepted) return { outcome: "accepted" };
  if (state.restoring?.text === request.text) state.restoring = undefined;
  if (await putBackUnsent($, request.text, draft)) {
    return { outcome: "not_delivered", reason: entered ? "not_submitted" : "enter_failed" };
  }
  return undefined;
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

/** The module's state for one load: the running sidecar, the fill in
 * progress, and the queues that keep fills and sidecar starts one at a time
 * (two fills at once would trade drafts; session.start and
 * classic.SessionStart arriving together must not each start a sidecar). */
export interface ModuleState {
  fill: FillState;
  queue: Promise<void>;
  sidecar?: { sid: string; child: AsyncGenerator<unknown, unknown> };
  delay: number;
  starting: Promise<void>;
}

async function serve(
  $: Engine,
  state: ModuleState,
  sid: string,
  request: FillRequest,
): Promise<void> {
  let report: Report | undefined;
  try {
    report = await handleFill($, state.fill, request);
  } catch (e) {
    $.ui.log(`ccmsg: fill ${request.id} failed: ${String(e)}`, { to: "debug" });
    return;
  }
  if (report === undefined) return;
  try {
    const done = await $.process.run(reportArgv($.plugin.root, sid, request.id, report), {
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
    state.queue = state.queue.then(() => serve($, state, sid, request));
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
  const sid = await $.session.id();
  if (state.sidecar?.sid === sid) return;
  const old = state.sidecar;
  state.sidecar = undefined;
  if (old !== undefined) await old.child.return(undefined);
  void runSidecar($, state, sid);
}

export function register(on: On): ModuleState {
  const state: ModuleState = {
    fill: {},
    queue: Promise.resolve(),
    delay: RESPAWN_MIN_MS,
    starting: Promise.resolve(),
  };
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    startSidecar($, state);
    return started;
  });
  on("classic.SessionStart", async ($, e, next) => {
    const started = await next(e);
    startSidecar($, state);
    return started;
  });
  on("classic.UserPromptSubmit", async (_$, e, next) => {
    const awaiting = state.fill.awaiting;
    if (awaiting !== undefined && samePrompt(e.prompt, awaiting.text)) {
      state.fill.awaiting = undefined;
      awaiting.accept();
    }
    return next(e);
  });
  on("prompt.submit", async ($, e, next) => {
    const submitted = await next(e);
    const restoring = state.fill.restoring;
    if (
      restoring !== undefined &&
      e.origin?.kind === "composer" &&
      samePrompt(e.text, restoring.text)
    ) {
      state.fill.restoring = undefined;
      // The prompt is in by now; a failed put-back must not read as a failed
      // hook on a submit that went through.
      if (restoring.draft !== "") {
        try {
          await $.prompt.fill({ text: restoring.draft, mode: "replace" });
        } catch (error) {
          $.ui.log(`ccmsg: draft put-back failed: ${String(error)}`, { to: "debug" });
        }
      }
    }
    return submitted;
  });
  return state;
}
