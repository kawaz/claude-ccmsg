// The hooks module of DR-0035 against a stand-in engine: what it does to the
// composer, what it runs, and what it replies, for each request and each way a
// prompt.send can go. What a request line must be to run, and which code
// refuses it, is the protocol's (packages/protocol/test/sidecar.test.ts); here
// it is how the module answers.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { errorText, jsonText, parseWith } from "@ccmsg/protocol/parse";
import { CCMSG_TOOLS } from "@ccmsg/protocol/peer-tools";
import {
  type DescribeResult,
  type SessionFacts,
  SessionFactsTextSchema,
  SIDECAR_OP_NAMES,
  type SidecarReply,
  SidecarReplyTextSchema,
  SidecarRunIdSchema,
} from "@ccmsg/protocol/sidecar";
import { concern, fanOut } from "./bus.ts";
import { type ModuleState, register } from "./register.ts";
import {
  AnyInputSchema,
  type Engine,
  type HookArgs,
  type HookedEvent,
  type HookOf,
  type ObservedEvent,
  type On,
  type SpawnChunk,
  type SpawnEnd,
  type ToolAnswer,
  type ToolName,
} from "./engine.ts";
import { GUIDANCE, guidanceText, GUIDED_TTL_MS } from "./guidance.ts";
import {
  ACCEPT_WAIT_MS,
  handlePromptSend,
  hyouiEnterArgv,
  PromptSubmitInputSchema,
  type QueuedSend,
  samePrompt,
} from "./prompt-send.ts";
import { beginArgv } from "./session-lifecycle.ts";
import { answer, lineSplitter, replyArgv, RESPAWN_MIN_MS } from "./sidecar.ts";
import { agentMessage } from "./subagents.ts";
import { LAUNCH_TIMEOUT_MS, PERMIT_TIMEOUT_MS, SEND_TIMEOUT_MS } from "./tools.ts";
import {
  LAUNCH_KILL_GRACE_MS,
  LAUNCH_PIPE_DRAIN_GRACE_MS,
  LAUNCH_TIMEOUT_SECONDS_MAX,
} from "@ccmsg/protocol/launch";
import { SPAWN_RETRY_DELAYS_MS } from "../packages/cli/src/client.ts";

const START = { cwd: "/w", isInteractive: true, surface: "terminal" };
/** A command.run as the engine raises it for `/<command>`. */
function command(name: string) {
  return { command: name, args: "", origin: { kind: "composer" } };
}
/** A prompt.submit of `text` from the person's Enter. */
function submitted(text: string) {
  return { text, wait: false, origin: { kind: "composer" } };
}
/** What a prompt.submit's `next` settles on when the prompt entered. */
async function entered(e: { text: string }) {
  return { text: e.text };
}

interface Timer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

/** A spawn stream the test feeds and ends. */
function controlledStream() {
  const queue: SpawnChunk[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const returned = { value: false };
  const gen = (async function* (): AsyncGenerator<SpawnChunk, SpawnEnd> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (ended) return { code: 0, signal: null };
      await new Promise<void>((resolve) => (wake = resolve));
    }
  })();
  const originalReturn = gen.return.bind(gen);
  gen.return = (value) => {
    returned.value = true;
    ended = true;
    wake?.();
    return originalReturn(value);
  };
  return {
    gen,
    returned,
    push(text: string) {
      queue.push({ stream: "stdout", text });
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

/** What the module registered on each event, in order: the arguments after
 * the event (the hook, and for tool.call the tool first). */
type HookTable = { [K in HookedEvent]: HookArgs[K][] };
/** The `.catch` handler of each registration, by event, in the same order. */
type CatchTable = { [K in HookedEvent]: HookOf[K][] };

/** A table with no registration on any event. */
function emptyTable(): HookTable & CatchTable {
  return {
    "session.start": [],
    "session.end": [],
    "session.measure": [],
    "session.compact": [],
    "command.run": [],
    "prompt.submit": [],
    "turn.start": [],
    "turn.complete": [],
    "turn.step": [],
    "tool.call": [],
  };
}
/** What a ccmsg command the module runs answers. */
type CommandRun = { exitCode: number; stdout: string; stderr: string };

interface Fake {
  $: Engine;
  composer: { text: string };
  /** What the session says of itself through `$.session`. */
  session: { model: string; window: number; root: string };
  /** The facts each `ccmsg sidecar facts` was given, with the sid it named,
   * in order. Kept apart from `runs`: they go with every session event, and
   * what a test of the other commands runs is told without them. */
  factsSent: { sid: string; facts: SessionFacts }[];
  /** Each `ccmsg sidecar begin` the module ran, with the sid and the cwd it
   * named, in order. Kept apart from `runs` as the facts are. */
  begins: { sid: string; cwd: string }[];
  /** The commands the module ran other than `ccmsg sidecar facts`,
   * `ccmsg sidecar begin` and `ccmsg status`. */
  runs: string[][];
  /** How many times the module ran `ccmsg status`. Kept apart from `runs` as
   * the facts are: it goes with the guidance, before a prompt. */
  statuses: { count: number };
  /** The runs that asked the harness pid. */
  /** What each run got on standard input, by the index of the run. */
  stdins: (string | undefined)[];
  spawns: { argv: readonly string[]; stream: ReturnType<typeof controlledStream> }[];
  timers: Timer[];
  hooks: HookTable;
  /** The events the module hooked, in the order it hooked them. */
  registered: HookedEvent[];
  catchers: CatchTable;
  /** The text of each row the module appended to the main conversation. */
  appended: string[];
  /** Each row the module appended to a subagent's conversation. */
  agentAppends: { agentId: string; text: string }[];
  /** The session's subagents as `$.agent.list()` says; a running one's
   * conversation takes an append, any other id is refused as Claude Code
   * refuses it. */
  agents: { id: string; description: string; type: string; status: string }[];
  /** This plugin's `$.store`, which outlives the process: a session resumed
   * in another process is given the same one. */
  store: Map<string, unknown>;
  /** The tools the module registered (`$.tool.register`), in order. */
  tools: { name: string; description: string; inputSchema: object; isDeferred: boolean }[];
  sid: { value: string };
  fills: string[];
  logs: string[];
}

/** The value given after `flag` in a sidecar's argv. */
function flagOf(argv: readonly string[], flag: string): string {
  const at = argv.indexOf(flag);
  const value = at < 0 ? undefined : argv[at + 1];
  if (value === undefined) throw new Error(`no ${flag} in ${argv.join(" ")}`);
  return value;
}

/** An engine whose composer, environment and clock the test holds. `onEnter`
 * stands for what the terminal does with the Enter key. */
function fakeEngine(
  options: {
    draft?: string;
    env?: Record<string, string>;
    refusal?: "dialog" | "no_composer";
    surfaces?: readonly string[];
    onEnter?: (fake: Fake) => Promise<number>;
    /** What `ccmsg version` does: print this, or throw. */
    version?: string | Error;
    /** What the ccmsg command a tool runs (`sidecar send-message`, `sidecar
     * peer-list`, `sidecar launch`, `sidecar permit`, `say`) does, given its argv and what it
     * was run with. */
    command?: (
      argv: readonly string[],
      init: { stdin?: string; timeoutMs?: number; env?: Record<string, string> },
    ) => Promise<CommandRun>;
    /** The plugin's store as an earlier process left it. */
    store?: Map<string, unknown>;
    /** What `ccmsg status` does: print a running daemon's status with this
     * `webui_url` (none when undefined), or throw. */
    webuiUrl?: string | Error;
  } = {},
): Fake {
  // HYOUI_NAMESPACE is still exported by environments set up for older hyoui;
  // the default env carries it so every Enter below shows it is not passed on.
  const env: Record<string, string | undefined> = options.env ?? {
    HYOUI_SESSION_ID: "term-1",
    HYOUI_NAMESPACE: "ns-1",
  };
  let now = 0;
  const composer = { text: options.draft ?? "" };
  const runs: string[][] = [];
  const statuses = { count: 0 };
  const stdins: (string | undefined)[] = [];
  const spawns: Fake["spawns"] = [];
  const timers: Timer[] = [];
  const sid = { value: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  const session = { model: "claude-opus-5-5[1m]", window: 1_000_000, root: "/w" };
  const factsSent: Fake["factsSent"] = [];
  const begins: Fake["begins"] = [];
  const fills: string[] = [];
  const logs: string[] = [];
  const tools: Fake["tools"] = [];
  const appended: string[] = [];
  const agentAppends: Fake["agentAppends"] = [];
  const agents: Fake["agents"] = [];
  const store = options.store ?? new Map<string, unknown>();
  const $: Engine = {
    plugin: { root: "/plugin" },
    session: {
      id: async () => sid.value,
      root: async () => session.root,
      surfaces: async () => options.surfaces ?? ["terminal"],
      model: async () => session.model,
      usage: async () => ({ context: { window: session.window } }),
      append: async ({ message, agentId }) => {
        const text = message.content.map((block) => block.text).join("");
        if (agentId === undefined) {
          appended.push(text);
          return {};
        }
        if (!agents.some((a) => a.id === agentId && a.status === "running")) {
          throw new Error(`HooksError: $.session.append: refused: no running loop is ${agentId}`);
        }
        agentAppends.push({ agentId, text });
        return {};
      },
    },
    agent: { list: async () => agents.map((a) => ({ ...a })) },
    store: {
      // What is stored is read back as a copy, as the engine's store does.
      get: async (key) => structuredClone(store.get(key)),
      set: async (key, value) => {
        store.set(key, structuredClone(value));
      },
      delete: async (key) => {
        store.delete(key);
      },
      keys: async () => [...store.keys()],
    },
    prompt: {
      read: async () => ({ text: composer.text, cursor: composer.text.length }),
      fill: async ({ text }) => {
        if (options.refusal) {
          return { isFilled: false, refusal: options.refusal, text: composer.text };
        }
        fills.push(text);
        composer.text = text;
        return { isFilled: true, text };
      },
    },
    process: {
      run: async (argv, init) => {
        if (argv[1] === "sidecar" && argv[2] === "facts") {
          const read = parseWith(SessionFactsTextSchema, init?.stdin ?? "");
          if (!read.ok) throw new Error(`facts not readable: ${read.failure.summary}`);
          factsSent.push({ sid: flagOf(argv, "--sid"), facts: read.value });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (argv[1] === "sidecar" && argv[2] === "begin") {
          begins.push({ sid: flagOf(argv, "--sid"), cwd: flagOf(argv, "--cwd") });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (argv[1] === "status") {
          statuses.count += 1;
          const url = options.webuiUrl;
          if (url instanceof Error) throw url;
          const status = { running: true, ok: true, pong: true, http: ["127.0.0.1:8642"] };
          return {
            exitCode: 0,
            stdout: `${JSON.stringify(url === undefined ? status : { ...status, webui_url: url })}\n`,
            stderr: "",
          };
        }
        runs.push([...argv]);
        stdins.push(init?.stdin);
        if (argv[0] === "hyoui") {
          const exitCode = options.onEnter ? await options.onEnter(fake) : 0;
          return { exitCode, stdout: "", stderr: "" };
        }
        if (
          argv[1] === "say" ||
          argv[2] === "send-message" ||
          argv[2] === "peer-list" ||
          argv[2] === "launch" ||
          argv[2] === "permit"
        ) {
          if (options.command === undefined) throw new Error(`no ${argv.join(" ")} here`);
          return options.command(argv, init ?? {});
        }
        if (argv.at(-1) === "version") {
          const version = options.version ?? "9.9.9";
          if (version instanceof Error) throw version;
          return { exitCode: 0, stdout: `${version}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: ({ argv }) => {
        const stream = controlledStream();
        spawns.push({ argv, stream });
        return stream.gen;
      },
    },
    tool: {
      register: async (spec) => {
        tools.push(spec);
      },
    },
    env: { get: async (name) => env[name] },
    clock: {
      now: async () => (now += 1),
      after: (ms, fn) => {
        const timer = { ms, fn, cancelled: false };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
    ui: {
      log: (text) => {
        logs.push(text);
      },
    },
  };
  const fake: Fake = {
    $,
    composer,
    session,
    factsSent,
    begins,
    runs,
    statuses,
    stdins,
    spawns,
    timers,
    hooks: emptyTable(),
    registered: [],
    sid,
    fills,
    logs,
    catchers: emptyTable(),
    tools,
    appended,
    agentAppends,
    agents,
    store,
  };
  return fake;
}

/** A matcher as a schema of the inputs it matches, read as the engine reads
 * a matcher: a leaf by `===` or a RegExp, an array as any of its values, an
 * object as a partial form of the input. */
/** Run the module's hook on `event` as the engine would: when the hook
 * throws, its `.catch` handler runs in its place with a replay-safe `next`,
 * which answers what the hook's own call settled to and runs nothing beneath
 * again (the engine's `Caught`). */
async function fire<E, R>(
  fake: Fake,
  event: ObservedEvent,
  e: E,
  next: (e: E) => Promise<R>,
): Promise<R> {
  return fireOne(fake, event, 0, e, next);
}

/** Run the `at`th hook registered on `event` over `next`. */
async function fireOne<E, R>(
  fake: Fake,
  event: ObservedEvent,
  at: number,
  e: E,
  next: (e: E) => Promise<R>,
): Promise<R> {
  const registered: HookArgs[ObservedEvent][] = fake.hooks[event];
  const hook = registered[at]?.[0];
  if (hook === undefined) throw new Error(`no hook #${at} on ${event}`);
  const once = replaySafe(next);
  try {
    return await hook(fake.$, e, once);
  } catch (error) {
    const handler = fake.catchers[event][at];
    if (handler === undefined) throw error;
    return handler(fake.$, e, once);
  }
}

/** Call the module's tool `tool` with input `e` as the engine would: the
 * hook answers without `next`, and when it throws its `.catch` answers. */
async function callTool<E>(fake: Fake, tool: ToolName, e: E): Promise<string> {
  const at = fake.hooks["tool.call"].findIndex(([matcher]) => matcher.tool === tool);
  const hook = fake.hooks["tool.call"][at]?.[1];
  if (hook === undefined) throw new Error(`no hook on ${tool}`);
  const next = async (): Promise<ToolAnswer> => {
    throw new Error(`${tool} ran next`);
  };
  try {
    return (await hook(fake.$, e, next)).result;
  } catch (error) {
    const handler = fake.catchers["tool.call"][at];
    if (handler === undefined) throw error;
    return (await handler(fake.$, e, next)).result;
  }
}

/** A `next` that runs what is beneath once and answers that call's result
 * to every later call. */
function replaySafe<E, R>(next: (e: E) => Promise<R>): (e: E) => Promise<R> {
  let called: Promise<R> | undefined;
  return (input) => {
    called ??= next(input);
    return called;
  };
}

/** Run the module's turn.step hook over a request whose stream beneath yields
 * `chunks` and ends on `result`, and take what the hook passed on. A hook
 * that throws before passing anything on is replaced by its `.catch`, as the
 * engine does. */
async function fireStep<E, Y, R>(
  fake: Fake,
  e: E,
  chunks: readonly Y[],
  result: R,
): Promise<{ chunks: Y[]; result: R }> {
  const hook = fake.hooks["turn.step"][0]?.[0];
  if (hook === undefined) throw new Error("no hook on turn.step");
  const beneath = async function* (_e: E): AsyncGenerator<Y, R> {
    for (const chunk of chunks) yield chunk;
    return result;
  };
  const drain = async (stream: AsyncGenerator<Y, R>) => {
    const passed: Y[] = [];
    for (;;) {
      const step = await stream.next();
      if (step.done === true) return { chunks: passed, result: step.value };
      passed.push(step.value);
    }
  };
  try {
    return await drain(hook(fake.$, e, beneath));
  } catch (error) {
    const handler = fake.catchers["turn.step"][0];
    if (handler === undefined) throw error;
    return drain(handler(fake.$, e, beneath));
  }
}

/** The `index`th sidecar the module spawned. */
function spawned(fake: Fake, index: number): Fake["spawns"][number] {
  const spawn = fake.spawns[index];
  if (spawn === undefined) throw new Error(`no spawn #${index}`);
  return spawn;
}

function lastTimer(fake: Fake): Timer {
  const timer = fake.timers.at(-1);
  if (timer === undefined) throw new Error("no timer");
  return timer;
}

/** What the `index`th run got on standard input, read as a reply. */
function stdinReply(fake: Fake, index: number): SidecarReply {
  const stdin = fake.stdins[index];
  if (stdin === undefined) throw new Error(`run #${index} got no standard input`);
  const read = parseWith(SidecarReplyTextSchema, stdin);
  if (!read.ok) throw new Error(`run #${index} got no reply: ${read.failure.summary}`);
  return read.value;
}

/** What the harness does on Enter with text in the composer: prompt.submit
 * through the module's hook, the prompt entering beneath it (the composer
 * clears). */
async function submitComposer(fake: Fake): Promise<number> {
  const text = fake.composer.text;
  await fire(fake, "prompt.submit", submitted(text), async (e) => {
    fake.composer.text = "";
    return entered(e);
  });
  return 0;
}

function registerOn(fake: Fake): ModuleState {
  const on: On = (event, ...args) => {
    const held: HookArgs[typeof event][] = fake.hooks[event];
    held.push(args);
    fake.registered.push(event);
    return {
      catch: (handler) => {
        const caught: HookOf[typeof event][] = fake.catchers[event];
        caught.push(handler);
      },
    };
  };
  return register(on);
}

/** A prompt.send as the module queues it, for the session as it is now. */
function queued(fake: Fake, state: ModuleState, text: string): QueuedSend {
  state.sid ??= fake.sid.value;
  return { id: "r1", text, sid: fake.sid.value, generation: state.generation };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fire the accept-wait timer once handlePromptSend has set it. */
async function expireAcceptWait(fake: Fake): Promise<void> {
  for (;;) {
    const timer = fake.timers.find((t) => t.ms === ACCEPT_WAIT_MS && !t.cancelled);
    if (timer !== undefined) {
      timer.fn();
      return;
    }
    await settle();
  }
}

describe("handlePromptSend", () => {
  test("accepted: Enter on its own terminal, then the draft goes back", async () => {
    const fake = fakeEngine({ draft: "half typed 書きかけ", onEnter: submitComposer });
    const state = registerOn(fake);
    const report = await handlePromptSend(fake.$, state, queued(fake, state, "from the web"));
    expect(report).toEqual({ outcome: "accepted" });
    expect(fake.runs).toEqual([["hyoui", "input", "term-1", "key:Enter"]]);
    expect(fake.composer.text).toBe("half typed 書きかけ");
    expect(state.awaiting).toBeUndefined();
    expect(state.restoring).toBeUndefined();
  });

  test("accepted with an empty composer leaves it empty", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "hi"))).toEqual({
      outcome: "accepted",
    });
    expect(fake.composer.text).toBe("");
    expect(fake.fills).toEqual(["hi"]);
  });

  test("no hyoui terminal: no_terminal, and the composer is never touched", async () => {
    const fake = fakeEngine({ draft: "keep", env: {} });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "not_delivered",
      reason: "no_terminal",
    });
    expect(fake.fills).toEqual([]);
    expect(fake.runs).toEqual([]);
  });

  test("a dialog refuses the fill: no Enter, the reason is reported", async () => {
    const fake = fakeEngine({ draft: "keep", refusal: "dialog" });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "not_delivered",
      reason: "dialog",
    });
    expect(fake.runs).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  test("Enter that submits nothing: not_submitted, the draft goes back", async () => {
    const fake = fakeEngine({ draft: "keep" });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "not_submitted" });
    expect(fake.composer.text).toBe("keep");
  });

  // Enter submitted nothing, and the put-back is refused: the text is still
  // in the composer, so nothing decisive can be said.
  test("Enter that submits nothing with a refused put-back: unconfirmed", async () => {
    const fake = fakeEngine({ draft: "keep" });
    const state = registerOn(fake);
    const prompt = fake.$.prompt;
    const fill = (input: Parameters<typeof prompt.fill>[0]) => prompt.fill(input);
    let fills = 0;
    fake.$.prompt = { ...prompt };
    fake.$.prompt.fill = async (input) =>
      ++fills === 1 ? fill(input) : { isFilled: false, refusal: "dialog", text: "x" };
    const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "unconfirmed" });
    expect(fake.composer.text).toBe("x");
  });

  test("hyoui failing with the text still in the composer: enter_failed", async () => {
    const fake = fakeEngine({ draft: "keep", onEnter: async () => 1 });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "enter_failed" });
    expect(fake.composer.text).toBe("keep");
  });

  // The composer moved on with no submit of the text: nothing decisive to say.
  test("the composer emptied with no submit of the text: unconfirmed", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        f.composer.text = "";
        return 0;
      },
    });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "unconfirmed" });
  });

  // The submit went through beneath the module's hook: the prompt entered the
  // session, or was queued behind the running turn (typed while busy, with
  // the running turn's id), DR-0039 §2.
  test("accepted while a turn runs: the submit was queued behind it", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        await fire(f, "prompt.submit", { ...submitted(f.composer.text), turnId: "t1" }, entered);
        f.composer.text = "";
        return 0;
      },
    });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "accepted",
    });
  });

  // A submit that settles on a drop did not enter; the text stays in the
  // composer and is taken back out.
  test("a dropped submit is not acceptance: not_submitted, the draft goes back", async () => {
    const fake = fakeEngine({
      draft: "keep",
      onEnter: async (f) => {
        await fire(f, "prompt.submit", submitted(f.composer.text), async () => ({ drop: "no" }));
        return 0;
      },
    });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "not_submitted" });
    expect(fake.composer.text).toBe("keep");
  });

  // The same text arriving from elsewhere (a peer's message, a plugin) is not
  // the person's Enter on the filled composer.
  test("a submit of the same text not from the composer is not acceptance", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        const peer = { ...submitted(f.composer.text), origin: { kind: "peer" } };
        await fire(f, "prompt.submit", peer, entered);
        return 0;
      },
    });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "not_submitted" });
  });

  test("a prompt.submit of other text does not put the draft back", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.restoring = { text: "mine", draft: "draft" };
    await fire(
      fake,
      "prompt.submit",
      { text: "someone else's", origin: { kind: "composer" } },
      async () => ({}),
    );
    expect(fake.fills).toEqual([]);
    expect(state.restoring).toEqual({ text: "mine", draft: "draft" });
  });
});

