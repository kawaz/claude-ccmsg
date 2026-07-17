// Pure derivations for SessionCreator (DR-0018 §2.1/§3.4). Kept out of
// utils.ts as a standalone module, same convention as rooms-filter.ts /
// in-view-search.ts — the form model and its wire-request projection are
// exercised in isolation by session-creator.test.ts, and neither reads
// AppState nor does I/O (that's SessionCreator.tsx's job, per DR-0005 §1).
import type { SessionLaunchRequest } from "@ccmsg/protocol";

/** DR-0018 §2.1 fixed dropdown options — the DR explicitly scopes "コマンド
 * テンプレの UI 編集" out (§2.3), so these lists are hardcoded here rather
 * than sourced from config; only `root_dirs`/`default_prompt` come from the
 * daemon (session_launcher_config). */
export const SESSION_CREATOR_MODELS = [
  "sonnet",
  "opus",
  "fable",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;
export const SESSION_CREATOR_EFFORTS = ["low", "middle", "high", "xhigh"] as const;

export const DEFAULT_SESSION_CREATOR_MODEL = "fable";
export const DEFAULT_SESSION_CREATOR_EFFORT = "middle";

export interface SessionCreatorForm {
  cwd: string;
  model: string;
  effort: string;
  prompt: string;
}

/** Initial form state once `default_prompt` is known (session_launcher_config
 * response) — `cwd` starts empty; the run button stays disabled until the
 * CwdTree picker sets one (see `sessionCreatorFormValid`). */
export function initialSessionCreatorForm(defaultPrompt: string): SessionCreatorForm {
  return {
    cwd: "",
    model: DEFAULT_SESSION_CREATOR_MODEL,
    effort: DEFAULT_SESSION_CREATOR_EFFORT,
    prompt: defaultPrompt,
  };
}

/** Run button gate: `session_launch` requires a real `cwd` (dir_tree picks
 * only ever produce non-empty absolute paths, but the field is free-typeable
 * too — DR-0018 doesn't forbid typing a path directly, it just describes the
 * click-to-pick affordance). Prompt may legitimately be empty (an agent
 * launched with no prompt is still a valid `claude` invocation), so it's not
 * part of this gate. */
export function sessionCreatorFormValid(form: SessionCreatorForm): boolean {
  return form.cwd.trim() !== "";
}

/** Builds the wire `session_launch` request body (op excluded — ws.ts's
 * `sessionLaunch` adds it, same convention as SessionSearchPanel's
 * buildSessionSearchRequest). Returns null when the form isn't launchable yet
 * (mirrors sessionCreatorFormValid) so callers can't accidentally fire a
 * request with an empty cwd. */
export function buildSessionLaunchRequest(
  form: SessionCreatorForm,
): Omit<SessionLaunchRequest, "op"> | null {
  if (!sessionCreatorFormValid(form)) return null;
  return { cwd: form.cwd.trim(), model: form.model, effort: form.effort, prompt: form.prompt };
}
