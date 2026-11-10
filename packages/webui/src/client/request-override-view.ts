// What the webui shows of the overrides of a session's main-thread requests
// (DR-0041 §5), and what its selects offer and send (§6). Pure: no store, no
// DOM.
//
// The engine's own display (`/model`, the session's model and effort) does
// not change under an override, so the ctx line shows the values the main
// thread's requests are sent with — the one-shot override, else the session
// override (whose unset fields are the session's own) — and marks the ones
// that differ from the session's own. Two values of a field are apart here:
// what the requests ran on (the status snapshot's context `model` / `effort`;
// the transcript's model is the one that answered, an override's included),
// which the ctx line shows where no override is in force, and the session's
// own (the context's `engine`, from the session's hooks module), which the
// marks, the selects' default and their 🏛️ are read against. The overrides'
// values come from the daemon's ev:"request_override" (RequestOverrideState).
import {
  LaunchEffortSchema,
  launchEffortFromTranscript,
  launchModelFromTranscript,
  LaunchModelSchema,
  type ErrorResponse,
  type LaunchEffort,
  type LaunchModel,
  type RequestOverride,
  type RequestOverridePatch,
  type RequestOverrideResponse,
  type RequestOverrideState,
  type SessionContextUsage,
} from "@ccmsg/protocol";

/** The two fields an override has. */
export type OverrideField = "model" | "effort";

/** The models and the efforts a select offers, in the launch's order. */
export const OVERRIDE_MODELS: readonly LaunchModel[] = LaunchModelSchema.options;
export const OVERRIDE_EFFORTS: readonly LaunchEffort[] = LaunchEffortSchema.options;

/** Whether `value` puts other than the session's own `own` on the requests.
 * A model is spelled as an alias (`opus[1m]`, an override's `sonnet`) or as
 * an ID (`claude-opus-5-5[1m]`): two IDs are compared without the `[1m]`
 * suffix, otherwise as the families they name, and as they are spelled when
 * either names none. An own value not known yet differs from everything. */
function differs(field: OverrideField, value: string, own: string | undefined): boolean {
  if (own === undefined) return true;
  if (field === "model") {
    const unsuffixed = (model: string) => model.replace(/\[[^\]]*\]$/, "");
    if (value.startsWith("claude-") && own.startsWith("claude-")) {
      return unsuffixed(value) !== unsuffixed(own);
    }
    const family = launchModelFromTranscript(value);
    const ownFamily = launchModelFromTranscript(own);
    if (family !== undefined && ownFamily !== undefined) return family !== ownFamily;
    return unsuffixed(value) !== unsuffixed(own);
  }
  return value !== own;
}

/** The override in force on one field, when it sets the field to other than
 * the session's own `engine` value: its value and which override it is. */
function overrideInForceOn(
  field: OverrideField,
  engine: string | undefined,
  state: RequestOverrideState | undefined,
): { value: string; by: "session" | "once" } | null {
  const once = state?.once[field] ?? null;
  const session = state?.session[field] ?? null;
  const value = once ?? session;
  if (value === null || !differs(field, value, engine)) return null;
  return { value, by: once !== null ? "once" : "session" };
}

/** The marks the selects put before a value (DR-0041 §6.1): what the value
 * is — the one-shot override's, the session override's, the session's own. */
export const LAYER_MARK = { once: "⏱️", session: "📌", engine: "🏛️" } as const;

/** A context window as it is written after a model, in square brackets:
 * whole millions as `[1m]`, anything else in thousands (`[200K]`). */
export function formatContextWindow(window: number): string {
  return window % 1_000_000 === 0 ? `[${window / 1_000_000}m]` : `[${Math.round(window / 1000)}K]`;
}

/** A model without a window after it (`claude-fable-5-1[1m]` →
 * `claude-fable-5-1`). */