// The session's state file and the daemon come from `ccmsg sidecar begin`,
// run when the session starts and when it changes its id (DR-0039 §2).
describe("ccmsg sidecar begin", () => {
  test("session.start begins the session under its id, in its project root", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    fake.session.root = "/project";
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    expect(fake.begins).toEqual([{ sid: fake.sid.value, cwd: "/project" }]);
    expect(beginArgv("/p", "s", "/w")).toEqual([
      "/p/bin/ccmsg",
      "sidecar",
      "begin",
      "--sid",
      "s",
      "--cwd",
      "/w",
    ]);
  });

  // A session with no composer still has a state file and a daemon, as the
  // daemon shows it; it only has no sidecar.
  test("a session with no composer begins too", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", { ...START, isInteractive: false, surface: null }, () =>
      Promise.resolve({}),
    );
    await settle();
    expect(fake.begins.length).toBe(1);
    expect(fake.spawns).toEqual([]);
  });

  for (const name of ["clear", "resume"]) {
    test(`/${name} begins the session under its new id`, async () => {
      const fake = fakeEngine();
      registerOn(fake);
      await fire(fake, "session.start", START, async () => ({}));
      await fire(fake, "command.run", command(name), async () => {
        fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        return {};
      });
      await settle();
      expect(fake.begins.map((b) => b.sid)).toEqual([
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ]);
    });
  }

  test("other commands begin nothing", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    for (const name of ["model", "compact", "help"]) {
      await fire(fake, "command.run", command(name), async () => ({}));
    }
    await settle();
    expect(fake.begins).toEqual([]);
  });

  // Not awaited by the hook, so a begin that fails is only logged.
  test("a begin that fails is logged, and session.start settles regardless", async () => {
    const fake = fakeEngine();
    const process = fake.$.process;
    fake.$.process = {
      ...process,
      run: async (argv, init) => {
        if (argv[2] === "begin") return { exitCode: 1, stdout: "", stderr: "no daemon\n" };
        return process.run(argv, init);
      },
    };
    registerOn(fake);
    expect(await fire(fake, "session.start", START, async () => ({ cwd: "/w" }))).toEqual({
      cwd: "/w",
    });
    await settle();
    expect(fake.logs).toContain("ccmsg: begin exited 1: no daemon");
  });
});

