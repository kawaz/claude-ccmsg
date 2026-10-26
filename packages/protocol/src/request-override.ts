// What a person overrides a running session's main-thread requests with from
// the webui (DR-0041): the model and the effort, in the launch's vocabulary,
// for the session (the session override) or for the turn a prompt starts or
// joins (the one-shot override); the values the requests are sent with, as the
// session's hooks module reports them; and the model a request is sent with
// for an overridden family.
//
// The hooks module bundles this file, so it imports nothing but valibot and
// the protocol files that import nothing else.
import * as v from "valibot";
import { LaunchEffortSchema, LaunchModelSchema, type LaunchModel } from "./launch.ts";
import type { Output } from "./parse.ts";

/** An override of the model and the effort of a session's requests: a field
 * absent where the request keeps its own. `{}` overrides nothing. */
export const RequestOverrideSchema = v.object({
  model: v.optional(LaunchModelSchema),
  effort: v.optional(LaunchEffortSchema),
});
export type RequestOverride = Output<typeof RequestOverrideSchema>;

/** A change to an override, read as a JSON Merge Patch: a field absent keeps
 * it, `null` clears it, a value sets it. */
export const RequestOverridePatchSchema = v.object({
  model: v.optional(v.nullable(LaunchModelSchema)),
  effort: v.optional(v.nullable(LaunchEffortSchema)),
});
export type RequestOverridePatch = Output<typeof RequestOverridePatchSchema>;

/** Which override a change of values is of (ev:"request_override"):
 * `session`, the session override, which holds until changed and updates the
 * one-shot override's fields it changes; `once`, the one-shot override, which
 * comes with a prompt and holds to the end of the turn that answers it. */
export const RequestOverrideTargetSchema = v.picklist(["session", "once"]);
export type RequestOverrideTarget = Output<typeof RequestOverrideTargetSchema>;

/** The model and the effort one override puts on the session's main-thread
 * requests, as the session's hooks module has them: for `session`, the
 * session override's fields over the session's own values (a model as the
 * session names it, `[1m]` kept, until a person sets a family); for `once`,
 * the one-shot override's. `null` where it puts nothing (an own value not
 * known yet, a one-shot field not set). */
export const RequestValuesSchema = v.object({
  model: v.nullable(v.pipe(v.string(), v.nonEmpty())),
  effort: v.nullable(v.pipe(v.string(), v.nonEmpty())),
});
export type RequestValues = Output<typeof RequestValuesSchema>;

/** Both overrides' values (DR-0041 §5): what the module reports with its
 * facts, and what the daemon hands each webui tab. */
export const RequestOverrideStateSchema = v.object({
  session: RequestValuesSchema,
  once: RequestValuesSchema,
});
export type RequestOverrideState = Output<typeof RequestOverrideStateSchema>;

/** Whether `override` overrides anything. */
export function overridesAnything(override: RequestOverride): boolean {
  return override.model !== undefined || override.effort !== undefined;
}

/** `override` with `patch` laid over it. */
export function patchOverride(
  override: RequestOverride,
  patch: RequestOverridePatch,
): RequestOverride {
  const model = patch.model === undefined ? override.model : (patch.model ?? undefined);
  const effort = patch.effort === undefined ? override.effort : (patch.effort ?? undefined);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/** The model a request whose own model is `requestModel` is sent with when
 * it is overridden to `family` (DR-0041 §2): the family's alias, which the
 * engine resolves to a model id, with the request's own `[1m]` kept so the
 * context window the session runs with stays. */
export function overrideModel(requestModel: string | undefined, family: LaunchModel): string {
  return requestModel?.endsWith("[1m]") === true ? `${family}[1m]` : family;
}

/** The model and the effort a request is sent with: per field, the one-shot
 * override, else the session override, else none (the request keeps its
 * own). */
export function overrideInForce(overrides: {
  session: RequestOverride;
  once?: RequestOverride;
}): RequestOverride {
  const model = overrides.once?.model ?? overrides.session.model;
  const effort = overrides.once?.effort ?? overrides.session.effort;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}
