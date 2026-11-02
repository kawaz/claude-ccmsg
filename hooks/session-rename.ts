// Renaming the session from the web UI (DR-0047): `session.rename` runs the
// built-in `/rename <name>` with `$.command.run`, as a person typing it does.
// The engine runs a command once the session is idle, so while the main loop
// answers a turn the rename waits for the turn's end, and the reply says so
// rather than holding the daemon until then.
import { errorText } from "@ccmsg/protocol/parse";
import type { SessionRenameArgs, SessionRenameResult } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";
import type { TurnAbortState } from "./turn-abort.ts";

/** How long the module waits for `$.command.run` before answering `queued`:
 * an idle session runs `/rename` in a few ms, and one that is busy in a way
 * the module does not see (a turn already running when the module was
 * loaded, a dialog open) still gets its reply well inside the daemon's
 * deadline. */
export const RENAME_WAIT_MS = 2_000;

/** session.rename: run `/rename <name>`. With a main-loop turn running, the
 * run is left to the engine's queue and the answer is `queued` at once; else
 * the module waits up to RENAME_WAIT_MS for it to end. A rejection that comes
 * after the answer is logged. */
export async function renameSession(
  $: Engine,
  state: TurnAbortState,
  args: SessionRenameArgs,
): Promise<SessionRenameResult> {
  const run = $.command.run({ command: "rename", args: args.name }).then(
    (): SessionRenameResult => ({ outcome: "renamed" }),
    (e: unknown): SessionRenameResult => {
      const message = errorText(e);
      $.ui.log(`ccmsg: /rename refused: ${message}`, { to: "debug" });
      return { outcome: "refused", message };
    },
  );
  if (state.mainTurnId !== undefined) return { outcome: "queued" };
  let timer: { cancel(): void } | undefined;
  const waited = new Promise<SessionRenameResult>((resolve) => {
    timer = $.clock.after(RENAME_WAIT_MS, () => resolve({ outcome: "queued" }));
  });
  const result = await Promise.race([run, waited]);
  timer?.cancel();
  return result;
}