describe("the sidecar the module keeps", () => {
  test("session.start spawns it; a prompt.send line becomes a fill and a reply", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    const argv = spawned(fake, 0).argv;
    expect(argv).toEqual([
      "/plugin/bin/ccmsg",
      "sidecar",
      "--sid",
      fake.sid.value,
      "--run",
      flagOf(argv, "--run"),
      "--started-at",
      flagOf(argv, "--started-at"),
      "--hyoui-session-id",
      "term-1",
    ]);
    // A time off the module's clock: epoch milliseconds.
    expect(Number.isSafeInteger(Number(flagOf(argv, "--started-at")))).toBe(true);
    spawned(fake, 0).stream.push('{"v":1,"op":"prompt.send","id":"r9",');
    spawned(fake, 0).stream.push('"args":{"text":"hello"}}\n');
    for (let i = 0; i < 10 && fake.runs.length < 2; i++) await settle();
    expect(fake.runs).toEqual([
      ["hyoui", "input", "term-1", "key:Enter"],
      ["/plugin/bin/ccmsg", "sidecar", "reply", "--sid", fake.sid.value],
    ]);
    expect(stdinReply(fake, 1)).toEqual({
      id: "r9",
      ok: true,
      result: { outcome: "accepted" },
    });
  });

  // The sidecar names the run to the daemon with what the module itself
  // knows — the session's environment as `$.env.get` reads it, and when the
  // module was loaded — and nothing it would have to ask a child for: a
  // sandboxed session cannot run `ps`, and the daemon finds the pid itself.
  test("the sidecar is told the run, the config dir and the terminal, and no pid", async () => {
    const fake = fakeEngine({
      env: { CLAUDE_CONFIG_DIR: "/h/.claude-a", HYOUI_SESSION_ID: "term-1" },
    });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    const argv = spawned(fake, 0).argv;
    expect(flagOf(argv, "--config-dir")).toBe("/h/.claude-a");
    expect(flagOf(argv, "--hyoui-session-id")).toBe("term-1");
    expect(argv).not.toContain("--pid");
    expect(parseWith(SidecarRunIdSchema, flagOf(argv, "--run")).ok).toBe(true);
    expect(fake.runs).toEqual([]);
  });

  test("outside hyoui and without a config dir, neither is named", async () => {
    const fake = fakeEngine({ env: {} });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    const argv = spawned(fake, 0).argv;
    expect(argv).not.toContain("--config-dir");
    expect(argv).not.toContain("--hyoui-session-id");
  });

  // One run, one id, for the module's whole load: a sidecar started again
  // and a sidecar under a new session id (/clear) name the same run, which is
  // how the daemon tells a session that changed its id from one that never
  // had a module.
  test("the run id and start stay the same across sidecars and session ids", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    spawned(fake, 0).stream.end();
    await settle();
    lastTimer(fake).fn();
    await settle();
    fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await fire(fake, "command.run", command("clear"), async () => ({}));
    await settle();
    expect(fake.spawns.length).toBe(3);
    const runs = fake.spawns.map((s) => [flagOf(s.argv, "--run"), flagOf(s.argv, "--started-at")]);
    expect(new Set(runs.map((r) => r.join(" "))).size).toBe(1);
    expect(fake.spawns.map((s) => flagOf(s.argv, "--sid"))).toEqual([
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]);
  });

  test("another load of the module is another run", async () => {
    const one = fakeEngine();
    registerOn(one);
    await fire(one, "session.start", START, async () => ({}));
    const two = fakeEngine();
    registerOn(two);
    await fire(two, "session.start", START, async () => ({}));
    await settle();
    expect(flagOf(spawned(one, 0).argv, "--run")).not.toBe(flagOf(spawned(two, 0).argv, "--run"));
  });

  // session.start runs again on a reload of the session's modules; under the
  // same id the sidecar it has is kept.
  test("session.start twice under one id keeps one sidecar", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await Promise.all([
      fire(fake, "session.start", START, async () => ({})),
      fire(fake, "session.start", START, async () => ({})),
    ]);
    await settle();
    expect(fake.spawns.length).toBe(1);
  });

  test("a sidecar that ends is started again after a delay", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    spawned(fake, 0).stream.end();
    await settle();
    expect(fake.spawns.length).toBe(1);
    const respawn = lastTimer(fake);
    expect(respawn.ms).toBe(RESPAWN_MIN_MS);
    respawn.fn();
    await settle();
    expect(fake.spawns.length).toBe(2);
    // Dying young again doubles the wait.
    spawned(fake, 1).stream.end();
    await settle();
    expect(lastTimer(fake).ms).toBe(RESPAWN_MIN_MS * 2);
  });

  // command.run settles after the session moved to its new id (DR-0039 §2).
  for (const name of ["clear", "resume"]) {
    test(`a new session id (/${name}) replaces the sidecar`, async () => {
      const fake = fakeEngine();
      registerOn(fake);
      await fire(fake, "session.start", START, async () => ({}));
      await settle();
      await fire(fake, "command.run", command(name), async () => {
        fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        return {};
      });
      await settle();
      expect(spawned(fake, 0).stream.returned.value).toBe(true);
      expect(fake.spawns.map((s) => flagOf(s.argv, "--sid"))).toEqual([
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ]);
      // The replaced sidecar's end is not answered with a respawn.
      expect(fake.timers).toEqual([]);
    });
  }

  test("another command keeps the sidecar", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    await fire(fake, "command.run", command("compact"), async () => ({}));
    await settle();
    expect(fake.spawns.length).toBe(1);
    expect(spawned(fake, 0).stream.returned.value).toBe(false);
  });
});

describe("sessions without a composer get no sidecar", () => {
  for (const [name, e] of [
    ["isInteractive false (-p)", { isInteractive: false, surface: null }],
    ["surface null", { isInteractive: true, surface: null }],
  ] as const) {
    test(`session.start with ${name}`, async () => {
      const fake = fakeEngine();
      registerOn(fake);
      await fire(fake, "session.start", e, async () => ({}));
      await fire(fake, "command.run", command("clear"), async () => ({}));
      await settle();
      expect(fake.spawns).toEqual([]);
    });
  }

  // After a reload the first event may be a command.run: the session itself
  // is asked whether it draws anywhere.
  test("/clear first, in a session that draws nowhere", async () => {
    const fake = fakeEngine({ surfaces: [] });
    registerOn(fake);
    await fire(fake, "command.run", command("clear"), async () => ({}));
    await settle();
    expect(fake.spawns).toEqual([]);
  });

  test("an interactive session.start does start one", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(
      fake,
      "session.start",
      { isInteractive: true, surface: "terminal" },
      async () => ({}),
    );
    await settle();
    expect(fake.spawns.length).toBe(1);
  });
});

describe("a session that changes its id (/clear)", () => {
  const NEW_SID = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  test("session.end(clear) moves on a generation", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    const before = state.generation;
    await fire(fake, "session.end", { reason: "other" }, async () => ({}));
    expect(state.generation).toBe(before);
    await fire(fake, "session.end", { reason: "clear" }, async () => ({}));
    expect(state.generation).toBe(before + 1);
  });

  // The id changed between the fill and Enter: no Enter, the draft goes
  // back: the text is known not to be in.
  test("a changed id before Enter keeps the text out", async () => {
    const fake = fakeEngine({ draft: "keep", onEnter: submitComposer });
    const state = registerOn(fake);
    const request = queued(fake, state, "for the old session");
    const prompt = fake.$.prompt;
    const fill = (input: Parameters<typeof prompt.fill>[0]) => prompt.fill(input);
    fake.$.prompt = { ...prompt };
    fake.$.prompt.fill = async (input) => {
      const filled = await fill(input);
      fake.sid.value = NEW_SID;
      return filled;
    };
    expect(await handlePromptSend(fake.$, state, request)).toEqual({
      outcome: "not_delivered",
      reason: "session_changed",
    });
    expect(fake.runs).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  // The put-back is refused (a dialog opened after the first fill): the text
  // stays in the composer, where a later Enter would send it, so the module
  // cannot say it was not delivered and the daemon must not try another run.
  test("a changed id with a refused put-back is unconfirmed, the text left in", async () => {
    const fake = fakeEngine({ draft: "keep", onEnter: submitComposer });
    const state = registerOn(fake);
    const request = queued(fake, state, "for the old session");
    const prompt = fake.$.prompt;
    const fill = (input: Parameters<typeof prompt.fill>[0]) => prompt.fill(input);
    let fills = 0;
    fake.$.prompt = { ...prompt };
    fake.$.prompt.fill = async (input) => {
      fills += 1;
      if (fills === 1) {
        const filled = await fill(input);
        fake.sid.value = NEW_SID;
        return filled;
      }
      return { isFilled: false, refusal: "dialog", text: fake.composer.text };
    };
    expect(await handlePromptSend(fake.$, state, request)).toEqual({ outcome: "unconfirmed" });
    expect(fake.runs).toEqual([]);
    expect(fake.composer.text).toBe("for the old session");
  });

  // Enter went out, then the session moved on before the event: whatever it
  // did is not this request's to claim.
  test("a new generation after Enter is unconfirmed", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        state.generation += 1;
        return submitComposer(f);
      },
    });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "unconfirmed",
    });
  });

  test("a prompt.send queued under the old id is not filled: session_changed", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    const oldSid = fake.sid.value;
    spawned(fake, 0).stream.push('{"v":1,"op":"prompt.send","id":"old","args":{"text":"late"}}\n');
    await fire(fake, "session.end", { reason: "clear" }, async () => ({}));
    for (let i = 0; i < 10 && fake.runs.length < 1; i++) await settle();
    expect(fake.fills).toEqual([]);
    expect(fake.runs).toEqual([["/plugin/bin/ccmsg", "sidecar", "reply", "--sid", oldSid]]);
    expect(stdinReply(fake, 0)).toEqual({
      id: "old",
      ok: true,
      result: { outcome: "not_delivered", reason: "session_changed" },
    });
  });
});

/** Start a sidecar, write `line` to the module, and return the reply it ran
 * `ccmsg sidecar reply` with. */
async function replyTo(fake: Fake, line: string): Promise<SidecarReply> {
  await fire(fake, "session.start", START, async () => ({}));
  await settle();
  spawned(fake, 0).stream.push(`${line}\n`);
  const isReply = (argv: string[]) => argv[2] === "reply";
  for (let i = 0; i < 20 && !fake.runs.some(isReply); i++) await settle();
  const at = fake.runs.findIndex(isReply);
  expect(at).toBeGreaterThanOrEqual(0);
  return stdinReply(fake, at);
}

describe("requests the module answers without running prompt.send", () => {
  test("a prompt.send that throws is internal", async () => {
    const fake = fakeEngine();
    fake.$.prompt = {
      ...fake.$.prompt,
      read: async () => {
        throw new Error("engine gone");
      },
    };
    registerOn(fake);
    const reply = await replyTo(fake, '{"v":1,"op":"prompt.send","id":"q4","args":{"text":"x"}}');
    expect(reply).toMatchObject({ id: "q4", ok: false, error: { code: "internal" } });
  });

  // A line that is not a request of this version, of an op the module runs,
  // with that op's args, is read no further: nothing runs, nothing is sent
  // back, and the line is logged.
  test("a line that is not a request this module runs is logged and not answered", async () => {
    const lines = [
      '{"v":1,"op":"describe","args":{}}',
      "not json",
      '{"v":1,"op":"prompt.peek","id":"q1","args":{}}',
      '{"v":2,"op":"prompt.send","id":"q2","args":{"text":"x"}}',
      '{"v":{"toString":null},"op":"describe","id":"q5","args":{}}',
      '{"v":1,"op":"prompt.send","id":"q3"}',
      '{"v":1,"op":"prompt.send","id":"q3","args":{"text":" \\n"}}',
      '{"v":1,"op":"describe","id":"d0","args":{"x":1}}',
      '{"v":1,"op":"describe","id":"d0","args":[]}',
    ];
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    spawned(fake, 0).stream.push(`${lines.join("\n")}\n`);
    await settle();
    expect(fake.runs).toEqual([]);
    expect(fake.fills).toEqual([]);
    expect(fake.logs.filter((l) => l.includes("not a request this module runs")).length).toBe(
      lines.length,
    );
  });

  test("a reply that cannot be sent is logged, and answering does not throw", async () => {
    const fake = fakeEngine();
    const process = fake.$.process;
    fake.$.process = {
      ...process,
      run: async (argv, init) => {
        if (argv[2] === "reply") throw new Error("spawn failed");
        return process.run(argv, init);
      },
    };
    const state = registerOn(fake);
    expect(
      await answer(fake.$, state, fake.sid.value, 0, '{"v":1,"op":"describe","id":"q6","args":{}}'),
    ).toBeUndefined();
    expect(
      fake.logs.some((l) => l.includes("reply q6 failed: ") && l.includes("spawn failed")),
    ).toBe(true);
  });

  test("describe lists the ops and the ccmsg version beside the module", async () => {
    const fake = fakeEngine({ version: "1.2.3" });
    registerOn(fake);
    const reply = await replyTo(fake, '{"v":1,"op":"describe","id":"d1","args":{}}');
    const result: DescribeResult = {
      v: [1],
      ops: ["describe", "prompt.send", "session.facts", "agent.append", "request.override"],
      version: "1.2.3",
    };
    expect(reply).toEqual({ id: "d1", ok: true, result });
    expect(fake.runs[0]).toEqual(["/plugin/bin/ccmsg", "version"]);
  });

  test("describe without a version when ccmsg cannot say", async () => {
    const fake = fakeEngine({ version: new Error("ENOENT") });
    registerOn(fake);
    const reply = await replyTo(fake, '{"v":1,"op":"describe","id":"d2","args":{}}');
    expect(reply).toEqual({ id: "d2", ok: true, result: { v: [1], ops: [...SIDECAR_OP_NAMES] } });
  });
});

/** A `next` that counts how often the event went on beneath the hook. */
function countingNext(result: object = {}) {
  const calls = { count: 0 };
  const next = async (): Promise<object> => {
    calls.count += 1;
    return result;
  };
  return { calls, next };
}

/** Settle until `count` facts have been sent. */
async function untilFacts(fake: Fake, count: number): Promise<void> {
  for (let i = 0; i < 20 && fake.factsSent.length < count; i++) await settle();
  expect(fake.factsSent.length).toBe(count);
}

