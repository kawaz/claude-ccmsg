// `prompt.send` puts a person's text from the web UI in (DR-0035): the module
// keeps the person's half-typed draft, fills the composer with the text, and
// presses Enter on its own terminal through hyoui, so the harness takes the
// prompt exactly as if it had been typed. The prompt counts as accepted when
// the prompt.submit of that text from the composer goes through (its `next`
// settles on anything but a drop). The draft is filled back right after the
// submit.
//
// A bash mode command (`mode: "bash"`) goes in as the person's `! <command>`:
// the module empties the composer, presses `!` on its terminal and waits for
// the composer to show bash mode, then appends the command and presses Enter.
// Bash mode raises no prompt.submit, so the command counts as accepted when
// Enter takes it out of the composer (prompt.change with `origin.kind:
// "clear"`); its draft goes back then (docs/findings/2026-11-06-permit-bang-run.md).
import * as v from "valibot";
import { errorText, type Output, parseWith } from "@ccmsg/protocol/parse";
import type { RequestOverride } from "@ccmsg/protocol/request-override";
import type { PromptSendMode, PromptSendResult, SidecarReplyOf } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";
import type { LifecycleState } from "./session-lifecycle.ts";

/** `hyoui input` budget. One prompt.send costs at most
 * HYOUI_TIMEOUT_MS + ACCEPT_WAIT_MS + REPLY_TIMEOUT_MS (9 s), and a bash mode
 * command SHELL_MODE_TIMEOUT_MS more (11 s), which fits the daemon's 12 s
 * deadline for a user_prompt with room for a second run's quick answer.
 * Enter itself takes tens of milliseconds; the margin is hyoui's own lock
 * when another client is mid-input. */
export const HYOUI_TIMEOUT_MS = 3_000;
/** `hyoui input` budget for the `!` that switches the composer to bash mode
 * and the wait for the switch to show. The switch showed at once (measured on
 * 2.1.319); the margin is hyoui's lock, as for Enter. */
export const SHELL_MODE_TIMEOUT_MS = 2_000;
/** What the terminal's screen shows once the composer is in bash mode, as
 * hyoui's `wait:` reads the screen (its lines joined by `\n`, trailing blanks
 * dropped): the composer's top border ends with `─`, and the line under it
 * starts with `!` in bash mode where it starts with `❯` otherwise. Measured on
 * 2.1.319 both while idle and while a turn runs (with the queued-messages
 * placeholder in the composer). */
export const SHELL_MODE_SCREEN = "─\\n!";
/** How long after Enter the prompt.submit of the filled text may take to go
 * through. Measured at 9 to 15 ms for a prompt typed while a tool runs
 * (DR-0039 §2); the margin is for a loaded machine. */
export const ACCEPT_WAIT_MS = 3_000;

/** A prompt.send, as the module queues it: under which session id and which
 * generation of it the line arrived, the one-shot override that comes with it
 * (DR-0041 §4), absent for none, and how the text goes in (`bash` for a bash
 * mode command, absent for a prompt). */
export interface QueuedSend {
  id: string;
  text: string;
  sid: string;
  generation: number;
  override?: RequestOverride;
  mode?: PromptSendMode;
}

