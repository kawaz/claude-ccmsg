// The overrides of each session's main-thread requests (DR-0041 §3, §5),
// as the daemon handles them.
//
// A person changes the session override with request_override. The daemon
// holds it (the fields a person set) and hands it, whole, to the hooks module
// of every live run of the session as a `request.override` request: when it
// changes (with the fields the change named, which the module takes out of
// the one-shot override too), and again when a run names itself (a module
// started again, or a run the daemon did not know of); it goes only when the
// person clears it, or with the daemon. The one-shot override comes with a prompt (user_prompt,
// user-prompt.ts) and is the module's to hold.
//
// What the overrides put on the requests is the module's to say: it sends it
// with its facts, and the daemon hands each change to every webui tab
// (ev:"request_override"), the values of one override at a time, and only
// when they changed. What the module does with the overrides is
// hooks/request-override.ts.
import {
  patchOverride,
  type RequestOverride,
  type RequestOverrideArgs,
  type RequestOverrideDelivery,
  type RequestOverrideField,
  type RequestOverridePatch,
  type RequestOverrideState,
  type RequestOverrideTarget,
  type RequestValues,
} from "@ccmsg/protocol";
import { callSidecar, type SidecarDeps } from "./sidecar-call.ts";
import type { SidecarRun } from "./sidecar-runs.ts";

/** How long the daemon waits for a module to answer `request.override`: the
 * write, then the module's reply over `POST /op` (a few ms, DR-0046). */
export const REQUEST_OVERRIDE_DEADLINE_MS = 5_000;

/** The session overrides the daemon holds, by session id. */
export class SessionOverrides {
  readonly #bySid = new Map<string, RequestOverride>();

  /** `sid`'s session override after `patch`, held. A session whose override
   * comes to nothing is let go. */
  change(sid: string, patch: RequestOverridePatch): RequestOverride {
    const next = patchOverride(this.get(sid), patch);
    if (next.model === undefined && next.effort === undefined) this.#bySid.delete(sid);
    else this.#bySid.set(sid, next);
    return next;
  }

  /** `sid`'s session override; `{}` for none. */
  get(sid: string): RequestOverride {
    return this.#bySid.get(sid) ?? {};
  }

  /** Whether `sid` has a session override. */
  has(sid: string): boolean {
    return this.#bySid.has(sid);
  }
}

/** One override of a session whose values changed. */
export interface RequestValuesChange extends RequestValues {
  sid: string;
  target: RequestOverrideTarget;
}

/** What each session's module last said its overrides put on the requests. */
export class RequestOverrideStates {
  readonly #bySid = new Map<string, RequestOverrideState>();

  /** Take what `sid`'s module says now, and answer the overrides whose
   * values changed: both for a session not heard of before, none when
   * nothing moved. */
  take(sid: string, state: RequestOverrideState): RequestValuesChange[] {
    const held = this.#bySid.get(sid);
    this.#bySid.set(sid, state);
    const targets: RequestOverrideTarget[] = ["session", "once"];
    return targets
      .filter((target) => held === undefined || !sameValues(held[target], state[target]))
      .map((target) => ({ sid, target, ...state[target] }));
  }

  /** Every session's, for a tab that has just subscribed. */
  snapshot(): ({ session_id: string } & RequestOverrideState)[] {
    return [...this.#bySid].map(([sid, state]) => ({ session_id: sid, ...state }));
  }

  /** Drop `sid`'s (the session ended). */
  forget(sid: string): void {
    this.#bySid.delete(sid);
  }
}

/** The fields `patch` names, a value or `null` (DR-0041 §6.5): what a
 * person's change takes out of the one-shot override too. */
export function namedFields(patch: RequestOverridePatch): RequestOverrideField[] {
  const fields: RequestOverrideField[] = ["model", "effort"];
  return fields.filter((field) => patch[field] !== undefined);
}

function sameValues(a: RequestValues, b: RequestValues): boolean {
  return a.model === b.model && a.effort === b.effort;
}

export interface RequestOverrideDeps extends SidecarDeps {
  deadlineMs: number;
}

export function productionRequestOverrideDeps(deps: SidecarDeps): RequestOverrideDeps {
  return { ...deps, deadlineMs: REQUEST_OVERRIDE_DEADLINE_MS };
}

/** What became of the change at one run, for the daemon log. */
export interface RequestOverrideTry {
  id: string;
  socket: string;
  result: "unwritten" | "write_uncertain" | "applied" | "unconfirmed";
}

/** Hand the session override in `args` (with the fields a person's change
 * named, for a change) to the hooks module behind each of `runs` (runs of
 * `sid`), all at once: a run applying it twice changes nothing, so unlike a
 * prompt there is nothing to keep from going in twice. `applied` when one
 * module applied it, `no_module` when there was no run to write to (or none
 * took the line), `unconfirmed` otherwise. */
export async function sendRequestOverride(
  sid: string,
  args: RequestOverrideArgs,
  runs: readonly SidecarRun[],
  deps: RequestOverrideDeps,
): Promise<{ delivery: RequestOverrideDelivery; tries: RequestOverrideTry[] }> {
  const tries = await Promise.all(
    runs.map(async ({ socket }): Promise<RequestOverrideTry> => {
      const call = await callSidecar(socket, sid, "request.override", args, deps.deadlineMs, deps);
      const { id } = call;
      if (call.write === "not_written") return { id, socket, result: "unwritten" };
      if (call.reply?.ok === true && call.reply.value.ok) return { id, socket, result: "applied" };
      return {
        id,
        socket,
        result:
          call.write === "uncertain" && call.reply === undefined
            ? "write_uncertain"
            : "unconfirmed",
      };
    }),
  );
  if (tries.some((t) => t.result === "applied")) return { delivery: "applied", tries };
  if (tries.every((t) => t.result === "unwritten")) return { delivery: "no_module", tries };
  return { delivery: "unconfirmed", tries };
}