/** The facts the latest `ccmsg sidecar facts` was given. */
function lastFacts(fake: Fake): SessionFacts {
  const sent = fake.factsSent.at(-1);
  if (sent === undefined) throw new Error("no facts sent");
  return sent.facts;
}

/** Settle until the latest facts sent satisfy `pred`. */
async function untilLastFacts(fake: Fake, pred: (facts: SessionFacts) => boolean): Promise<void> {
  const holds = () => {
    const sent = fake.factsSent.at(-1);
    return sent !== undefined && pred(sent.facts);
  };
  for (let i = 0; i < 20 && !holds(); i++) await settle();
  expect(holds()).toBe(true);
}

/** The facts the `index`th `ccmsg sidecar facts` was given. */
function factsAt(fake: Fake, index: number): { sid: string; facts: SessionFacts } {
  const sent = fake.factsSent[index];
  if (sent === undefined) throw new Error(`no facts #${index}`);
  return sent;
}

describe("the facts the module sends of its session (session.facts)", () => {
  // The window is Claude Code's own, so the daemon has the denominator from
  // the start (findings 2026-10-14-mods-vs-transcript-information-sources);
  // the model keeps the `[1m]` the transcript drops.
  test("session.start sends the model as the session names it and the window", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await untilFacts(fake, 1);
    const { sid, facts } = factsAt(fake, 0);
    expect(sid).toBe(fake.sid.value);
    expect(facts.model).toBe("claude-opus-5-5[1m]");
    expect(facts.context?.window).toBe(1_000_000);
  });

  // `-p` and the SDK have no sidecar, but the daemon still shows them.
  test("a session without a composer sends them too", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(
      fake,
      "session.start",
      { cwd: "/w", isInteractive: false, surface: null },
      async () => ({}),
    );
    await untilFacts(fake, 1);
    expect(fake.spawns).toEqual([]);
    expect(factsAt(fake, 0).facts.context?.window).toBe(1_000_000);
  });

  test("session.measure sends the window it says, the model kept", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await untilFacts(fake, 1);
    const { calls, next } = countingNext({ changed: ["context"] });
    const measure = { context: { window: 300_000 }, rateLimits: [], changed: ["context"] };
    expect(await fire(fake, "session.measure", measure, next)).toEqual({ changed: ["context"] });
    expect(calls.count).toBe(1);
    await untilFacts(fake, 2);
    expect(factsAt(fake, 1).facts.model).toBe("claude-opus-5-5[1m]");
    expect(factsAt(fake, 1).facts.context?.window).toBe(300_000);
  });

  // The fill comes with each measure; before the first response there is
  // none, and the facts say none rather than zero.
  test("session.measure sends the fill it says, and none when it says none", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    const measure = { context: { window: 1_000_000, tokens: 42_000 } };
    await fire(fake, "session.measure", measure, async () => ({}));
    await untilFacts(fake, 1);
    expect(factsAt(fake, 0).facts.context?.tokens).toBe(42_000);
    await fire(fake, "session.measure", { context: { window: 1_000_000 } }, async () => ({}));
    await untilFacts(fake, 2);
    expect(factsAt(fake, 1).facts.context).not.toHaveProperty("tokens");
  });

  // No `$` call answers the effort: each main-thread request names it, before
  // any of its answer.
  test("the effort comes with a main-thread request, and is sent when it moves", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    const step = { turnId: "t", index: 0, model: "m", messageCount: 1 };
    const passed = await fireStep(fake, { ...step, effort: "high" }, ["a", "b"], { done: 1 });
    // The request's stream goes on as it came.
    expect(passed).toEqual({ chunks: ["a", "b"], result: { done: 1 } });
    await untilFacts(fake, 1);
    expect(factsAt(fake, 0).facts.effort).toBe("high");
    await fireStep(fake, { ...step, effort: "high" }, [], {});
    await fireStep(fake, { ...step, effort: "low", agentId: "a1" }, [], {});
    // A model without effort names none.
    await fireStep(fake, step, [], {});
    await settle();
    expect(fake.factsSent.length).toBe(1);
    await fireStep(fake, { ...step, effort: 32_000 }, [], {});
    await untilFacts(fake, 2);
    expect(factsAt(fake, 1).facts.effort).toBe("32000");
  });

  test("a turn.step hook that fails passes the request's stream on", async () => {
    const fake = fakeEngine();
    fake.$.ui = {
      log: () => {
        throw new Error("log broke");
      },
    };
    registerOn(fake);
    // Not an event: logging that is what throws.
    expect(await fireStep(fake, "not an event", ["a"], { done: 1 })).toEqual({
      chunks: ["a"],
      result: { done: 1 },
    });
  });

  // /model raises no session.measure, so the module reads both again.
  test("/model sends the new model and its window", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await untilFacts(fake, 1);
    fake.session.model = "claude-haiku-4-5-20251001";
    fake.session.window = 200_000;
    await fire(fake, "command.run", command("model"), async () => ({}));
    await untilFacts(fake, 2);
    expect(factsAt(fake, 1).facts.model).toBe("claude-haiku-4-5-20251001");
    expect(factsAt(fake, 1).facts.context?.window).toBe(200_000);
  });

  // /clear and /resume raise no session.start: the command's end is when the
  // session has its new id.
  for (const name of ["clear", "resume"]) {
    test(`after /${name} the facts go under the new id`, async () => {
      const fake = fakeEngine();
      registerOn(fake);
      await fire(fake, "session.start", START, async () => ({}));
      await untilFacts(fake, 1);
      await fire(fake, "session.end", { reason: name }, async () => ({}));
      fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await fire(fake, "command.run", command(name), async () => ({}));
      await untilFacts(fake, 2);
      expect(factsAt(fake, 1).sid).toBe("ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    });
  }

  // A daemon that came up after the module asks for what it missed.
  test("the session.facts request is answered with the facts as they are", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    const reply = await replyTo(fake, '{"v":1,"op":"session.facts","id":"f1","args":{}}');
    if (!reply.ok) throw new Error("session.facts failed");
    const read = parseWith(SessionFactsTextSchema, JSON.stringify(reply.result));
    if (!read.ok) throw new Error(read.failure.summary);
    expect(read.value.model).toBe("claude-opus-5-5[1m]");
    expect(read.value.context?.window).toBe(1_000_000);
  });

  // One send at a time, and changes while one runs cost one more send, which
  // carries the latest of them.
  test("changes during a send are sent once, as they stand when it starts", async () => {
    const fake = fakeEngine();
    const gate = Promise.withResolvers<void>();
    const process = fake.$.process;
    let held = 0;
    fake.$.process = {
      ...process,
      run: async (argv, init) => {
        if (argv[2] === "facts" && held++ === 0) await gate.promise;
        return process.run(argv, init);
      },
    };
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    for (const window of [200_000, 300_000, 400_000]) {
      await fire(fake, "session.measure", { context: { window } }, async () => ({}));
    }
    gate.resolve();
    await untilFacts(fake, 2);
    await settle();
    expect(fake.factsSent.map((f) => f.facts.context?.window)).toEqual([1_000_000, 400_000]);
  });

  // The module is the plugin's one tie to Claude Code and hooks no classic
  // event (DR-0039 §1). The API error a turn ends on is the daemon's to read
  // off the transcript, classification included (§2): a turn that ends on an
  // error only goes idle.
  test("the module hooks no classic event, and takes no part in the API error", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    expect(fake.registered.filter((e) => e.startsWith("classic."))).toEqual([]);
    await fire(fake, "turn.start", { text: "", turnId: "t" }, async () => ({}));
    await fire(fake, "turn.complete", { reason: "error", turnId: "t" }, async () => ({}));
    await untilLastFacts(fake, (f) => f.turn?.state === "idle");
  });

  // The TL shows a turn running the moment it starts, not when the
  // transcript's assistant row lands at its end.
  test("a main-thread turn is responding from its start until its end", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await untilLastFacts(fake, (f) => f.turn?.state === "idle");
    const { calls, next } = countingNext({ turnId: "t1" });
    expect(await fire(fake, "turn.start", { text: "hi", turnId: "t1" }, next)).toEqual({
      turnId: "t1",
    });
    expect(calls.count).toBe(1);
    await untilLastFacts(fake, (f) => f.turn?.state === "responding");
    const responding = lastFacts(fake).turn;
    // A subagent's turn end is not the session's.
    const subagentEnd = { reason: "answer", turnId: "s", agentId: "a1" };
    await fire(fake, "turn.complete", subagentEnd, async () => ({}));
    await settle();
    expect(lastFacts(fake).turn).toEqual(responding);
    await fire(fake, "turn.complete", { reason: "answer", turnId: "t1" }, async () => ({}));
    await untilLastFacts(fake, (f) => f.turn?.state === "idle");
  });

  // A compaction can run mid-turn; /clear begins a session with no turn.
  test("/compact leaves a running turn running; /clear ends it", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "turn.start", { text: "hi", turnId: "t1" }, async () => ({}));
    await untilLastFacts(fake, (f) => f.turn?.state === "responding");
    await fire(fake, "command.run", command("compact"), async () => ({}));
    await settle();
    expect(lastFacts(fake).turn?.state).toBe("responding");
    await fire(fake, "command.run", command("clear"), async () => ({}));
    await untilLastFacts(fake, (f) => f.turn?.state === "idle");
  });

  test("a facts send that fails is logged, and the event goes on once", async () => {
    const fake = fakeEngine();
    const process = fake.$.process;
    fake.$.process = {
      ...process,
      run: async (argv, init) => {
        if (argv[2] === "facts") throw new Error("spawn failed");
        return process.run(argv, init);
      },
    };
    registerOn(fake);
    const { calls, next } = countingNext();
    await fire(fake, "session.measure", { context: { window: 1 } }, next);
    expect(calls.count).toBe(1);
    for (let i = 0; i < 10 && !fake.logs.some((l) => l.includes("facts not sent")); i++) {
      await settle();
    }
    expect(fake.logs.some((l) => l === "ccmsg: facts not sent: Error: spawn failed")).toBe(true);
  });
});

describe("each hook passes the event on once", () => {
  // The engine's input is read by a schema: a prompt.submit without `origin`
  // is not a composer submit, and is passed on untouched.
  test("a prompt.submit without origin goes on once, and no draft is put back", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.restoring = { text: "mine", draft: "draft" };
    const { calls, next } = countingNext({ entered: true });
    expect(await fire(fake, "prompt.submit", { text: "mine" }, next)).toEqual({ entered: true });
    expect(calls.count).toBe(1);
    expect(fake.fills).toEqual([]);
    expect(state.restoring).toEqual({ text: "mine", draft: "draft" });
  });

  test("an input that does not read is logged and goes on once", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.restoring = { text: "mine", draft: "draft" };
    const { calls, next } = countingNext();
    await fire(fake, "prompt.submit", { text: 42, origin: { kind: "composer" } }, next);
    expect(calls.count).toBe(1);
    expect(fake.fills).toEqual([]);
    expect(
      fake.logs.some((l) => l.startsWith("ccmsg: prompt.submit not read (prompt-send): text")),
    ).toBe(true);
  });

  // The draft put-back runs after the prompt went in: its failure is logged,
  // the submit's result stands, and nothing beneath runs again.
  test("a failure after next is logged and next is not run again", async () => {
    const fake = fakeEngine();
    fake.$.prompt = {
      ...fake.$.prompt,
      read: async () => {
        throw new Error("engine gone");
      },
    };
    const state = registerOn(fake);
    state.restoring = { text: "mine", draft: "draft" };
    const { calls, next } = countingNext({ entered: true });
    const e = { text: "mine", origin: { kind: "composer" } };
    expect(await fire(fake, "prompt.submit", e, next)).toEqual({ entered: true });
    expect(calls.count).toBe(1);
    expect(
      fake.logs.some(
        (l) =>
          l === "ccmsg: prompt.submit failed after the event (prompt-send): Error: engine gone",
      ),
    ).toBe(true);
  });

  test("a failure in accepting the prompt is logged and the event goes on once", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.awaiting = {
      text: "x",
      accept: () => {
        throw new Error("accept broke");
      },
    };
    let calls = 0;
    await fire(fake, "prompt.submit", submitted("x"), async (e) => {
      calls += 1;
      return entered(e);
    });
    expect(calls).toBe(1);
    expect(
      fake.logs.some((l) =>
        l.includes("failed after the event (prompt-send): Error: accept broke"),
      ),
    ).toBe(true);
  });

  // Only `next` failing makes the hook throw; the `.catch` then answers with
  // that same failure instead of running the event a second time.
  test("a next that fails runs once, and its failure is the event's", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    let count = 0;
    const failing = async (): Promise<object> => {
      count += 1;
      throw new Error("beneath failed");
    };
    for (const event of [
      "session.start",
      "session.end",
      "command.run",
      "turn.start",
      "turn.complete",
      "prompt.submit",
    ] as const) {
      count = 0;
      const outcome = await fire(fake, event, {}, failing).then(
        () => "resolved",
        (e: unknown) => errorText(e),
      );
      expect(outcome).toBe("Error: beneath failed");
      expect(count).toBe(1);
    }
  });

  // The hook itself throwing, before the event went on: the `.catch` passes
  // it on in the hook's place, once.
  test("every hook that fails still passes the event on once", async () => {
    const fake = fakeEngine();
    let logged = 0;
    fake.$.ui = {
      log: () => {
        logged += 1;
        throw new Error("log broke");
      },
    };
    registerOn(fake);
    expect(fake.registered.length).toBeGreaterThan(0);
    // The tools answer their calls themselves, and turn.step is a stream;
    // their failures are their own tests'.
    const observed = fake.registered.flatMap((e) =>
      e === "tool.call" || e === "turn.step" ? [] : [e],
    );
    // An event several concerns hook has a hook of each: every one of them,
    // run alone.
    const seen = new Map<ObservedEvent, number>();
    for (const event of observed) {
      const at = seen.get(event) ?? 0;
      seen.set(event, at + 1);
      logged = 0;
      const { calls, next } = countingNext({ passed: event });
      // No hook reads this input; logging that is what throws.
      expect(await fireOne(fake, event, at, "not an event", next)).toEqual({ passed: event });
      expect(calls.count).toBe(1);
      expect(logged).toBe(1);
    }
  });
});

