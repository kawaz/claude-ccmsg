// Which sessions a person types into, as Claude Code's `sessions/<pid>.json`
// (and its transcript) name how a session was started (`entrypoint`). The
// webui puts the others apart in SESSIONS (DR-0060 §8); the daemon passes
// over them when it looks for the session a continue would pick
// (launch-context.ts).

/** The `entrypoint`s of Claude Code's `sessions/<pid>.json` that name a
 * session no person types into: `claude -p` (`sdk-cli`) and the SDKs. */
export const SDK_ENTRYPOINTS: ReadonlySet<string> = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);

/** Whether a session started from `entrypoint` is one a person types into.
 * A session whose record names none is taken as one. */
export function isInteractiveEntrypoint(entrypoint: string | undefined): boolean {
  return entrypoint === undefined || !SDK_ENTRYPOINTS.has(entrypoint);
}
