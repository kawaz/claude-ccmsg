// `prompt.send` puts a person's text from the web UI in (DR-0035): the module
// keeps the person's half-typed draft, fills the composer with the text, and
// presses Enter on its own terminal through hyoui, so the harness takes the
// prompt exactly as if it had been typed. The prompt counts as accepted when
// the prompt.submit of that text from the composer goes through (its `next`
// settles on anything but a drop). The draft is filled back right after the
// submit.
import * as v from "valibot";
import { type Output, parseWith } from "@ccmsg/protocol/parse";
import type { PromptSendResult, SidecarReplyOf } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";
import type { LifecycleState } from "./session-lifecycle.ts";

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

/** A prompt.send, as the module queues it: under which session id and which
 * generation of it the line arrived. */
export interface QueuedSend {
  id: string;
  text: string;
  sid: string;
  generation: number;
}

/** The prompt.sends in flight. */
export interface PromptSendState {
  /** The text whose submit from the composer is awaited, and who to tell. */
  awaiting?: { text: string; accept: () => void };
  /** The text whose submit puts the draft back, and the draft. */
  restoring?: { text: string; draft: string };
  /** prompt.sends run one at a time: two at once would trade drafts. */
  queue: Promise<void>;
}

export function newPromptSendState(): PromptSendState {
  return { queue: Promise.resolve() };
}

/** What handlePromptSend reads and writes: its own state, and the session id
 * and generation a request is checked against. */
type SendState = PromptSendState & Pick<LifecycleState, "sid" | "generation">;

export const PromptSubmitInputSchema = v.looseObject({
  text: v.optional(v.string()),
  origin: v.optional(v.looseObject({ kind: v.optional(v.string()) })),
});
/** What a prompt.submit settles on: the prompt that entered, or a `drop`. */
const PromptSubmitResultSchema = v.looseObject({ drop: v.optional(v.string()) });

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

const UNCONFIRMED: PromptSendResult = { outcome: "unconfirmed" };
const SESSION_CHANGED: PromptSendResult = { outcome: "not_delivered", reason: "session_changed" };

/** Whether `request` still belongs to the session as it is now. */
async function stillCurrent($: Engine, state: SendState, request: QueuedSend): Promise<boolean> {
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
  state: SendState,
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

async function promptSend(
  $: Engine,
  state: SendState,
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

/** Run `request` once the prompt.sends before it are done: two at once would
 * trade drafts. A failed one does not hold up the next. */
export function queuePromptSend(
  $: Engine,
  state: SendState,
  request: QueuedSend,
): Promise<SidecarReplyOf<"prompt.send">> {
  const result = state.queue.then(() => promptSend($, state, request));
  state.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** A prompt from the composer went through (`result` is what its submit
 * settled on): a filled prompt is accepted once its submit entered the
 * session or was queued behind the running turn, not on a drop. The person
 * gets their draft back then. */
export async function promptSubmitted<R>(
  $: Engine,
  state: PromptSendState,
  input: Output<typeof PromptSubmitInputSchema>,
  result: R,
): Promise<void> {
  if (input.text === undefined) return;
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
}
