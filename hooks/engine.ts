// The part of Claude Code's engine the hooks module talks to, and the shape
// of its hooks.
import * as v from "valibot";
import type { CcmsgToolName } from "@ccmsg/protocol/peer-tools";

/** A piece of a spawned child's output. */
export interface SpawnChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/** How a spawned child ended; undefined when the module ended the stream
 * itself (`return(undefined)`). */
export type SpawnEnd = { code: number | null; signal: string | null } | undefined;

/** The part of the engine interface this module uses, as the engine's
 * `claude-code.d.ts` states it. Declared here rather than imported from
 * `claude-code`, whose types exist only where the engine lays them beside a
 * loaded mod. */
export interface Engine {
  plugin: { root: string };
  session: {
    id(): Promise<string>;
    /** The session's project root, absolute: where it started, or where `/cd`
     * took it; a shell `cd` does not move it. */
    root(): Promise<string>;
    surfaces(): Promise<readonly string[]>;
    /** The model as `/model` names it, a launch-time `[1m]` kept. */
    model(): Promise<string>;
    usage(): Promise<{ context: { window: number; tokens?: number } }>;
    append(args: {
      message: { type: "user"; content: readonly { type: "text"; text: string }[] };
      /** The running subagent whose conversation the row joins; absent for
       * the main one. */
      agentId?: string;
    }): Promise<unknown>;
  };
  turn: {
    /** Stop the main loop's running turn, its tools with it, leaving no
     * interruption marker. `turnId` is the id the main loop's turn.start
     * carried; the engine rejects any other, naming both. */
    abort(input: { turnId: string }): Promise<void>;
  };
  agent: {
    /** The session's subagents and teammates, `status` where each loop stands. */
    list(): Promise<readonly { id: string; description: string; type: string; status: string }[]>;
  };
  /** This plugin's key-value store, kept on disk under the config dir across
   * sessions, resumes and reloads. A value read back is outside data. */
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: object): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  prompt: {
    read(): Promise<{ text: string; cursor: number }>;
    fill(input: {
      text: string;
      mode?: "replace" | "append" | "insert";
    }): Promise<{ isFilled: boolean; refusal?: "no_composer" | "dialog"; text: string }>;
  };
  process: {
    run(
      argv: readonly string[],
      init?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    spawn(request: { argv: readonly string[] }): AsyncGenerator<SpawnChunk, SpawnEnd>;
  };
  tool: {
    register(spec: {
      name: string;
      description: string;
      inputSchema: object;
      isDeferred: boolean;
    }): Promise<void>;
  };
  env: { get(name: string): Promise<string | undefined> };
  clock: {
    now(): Promise<number>;
    after(ms: number, fn: () => void): { cancel(): void };
  };
  ui: { log(text: string, options?: { to?: "debug" }): void };
}

/** The events this module observes and passes on. */
export type ObservedEvent =
  | "session.start"
  | "session.end"
  | "session.measure"
  | "session.compact"
  | "command.run"
  | "prompt.submit"
  | "turn.start"
  | "turn.complete";

/** The events this module hooks. */
export type HookedEvent = ObservedEvent | "turn.step" | "tool.call";

/** A hook: generic in the event's input and in its result, so all it can do
 * with either is read the input through a schema and pass both on as
 * received. */
export type Hook = <E, R>($: Engine, e: E, next: (e: E) => Promise<R>) => Promise<R>;
/** What a tool of this module answers its call with: the text the model
 * reads. */
export interface ToolAnswer {
  result: string;
}
/** A tool.call hook: it answers the call itself, without `next`. */
export type ToolHook = <E, R>(
  $: Engine,
  e: E,
  next: (e: E) => Promise<R>,
) => Promise<R | ToolAnswer>;
/** The turn.step hook: a streaming event, so the hook is a generator that
 * passes the stream beneath on as it comes (`yield* next(e)`). */
export type StepHook = <E, Y, R>(
  $: Engine,
  e: E,
  next: (e: E) => AsyncGenerator<Y, R>,
) => AsyncGenerator<Y, R>;
/** The hook each event takes. */
export interface HookOf extends Record<ObservedEvent, Hook> {
  "turn.step": StepHook;
  "tool.call": ToolHook;
}
/** The tools this module registers, as the model calls them: the plugin's
 * name is their prefix (plugin.json). */
export type ToolName = CcmsgToolName;

/** What `on` takes after the event: the hook, and for tool.call first the
 * tool it answers (a matcher, as the engine reads it: a partial form of the
 * call). */
export type HookArgs = {
  [K in HookedEvent]: K extends "tool.call"
    ? [matcher: { tool: ToolName }, hook: HookOf[K]]
    : [hook: HookOf[K]];
};
/** `on(event, hook)`, `on("tool.call", { tool }, hook)`. Registrations nest in the
 * order they are made, the first outermost; the engine refuses a module that
 * registers one event twice without a matcher. What it returns has one
 * `.catch`, run in the hook's place when the hook throws or overruns its
 * budget. The engine's `next` there is replay-safe: after the hook called it,
 * it answers what that call settled to and runs nothing beneath again. */
export type On = <K extends HookedEvent>(
  event: K,
  ...args: HookArgs[K]
) => { catch(handler: HookOf[K]): void };

/** command.run's input, as far as the module reads it (DR-0038 §1): the
 * command, without its slash. */
export const CommandRunInputSchema = v.looseObject({ command: v.optional(v.string()) });

/** An input this hook reads no field of: only that it is an object. */
export const AnyInputSchema = v.looseObject({});
