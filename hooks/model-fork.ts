// `model.fork` (DR-0060 §2): the daemon asks a btw of the session, and the
// module answers it with `$.model.fork` — one tool-less completion over the
// main thread's last request with the question after it, which reads the
// session's prompt cache and is written nowhere in the transcript. The reply
// carries the answer's text, what it cost and the effort it ran at, or why
// there is none, in the engine's own words.
import type { ModelForkArgs, ModelForkEffort, ModelForkResult } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";

/** `{ effort }` when the engine named one, else nothing. */
function effortOf(effort: ModelForkEffort | undefined): { effort?: ModelForkEffort } {
  return effort !== undefined ? { effort } : {};
}

export async function forkForDaemon($: Engine, args: ModelForkArgs): Promise<ModelForkResult> {
  const forked = await $.model.fork({ prompt: args.prompt, ...effortOf(args.effort) });
  if (forked.isAnswered) {
    return {
      outcome: "answered",
      text: forked.text,
      usage: forked.usage,
      ...effortOf(forked.effort),
    };
  }
  switch (forked.reason) {
    case "nothing-to-fork":
      return { outcome: "not_answered", reason: forked.reason };
    case "api-error":
      return {
        outcome: "not_answered",
        reason: forked.reason,
        status: forked.status,
        error: forked.error,
        usage: forked.usage,
        ...effortOf(forked.effort),
      };
    case "empty-reply":
    case "aborted":
      return {
        outcome: "not_answered",
        reason: forked.reason,
        usage: forked.usage,
        ...effortOf(forked.effort),
      };
  }
}