// The concerns that observe one event are run from its one registration
// (bus.ts): each takes its part on its own.
describe("the concerns of one event", () => {
  // The engine refuses a module that registers one event twice without a
  // matcher: every event the module observes is registered once, and only
  // tool.call goes by a matcher, one per tool.
  test("each event is registered once, and tool.call once per tool", () => {
    const fake = fakeEngine();
    registerOn(fake);
    const observed = fake.registered.filter((e) => e !== "tool.call");
    expect(observed.length).toBe(new Set(observed).size);
    const tools = fake.hooks["tool.call"].map(([matcher]) => matcher.tool);
    expect(tools.length).toBe(new Set(tools).size);
  });

  test("a concern whose part throws is logged, and the others' parts run", async () => {
    const fake = fakeEngine();
    const ran: string[] = [];
    const { calls, next } = countingNext({ passed: true });
    const result = await fanOut(fake.$, {}, next, "session.start", [
      concern("first", AnyInputSchema, {
        before: () => {
          throw new Error("first broke before");
        },
        after: () => {
          throw new Error("first broke after");
        },
      }),
      concern("second", AnyInputSchema, {
        before: () => {
          ran.push("second before");
        },
        after: () => {
          ran.push("second after");
        },
      }),
    ]);
    expect(result).toEqual({ passed: true });
    expect(calls.count).toBe(1);
    expect(ran).toEqual(["second before", "second after"]);
    expect(fake.logs).toContain(
      "ccmsg: session.start failed before the event (first): Error: first broke before",
    );
    expect(fake.logs).toContain(
      "ccmsg: session.start failed after the event (first): Error: first broke after",
    );
  });

  test("a concern whose input does not read takes no part, and the others' parts run", async () => {
    const fake = fakeEngine();
    const ran: string[] = [];
    const { calls, next } = countingNext();
    await fanOut(fake.$, { text: 42 }, next, "prompt.submit", [
      concern("reads text", PromptSubmitInputSchema, {
        after: () => {
          ran.push("reads text");
        },
      }),
      concern("reads nothing", AnyInputSchema, {
        after: () => {
          ran.push("reads nothing");
        },
      }),
    ]);
    expect(calls.count).toBe(1);
    expect(ran).toEqual(["reads nothing"]);
    expect(
      fake.logs.some((l) => l.startsWith("ccmsg: prompt.submit not read (reads text): text")),
    ).toBe(true);
  });
});

/** Run the module's turn.step hook over request `e` and take the request it
 * passed on beneath (whose stream is one chunk). */
async function stepSent<E>(fake: Fake, e: E): Promise<E> {
  const hook = fake.hooks["turn.step"][0]?.[0];
  if (hook === undefined) throw new Error("no hook on turn.step");
  const sent: E[] = [];
  const beneath = async function* (input: E): AsyncGenerator<string, object> {
    sent.push(input);
    yield "chunk";
    return {};
  };
  const stream = hook(fake.$, e, beneath);
  while ((await stream.next()).done !== true);
  const [only, ...rest] = sent;
  if (only === undefined || rest.length > 0) throw new Error(`passed on ${sent.length} times`);
  return only;
}

// DR-0041: what a person overrides the requests with from the web UI.
describe("the overrides of the session's requests", () => {
  const MAIN = {
    turnId: "t1",
    index: 0,
    model: "claude-opus-5-5[1m]",
    effort: "high",
    messageCount: 1,
  };
  const SUB = { ...MAIN, model: "claude-haiku-5-5", effort: "medium", agentId: "a1" };
  const turn = (agentId?: string) => ({
    text: "",
    turnId: "t1",
    ...(agentId !== undefined ? { agentId } : {}),
  });
  /** The daemon hands the session override over the sidecar. */
  async function session(fake: Fake, override: object): Promise<SidecarReply> {
    const at = fake.runs.length;
    spawned(fake, 0).stream.push(
      `${JSON.stringify({ v: 1, op: "request.override", id: `o${at}`, args: override })}\n`,
    );
    const isReply = (argv: string[]) => argv[2] === "reply";
    for (let i = 0; i < 20 && !fake.runs.slice(at).some(isReply); i++) await settle();
    const found = fake.runs.findIndex((argv, i) => i >= at && isReply(argv));
    expect(found).toBeGreaterThanOrEqual(0);
    return stdinReply(fake, found);
  }
  /** What a request is sent with, as far as the override changes it. */
  const sentWith = async (fake: Fake, e: object) => {
    const sent = await stepSent(fake, e);
    return parseWith(v.looseObject({ model: v.string(), effort: v.string() }), sent);
  };
  async function started(): Promise<{ fake: Fake; state: ModuleState }> {
    const fake = fakeEngine({ onEnter: submitComposer });
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    return { fake, state };
  }
  /** A prompt from the web UI with the one-shot override `override`. */
  const prompt = (fake: Fake, state: ModuleState, text: string, override: object) =>
    handlePromptSend(fake.$, state, { ...queued(fake, state, text), override });
  /** The overrides' values the latest facts carry. */
  const values = (fake: Fake) => lastFacts(fake).request_override;

  test("the session override: every main-thread request from the next one on, until cleared", async () => {
    const { fake } = await started();
    expect(await session(fake, { model: "sonnet", effort: "low" })).toEqual({
      id: "o0",
      ok: true,
      result: { outcome: "applied" },
    });
    // The alias goes to the engine, with the request's own [1m].
    expect(await sentWith(fake, MAIN)).toMatchObject({
      ok: true,
      value: { ...MAIN, model: "sonnet[1m]", effort: "low" },
    });
    expect(await sentWith(fake, { ...MAIN, index: 1 })).toMatchObject({
      value: { model: "sonnet[1m]", effort: "low" },
    });
    // Only the effort: the model goes as it came.
    await session(fake, { effort: "max" });
    expect(await sentWith(fake, MAIN)).toMatchObject({ value: { ...MAIN, effort: "max" } });
    await session(fake, {});
    expect(await stepSent(fake, MAIN)).toBe(MAIN);
  });

  // A subagent is started with the model and the effort it is meant to run
  // on: neither override touches its requests.
  test("a subagent's request goes as it came", async () => {
    const { fake, state } = await started();
    await session(fake, { model: "sonnet", effort: "low" });
    await prompt(fake, state, "go", { effort: "max" });
    expect(await stepSent(fake, SUB)).toBe(SUB);
    expect(await sentWith(fake, MAIN)).toMatchObject({
      value: { model: "sonnet[1m]", effort: "max" },
    });
  });

  // The session override's values are the session's own wherever a person
  // set none: the model as the session names it, the effort once a request
  // named it, and what /model in the terminal moves them to.
  test("the facts carry the values: the session's own under the session override", async () => {
    const { fake } = await started();
    await untilLastFacts(fake, (f) => f.request_override !== undefined);
    expect(values(fake)).toEqual({
      session: { model: "claude-opus-5-5[1m]", effort: null },
      once: { model: null, effort: null },
    });
    await stepSent(fake, MAIN);
    await untilLastFacts(fake, (f) => f.request_override?.session.effort === "high");
    fake.session.model = "claude-sonnet-5-5[1m]";
    await fire(fake, "command.run", command("model"), async () => ({}));
    await untilLastFacts(
      fake,
      (f) => f.request_override?.session.model === "claude-sonnet-5-5[1m]",
    );
    await session(fake, { effort: "low" });
    await untilLastFacts(fake, (f) => f.request_override?.session.effort === "low");
    expect(values(fake)?.session).toEqual({ model: "claude-sonnet-5-5[1m]", effort: "low" });
    // The facts' own model and effort stay the session's.
    expect(lastFacts(fake).effort).toBe("high");
  });

  // Facts go when the values move, and not for a change that moves none.
  test("a session override that moves no value sends no facts", async () => {
    const { fake } = await started();
    await session(fake, { effort: "low" });
    await untilLastFacts(fake, (f) => f.request_override?.session.effort === "low");
    const sent = fake.factsSent.length;
    await session(fake, { effort: "low" });
    await settle();
    expect(fake.factsSent.length).toBe(sent);
  });

  // Armed ahead of the submit, so the turn's first request, which may come
  // before the submit's next settles, carries it; it lasts to that turn's end.
  test("the one-shot override: from its prompt's turn's first request to that turn's end", async () => {
    const firstSent: Awaited<ReturnType<typeof sentWith>>[] = [];
    const fake = fakeEngine({
      onEnter: async (f) => {
        const text = f.composer.text;
        await fire(f, "prompt.submit", submitted(text), async (e) => {
          f.composer.text = "";
          await fire(f, "turn.start", turn(), async () => ({}));
          firstSent.push(await sentWith(f, MAIN));
          return entered(e);
        });
        return 0;
      },
    });
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    await session(fake, { model: "fable", effort: "high" });
    expect(await prompt(fake, state, "go easy", { effort: "low" })).toEqual({
      outcome: "accepted",
    });
    // The one-shot beats the session override field by field.
    expect(firstSent).toMatchObject([{ value: { model: "fable[1m]", effort: "low" } }]);
    expect(await sentWith(fake, { ...MAIN, index: 1 })).toMatchObject({
      value: { model: "fable[1m]", effort: "low" },
    });
    await untilLastFacts(fake, (f) => f.request_override?.once.effort === "low");
    // A subagent's turn ending is not the main thread's.
    await fire(fake, "turn.complete", turn("a1"), async () => ({}));
    expect(await sentWith(fake, MAIN)).toMatchObject({ value: { effort: "low" } });
    await fire(fake, "turn.complete", turn(), async () => ({}));
    expect(await sentWith(fake, MAIN)).toMatchObject({
      value: { model: "fable[1m]", effort: "high" },
    });
    await untilLastFacts(fake, (f) => f.request_override?.once.effort === null);
  });

  // A prompt typed while a turn runs joins that turn's next request; a turn
  // that ends before a request took it leaves it for the next turn.
  test("sent while a turn runs: from its next request; a turn ending first leaves it for the next", async () => {
    const { fake, state } = await started();
    await fire(fake, "turn.start", turn(), async () => ({}));
    expect(await stepSent(fake, MAIN)).toBe(MAIN);
    await prompt(fake, state, "stop", { effort: "low" });
    expect(await sentWith(fake, { ...MAIN, index: 1 })).toMatchObject({ value: { effort: "low" } });
    await fire(fake, "turn.complete", turn(), async () => ({}));
    expect(await stepSent(fake, MAIN)).toBe(MAIN);

    await fire(fake, "turn.start", turn(), async () => ({}));
    await stepSent(fake, MAIN);
    await prompt(fake, state, "next", { model: "haiku" });
    await fire(fake, "turn.complete", turn(), async () => ({}));
    await fire(fake, "turn.start", turn(), async () => ({}));
    expect(await sentWith(fake, MAIN)).toMatchObject({ value: { model: "haiku[1m]" } });
    await fire(fake, "turn.complete", turn(), async () => ({}));
    expect(await stepSent(fake, MAIN)).toBe(MAIN);
  });

  // DR-0041 裁定: a change of the session override updates the one-shot too,
  // so it is in force from the next request even while a one-shot override
  // is; the one-shot keeps the fields the change did not touch.
  test("a session override change is in force from the next request over the one-shot", async () => {
    const { fake, state } = await started();
    await session(fake, { effort: "high" });
    await fire(fake, "turn.start", turn(), async () => ({}));
    await prompt(fake, state, "x", { model: "haiku", effort: "max" });
    expect(await sentWith(fake, MAIN)).toMatchObject({
      value: { model: "haiku[1m]", effort: "max" },
    });
    await session(fake, { effort: "low" });
    expect(await sentWith(fake, { ...MAIN, index: 1 })).toMatchObject({
      value: { model: "haiku[1m]", effort: "low" },
    });
    await untilLastFacts(fake, (f) => f.request_override?.once.effort === null);
    expect(values(fake)?.once).toEqual({ model: "haiku", effort: null });
    await fire(fake, "turn.complete", turn(), async () => ({}));
    expect(await sentWith(fake, MAIN)).toMatchObject({
      value: { model: "claude-opus-5-5[1m]", effort: "low" },
    });
  });

  // DR-0041 §6.5 (🏛️): the fields a person's change named go out of the
  // one-shot override too, even where the session override has none to
  // change; the fields it did not name stay.
  test("a field the change names goes out of the one-shot override, the session override's or not", async () => {
    const { fake, state } = await started();
    await stepSent(fake, MAIN);
    await fire(fake, "turn.start", turn(), async () => ({}));
    await prompt(fake, state, "x", { model: "haiku", effort: "max" });
    expect(await sentWith(fake, MAIN)).toMatchObject({
      value: { model: "haiku[1m]", effort: "max" },
    });
    await untilLastFacts(fake, (f) => f.request_override?.once.effort === "max");
    // No session override: the session's own effort, from the next request.
    await session(fake, { clear_once: ["effort"] });
    expect(await sentWith(fake, { ...MAIN, index: 1 })).toMatchObject({
      value: { model: "haiku[1m]", effort: "high" },
    });
    await untilLastFacts(fake, (f) => f.request_override?.once.effort === null);
    expect(values(fake)).toEqual({
      session: { model: "claude-opus-5-5[1m]", effort: "high" },
      once: { model: "haiku", effort: null },
    });
    // A session override that stays as it was, named: out of the one-shot.
    await session(fake, { effort: "low" });
    await prompt(fake, state, "y", { model: "haiku", effort: "max" });
    await session(fake, { effort: "low", clear_once: ["effort"] });
    expect(await sentWith(fake, { ...MAIN, index: 2 })).toMatchObject({
      value: { model: "haiku[1m]", effort: "low" },
    });
    // Both fields named: the request goes as it came.
    await session(fake, { clear_once: ["model", "effort"] });
    expect(await stepSent(fake, { ...MAIN, index: 3 })).toEqual({ ...MAIN, index: 3 });
    await untilLastFacts(fake, (f) => f.request_override?.once.model === null);
    expect(values(fake)?.once).toEqual({ model: null, effort: null });
  });

  test("a dropped submit takes its one-shot override back; a prompt without one arms nothing", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        await fire(f, "prompt.submit", submitted(f.composer.text), async () => ({ drop: "no" }));
        return 0;
      },
    });
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    const sending = prompt(fake, state, "x", { effort: "max" });
    await expireAcceptWait(fake);
    expect(await sending).toMatchObject({ outcome: "not_delivered" });
    expect(await stepSent(fake, MAIN)).toBe(MAIN);
    // It was armed ahead of the submit, and went with the drop.
    await untilLastFacts(fake, (f) => f.request_override?.once.effort === null);
    expect(fake.factsSent.some(({ facts }) => facts.request_override?.once.effort === "max")).toBe(
      true,
    );

    const plain = await started();
    await handlePromptSend(plain.fake.$, plain.state, queued(plain.fake, plain.state, "x"));
    expect(await stepSent(plain.fake, MAIN)).toBe(MAIN);
  });

  // The daemon holds the session override by session id.
  test("the session changing its id drops the overrides", async () => {
    const { fake } = await started();
    await session(fake, { effort: "low" });
    await fire(fake, "session.end", { reason: "clear" }, async () => ({}));
    expect(await stepSent(fake, MAIN)).toBe(MAIN);
    await untilLastFacts(fake, (f) => f.request_override?.session.effort !== "low");
  });
});