function withoutWindow(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

/** The session's own model, as exactly as it is known: the ID of the model
 * that answered (the transcript's `claude-fable-5-2`) where that is the model
 * the session names for itself, else the name the session was started or
 * switched with (the module's `fable[1m]`, an alias with no version: after
 * `/model`, or under a model override, the last answer is another model's).
 * Without the module's facts, the model that answered. */
function ownModel(ctx: SessionContextUsage): string {
  const named = ctx.engine?.model;
  if (named === undefined) return ctx.model;
  const family = launchModelFromTranscript(named);
  return family !== undefined && family === launchModelFromTranscript(ctx.model)
    ? ctx.model
    : withoutWindow(named);
}

/** The value of `field` in force, as every place that shows it writes it
 * (DR-0041 §6.1): the override's with the mark of which one (`📌low`,
 * `⏱️high`) when it sets other than the session's own, else the session's
 * own — or, without the module's facts, what the requests ran on — and null
 * when nothing names one. A model is followed by the context window the
 * session measures (`fable-5-2[1m]`). */
function valueInForce(
  field: OverrideField,
  ctx: SessionContextUsage | undefined,
  state: RequestOverrideState | undefined,
  shorten: (model: string) => string,
): string | null {
  const over = overrideInForceOn(field, ctx?.engine?.[field], state);
  if (field === "effort") {
    if (over !== null) return `${LAYER_MARK[over.by]}${over.value}`;
    return ctx?.engine?.effort ?? ctx?.effort ?? null;
  }
  if (ctx === undefined)
    return over === null ? null : `${LAYER_MARK[over.by]}${shorten(over.value)}`;
  const window = ctx.window !== undefined ? formatContextWindow(ctx.window) : "";
  return over !== null
    ? `${LAYER_MARK[over.by]}${shorten(withoutWindow(over.value))}${window}`
    : `${shorten(ownModel(ctx))}${window}`;
}

/** The model and the effort of the ctx line, each the text its select shows
 * at rest (the Status tab's MODEL / EFFORT show the same): the model with its
 * window. The effort is null when neither the session nor an override names
 * one (a model without effort, an older transcript row). */
export function requestValueTexts(
  ctx: SessionContextUsage,
  state: RequestOverrideState | undefined,
  shorten: (model: string) => string,
): { model: string; effort: string | null } {
  return {
    model: valueInForce("model", ctx, state, shorten) ?? shorten(ctx.model),
    effort: valueInForce("effort", ctx, state, shorten),
  };
}

/** What choosing an option of a select does (DR-0041 §6.1): nothing (the
 * default, the value in force); the one-shot override of the send; the
 * session override set to a value; or the field's one-shot and session
 * overrides both cleared, to the session's own value (§6.5). */
export type OverrideChoice =
  | { kind: "current" }
  | { kind: "once"; override: RequestOverride }
  | { kind: "session" | "engine"; patch: RequestOverridePatch };

export interface OverrideOption {
  /** The `<option>`'s value, unique in its select. */
  key: string;
  label: string;
  choice: OverrideChoice;
}

/** The groups of a select (DR-0041 §6.2), in this order. */
export interface OverrideGroup {
  label: "default" | "turn" | "session";
  options: OverrideOption[];
}

/** The key of the default option, the one a select starts on and returns
 * to. */
export const CURRENT_KEY = "current";

/** One field's vocabulary, in the launch's order (§2), each value as the
 * one-shot override that sets it. */
function vocabulary(field: OverrideField): { value: string; set: RequestOverride }[] {
  return field === "model"
    ? OVERRIDE_MODELS.map((model) => ({ value: model, set: { model } }))
    : OVERRIDE_EFFORTS.map((effort) => ({ value: effort, set: { effort } }));
}

/** The session's own value of `field` (the context's `engine`) in the
 * vocabulary: the family of the model (`claude-fable-5-1` and `fable[1m]`
 * are `fable`), the effort as it is. Undefined when it is not known (no
 * module's facts) or outside the vocabulary, where the session group has no
 * 🏛️ and offers every value with 📌. */
function engineValue(
  field: OverrideField,
  ctx: SessionContextUsage | undefined,
): string | undefined {
  const engine = ctx?.engine?.[field];
  if (engine === undefined) return undefined;
  return field === "model" ? launchModelFromTranscript(engine) : launchEffortFromTranscript(engine);
}

/** The groups of the select of `field` (DR-0041 §6.2): default (the value in
 * force: the override's, marked with which one, else the session's own),
 * turn (⏱️, when `turn`), and session (📌, with 🏛️ in place of the session's
 * own value). `ctx` is the status snapshot's context, whose `engine` is the
 * session's own; `shorten` how a model name is shown. */
export function overrideGroups(
  field: OverrideField,
  state: RequestOverrideState | undefined,
  ctx: SessionContextUsage | undefined,
  { turn, shorten }: { turn: boolean; shorten: (model: string) => string },
): OverrideGroup[] {
  const current = valueInForce(field, ctx, state, shorten) ?? "—";
  const engine = engineValue(field, ctx);
  const cleared: RequestOverridePatch = field === "model" ? { model: null } : { effort: null };
  const values = vocabulary(field);
  return [
    {
      label: "default",
      options: [{ key: CURRENT_KEY, label: current, choice: { kind: "current" } }],
    },
    ...(turn
      ? [
          {
            label: "turn" as const,
            options: values.map(({ value, set }) => ({
              key: `once:${value}`,
              label: `${LAYER_MARK.once}${value}`,
              choice: { kind: "once" as const, override: set },
            })),
          },
        ]
      : []),
    {
      label: "session",
      options: values.map(({ value, set }) =>
        value === engine
          ? {
              key: "engine",
              label: `${LAYER_MARK.engine}${value}`,
              choice: { kind: "engine", patch: cleared },
            }
          : {
              key: `session:${value}`,
              label: `${LAYER_MARK.session}${value}`,
              choice: { kind: "session", patch: set },
            },
      ),
    },
  ];
}

/** The option of `groups` whose key is `key`; the default one when there is
 * none (the options moved under a choice, e.g. the session's own value
 * changed). */
export function chosenOption(groups: readonly OverrideGroup[], key: string): OverrideOption {
  const options = groups.flatMap((group) => group.options);
  const found = options.find((option) => option.key === key);
  if (found !== undefined) return found;
  return { key: CURRENT_KEY, label: options[0]?.label ?? "—", choice: { kind: "current" } };
}

/** The request_override patch a choice sends; null for one that sends none
 * (the default, a one-shot override, which goes with the prompt). */
export function choicePatch(choice: OverrideChoice): RequestOverridePatch | null {
  return choice.kind === "session" || choice.kind === "engine" ? choice.patch : null;
}

/** What a select says of a request_override's reply: nothing when a module
 * took it, else what became of it and what to do. */
export function requestOverrideNotice(
  reply: RequestOverrideResponse | ErrorResponse,
): string | null {
  if (!reply.ok) return `変更できなかった (${reply.error.code}): ${reply.error.msg}`;
  switch (reply.delivery) {
    case "applied":
      return null;
    case "unconfirmed":
      return "セッションが受け取ったかを確認できていない。効いているかは状態行の印で分かる";
    case "no_module":
      return "このセッションには ccmsg の受け口 (hooks module) が無いので、今は効かない。受け口のある版で起動し直すと効く";
  }
}
