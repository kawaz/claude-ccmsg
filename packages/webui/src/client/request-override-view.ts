// What the webui shows of the overrides of a session's main-thread requests
// (DR-0041 §5), and what its selects offer and send (§6). Pure: no store, no
// DOM.
//
// The engine's own display (`/model`, the session's model and effort) does
// not change under an override, so the ctx line shows the values the main
// thread's requests are sent with — the one-shot override, else the session
// override (whose unset fields are the session's own) — and marks the ones
// that differ from the session's own. The values come from the daemon's
// ev:"request_override" (RequestOverrideState), the session's own from the
// status snapshot's context.
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

/** The mark an overridden value carries on the ctx line. */
export const OVERRIDE_MARK = "⁺";

/** The two fields an override has. */
export type OverrideField = "model" | "effort";

/** The models and the efforts a select offers, in the launch's order. */
export const OVERRIDE_MODELS: readonly LaunchModel[] = LaunchModelSchema.options;
export const OVERRIDE_EFFORTS: readonly LaunchEffort[] = LaunchEffortSchema.options;

/** What one of the model and the effort of the ctx line shows: the value the
 * requests are sent with, and when an override sets it to other than the
 * session's own, which one. */
export interface RequestValueView {
  text: string;
  by?: "session" | "once";
  title: string;
}

const OVERRIDE_NAME = { session: "通しの上書き", once: "単発の上書き" } as const;

/** Whether `value` puts other than the session's own `own` on the requests.
 * `own` is the transcript's model ID (`claude-opus-5-5`), while the module
 * spells the session's model as the session names it (`opus[1m]`,
 * `claude-opus-5-5[1m]`): a model name that is not an ID is read as the
 * family it names, an ID is compared as it is without the `[1m]` suffix,
 * anything else as it is spelled. */
function differs(field: OverrideField, value: string, own: string | undefined): boolean {
  if (own === undefined) return true;
  if (field === "model") {
    const unsuffixed = (model: string) => model.replace(/\[[^\]]*\]$/, "");
    if (!value.startsWith("claude-")) {
      const family = launchModelFromTranscript(value);
      if (family !== undefined) return launchModelFromTranscript(own) !== family;
    }
    return unsuffixed(value) !== unsuffixed(own);
  }
  return value !== own;
}

/** The value one field's requests are sent with, and which override it is
 * when an override sets it to other than the session's own (`by`); null
 * when neither the session nor an override names one. The same judgment
 * marks the ctx line (§5) and labels the selects (§6.1). */
function inForce(
  field: OverrideField,
  own: string | undefined,
  state: RequestOverrideState | undefined,
): { value: string; by?: "session" | "once" } | null {
  const once = state?.once[field] ?? null;
  const session = state?.session[field] ?? null;
  const by =
    once !== null
      ? "once"
      : session !== null && differs(field, session, own)
        ? "session"
        : undefined;
  const value = by === "once" ? once : by === "session" ? session : null;
  if (value === null || by === undefined || !differs(field, value, own)) {
    return own === undefined ? null : { value: own };
  }
  return { value, by };
}

function valueView(
  field: OverrideField,
  own: string | undefined,
  state: RequestOverrideState | undefined,
  shorten: (value: string) => string,
): RequestValueView | null {
  const now = inForce(field, own, state);
  if (now === null) return null;
  if (now.by === undefined) return { text: shorten(now.value), title: `${field} ${now.value}` };
  return {
    text: `${shorten(now.value)}${OVERRIDE_MARK}`,
    by: now.by,
    title:
      `${field} ${now.value} (${OVERRIDE_NAME[now.by]}。` +
      (own !== undefined ? `セッション自身は ${own})` : "セッション自身の値はまだ分からない)"),
  };
}

/** The model and the effort of the ctx line. The effort is null when neither
 * the session nor an override names one (a model without effort, an older
 * transcript row). */
export function requestValueViews(
  ctx: SessionContextUsage,
  state: RequestOverrideState | undefined,
  shorten: (model: string) => string,
): { model: RequestValueView; effort: RequestValueView | null } {
  const model = valueView("model", ctx.model, state, shorten) ?? {
    text: shorten(ctx.model),
    title: `model ${ctx.model}`,
  };
  return { model, effort: valueView("effort", ctx.effort, state, (e) => e) };
}

/** The marks the selects put before a value (DR-0041 §6.1): what the value
 * is — the one-shot override's, the session override's, the session's own. */
export const LAYER_MARK = { once: "⏱️", session: "📌", engine: "🏛️" } as const;

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

/** The session's own value of `field` in the vocabulary: the family of the
 * model ID (`claude-fable-5-1` is `fable`), the effort as it is. Undefined
 * when it is not known or outside the vocabulary, where the session group
 * has no 🏛️ and offers every value with 📌. */
function engineValue(
  field: OverrideField,
  own: SessionContextUsage | undefined,
): string | undefined {
  if (own === undefined) return undefined;
  if (field === "model") return launchModelFromTranscript(own.model);
  return own.effort !== undefined ? launchEffortFromTranscript(own.effort) : undefined;
}

/** The groups of the select of `field` (DR-0041 §6.2): default (the value in
 * force, marked with the override it is), turn (⏱️, when `turn`), and
 * session (📌, with 🏛️ in place of the session's own value). `own` is the
 * session's own model and effort (the status snapshot's context); `shorten`
 * how a model ID is shown. */
export function overrideGroups(
  field: OverrideField,
  state: RequestOverrideState | undefined,
  own: SessionContextUsage | undefined,
  { turn, shorten }: { turn: boolean; shorten: (model: string) => string },
): OverrideGroup[] {
  const now = inForce(field, own?.[field], state);
  const shown = (value: string) => (field === "model" ? shorten(value) : value);
  const current =
    now === null ? "—" : `${now.by !== undefined ? LAYER_MARK[now.by] : ""}${shown(now.value)}`;
  const engine = engineValue(field, own);
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