/** The prompt.sends in flight. */
export interface PromptSendState {
  /** The text whose submit from the composer is awaited, who to tell, and
   * the one-shot override its submit arms (request-override.ts). With `mode`
   * `bash`, what is awaited is Enter taking the command out of the composer
   * instead, and no override comes with it. */
  awaiting?: {
    text: string;
    accept: () => void;
    override?: RequestOverride;
    mode?: PromptSendMode;
  };
  /** The text whose submit puts the draft back, and the draft; with `mode`
   * `bash`, the command whose leaving the composer does. */
  restoring?: { text: string; draft: string; mode?: PromptSendMode };
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
/** prompt.change's input, as far as the module reads it: who changed the
 * composer (`clear` when a submit took the draft, a clear, a stash). */
export const PromptChangeInputSchema = v.looseObject({
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

/** `hyoui input` that presses `!` on this session's terminal and waits until
 * the screen shows the composer in bash mode (SHELL_MODE_SCREEN). It exits 0
 * only once the switch shows. The command is put in after it: keys and a fill
 * go by separate ways into the composer, and a command filled before the
 * switch shows can land ahead of the `!` (measured: `echo x` became
 * `echo x!`). */
export function hyouiShellModeArgv(hyouiSessionId: string): string[] {
  return [
    "hyoui",
    "input",
    hyouiSessionId,
    "text:!",
    `wait:${SHELL_MODE_SCREEN}`,
    "--timeout",
    "1s",
  ];
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

/** Whether the text is in the composer, ready for Enter; when it is not, what
 * the prompt.send says. */
type Filled = { isFilled: true } | { isFilled: false; result: PromptSendResult };

/** A fill the composer refused: why, as the engine said (a hook's refusal
 * says nothing). */
function refused(refusal: "no_composer" | "dialog" | undefined): Filled {
  return { isFilled: false, result: { outcome: "not_delivered", reason: refusal ?? "refused" } };
}

/** Put the person's draft back after a step that had emptied the composer
 * failed. A put-back the composer refuses (a dialog opened meanwhile) leaves
 * the draft to the debug log. A replacing fill leaves bash mode as well. */
async function restoreDraft($: Engine, draft: string): Promise<void> {
  const put = await $.prompt.fill({ text: draft, mode: "replace" });
  if (!put.isFilled) {
    $.ui.log(`ccmsg: could not put the draft back; it was: ${draft}`, { to: "debug" });
  }
}

/** Put `text` in the composer as a bash mode command. The composer is
 * emptied first: a replacing fill leaves bash mode, so the `!` pressed next
 * switches into it rather than going in as text, and a dialog refuses the
 * fill before any key is pressed. The command is appended once the switch
 * shows (an append keeps bash mode). Until it is in, the person's draft is out
 * of the composer, and a step that fails puts it back: the command never
 * went in, so it is known not to be delivered. */
async function fillBashCommand(
  $: Engine,
  hyouiSessionId: string,
  text: string,
  draft: string,
): Promise<Filled> {
  const emptied = await $.prompt.fill({ text: "", mode: "replace" });
  if (!emptied.isFilled) return refused(emptied.refusal);
  let switched: boolean;
  try {
    const run = await $.process.run(hyouiShellModeArgv(hyouiSessionId), {
      timeoutMs: SHELL_MODE_TIMEOUT_MS,
    });
    switched = run.exitCode === 0;
  } catch {
    switched = false;
  }
  if (!switched) {
    await restoreDraft($, draft);
    return { isFilled: false, result: { outcome: "not_delivered", reason: "enter_failed" } };
  }
  const filled = await $.prompt.fill({ text, mode: "append" });
  if (!filled.isFilled) {
    await restoreDraft($, draft);
    return refused(filled.refusal);
  }
  return { isFilled: true };
}

/** Put `text` in the composer as the person's prompt, over their draft. */
async function fillPrompt($: Engine, text: string): Promise<Filled> {
  const filled = await $.prompt.fill({ text, mode: "replace" });
  return filled.isFilled ? { isFilled: true } : refused(filled.refusal);
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
  const filled =
    request.mode === "bash"
      ? await fillBashCommand($, hyouiSessionId, request.text, draft)
      : await fillPrompt($, request.text);
  if (!filled.isFilled) return filled.result;

  // The last moment the request can still be kept out of a session it was
  // not meant for. With the text still in the composer and put back, no Enter
  // went out for it: it is known not to be in.
  if (!(await stillCurrent($, state, request))) {
    return (await putBackUnsent($, request.text, draft)) ? SESSION_CHANGED : UNCONFIRMED;
  }
  const accepted = Promise.withResolvers<boolean>();
  // A bash mode command starts no prompt.submit, which is where a one-shot
  // override is armed: it carries none (DR-0035 §3).
  state.awaiting =
    request.mode === "bash"
      ? { text: request.text, accept: () => accepted.resolve(true), mode: request.mode }
      : {
          text: request.text,
          accept: () => accepted.resolve(true),
          ...(request.override !== undefined ? { override: request.override } : {}),
        };
  state.restoring = {
    text: request.text,
    draft,
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
  };
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
  // A bash mode command is taken by its Enter clearing the composer
  // (composerCleared), never by a submit: a prompt of the same text is not it.
  const awaiting = state.awaiting?.mode === undefined ? state.awaiting : undefined;
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
  if (!entered || restoring === undefined || restoring.mode !== undefined) return;
  if (!samePrompt(input.text, restoring.text)) return;
  state.restoring = undefined;
  if (restoring.draft !== "") await putBackDraft($, restoring.text, restoring.draft);
}

/** The composer was emptied by something other than an edit (prompt.change
 * with `origin.kind: "clear"`): when a bash mode command is awaited, this is
 * its Enter taking it, which is all the harness tells of it until the command
 * has finished (the `<bash-input>` row comes only then). The command runs, or
 * is queued behind the running turn: it is accepted, and the person gets
 * their draft back.
 *
 * The draft goes back without holding the event: prompt.change is raised one
 * at a time, and the put-back's own change comes after this one. */
export function composerCleared($: Engine, state: PromptSendState): void {
  const awaiting = state.awaiting;
  if (awaiting?.mode === "bash") {
    state.awaiting = undefined;
    awaiting.accept();
  }
  const restoring = state.restoring;
  if (restoring?.mode !== "bash") return;
  state.restoring = undefined;
  if (restoring.draft === "") return;
  putBackDraft($, restoring.text, restoring.draft).catch((e: unknown) => {
    $.ui.log(`ccmsg: the draft was not put back: ${errorText(e)}`, { to: "debug" });
  });
}
