// Running the person's userscript as the page starts (DR-0057 §3-§5).
//
// Whether a page runs it is this browser's own switch, kept in localStorage
// and off unless switched on (from GLOBALS, or by opening a page with
// `?userscript=on`). When it is on and a script is saved, the page takes the
// JavaScript the daemon built from it (`userscript_load`), imports it as a
// module from a `blob:` URL and awaits its `userscript(util)`. Whatever the
// script does is the person's own: the page only keeps itself running when
// the script does not load or throws, and says so; a script that breaks the
// page is switched off for the browser by opening it with `?userscript=off`.
import * as v from "valibot";
import type { AgentInfo, PeerInfo, ReplyOf } from "@ccmsg/protocol";
import { readStorage, removeStorage, writeStorage } from "./storage.ts";
import type { Store } from "./useStore.ts";

/** The query parameter that switches this browser's userscript on or off. */
export const USERSCRIPT_PARAM = "userscript";

/** Where this browser keeps its switch (storage.ts's 内容: one value for the
 * whole browser, not per window). `"on"` = runs; absent = does not. */
export const USERSCRIPT_DEVICE_KEY = "ccmsg.userscript";

/** What the edit dialog starts from when no userscript is saved. */
export const USERSCRIPT_TEMPLATE = "export async function userscript(util) {\n}\n";

/** What `util` gives the script, as the edit dialog shows it (DR-0057 §5). */
export const USERSCRIPT_UTIL_TYPES = `interface Util {
  /** The session's rows as the webui holds them: its peer row (connected
   * sessions; PeerInfo) and its process row (AgentInfo), each null when the
   * webui has none. null when it has neither. Waits for the first lists. */
  session(sid: string): Promise<{ sid: string; peer: PeerInfo | null; agent: AgentInfo | null } | null>;
}
export async function userscript(util: Util): Promise<void>`;

/** The switch a page's URL asks for (`search` is `location.search`):
 * `?userscript=on` / `true` is on, `off` / `false` is off, anything else
 * (absent, another value) asks nothing. */
export function deviceSwitchFromQuery(search: string): boolean | null {
  const value = new URLSearchParams(search).get(USERSCRIPT_PARAM)?.toLowerCase();
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  return null;
}

/** This browser's switch as stored: on only when switched on. */
export function readDeviceEnabled(): boolean {
  return readStorage(USERSCRIPT_DEVICE_KEY) === "on";
}

/** Switch this browser's userscript on or off: localStorage, and the page's
 * state that GLOBALS shows. */
export function setDeviceEnabled(store: Store, enabled: boolean): void {
  if (enabled) writeStorage(USERSCRIPT_DEVICE_KEY, "on");
  else removeStorage(USERSCRIPT_DEVICE_KEY);
  store.dispatch({ type: "userscript/device", enabled });
}

/** One session as `util.session` gives it (DR-0057 §5). */
export interface UserscriptSession {
  sid: string;
  peer: PeerInfo | null;
  agent: AgentInfo | null;
}

export interface UserscriptUtil {
  session(sid: string): Promise<UserscriptSession | null>;
}

/** `util` over the page's store. A call waits until the first peers and
 * agents lists have come (a script runs as the page starts, before them), and
 * answers a copy, so that what the script does to it does not reach the
 * page's state. */
export function createUserscriptUtil(store: Store): UserscriptUtil {
  const loaded = (): boolean => {
    const state = store.getState();
    return state.peersLoaded && state.agentsLoaded;
  };
  let ready: Promise<void> | null = null;
  const whenLoaded = (): Promise<void> => {
    ready ??= new Promise<void>((resolve) => {
      if (loaded()) {
        resolve();
        return;
      }
      const stop = store.subscribe(() => {
        if (!loaded()) return;
        stop();
        resolve();
      });
    });
    return ready;
  };
  return Object.freeze({
    async session(sid: string): Promise<UserscriptSession | null> {
      await whenLoaded();
      const state = store.getState();
      const peer = state.peers.find((p) => p.sid === sid) ?? null;
      const agent = state.agents.find((a) => a.sessionId === sid) ?? null;
      if (peer === null && agent === null) return null;
      return structuredClone({ sid, peer, agent });
    },
  });
}

/** The module the userscript's JavaScript is, as far as the page calls it. */
const UserscriptModuleSchema = v.object({ userscript: v.function() });

/** The script's `userscript`, which the page calls with `util`. */
export type UserscriptFunction = v.InferOutput<typeof UserscriptModuleSchema>["userscript"];

/** Import `js` as a module from a `blob:` URL and take its `userscript`
 * (DR-0057 §4). Rejects when the module does not load (its top level threw,
 * an import failed) or has no function of that name. */
export async function importUserscript(js: string): Promise<UserscriptFunction> {
  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  try {
    const loaded: unknown = await import(url);
    // Read with valibot itself, not parseWith: parseWith's output is data
    // made read-only all the way down, which would take the call signature
    // off the function this reads.
    const module = v.safeParse(UserscriptModuleSchema, loaded);
    if (!module.success) throw new Error("`userscript` が関数として export されていない");
    return module.output.userscript;
  } finally {
    // The module is evaluated once imported; nothing loads it by this URL
    // again.
    URL.revokeObjectURL(url);
  }
}

export interface UserscriptRunDeps {
  load(): Promise<ReplyOf<"userscript_load">>;
  importUserscript(js: string): Promise<UserscriptFunction>;
  util: UserscriptUtil;
}

/** What came of running the userscript once. */
export type UserscriptRun =
  | { kind: "ran" }
  | { kind: "none" }
  | { kind: "failed"; message: string };

function messageOf(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Load the userscript and run it (DR-0057 §4). Never rejects: a failure of
 * any step is the run's outcome. */
export async function runUserscript(deps: UserscriptRunDeps): Promise<UserscriptRun> {
  let reply: ReplyOf<"userscript_load">;
  try {
    reply = await deps.load();
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  if (!reply.ok) return { kind: "failed", message: reply.error.msg };
  if (reply.js === undefined) return { kind: "none" };
  try {
    const userscript = await deps.importUserscript(reply.js);
    await userscript(deps.util);
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  return { kind: "ran" };
}

/** Run the userscript once, as the page starts (main.tsx). `search` is the
 * page's `location.search`: a `?userscript=` in it is written to this
 * browser's switch first, so `on` runs it on this very page and `off` keeps
 * this page from it. Then, when the switch is on, it runs once the first
 * connection has said a script is saved. A failure goes to the console and
 * to the page's notice. */
export function startUserscript(
  store: Store,
  deps: Omit<UserscriptRunDeps, "util">,
  search: string,
): void {
  const asked = deviceSwitchFromQuery(search);
  if (asked !== null) setDeviceEnabled(store, asked);
  else store.dispatch({ type: "userscript/device", enabled: readDeviceEnabled() });
  if (!store.getState().userscript.deviceEnabled) return;
  const begin = (saved: boolean): void => {
    if (!saved) return;
    void runUserscript({ ...deps, util: createUserscriptUtil(store) }).then((run) => {
      if (run.kind !== "failed") return;
      console.error(`ccmsg userscript: ${run.message}`);
      store.dispatch({ type: "userscript/failure", message: run.message });
    });
  };
  const known = store.getState().userscript.saved;
  if (known !== null) {
    begin(known);
    return;
  }
  const stop = store.subscribe(() => {
    const saved = store.getState().userscript.saved;
    if (saved === null) return;
    stop();
    begin(saved);
  });
}
