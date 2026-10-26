// What the webui shows of the overrides of a session's main-thread requests
// (DR-0041 §5), and what its pickers send. Pure: no store, no DOM.
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
  launchModelFromTranscript,
  LaunchModelSchema,
  parseWith,
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

/** The models and the efforts a picker offers, in the launch's order. */
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

/** Whether `value` puts other than the session's own `own` on the requests:
 * a model family against the family of the session's model, anything else
 * as it is spelled. */
function differs(field: OverrideField, value: string, own: string | undefined): boolean {
  if (own === undefined) return true;
  if (field === "model" && parseWith(LaunchModelSchema, value).ok) {
    return launchModelFromTranscript(own) !== value;
  }
  return value !== own;
}

function valueView(
  field: OverrideField,
  own: string | undefined,
  state: RequestOverrideState | undefined,
  shorten: (value: string) => string,
): RequestValueView | null {
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
    return own === undefined ? null : { text: shorten(own), title: `${field} ${own}` };
  }
  return {
    text: `${shorten(value)}${OVERRIDE_MARK}`,
    by,
    title:
      `${field} ${value} (${OVERRIDE_NAME[by]}。` +
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

/** What the session override's pickers show: the fields whose values differ
 * from the session's own, in the pickers' vocabulary; "上書きなし" for the
 * rest. */
export function sessionPickerValue(
  state: RequestOverrideState | undefined,
  ctx: SessionContextUsage | undefined,
): RequestOverride {
  const model = parseWith(LaunchModelSchema, state?.session.model ?? "");
  const effort = parseWith(LaunchEffortSchema, state?.session.effort ?? "");
  return {
    ...(model.ok && differs("model", model.value, ctx?.model) ? { model: model.value } : {}),
    ...(effort.ok && differs("effort", effort.value, ctx?.effort) ? { effort: effort.value } : {}),
  };
}

/** The one-shot override's values in the pickers' vocabulary. */
export function onceOverride(state: RequestOverrideState | undefined): RequestOverride {
  const model = parseWith(LaunchModelSchema, state?.once.model ?? "");
  const effort = parseWith(LaunchEffortSchema, state?.once.effort ?? "");
  return {
    ...(model.ok ? { model: model.value } : {}),
    ...(effort.ok ? { effort: effort.value } : {}),
  };
}

/** A picker's value: an override field's value, or "" for none. */
export function pickerValue(override: RequestOverride, field: OverrideField): string {
  return override[field] ?? "";
}

/** `override` with `field` set to what a picker's `<select>` holds: "" (or
 * anything outside the vocabulary) is no override of that field. */
export function withPicked(
  override: RequestOverride,
  field: OverrideField,
  picked: string,
): RequestOverride {
  const model = parseWith(LaunchModelSchema, picked);
  const effort = parseWith(LaunchEffortSchema, picked);
  const next = {
    model: field === "model" ? (model.ok ? model.value : undefined) : override.model,
    effort: field === "effort" ? (effort.ok ? effort.value : undefined) : override.effort,
  };
  return {
    ...(next.model !== undefined ? { model: next.model } : {}),
    ...(next.effort !== undefined ? { effort: next.effort } : {}),
  };
}

/** The request_override patch for a session picker of `field` set to `picked`: the
 * value, or null (clear) for none. */
export function overridePatch(field: OverrideField, picked: string): RequestOverridePatch {
  const set = withPicked({}, field, picked);
  return field === "model" ? { model: set.model ?? null } : { effort: set.effort ?? null };
}

/** The values as a line (Status tab): its fields, or that there is none. */
export function overrideText(override: RequestOverride): string {
  const parts = [
    ...(override.model !== undefined ? [`model ${override.model}`] : []),
    ...(override.effort !== undefined ? [`effort ${override.effort}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "なし";
}

/** What a picker says of a request_override's reply: nothing when a module
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