// The subagents a person can add a message to from the web UI (DR-0039 §6).
describe("the subagents", () => {
  /** The subagents in `facts`, each saying whether its turn's start is known
   * rather than when (the fake's clock is a counter). */
  const withStart = (facts: SessionFacts) =>
    (facts.subagents ?? []).map(({ since, ...agent }) => ({
      ...agent,
      started: since !== undefined,
    }));
  const A = "a1b2c3d4e5f6a7b8c";
  const B = "b9b8b7b6b5b4b3b2a";

  test("a subagent is in the facts from its turn's start to its end, with what list() says", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await untilLastFacts(fake, (f) => f.subagents !== undefined);
    expect(lastFacts(fake).subagents).toEqual([]);
    fake.agents.push({ id: A, description: "調査", type: "Explore", status: "running" });
    await fire(fake, "turn.start", { text: "go", turnId: "s1", agentId: A }, async () => ({}));
    await untilLastFacts(fake, (f) => (f.subagents ?? []).length === 1);
    expect(withStart(lastFacts(fake))).toEqual([
      { id: A, description: "調査", type: "Explore", started: true },
    ]);
    // A teammate's loop, which list() may not describe yet, is listed bare.
    await fire(fake, "turn.start", { text: "", turnId: "s2", agentId: B }, async () => ({}));
    await untilLastFacts(fake, (f) => (f.subagents ?? []).length === 2);
    await fire(
      fake,
      "turn.complete",
      { reason: "answer", turnId: "s1", agentId: A },
      async () => ({}),
    );
    await untilLastFacts(fake, (f) => (f.subagents ?? []).length === 1);
    expect(withStart(lastFacts(fake))).toEqual([{ id: B, started: true }]);
    // The main thread's turns leave them alone.
    expect(lastFacts(fake).turn?.state).toBe("idle");
  });

  // Loaded while a subagent runs (a reload), or after /clear: the module has
  // seen no turn start, so it reads who runs off list(), without a start.
  test("at a start and after /clear the running ones are read off list(), without a start", async () => {
    const fake = fakeEngine();
    fake.agents.push(
      { id: A, description: "d", type: "general-purpose", status: "running" },
      { id: B, description: "done", type: "Explore", status: "completed" },
    );
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await untilLastFacts(fake, (f) => f.subagents !== undefined);
    expect(lastFacts(fake).subagents).toEqual([
      { id: A, description: "d", type: "general-purpose" },
    ]);
  });

  test("agent.append adds the text, marked as the person's, to the running subagent only", async () => {
    const fake = fakeEngine();
    fake.agents.push({ id: A, description: "d", type: "t", status: "running" });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    // Each request on the sidecar, and the reply the module sent for it.
    const append = async (agentId: string, text: string) => {
      const isReply = (argv: string[]) => argv[2] === "reply";
      const before = fake.runs.filter(isReply).length;
      spawned(fake, 0).stream.push(
        `${JSON.stringify({ v: 1, op: "agent.append", id: "g1", args: { agentId, text } })}\n`,
      );
      for (let i = 0; i < 20 && fake.runs.filter(isReply).length === before; i++) await settle();
      return stdinReply(fake, fake.runs.findLastIndex(isReply));
    };
    expect(await append(A, "その方針で")).toEqual({
      id: "g1",
      ok: true,
      result: { outcome: "appended" },
    });
    expect(fake.agentAppends).toEqual([{ agentId: A, text: agentMessage("その方針で") }]);
    expect(agentMessage("x")).toBe("ユーザから (ccmsg 経由):\nx");
    expect(fake.appended).toEqual([]);
    expect(await append(B, "x")).toEqual({
      id: "g1",
      ok: true,
      result: { outcome: "not_delivered", reason: "not_running" },
    });
  });

  // send with agent_id (DR-0039 §3): the session that sent it is named, not
  // the person.
  test("agent.append with from marks the text as from that session", async () => {
    const fake = fakeEngine();
    fake.agents.push({ id: A, description: "d", type: "t", status: "running" });
    registerOn(fake);
    const sender = "11111111-2222-4333-8444-555555555555";
    const reply = await replyTo(
      fake,
      JSON.stringify({
        v: 1,
        op: "agent.append",
        id: "g3",
        args: { agentId: A, from: sender, text: "確認お願い" },
      }),
    );
    expect(reply).toEqual({ id: "g3", ok: true, result: { outcome: "appended" } });
    expect(fake.agentAppends).toEqual([{ agentId: A, text: `ccmsg:${sender} から:\n確認お願い` }]);
    expect(agentMessage("x", sender)).toBe(`ccmsg:${sender} から:\nx`);
  });

  test("an append refused for another reason says refused", async () => {
    const fake = fakeEngine();
    fake.$.session = {
      ...fake.$.session,
      append: async () => {
        throw new Error("denied by a hook above");
      },
    };
    registerOn(fake);
    const reply = await replyTo(
      fake,
      JSON.stringify({ v: 1, op: "agent.append", id: "g2", args: { agentId: A, text: "x" } }),
    );
    expect(reply).toEqual({
      id: "g2",
      ok: true,
      result: { outcome: "not_delivered", reason: "refused" },
    });
  });
});

// What the model is told of ccmsg before its first turn (DR-0039 §5).
describe("the guidance", () => {
  const prompt = (fake: Fake, text: string) =>
    fire(fake, "prompt.submit", submitted(text), entered);
  const started = async (options: Parameters<typeof fakeEngine>[0] = {}) => {
    const fake = fakeEngine(options);
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    return fake;
  };

  test("goes in before the first prompt of a conversation, once", async () => {
    const fake = await started();
    let appendedAtNext: number | undefined;
    await fire(fake, "prompt.submit", submitted("one"), async (e) => {
      appendedAtNext = fake.appended.length;
      return entered(e);
    });
    // In before the prompt goes in, so the prompt's request carries it.
    expect(appendedAtNext).toBe(1);
    await prompt(fake, "two");
    expect(fake.appended).toEqual([GUIDANCE]);
    expect(GUIDANCE).toContain("skill ccmsg-v1:ccmsg");
  });

  // A conversation keeps its id across processes (`--resume`, an in-session
  // /resume): it holds the guidance already, and is not told again.
  test("a resumed conversation is not told again, in another process or the same", async () => {
    const first = await started();
    await prompt(first, "one");
    const resumed = await started({ store: first.store });
    await prompt(resumed, "after --resume");
    expect(resumed.appended).toEqual([]);
    // An in-session /resume back to it, after a /clear moved on.
    resumed.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await prompt(resumed, "after clear");
    resumed.sid.value = first.sid.value;
    await prompt(resumed, "after /resume");
    expect(resumed.appended).toEqual([GUIDANCE]);
  });

  // /clear starts a conversation under a new id: it gets the guidance. A
  // compaction summarized it away, so the next prompt adds it back.
  test("goes in again after /clear and after a compaction", async () => {
    const fake = await started();
    await prompt(fake, "one");
    fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await prompt(fake, "after clear");
    await fire(fake, "session.compact", { trigger: "auto" }, async () => ({}));
    await prompt(fake, "after compact");
    await prompt(fake, "next");
    expect(fake.appended).toEqual([GUIDANCE, GUIDANCE, GUIDANCE]);
  });

  // The agent links the person to the webui by `ccmsg_url`: the URL the
  // daemon says the webui is opened at, in the guidance of the session's
  // start and of each /clear.
  test("carries the webui URL the daemon names, at the start and after /clear", async () => {
    const url = "https://ccmsg.host.example.com";
    const fake = await started({ webuiUrl: url });
    await prompt(fake, "one");
    fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await prompt(fake, "after clear");
    await prompt(fake, "next");
    expect(fake.appended).toEqual([guidanceText(url), guidanceText(url)]);
    expect(guidanceText(url)).toBe(`${GUIDANCE}\nccmsg_url: ${url}`);
    // Asked when the guidance goes in, not for every prompt.
    expect(fake.statuses.count).toBe(2);
  });

  // No URL is made up: a daemon that names none, and one that cannot be
  // asked, leave the line out and the guidance goes in regardless.
  test("leaves the line out when the daemon names no URL or cannot be asked", async () => {
    const none = await started();
    await prompt(none, "one");
    expect(none.appended).toEqual([GUIDANCE]);
    const failing = await started({ webuiUrl: new Error("timed out") });
    await prompt(failing, "one");
    expect(failing.appended).toEqual([GUIDANCE]);
    expect(failing.logs).toContain("ccmsg: status failed: Error: timed out");
  });

  test("a session with no composer (-p) gets none", async () => {
    const fake = await started();
    const p = fakeEngine();
    registerOn(p);
    await fire(
      p,
      "session.start",
      { ...START, isInteractive: false, surface: null },
      async () => ({}),
    );
    await prompt(p, "one");
    expect(p.appended).toEqual([]);
    expect(fake.appended).toEqual([]);
  });

  test("one that cannot go in is logged, and the prompt goes in regardless", async () => {
    const fake = fakeEngine();
    fake.$.session = {
      ...fake.$.session,
      append: async () => {
        throw new Error("refused: no conversation");
      },
    };
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    expect(await prompt(fake, "one")).toEqual({ text: "one" });
    expect(fake.logs).toContain("ccmsg: guidance not added: Error: refused: no conversation");
    // Not marked: the next prompt tries again.
    expect([...fake.store.keys()]).toEqual([]);
  });

  // The records of sessions not used for the TTL, and those not read, go
  // when a session starts; the others stay, other keys untouched.
  test("a session's start sweeps the records gone stale", async () => {
    const store = new Map<string, unknown>([
      ["guided:old", { guided: true, at: -GUIDED_TTL_MS - 10 }],
      ["guided:fresh", { guided: true, at: 0 }],
      ["guided:unread", "x"],
      ["other", { at: -GUIDED_TTL_MS - 10 }],
    ]);
    await started({ store });
    for (let i = 0; i < 10 && store.has("guided:old"); i++) await settle();
    expect([...store.keys()].sort()).toEqual(["guided:fresh", "other"]);
  });
});

// The tools an agent uses ccmsg through (DR-0039 §3).
describe("the ccmsg tools", () => {
  const OTHER = "bbbbbbbb-2222-4333-8444-555555555555";
  const fake0 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  /** A command that prints `value` as JSON and exits 0. */
  const printing = (value: object) => async (): Promise<CommandRun> => ({
    exitCode: 0,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: "",
  });

  function toolFake(command: NonNullable<Parameters<typeof fakeEngine>[0]>["command"]) {
    const fake = fakeEngine({ command });
    registerOn(fake);
    return fake;
  }

  // The tools are ccmsg's typed calls, not general tools to be found: a few
  // words each, and the skill names them in full (DR-0039 §3, "mods の tool
  // の作り方").
  test("an interactive session.start registers send, say, peers, launch and permit, deferred, in a few words", async () => {
    const fake = toolFake(printing({}));
    await fire(fake, "session.start", START, async () => ({}));
    expect(fake.tools.map((t) => [t.name, t.description, t.isDeferred])).toEqual([
      ["send", "Message other sessions", true],
      ["say", "Speak to the person", true],
      ["peers", "List reachable sessions", true],
      ["launch", "Launch a Claude session", true],
      ["permit", "Ask the person for permission", true],
    ]);
    // The model is shown the shape the handler reads, and no more: send's
    // text required, the recipient fields beside it, each field its type
    // alone (the finer rules are the handler's).
    expect(fake.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
        name: { type: "string" },
        pid: { type: "integer" },
        agent_id: { type: "string", description: "Running subagent's id" },
        text: { type: "string" },
      },
      required: ["text"],
    });
    // A list field is shown with what it holds, an object with its fields:
    // permit's commands are objects whose command is required, and only
    // blocked is required of the input (which of intents and commands is the
    // handler's rule).
    expect(fake.tools[4]?.inputSchema).toEqual({
      type: "object",
      properties: {
        blocked: { type: "string" },
        attachments: { type: "array", items: { type: "string" } },
        intents: { type: "array", items: { type: "string" } },
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: { command: { type: "string" }, description: { type: "string" } },
            required: ["command"],
          },
        },
      },
      required: ["blocked"],
    });
  });

  test("a session with no composer (-p) gets no tools", async () => {
    const fake = toolFake(printing({}));
    await fire(
      fake,
      "session.start",
      { ...START, isInteractive: false, surface: null },
      async () => ({}),
    );
    expect(fake.tools).toEqual([]);
  });

  test("send hands { to, text } to ccmsg sidecar send-message and reads each result", async () => {
    const seen: { argv: readonly string[]; stdin?: string; timeoutMs?: number }[] = [];
    const fake = toolFake(async (argv, init) => {
      seen.push({ argv, ...init });
      return printing({
        ok: true,
        results: [
          { sid: OTHER, name: "n", cwd: "/w", outcome: "delivered" },
          { sid: "c", outcome: "not_delivered", reason: "no_module" },
        ],
      })();
    });
    const text = "long\nmessage `with` $chars";
    const result = await callTool(fake, "mcp__ccmsg-v1__send", {
      cwd: "/w",
      text,
      tool: "mcp__ccmsg-v1__send",
      tool_use_id: "toolu_1",
    });
    expect(seen).toEqual([
      {
        argv: ["/plugin/bin/ccmsg", "sidecar", "send-message", "--sid", fake.sid.value],
        stdin: JSON.stringify({ to: { cwd: "/w" }, text }),
        timeoutMs: SEND_TIMEOUT_MS,
      },
    ]);
    expect(result).toContain("2 件の宛先のうち 1 件に届いた");
    expect(result).toContain(`- session_id: ${OTHER}, name: "n", cwd: "/w": 届いた`);
    expect(result).toContain("- session_id: c: 届かなかった。ccmsg の hooks module が動いていない");
  });

  // A send that names a running subagent hands its agent_id on with the rest.
  test("send with agent_id hands it to ccmsg sidecar send-message", async () => {
    const seen: (string | undefined)[] = [];
    const fake = toolFake(async (_argv, init) => {
      seen.push(init?.stdin);
      return printing({ ok: true, results: [{ sid: OTHER, outcome: "delivered" }] })();
    });
    const result = await callTool(fake, "mcp__ccmsg-v1__send", {
      session_id: OTHER,
      agent_id: "a1b2",
      text: "hi",
    });
    expect(seen).toEqual([
      JSON.stringify({ to: { session_id: OTHER }, agent_id: "a1b2", text: "hi" }),
    ]);
    expect(result).toContain(`- session_id: ${OTHER}: 届いた`);
    expect(
      await callTool(fake, "mcp__ccmsg-v1__send", { session_id: OTHER, agent_id: "", text: "hi" }),
    ).toContain("send の入力が形に合わない");
  });

  // engine does not check the input against the schema (DR-0039 §3): the
  // handler reads it and answers what does not read, running nothing.
  test("an input that is not send's is answered in text, and nothing runs", async () => {
    const fake = toolFake(printing({ ok: true, results: [] }));
    for (const input of [{ text: 1, cwd: "/w" }, { text: "hi" }, { cwd: "/w", text: "  " }, {}]) {
      expect(await callTool(fake, "mcp__ccmsg-v1__send", input)).toContain(
        "send の入力が形に合わない",
      );
    }
    expect(fake.runs).toEqual([]);
  });

  // The model calls a plugin's tool as mcp__<plugin name>__<tool>, so the
  // tools the module answers carry the name plugin.json gives.
  test("the tools answered are named under the plugin's name", async () => {
    const read = parseWith(
      jsonText(v.object({ name: v.string() })),
      fs.readFileSync(path.join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8"),
    );
    if (!read.ok) throw new Error(read.failure.summary);
    const fake = toolFake(printing({}));
    const answered: string[] = fake.hooks["tool.call"].map(([matcher]) => matcher.tool);
    expect(answered).toEqual(
      ["send", "say", "peers", "launch", "permit"].map(
        (tool) => `mcp__${read.value.name}__${tool}`,
      ),
    );
    // A transcript's reader knows the tools by the same names.
    expect(answered).toEqual([
      CCMSG_TOOLS.send,
      CCMSG_TOOLS.say,
      CCMSG_TOOLS.peers,
      CCMSG_TOOLS.launch,
      CCMSG_TOOLS.permit,
    ]);
  });

  test("a send that matched only the sender says so", async () => {
    const fake = toolFake(
      printing({
        ok: true,
        results: [{ sid: fake0, outcome: "not_delivered", reason: "self" }],
      }),
    );
    expect(await callTool(fake, "mcp__ccmsg-v1__send", { name: "me", text: "hi" })).toContain(
      "送り主自身だけなので、送っていない",
    );
  });

  test("a send that matched nobody says so", async () => {
    const fake = toolFake(printing({ ok: true, results: [] }));
    expect(await callTool(fake, "mcp__ccmsg-v1__send", { name: "x", text: "hi" })).toContain(
      "宛先に当たる生きているセッションが無い",
    );
  });

  test("a send whose result cannot be told is unconfirmed; one with no daemon was not sent", async () => {
    const thrown = toolFake(async () => {
      throw new Error("aborted: still running after 10000ms");
    });
    expect(await callTool(thrown, "mcp__ccmsg-v1__send", { cwd: "/w", text: "hi" })).toContain(
      "届いたか確かめられなかった: Error: aborted",
    );
    const silent = toolFake(async () => ({ exitCode: 1, stdout: "", stderr: "broke\n  detail\n" }));
    expect(await callTool(silent, "mcp__ccmsg-v1__send", { cwd: "/w", text: "hi" })).toContain(
      "届いたか確かめられなかった: broke。",
    );
    const nodaemon = toolFake(async () => ({ exitCode: 3, stdout: "", stderr: "no daemon\n" }));
    expect(await callTool(nodaemon, "mcp__ccmsg-v1__send", { cwd: "/w", text: "hi" })).toContain(
      "daemon に繋がらず、送っていない: no daemon",
    );
  });

  // The daemon's refusal is printed as its JSON; the tool says its msg in
  // words. A refusal comes before any session is written to, so nothing went;
  // one from an op that threw part way leaves the send unconfirmed.
  test("a send the daemon refused says the daemon's reason, not its JSON", async () => {
    const refusing = (code: string) =>
      toolFake(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ ok: false, error: { code, msg: "op: `peer_send` は `send_message` に改名された" } })}\n`,
      }));
    const refused = await callTool(refusing("invalid_args"), "mcp__ccmsg-v1__send", {
      cwd: "/w",
      text: "hi",
    });
    expect(refused).toBe(
      "ccmsg の daemon が送信を断ったので、送っていない: op: `peer_send` は `send_message` に改名された",
    );
    const threw = await callTool(refusing("internal"), "mcp__ccmsg-v1__send", {
      cwd: "/w",
      text: "hi",
    });
    expect(threw).toContain(
      "届いたか確かめられなかった: op: `peer_send` は `send_message` に改名された。",
    );
    expect(threw).not.toContain("{");
  });

  // A handler that throws (here its log) is answered by the `.catch`, never
  // by `next`, which would only reach core's "no tool.call hook answered".
  test("a send whose handler fails is answered by its .catch", async () => {
    const fake = toolFake(async () => {
      throw new Error("run broke");
    });
    fake.$.ui = {
      log: () => {
        throw new Error("log broke");
      },
    };
    expect(await callTool(fake, "mcp__ccmsg-v1__send", { cwd: "/w", text: "hi" })).toContain(
      "send が途中で止まり",
    );
  });

  test("say runs ccmsg say as the session, the text one argument", async () => {
    const seen: { argv: readonly string[]; env?: Record<string, string> }[] = [];
    const fake = toolFake(async (argv, init) => {
      seen.push({ argv, ...(init.env !== undefined ? { env: init.env } : {}) });
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    expect(await callTool(fake, "mcp__ccmsg-v1__say", { text: "終わりました 3 件" })).toContain(
      "伝えた",
    );
    expect(seen).toEqual([
      {
        argv: ["/plugin/bin/ccmsg", "say", "終わりました 3 件"],
        env: { CCMSG_SID: fake.sid.value },
      },
    ]);
    expect(await callTool(fake, "mcp__ccmsg-v1__say", {})).toContain("say の入力が形に合わない");
  });

  test("peers lists the sessions send can reach, spelled as send takes them", async () => {
    const seen: (string | undefined)[] = [];
    const fake = toolFake(async (_argv, init) => {
      seen.push(init.stdin);
      return printing({
        ok: true,
        peers: [
          { sid: fake.sid.value, pids: [1], module: true, self: true },
          { sid: OTHER, name: "n", cwd: "/w", pids: [2, 3], module: true, self: false },
          { sid: "c", pids: [4], module: false, self: false },
        ],
      })();
    });
    const result = await callTool(fake, "mcp__ccmsg-v1__peers", { cwd_prefix: "/w/" });
    expect(seen).toEqual([JSON.stringify({ cwd_prefix: "/w/" })]);
    expect(result.split("\n").slice(1)).toEqual([
      `- session_id: ${OTHER}, name: "n", cwd: "/w", pid: 2 / 3`,
      "- session_id: c (ccmsg の hooks module が動いていないので送れない)",
    ]);
  });

  // launch (DR-0018 §3.7): the model is shown one flat object of claude's
  // options, since Claude Code leaves out a tool whose schema is a top-level
  // oneOf / anyOf (docs/findings/2026-10-25-launch-tool-input-schema.md).
  // Which options go together is the skill's to say and the handler's to
  // check, not the schema's.
  test("launch is shown one flat object of types: cwd required, no resume_session_at", async () => {
    const fake = toolFake(printing({}));
    await fire(fake, "session.start", START, async () => ({}));
    expect(fake.tools.find((t) => t.name === "launch")?.inputSchema).toEqual({
      type: "object",
      properties: {
        cwd: { type: "string" },
        model: { type: "string", enum: ["fable", "opus", "sonnet", "haiku"] },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        continue: { type: "boolean" },
        resume: { type: "string", description: "Session id to resume" },
        fork_session: { type: "boolean" },
        name: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["cwd"],
    });
  });

  // The tool's wait holds the longest launch the daemon can make: the longest
  // timeout_seconds, the kill grace, the wait for the pipes' EOF and a daemon
  // the CLI has to start (its connect retries), with room left over.
  test("the launch wait holds the longest launch and a daemon start", () => {
    const daemonStart = SPAWN_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    const longest =
      LAUNCH_TIMEOUT_SECONDS_MAX * 1000 +
      LAUNCH_KILL_GRACE_MS * 2 +
      LAUNCH_PIPE_DRAIN_GRACE_MS +
      daemonStart;
    expect(LAUNCH_TIMEOUT_MS).toBeGreaterThan(longest);
  });

  const RESUMED = "cccccccc-0000-4000-8000-000000000003";
  const launched = { ok: true, session_id: OTHER, exit_code: 0, stdout: "started\n", stderr: "" };

  // The engine puts the tool's name, the call's id, a subagent's agent id and
  // whatever it adds later beside the input; only the input goes to the
  // command.
  test("launch hands the launch to ccmsg sidecar launch and answers its reply as JSON", async () => {
    const seen: { argv: readonly string[]; stdin?: string; timeoutMs?: number }[] = [];
    const fake = toolFake(async (argv, init) => {
      seen.push({ argv, ...init });
      return printing(launched)();
    });
    // In the schema's order, which is the order the handler writes it in.
    const input = { cwd: "/w", model: "opus", effort: "high", prompt: "a\n`b` $c" };
    const result = await callTool(fake, "mcp__ccmsg-v1__launch", {
      ...input,
      tool: "mcp__ccmsg-v1__launch",
      tool_use_id: "toolu_1",
      agentId: "a1",
      engine_field_of_tomorrow: { any: "shape" },
    });
    expect(seen).toEqual([
      {
        argv: ["/plugin/bin/ccmsg", "sidecar", "launch", "--sid", fake.sid.value],
        stdin: JSON.stringify(input),
        timeoutMs: LAUNCH_TIMEOUT_MS,
      },
    ]);
    expect(result).toBe(
      JSON.stringify({ session_id: OTHER, exit_code: 0, stdout: "started\n", stderr: "" }),
    );
    // A non-zero exit carries no session_id, and is answered as it came.
    const failed = toolFake(
      printing({ ok: true, exit_code: 2, stdout: "", stderr: "no such dir\n" }),
    );
    expect(await callTool(failed, "mcp__ccmsg-v1__launch", { cwd: "/w", resume: RESUMED })).toBe(
      JSON.stringify({ exit_code: 2, stdout: "", stderr: "no such dir\n" }),
    );
  });

  // A fork point names a transcript record the agent cannot see: the tool
  // has no such field, and one written anyway does not reach the command.
  test("a resume_session_at written anyway does not reach the command", async () => {
    const seen: (string | undefined)[] = [];
    const fake = toolFake(async (_argv, init) => {
      seen.push(init?.stdin);
      return printing(launched)();
    });
    await callTool(fake, "mcp__ccmsg-v1__launch", {
      cwd: "/w",
      resume: RESUMED,
      fork_session: true,
      resume_session_at: RESUMED,
    });
    expect(seen).toEqual([JSON.stringify({ cwd: "/w", resume: RESUMED, fork_session: true })]);
  });

  // What a new session requires missing, a combination claude refuses, or a
  // field that does not read is answered in text, and nothing runs.
  test("an input that is not a launch is answered in text, and nothing runs", async () => {
    const fake = toolFake(printing(launched));
    for (const input of [
      {},
      { cwd: "/w" },
      { cwd: "/w", model: "opus" },
      { cwd: "/w", continue: true, resume: RESUMED },
      { cwd: "/w", model: "opus", effort: "high", fork_session: true },
      { cwd: "w", continue: true },
      { cwd: "/w", resume: "not-a-uuid" },
      { cwd: "/w", continue: "yes" },
      { cwd: "/w", continue: true, prompt: "" },
    ]) {
      const result = await callTool(fake, "mcp__ccmsg-v1__launch", {
        tool: "mcp__ccmsg-v1__launch",
        ...input,
      });
      expect({
        input,
        answer: result.startsWith("launch の入力が形に合わないので何もしていない: "),
      }).toEqual({
        input,
        answer: true,
      });
    }
    expect(fake.runs).toEqual([]);
    // The reason names the field to change.
    expect(
      await callTool(fake, "mcp__ccmsg-v1__launch", { cwd: "/w", continue: true, resume: RESUMED }),
    ).toBe(
      "launch の入力が形に合わないので何もしていない: resume: continue と resume は同時に指定できない",
    );
  });

  test("a launch the daemon refused or could not be asked was not started; else it is unconfirmed", async () => {
    const refusing = (code: string, msg: string) =>
      toolFake(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ ok: false, error: { code, msg } })}\n`,
      }));
    const input = { tool: "mcp__ccmsg-v1__launch", cwd: "/w", continue: true };
    expect(
      await callTool(
        refusing("invalid_args", "cwd: not a directory"),
        "mcp__ccmsg-v1__launch",
        input,
      ),
    ).toBe(
      "ccmsg の daemon が起動を断ったので、起動していない (invalid_args): cwd: not a directory",
    );
    expect(
      await callTool(
        refusing("launch_busy", "4 launches are running"),
        "mcp__ccmsg-v1__launch",
        input,
      ),
    ).toBe(
      "ccmsg の daemon が起動を断ったので、起動していない (launch_busy): 4 launches are running",
    );
    // An op that threw may have run the command: the same words the webui
    // shows (launchErrorText), with what to do next.
    expect(
      await callTool(refusing("internal", "spawn broke"), "mcp__ccmsg-v1__launch", input),
    ).toBe("起動したか確かめられなかった: spawn broke。`peers` で確かめる");
    const nodaemon = toolFake(async () => ({ exitCode: 3, stdout: "", stderr: "no daemon\n" }));
    expect(await callTool(nodaemon, "mcp__ccmsg-v1__launch", input)).toBe(
      "ccmsg の daemon に繋がらず、起動していない: no daemon",
    );
    const silent = toolFake(async () => ({ exitCode: 1, stdout: "", stderr: "" }));
    expect(await callTool(silent, "mcp__ccmsg-v1__launch", input)).toBe(
      "ccmsg が起動の結果を返さなかった。起動したか確かめられなかった。`peers` で確かめる",
    );
    // The wait ran out (or the command could not be run): it may have started.
    const overran = toolFake(async () => {
      throw new Error("aborted: still running after 65000ms");
    });
    expect(await callTool(overran, "mcp__ccmsg-v1__launch", input)).toBe(
      "ccmsg sidecar launch が 65 秒以内に終わらなかったか起動できなかった: Error: aborted: still running after 65000ms。起動したか確かめられなかった。`peers` で確かめる",
    );
  });

  test("a launch whose handler fails is answered by its .catch", async () => {
    const fake = toolFake(async () => {
      throw new Error("run broke");
    });
    fake.$.ui = {
      log: () => {
        throw new Error("log broke");
      },
    };
    expect(
      await callTool(fake, "mcp__ccmsg-v1__launch", {
        tool: "mcp__ccmsg-v1__launch",
        cwd: "/w",
        continue: true,
      }),
    ).toBe("ccmsg の launch が途中で止まった。起動したか確かめられなかった。`peers` で確かめる");
  });

  // permit hands the request to `ccmsg sidecar permit` on standard input,
  // the engine's own fields of the call left out (DR-0040 §2).
  test("permit hands the request to ccmsg sidecar permit and says it was asked", async () => {
    const seen: { argv: readonly string[]; stdin?: string; timeoutMs?: number }[] = [];
    const fake = toolFake(async (argv, init) => {
      seen.push({ argv, ...init });
      return printing({ ok: true, id: "0f0f/1" })();
    });
    const result = await callTool(fake, "mcp__ccmsg-v1__permit", {
      blocked: "`git push` が止められた",
      attachments: ["/w/policy.json"],
      commands: [{ command: "git push origin main", description: "main を公開する" }],
      tool: "mcp__ccmsg-v1__permit",
      tool_use_id: "toolu_1",
    });
    expect(seen).toEqual([
      {
        argv: ["/plugin/bin/ccmsg", "sidecar", "permit", "--sid", fake.sid.value],
        stdin: JSON.stringify({
          blocked: "`git push` が止められた",
          attachments: ["/w/policy.json"],
          commands: [{ command: "git push origin main", description: "main を公開する" }],
        }),
        timeoutMs: PERMIT_TIMEOUT_MS,
      },
    ]);
    // The model is told the request went out, nothing of the files.
    expect(result).toBe("許可依頼を出した");
  });

  // Nothing to permit, a path that is not absolute, a field of another
  // type, a command that is its text alone or has none: answered in text,
  // and nothing runs.
  test("an input that is not permit's is answered in text, and nothing runs", async () => {
    const fake = toolFake(printing({ ok: true, id: "0f0f/1" }));
    for (const input of [
      { blocked: "x" },
      { blocked: "x", intents: [], commands: [] },
      { blocked: "", commands: [{ command: "ls" }] },
      { blocked: "x", commands: [{ command: "ls" }], attachments: ["rel/a.ts"] },
      { blocked: "x", commands: "ls" },
      { blocked: "x", commands: ["ls"] },
      { blocked: "x", commands: [{ description: "一覧" }] },
      {},
    ]) {
      expect(await callTool(fake, "mcp__ccmsg-v1__permit", input)).toContain(
        "permit の入力が形に合わない",
      );
    }
    expect(fake.runs).toEqual([]);
  });

  // The person's permission is written to the session, which only the main
  // thread reads: a subagent hands the stopped action to its delegator.
  test("a subagent's permit is refused, and nothing runs", async () => {
    const fake = toolFake(printing({ ok: true, id: "0f0f/1" }));
    expect(
      await callTool(fake, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        commands: [{ command: "ls" }],
        agentId: "a1b2",
      }),
    ).toContain("permit は subagent からは使えない");
    expect(fake.runs).toEqual([]);
  });

  test("a permit with no daemon, or one the daemon refused, says it was not asked", async () => {
    const unreachable = toolFake(async () => ({
      exitCode: 3,
      stdout: "",
      stderr: "ccmsg sidecar permit: the daemon could not be reached: ECONNREFUSED\n",
    }));
    expect(
      await callTool(unreachable, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        commands: [{ command: "ls" }],
      }),
    ).toBe(
      "ccmsg の daemon に繋がらず、許可依頼を出していない: ccmsg sidecar permit: the daemon could not be reached: ECONNREFUSED",
    );
    const refused = toolFake(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ ok: false, error: { code: "invalid_args", msg: "op: unknown op: permit_request" } })}\n`,
    }));
    expect(
      await callTool(refused, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        commands: [{ command: "ls" }],
      }),
    ).toBe("許可依頼を出せなかった: op: unknown op: permit_request");
  });

  test("a permit whose command did not end in time says it is unknown whether it was asked", async () => {
    const fake = toolFake(async () => {
      throw new Error("timed out");
    });
    expect(
      await callTool(fake, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        commands: [{ command: "ls" }],
      }),
    ).toBe(
      `ccmsg sidecar permit が ${String(PERMIT_TIMEOUT_MS / 1000)} 秒以内に終わらなかったか起動できず、許可依頼が出たか確かめられなかった: Error: timed out`,
    );
  });

  test("peers the daemon refused says the daemon's reason, not its JSON", async () => {
    const fake = toolFake(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ ok: false, error: { code: "invalid_args", msg: "op: unknown op: peer_list" } })}\n`,
    }));
    expect(await callTool(fake, "mcp__ccmsg-v1__peers", {})).toBe(
      "一覧を返せなかった: op: unknown op: peer_list",
    );
  });
});

describe("putting the draft back", () => {
  // The person started typing something new while the filled prompt went in:
  // what they type now wins, and the old draft goes to the debug log.
  test("does not overwrite text typed meanwhile", async () => {
    const fake = fakeEngine({
      draft: "old draft",
      onEnter: async (f) => {
        await fire(f, "prompt.submit", submitted(f.composer.text), async (e) => {
          f.composer.text = "typed meanwhile";
          return entered(e);
        });
        return 0;
      },
    });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "accepted",
    });
    expect(fake.composer.text).toBe("typed meanwhile");
    expect(fake.logs.some((l) => l.includes("old draft"))).toBe(true);
  });
});

describe("pure helpers", () => {
  test("hyouiEnterArgv names the terminal by its session id alone", () => {
    expect(hyouiEnterArgv("t")).toEqual(["hyoui", "input", "t", "key:Enter"]);
  });

  test("replyArgv names the session and carries nothing of the reply", () => {
    expect(replyArgv("/p", "s")).toEqual(["/p/bin/ccmsg", "sidecar", "reply", "--sid", "s"]);
  });

  // As measured for UserPromptSubmit: the harness hands on the prompt with
  // trailing whitespace dropped, and nothing else changed. prompt.submit's
  // text is held to the same allowance.
  test("samePrompt allows only trailing whitespace dropped by the harness", () => {
    expect(samePrompt("a b\n", "a b\n")).toBe(true);
    expect(samePrompt("a b", "a b\n")).toBe(true);
    expect(samePrompt("a b", "a b \t　")).toBe(true);
    expect(samePrompt("a b\n", "a b")).toBe(false);
    expect(samePrompt("a b", "  a b")).toBe(false);
    expect(samePrompt("a\nb", "a\n\nb")).toBe(false);
    expect(samePrompt("a  b", "a b")).toBe(false);
  });

  test("lineSplitter joins pieces and drops blank lines", () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed("a\nb");
    feed("c\n\n");
    expect(lines).toEqual(["a", "bc"]);
  });
});
