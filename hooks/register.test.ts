// The hooks module of DR-0035 against a stand-in engine: what it does to the
// composer, what it runs, and what it replies, for each request and each way a
// prompt.send can go. What a request line must be to run, and which code
// refuses it, is the protocol's (packages/protocol/test/sidecar.test.ts); here
// it is how the module answers.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { type JsonObject, JsonObjectSchema } from "@ccmsg/protocol";
import { stateDirOf } from "@ccmsg/protocol/module-op";
import { NOTHING_TO_REPLY_TEXT } from "@ccmsg/protocol/nothing-to-reply";
import { errorText, jsonText, parseWith } from "@ccmsg/protocol/parse";
import { CCMSG_TOOLS } from "@ccmsg/protocol/peer-tools";
import { UNCONFIRMED_ADVICE } from "@ccmsg/protocol/peer-tools-text";
import {
  PERMIT_ITEM_TEXT_MAX_LENGTH,
  PERMIT_VOICE_MAX_LENGTH,
} from "@ccmsg/protocol/permit-request";
import { PROTOCOL_VERSION } from "@ccmsg/protocol/protocol-version";
import {
  AGENT_APPEND_MARK,
  type DescribeResult,
  type SessionFacts,
  SessionFactsSchema,
  SIDECAR_OP_NAMES,
  type SidecarReply,
  SidecarReplySchema,
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
import { GUIDANCE, guidanceText, GUIDED_TTL_MS, PING_TIMEOUT_MS } from "./guidance.ts";
import {
  ACCEPT_WAIT_MS,
  handlePromptSend,
  hyouiEnterArgv,
  hyouiShellModeArgv,
  PromptSubmitInputSchema,
  type QueuedSend,
  samePrompt,
} from "./prompt-send.ts";
import { beginArgv } from "./session-lifecycle.ts";
import { RENAME_WAIT_MS } from "./session-rename.ts";
import { answer, lineSplitter, RESPAWN_MIN_MS } from "./sidecar.ts";
import { FORK_TURN_WAIT_MS, forksForPlugins } from "./fork-ask.ts";
import { agentMessage } from "./subagents.ts";
import { PERMIT_TIMEOUT_MS } from "./tools.ts";

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
    "prompt.change": [],
    "turn.start": [],
    "turn.complete": [],
    "session.append": [],
    "turn.step": [],
    "tool.call": [],
    "tool.run": [],
    "agent.report": [],
  };
}
/** What a ccmsg command the module runs answers. */
type CommandRun = { exitCode: number; stdout: string; stderr: string };

/** What the daemon's `POST /op` answers (DR-0046). */
type OpAnswer = { status: number; text: string };

/** A `POST /op` body, as far as the fake daemon tells requests apart: the
 * op, and the session the hello names. */
const OpRequestSchema = v.object({
  op: v.string(),
  hello: v.object({ sid: v.string() }),
});
const FactsRequestSchema = v.object({ facts: SessionFactsSchema });
const ReplyRequestSchema = v.object({ reply: SidecarReplySchema });
const OpBodyTextSchema = jsonText(JsonObjectSchema);

interface Fake {
  $: Engine;
  composer: { text: string };
  /** What the session says of itself through `$.session`. */
  session: { model: string; window: number; root: string };
  /** The facts each `session_facts` to the daemon carried, with the sid its
   * hello named, in order. Kept apart from `asked`: they go with every
   * session event, and what a test of the other requests asks is told
   * without them. */
  factsSent: { sid: string; facts: SessionFacts }[];
  /** Each `POST /op` the module made other than `session_facts`,
   * `sidecar_reply` and `ping`: the socket and the body, in order. */
  asked: { socketPath: string | undefined; body: JsonObject }[];
  /** Each reply the module handed the daemon (`sidecar_reply`), with the sid
   * its hello named, in order. Kept apart from `asked` as the facts are. */
  replies: { sid: string; reply: SidecarReply }[];
  /** The bodies of each `transcript_push` the module asked, in order. */
  pushes: JsonObject[];

  /** Each `ccmsg sidecar begin` the module ran, with the sid and the cwd it
   * named, in order. Kept apart from `runs` as the facts are. */
  begins: { sid: string; cwd: string }[];
  /** The commands the module ran other than `ccmsg sidecar begin` and the
   * two that check its terminal (`checks`). */
  runs: string[][];
  /** The commands the module ran to check that the terminal it would press
   * keys on is its own (`hyoui status` and the shell that prints the
   * claude's pid), in order. Kept apart from `runs`, which are the keys and the commands each
   * request runs. */
  checks: string[][];
  /** How many times the module asked the daemon `ping`. Kept apart from
   * `asked` as the facts are: it goes with the guidance, before a prompt. */
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
  /** Each message the module sent to an agent with `$.session.send`. */
  agentSends: { agentId: string; text: string }[];
  /** The session's subagents as `$.agent.list()` says; a running one's
   * conversation takes an append, any other id is refused as Claude Code
   * refuses it. A send reaches any of them, running or not; any other id has
   * no transcript to resume, as Claude Code says. */
  agents: { id: string; description: string; type: string; status: string; spawnedBy?: string }[];
  /** This plugin's `$.store`, which outlives the process: a session resumed
   * in another process is given the same one. */
  store: Map<string, unknown>;
  /** The tools the module registered (`$.tool.register`), in order. */
  tools: { name: string; description: string; inputSchema: object; isDeferred: boolean }[];
  sid: { value: string };
  fills: string[];
  logs: string[];
  /** The turn ids the module asked `$.turn.abort` to stop, in order. */
  aborts: string[];
  /** What the module asked `$.agent.spawn`, in order. */
  agentSpawns: { prompt: string; description?: string; subagentType?: string }[];
  /** The tool calls the module made with `$.agent.call`, in order. */
  agentCalls: { tool: string; input: Record<string, string> }[];
  /** The slash commands the module ran with `$.command.run`, in order. */
  commandRuns: { command: string; args?: string }[];
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
    /** What the terminal does with the keys hyoui sends it (`argv` is the
     * `hyoui input` command): Enter, or for a bash mode command first the
     * `!`. */
    onEnter?: (fake: Fake, argv: readonly string[]) => Promise<number>;
    /** What `ccmsg version` does: print this, or throw. */
    version?: string | Error;
    /** What the ccmsg command a tool runs (`sidecar launch`, `sidecar permit`,
     * `say`) does, given its argv and what it was run with. */
    command?: (
      argv: readonly string[],
      init: { stdin?: string; timeoutMs?: number; env?: Record<string, string> },
    ) => Promise<CommandRun>;
    /** The plugin's store as an earlier process left it. */
    store?: Map<string, unknown>;
    /** What `hyoui status <id> --format json` does: exit with this code
     * and print this, or throw; a function answers each call in turn. The
     * default is a terminal whose child is pid 4242, this claude
     * (`parentPid`). */
    hyouiStatus?: CommandRun | Error | (() => CommandRun | Error);
    /** What the shell that prints its parent's pid (`echo $PPID`, the
     * claude's pid) does: exit with this code and print this, or throw. The
     * default prints 4242, the pid of the terminal's child (`hyouiStatus`). */
    parentPid?: CommandRun | Error;
    /** Whether the session runs under sandbox-exec, which refuses to run a
     * setuid program such as `/bin/ps` (measured on macOS 26). */
    sandboxed?: boolean;
    /** What the daemon's `ping` answers: a reply with this `webui_url`
     * (none when undefined), or the fetch rejects. */
    webuiUrl?: string | Error;
    /** What the daemon answers a `POST /op` other than `session_facts` and
     * `ping` with, given the body. */
    daemon?: (body: JsonObject) => Promise<OpAnswer>;
    /** The daemon's sockets in the state dir: both (`up`, the default), none
     * (`none`), or the wire's alone (`old`, a daemon from before `POST /op`).
     * Without `http.sock` every fetch rejects as the engine's does. */
    sockets?: "up" | "none" | "old";
    /** What `$.turn.abort` does with the id it is given: resolve when
     * absent. */
    abort?: (turnId: string) => Promise<void>;
    /** What `$.session.version()` answers: 2.1.330 when absent. */
    engineVersion?: { version: string; base?: string };
    /** What `$.agent.spawn` resolves to for a request: a started agent
     * `a<n>` (n from 1) when absent. */
    agentSpawn?: (args: {
      prompt: string;
      description?: string;
      subagentType?: string;
    }) => Promise<{ model: string; agentId?: string } | { deny: string }>;
    /** What `$.agent.call` resolves to: the tool's text when absent. */
    agentCall?: (args: {
      tool: string;
      input: Record<string, string>;
    }) => Promise<{ deny: string } | { isError?: boolean; text?: string }>;
    /** What `$.command.run` does with the command it is given: resolve at
     * once when absent. */
    commandRun?: (input: { command: string; args?: string }) => Promise<unknown>;
    /** The files `$.fs` holds, by absolute path: a text is the file's, an
     * Error is what reading it rejects with. The plugin's package.json is
     * there unless given. */
    files?: Record<string, string | Error>;
    /** What the daemon answers a `transcript_push` with, given the body: ok
     * when absent. */
    pushed?: (body: JsonObject) => Promise<{ status: number; text: string }>;
  } = {},
): Fake {
  // HYOUI_NAMESPACE is still exported by environments set up for older hyoui;
  // the default env carries it so every Enter below shows it is not passed on.
  const env: Record<string, string | undefined> = options.env ?? {
    HOME: "/home/k",
    HYOUI_SESSION_ID: "term-1",
    HYOUI_NAMESPACE: "ns-1",
  };
  let now = 0;
  const composer = { text: options.draft ?? "" };
  const runs: string[][] = [];
  const checks: string[][] = [];
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
  const agentSends: Fake["agentSends"] = [];
  const agents: Fake["agents"] = [];
  const aborts: string[] = [];
  const agentSpawns: Fake["agentSpawns"] = [];
  const agentCalls: Fake["agentCalls"] = [];
  const commandRuns: Fake["commandRuns"] = [];
  const store = options.store ?? new Map<string, unknown>();
  const files: Record<string, string | Error> = {
    "/plugin/package.json": '{ "name": "ccmsg", "version": "9.9.9" }',
    ...options.files,
  };
  const asked: Fake["asked"] = [];
  const replies: Fake["replies"] = [];
  const pushes: Fake["pushes"] = [];
  const sockets = options.sockets ?? "up";
  const stateDir = (): string =>
    stateDirOf(
      { CCMSG_STATE_DIR: env.CCMSG_STATE_DIR, XDG_STATE_HOME: env.XDG_STATE_HOME },
      env.HOME ?? "",
    );
  const socketThere = (file: string): boolean =>
    (sockets === "up" && file === `${stateDir()}/http.sock`) ||
    (sockets !== "none" && file === `${stateDir()}/daemon.sock`);
  const answering = (status: number, reply: object) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { "content-type": "application/json" },
    text: JSON.stringify(reply),
  });
  const $: Engine = {
    plugin: { root: "/plugin" },
    session: {
      id: async () => sid.value,
      root: async () => session.root,
      surfaces: async () => options.surfaces ?? ["terminal"],
      model: async () => session.model,
      usage: async () => ({ context: { window: session.window } }),
      version: async () =>
        options.engineVersion ?? { version: "2.1.330 (Claude Code)", base: "2.1.330" },
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
      send: async ({ to, text }) => {
        if (!agents.some((a) => a.id === to.agentId)) {
          return {
            isDelivered: false,
            reason: `Agent "${to.agentId}" could not be resumed: No transcript found for agent ID: ${to.agentId}.`,
          };
        }
        agentSends.push({ agentId: to.agentId, text });
        return { isDelivered: true };
      },
    },
    turn: {
      abort: async ({ turnId }) => {
        aborts.push(turnId);
        await options.abort?.(turnId);
      },
    },
    command: {
      run: async (input) => {
        commandRuns.push(input);
        return (await options.commandRun?.(input)) ?? {};
      },
    },
    agent: {
      list: async () => agents.map((a) => ({ ...a })),
      spawn: async (args) => {
        agentSpawns.push(args);
        return (
          (await options.agentSpawn?.(args)) ?? {
            model: "claude-opus-5-5",
            agentId: `a${String(agentSpawns.length)}`,
          }
        );
      },
      call: async (args) => {
        agentCalls.push(args);
        return (await options.agentCall?.(args)) ?? { text: "stopped" };
      },
    },
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
      fill: async ({ text, mode }) => {
        if (options.refusal) {
          return { isFilled: false, refusal: options.refusal, text: composer.text };
        }
        fills.push(text);
        composer.text = mode === "append" ? composer.text + text : text;
        return { isFilled: true, text: composer.text };
      },
    },
    process: {
      run: async (argv, init) => {
        if (argv[1] === "sidecar" && argv[2] === "begin") {
          begins.push({ sid: flagOf(argv, "--sid"), cwd: flagOf(argv, "--cwd") });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "hyoui" && argv[1] === "status") {
          checks.push([...argv]);
          const given =
            typeof options.hyouiStatus === "function" ? options.hyouiStatus() : options.hyouiStatus;
          const status = given ?? {
            exitCode: 0,
            stdout: `{"session_id":"${argv[2] ?? ""}","daemon_pid":4241,"child_pid":4242,"child_pgid":4242,"child_stopped":false,"child_state":"running"}\n`,
            stderr: "",
          };
          if (status instanceof Error) throw status;
          return status;
        }
        if (argv[0] === "/bin/sh" && argv[2]?.includes("echo $PPID")) {
          checks.push([...argv]);
          const parent = options.parentPid ?? { exitCode: 0, stdout: "4242\n", stderr: "" };
          if (parent instanceof Error) throw parent;
          return parent;
        }
        if (argv[0] === "/bin/sh") {
          checks.push([...argv]);
          if (options.sandboxed === true) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "/bin/sh: /bin/ps: Operation not permitted\n",
            };
          }
          return { exitCode: 0, stdout: " 4242\n", stderr: "" };
        }
        runs.push([...argv]);
        stdins.push(init?.stdin);
        if (argv[0] === "hyoui") {
          const exitCode = options.onEnter ? await options.onEnter(fake, argv) : 0;
          return { exitCode, stdout: "", stderr: "" };
        }
        if (argv[2] === "launch" || argv[2] === "permit") {
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
    http: {
      fetch: async (url, init) => {
        if (!socketThere(init?.socketPath ?? "")) {
          throw new Error(
            `HooksError: ccmsg: $.http.fetch(${url}) over ${init?.socketPath ?? "?"} failed: ENOENT: ENOENT`,
          );
        }
        const body = parseWith(OpBodyTextSchema, init?.body ?? "");
        if (!body.ok) throw new Error(`not a body of POST /op: ${body.failure.summary}`);
        const request = parseWith(OpRequestSchema, body.value);
        if (!request.ok) throw new Error(`not a request of POST /op: ${request.failure.summary}`);
        if (request.value.op === "session_facts") {
          const read = parseWith(FactsRequestSchema, body.value);
          if (!read.ok) throw new Error(`facts not readable: ${read.failure.summary}`);
          factsSent.push({ sid: request.value.hello.sid, facts: read.value.facts });
          return answering(200, { ok: true, request_id: "op" });
        }
        if (request.value.op === "sidecar_reply") {
          const read = parseWith(ReplyRequestSchema, body.value);
          if (!read.ok) throw new Error(`reply not readable: ${read.failure.summary}`);
          replies.push({ sid: request.value.hello.sid, reply: read.value.reply });
          return answering(200, { ok: true, request_id: "op" });
        }
        if (request.value.op === "transcript_push") {
          pushes.push(body.value);
          if (options.pushed === undefined) return answering(200, { ok: true, request_id: "op" });
          const answered = await options.pushed(body.value);
          return {
            ...answered,
            ok: answered.status >= 200 && answered.status < 300,
            headers: { "content-type": "application/json" },
          };
        }
        if (request.value.op === "ping") {
          statuses.count += 1;
          const webuiUrl = options.webuiUrl;
          if (webuiUrl instanceof Error) throw webuiUrl;
          const pong = { ok: true, request_id: "op", pong: true, http: ["127.0.0.1:8642"] };
          return answering(200, webuiUrl === undefined ? pong : { ...pong, webui_url: webuiUrl });
        }
        asked.push({ socketPath: init?.socketPath, body: body.value });
        if (options.daemon === undefined) throw new Error(`no daemon here for ${request.value.op}`);
        const answered = await options.daemon(body.value);
        return {
          ...answered,
          ok: answered.status >= 200 && answered.status < 300,
          headers: { "content-type": "application/json" },
        };
      },
    },
    fs: {
      exists: async (path) => path in files || socketThere(path),
      read: async (path) => {
        const file = files[path];
        if (file === undefined) throw new Error(`HooksError: $.fs.read(${path}) failed: ENOENT`);
        if (file instanceof Error) throw file;
        return file;
      },
    },
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
    asked,
    replies,
    pushes,
    begins,
    runs,
    checks,
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
    agentSends,
    agents,
    store,
    aborts,
    agentSpawns,
    agentCalls,
    commandRuns,
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

/** Run the module's tool `tool` with input `e` as the engine does once the
 * call went through permission (`tool.run`, DR-0066 K12): the hook answers
 * without `next`, and when it throws its `.catch` answers. */
async function runTool<E>(fake: Fake, tool: ToolName, e: E): Promise<string> {
  const at = fake.hooks["tool.run"].findIndex(([matcher]) => matcher.tool === tool);
  const hook = fake.hooks["tool.run"][at]?.[1];
  if (hook === undefined) throw new Error(`no tool.run hook on ${tool}`);
  const next = async (): Promise<ToolAnswer> => {
    throw new Error(`${tool} ran next`);
  };
  try {
    return (await hook(fake.$, e, next)).result;
  } catch (error) {
    const handler = fake.catchers["tool.run"][at];
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

/** The reply the module handed the daemon after the first `from`, once it
 * has. */
async function nextReply(fake: Fake, from = 0): Promise<SidecarReply> {
  for (let i = 0; i < 20 && fake.replies.length <= from; i++) await settle();
  const sent = fake.replies[from];
  if (sent === undefined) throw new Error(`no reply after #${String(from)}`);
  return sent.reply;
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
    const at = held.push(args) - 1;
    fake.registered.push(event);
    return {
      // At the hook's own index: a hook with no `.catch` leaves its slot
      // empty, so the next hook's catcher still lines up with it.
      catch: (handler) => {
        const caught: HookOf[typeof event][] = fake.catchers[event];
        caught[at] = handler;
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

  // Measured on 2.1.330: a prompt entered during a turn is taken with the
  // whitespace at both of its ends dropped. Its submit is the filled text's.
  test("accepted while a turn runs: the submit lost the whitespace at the text's ends", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        const taken = { ...submitted(f.composer.text.trim()), turnId: "t1" };
        await fire(f, "prompt.submit", taken, entered);
        f.composer.text = "";
        return 0;
      },
    });
    const state = registerOn(fake);
    const request = queued(fake, state, "  indented\n\tbody\n");
    expect(await handlePromptSend(fake.$, state, request)).toEqual({ outcome: "accepted" });
    expect(fake.fills).toEqual(["  indented\n\tbody\n"]);
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

/** What the terminal does with a bash mode command's keys: the `!` shows the
 * composer in bash mode (hyoui's wait sees it), and Enter takes the command
 * out of the composer, which the harness tells only as prompt.change with
 * `origin.kind: "clear"` (docs/findings/2026-11-06-permit-bang-run.md). */
async function runOnEnter(fake: Fake, argv: readonly string[]): Promise<number> {
  if (argv.includes("key:Enter")) {
    fake.composer.text = "";
    await fire(fake, "prompt.change", CLEARED, async (e) => ({ text: e.text }));
  }
  return 0;
}

/** prompt.change as the harness raises it when a submit took the draft. */
const CLEARED = { text: "", cursor: 0, origin: { kind: "clear" } };

/** A bash mode command as the module queues it. */
function queuedBash(fake: Fake, state: ModuleState, text: string): QueuedSend {
  return { ...queued(fake, state, text), mode: "bash" };
}

// A bash mode command (`mode: "bash"`, DR-0035 §3) goes in as the person's
// `! <command>`: the composer emptied, `!` pressed and its switch to bash mode
// waited for, the command appended, then Enter. Its Enter raises no
// prompt.submit; the composer emptied by it is the acceptance.
describe("handlePromptSend: a bash mode command", () => {
  test("accepted: `!` and its switch, the command appended, Enter, then the draft goes back", async () => {
    const fake = fakeEngine({ draft: "half typed 書きかけ", onEnter: runOnEnter });
    const state = registerOn(fake);
    const report = await handlePromptSend(fake.$, state, queuedBash(fake, state, "ls -la"));
    expect(report).toEqual({ outcome: "accepted" });
    expect(fake.runs).toEqual([
      ["hyoui", "input", "term-1", "text:!", "wait:─\\n!\\x{a0}", "--timeout", "1s"],
      ["hyoui", "input", "term-1", "key:Enter"],
    ]);
    expect(fake.runs[0]).toEqual(hyouiShellModeArgv("term-1"));
    await settle();
    // Emptied (leaving bash mode, so the `!` switches into it), the command
    // appended after the `!`, then the draft back once Enter took it.
    expect(fake.fills).toEqual(["", "ls -la", "half typed 書きかけ"]);
    expect(fake.composer.text).toBe("half typed 書きかけ");
    expect(state.awaiting).toBeUndefined();
    expect(state.restoring).toBeUndefined();
  });

  test("the `!` not seen to switch: enter_failed, no Enter, the draft goes back", async () => {
    const fake = fakeEngine({
      draft: "keep",
      onEnter: async (_f, argv) => (argv.includes("text:!") ? 1 : 0),
    });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queuedBash(fake, state, "ls"))).toEqual({
      outcome: "not_delivered",
      reason: "enter_failed",
    });
    expect(fake.runs).toEqual([hyouiShellModeArgv("term-1")]);
    expect(fake.fills).toEqual(["", "keep"]);
    expect(fake.composer.text).toBe("keep");
  });

  test("a dialog refuses the emptying fill: no key is pressed, the reason is reported", async () => {
    const fake = fakeEngine({ draft: "keep", refusal: "dialog" });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queuedBash(fake, state, "ls"))).toEqual({
      outcome: "not_delivered",
      reason: "dialog",
    });
    expect(fake.runs).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  // The command never went in: the draft goes back and it is known not to be
  // delivered.
  test("a dialog refusing the command after the switch: the draft goes back, the reason is reported", async () => {
    const fake = fakeEngine({ draft: "keep", onEnter: runOnEnter });
    const state = registerOn(fake);
    const prompt = fake.$.prompt;
    const fill = (input: Parameters<typeof prompt.fill>[0]) => prompt.fill(input);
    fake.$.prompt = { ...prompt };
    fake.$.prompt.fill = async (input) =>
      input.mode === "append" ? { isFilled: false, refusal: "dialog", text: "" } : fill(input);
    expect(await handlePromptSend(fake.$, state, queuedBash(fake, state, "ls"))).toEqual({
      outcome: "not_delivered",
      reason: "dialog",
    });
    expect(fake.runs).toEqual([hyouiShellModeArgv("term-1")]);
    expect(fake.composer.text).toBe("keep");
  });

  // A prompt.submit of the same text is a prompt someone typed, not the bash
  // mode command: the command stayed in the composer and is taken back out.
  test("a prompt.submit of the same text is not its acceptance: not_submitted", async () => {
    const fake = fakeEngine({
      draft: "keep",
      onEnter: async (f, argv) => {
        if (argv.includes("key:Enter")) {
          await fire(f, "prompt.submit", submitted(f.composer.text), entered);
        }
        return 0;
      },
    });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queuedBash(fake, state, "ls"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "not_submitted" });
    expect(fake.composer.text).toBe("keep");
  });

  // Bash mode raises no prompt.submit, which is where the one-shot override
  // is armed: it is not carried with the command.
  test("the one-shot override does not ride on a bash mode command", async () => {
    let awaited: ModuleState["awaiting"];
    const fake = fakeEngine({
      onEnter: async (f, argv) => {
        if (argv.includes("key:Enter")) awaited = state.awaiting;
        return runOnEnter(f, argv);
      },
    });
    const state = registerOn(fake);
    const request = { ...queuedBash(fake, state, "ls"), override: { effort: "low" } } as const;
    expect(await handlePromptSend(fake.$, state, request)).toEqual({ outcome: "accepted" });
    expect(awaited?.mode).toBe("bash");
    expect(awaited?.override).toBeUndefined();
  });

  // The emptied composer accepts only a bash mode command: a prompt is
  // accepted by its submit alone.
  test("a composer emptied with no submit does not accept a prompt", async () => {
    const fake = fakeEngine({ onEnter: runOnEnter });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "ls"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "unconfirmed" });
  });

  test("a clear with nothing awaited puts nothing back", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.restoring = { text: "mine", draft: "draft" };
    await fire(fake, "prompt.change", CLEARED, async (e) => ({ text: e.text }));
    for (const kind of ["plugin", "engine", "history"]) {
      await fire(fake, "prompt.change", { ...CLEARED, origin: { kind } }, async (e) => e);
    }
    await settle();
    expect(fake.fills).toEqual([]);
    expect(state.restoring).toEqual({ text: "mine", draft: "draft" });
  });

  test("a prompt.send line with mode bash runs as a bash mode command", async () => {
    const fake = fakeEngine({ onEnter: runOnEnter });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    spawned(fake, 0).stream.push(
      '{"v":1,"op":"prompt.send","id":"b1","args":{"text":"ls -la","mode":"bash"}}\n',
    );
    expect(await nextReply(fake)).toEqual({ id: "b1", ok: true, result: { outcome: "accepted" } });
    expect(fake.runs).toEqual([hyouiShellModeArgv("term-1"), hyouiEnterArgv("term-1")]);
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
    expect(await nextReply(fake)).toEqual({
      id: "r9",
      ok: true,
      result: { outcome: "accepted" },
    });
    expect(fake.replies.map((r) => r.sid)).toEqual([fake.sid.value]);
    expect(fake.runs).toEqual([["hyoui", "input", "term-1", "key:Enter"]]);
  });

  // The sidecar names the run to the daemon with what the module itself
  // knows — the config dir as `$.env.get` reads it, the terminal checked to
  // be its own, and when the module was loaded — and not the pid: the daemon
  // finds the pid itself.
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
    expect(await nextReply(fake)).toEqual({
      id: "old",
      ok: true,
      result: { outcome: "not_delivered", reason: "session_changed" },
    });
    expect(fake.fills).toEqual([]);
    // Answered under the id the request came to, which the daemon pairs it
    // with: the same process ran it (DR-0046 §3).
    expect(fake.replies.map((r) => r.sid)).toEqual([oldSid]);
    expect(fake.runs).toEqual([]);
  });
});

/** Start a sidecar, write `line` to the module, and return the reply it
 * handed the daemon. */
async function replyTo(fake: Fake, line: string): Promise<SidecarReply> {
  await fire(fake, "session.start", START, async () => ({}));
  await settle();
  const from = fake.replies.length;
  spawned(fake, 0).stream.push(`${line}\n`);
  return nextReply(fake, from);
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
      // agent.send names its sender (DR-0039 §3).
      '{"v":1,"op":"agent.send","id":"s0","args":{"agentId":"a1","text":"x"}}',
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
    fake.$.http = {
      fetch: async () => {
        throw new Error("aborted: no complete answer within 30000ms");
      },
    };
    const state = registerOn(fake);
    expect(
      await answer(fake.$, state, fake.sid.value, 0, '{"v":1,"op":"describe","id":"q6","args":{}}'),
    ).toBeUndefined();
    expect(fake.logs).toContain(
      "ccmsg: reply q6 not sent: Error: aborted: no complete answer within 30000ms",
    );
  });

  test("describe lists the ops and the ccmsg version beside the module", async () => {
    const fake = fakeEngine({ version: "1.2.3" });
    registerOn(fake);
    const reply = await replyTo(fake, '{"v":1,"op":"describe","id":"d1","args":{}}');
    const result: DescribeResult = {
      v: [1],
      ops: [
        "describe",
        "prompt.send",
        "session.facts",
        "agent.append",
        "agent.send",
        "agent.wake",
        "notice.append",
        "request.override",
        "turn.abort",
        "session.rename",
        "fork.ask",
        "fork.stop",
      ],
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

/** The facts the latest `session_facts` carried. */
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

/** The facts the `index`th `session_facts` carried. */
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

  // A later request of a turn comes with the turn's effort as the engine kept
  // it from the first request, which an override may have changed: only the
  // first request says the session's own (DR-0060 §6).
  test("only a turn's first request moves the effort", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    const step = { turnId: "t", model: "m", messageCount: 1 };
    await fireStep(fake, { ...step, index: 0, effort: "low" }, [], {});
    await untilFacts(fake, 1);
    await fireStep(fake, { ...step, index: 1, effort: "xhigh" }, [], {});
    await fireStep(fake, { ...step, index: 2, effort: "xhigh" }, [], {});
    await settle();
    expect(fake.factsSent.length).toBe(1);
    expect(factsAt(fake, 0).facts.effort).toBe("low");
    await fireStep(
      fake,
      { turnId: "u", model: "m", messageCount: 1, index: 0, effort: "high" },
      [],
      {},
    );
    await untilFacts(fake, 2);
    expect(factsAt(fake, 1).facts.effort).toBe("high");
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
    const read = parseWith(SessionFactsSchema, reply.result);
    if (!read.ok) throw new Error(read.failure.summary);
    expect(read.value.model).toBe("claude-opus-5-5[1m]");
    expect(read.value.context?.window).toBe(1_000_000);
  });

  // One send at a time, and changes while one runs cost one more send, which
  // carries the latest of them.
  test("changes during a send are sent once, as they stand when it starts", async () => {
    const fake = fakeEngine();
    const gate = Promise.withResolvers<void>();
    const http = fake.$.http;
    let held = 0;
    fake.$.http = {
      fetch: async (url, init) => {
        if (init?.body?.includes('"op":"session_facts"') === true && held++ === 0) {
          await gate.promise;
        }
        return http.fetch(url, init);
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
    fake.$.http = {
      fetch: async () => {
        throw new Error("aborted: no complete answer within 30000ms");
      },
    };
    registerOn(fake);
    const { calls, next } = countingNext();
    await fire(fake, "session.measure", { context: { window: 1 } }, next);
    expect(calls.count).toBe(1);
    for (let i = 0; i < 10 && !fake.logs.some((l) => l.includes("facts not sent")); i++) {
      await settle();
    }
    expect(fake.logs).toContain(
      "ccmsg: facts not sent: Error: aborted: no complete answer within 30000ms",
    );
  });

  // The facts start no daemon (DR-0035 §3): with none running they are
  // dropped without a word, and the next daemon asks for them. One the daemon
  // refuses is logged.
  test("facts with no daemon running are dropped quietly; facts refused are logged", async () => {
    const stopped = fakeEngine({ sockets: "none" });
    registerOn(stopped);
    await fire(stopped, "session.measure", { context: { window: 1 } }, async () => ({}));
    await settle();
    await settle();
    expect(stopped.factsSent).toEqual([]);
    expect(stopped.logs.filter((l) => l.includes("facts"))).toEqual([]);
    const refusing = fakeEngine();
    const http = refusing.$.http;
    refusing.$.http = {
      fetch: async (url, init) =>
        init?.body?.includes('"op":"session_facts"') === true
          ? {
              status: 200,
              ok: true,
              headers: {},
              text: '{"ok":false,"error":{"code":"bad_request","msg":"no"},"request_id":"op"}',
            }
          : http.fetch(url, init),
    };
    registerOn(refusing);
    await fire(refusing, "session.measure", { context: { window: 1 } }, async () => ({}));
    for (let i = 0; i < 10 && !refusing.logs.some((l) => l.includes("facts refused")); i++) {
      await settle();
    }
    expect(refusing.logs).toContain(
      'ccmsg: facts refused: {"ok":false,"error":{"code":"bad_request","msg":"no"},"request_id":"op"}',
    );
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
    // The tools answer their calls themselves, agent.report is answered for
    // the module's own forks alone, and turn.step is a stream; their
    // failures are their own tests'.
    const observed = fake.registered.flatMap((e) =>
      e === "tool.call" || e === "tool.run" || e === "turn.step" || e === "agent.report" ? [] : [e],
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
    const at = fake.replies.length;
    spawned(fake, 0).stream.push(
      `${JSON.stringify({ v: 1, op: "request.override", id: `o${at}`, args: override })}\n`,
    );
    return nextReply(fake, at);
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
describe("stopping the main loop's turn (turn.abort)", () => {
  const ABORT = '{"v":1,"op":"turn.abort","id":"x1","args":{}}';
  const turn = (turnId: string, agentId?: string) => ({
    text: "",
    turnId,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  async function started(
    options: Parameters<typeof fakeEngine>[0] = {},
  ): Promise<{ fake: Fake; state: ModuleState }> {
    const fake = fakeEngine(options);
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    return { fake, state };
  }
  /** The daemon asks turn.abort over the sidecar; the module's reply. */
  async function abort(fake: Fake): Promise<SidecarReply> {
    const at = fake.replies.length;
    spawned(fake, 0).stream.push(`${ABORT}\n`);
    return nextReply(fake, at);
  }

  test("the main loop's running turn is stopped by the id its turn.start carried", async () => {
    const { fake } = await started();
    await fire(fake, "turn.start", turn("t1"), async () => ({}));
    expect(await abort(fake)).toEqual({ id: "x1", ok: true, result: { outcome: "aborted" } });
    expect(fake.aborts).toEqual(["t1"]);
  });

  // Nothing is asked of the engine when no main-loop turn runs: before the
  // first turn, and once the turn ended — an ended turn's id is not used.
  test("no turn running: no_turn, and the engine is not asked", async () => {
    const { fake } = await started();
    expect(await abort(fake)).toEqual({ id: "x1", ok: true, result: { outcome: "no_turn" } });
    await fire(fake, "turn.start", turn("t1"), async () => ({}));
    await fire(fake, "turn.complete", { reason: "answer", turnId: "t1" }, async () => ({}));
    expect(await abort(fake)).toMatchObject({ result: { outcome: "no_turn" } });
    expect(fake.aborts).toEqual([]);
  });

  // A subagent's or teammate's turn is not the main loop's: its turn.start
  // does not replace the main loop's id, its turn.complete does not clear it,
  // and with only a subagent running there is no turn to stop.
  test("a subagent's turns neither replace nor clear the main loop's", async () => {
    const { fake } = await started();
    await fire(fake, "turn.start", turn("s1", "a1"), async () => ({}));
    expect(await abort(fake)).toMatchObject({ result: { outcome: "no_turn" } });
    await fire(fake, "turn.start", turn("t1"), async () => ({}));
    await fire(fake, "turn.start", turn("s2", "a1"), async () => ({}));
    await fire(fake, "turn.complete", { reason: "answer", ...turn("s2", "a1") }, async () => ({}));
    expect(await abort(fake)).toMatchObject({ result: { outcome: "aborted" } });
    expect(fake.aborts).toEqual(["t1"]);
  });

  test("the next main-loop turn is the one stopped", async () => {
    const { fake } = await started();
    await fire(fake, "turn.start", turn("t1"), async () => ({}));
    await fire(fake, "turn.complete", { reason: "answer", turnId: "t1" }, async () => ({}));
    await fire(fake, "turn.start", turn("t2"), async () => ({}));
    await abort(fake);
    expect(fake.aborts).toEqual(["t2"]);
  });

  // The engine rejects an id that is not the running turn's; what it said
  // goes back to the daemon, for the person.
  test("the engine refusing: refused, with its words", async () => {
    const { fake } = await started({
      abort: async (turnId) => {
        throw new Error(`HooksError: $.turn.abort: ${turnId} is not the running turn t9`);
      },
    });
    await fire(fake, "turn.start", turn("t1"), async () => ({}));
    expect(await abort(fake)).toEqual({
      id: "x1",
      ok: true,
      result: {
        outcome: "refused",
        message: "Error: HooksError: $.turn.abort: t1 is not the running turn t9",
      },
    });
  });
});

// A btw's fork (DR-0060 §2): `$.agent.spawn({ subagentType: "fork" })`, its
// report taken so the main conversation hears nothing of it, its answer and
// what it cost sent back to the daemon.
describe("a btw's fork (fork.ask, fork.stop)", () => {
  const ASK = (id: string, args: object): string =>
    `${JSON.stringify({ v: 1, op: "fork.ask", id, args })}\n`;
  const STOP = (id: string, key: string): string =>
    `${JSON.stringify({ v: 1, op: "fork.stop", id, args: { key } })}\n`;
  const USAGE = {
    input_tokens: 4,
    output_tokens: 339,
    cache_read_input_tokens: 129_890,
    cache_creation_input_tokens: 1_074,
  };
  /** A fork's turn.complete as 2.1.330 raised it: the turn's usage carries
   * the 5m / 1h split and the model beside the four counts. */
  const COMPLETE = (agentId: string, answer: string) => ({
    answer,
    durationMs: 900,
    isAborted: false,
    turnId: `t-${agentId}`,
    agentId,
    reason: "answer",
    usage: {
      ...USAGE,
      ephemeral_5m_input_tokens: 1_074,
      ephemeral_1h_input_tokens: 0,
      model: "claude-haiku-5-5",
    },
  });
  /** A report as 2.1.330 raised it. */
  const REPORT = (agentId: string, status: string, text: string) => ({
    agentId,
    subagentType: "fork",
    status,
    provider: { plugin: "engine", tier: "core" },
    text,
  });
  const TAKEN = "ccmsg: a btw's answer goes to the web UI, not to the conversation";
  const STEP = (agentId: string | undefined, effort: string) => ({
    turnId: "t",
    index: 0,
    model: "claude-haiku-5-5",
    effort,
    messageCount: 29,
    ...(agentId !== undefined ? { agentId } : {}),
  });

  async function started(
    options: Parameters<typeof fakeEngine>[0] = {},
  ): Promise<{ fake: Fake; state: ModuleState }> {
    const fake = fakeEngine(options);
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    return { fake, state };
  }
  function send(fake: Fake, line: string): void {
    spawned(fake, 0).stream.push(line);
  }
  /** Run the module's agent.report hook as the engine would; `beneath` is
   * the report delivered to the parent when the hook passes it on. */
  async function passedOn<E>(fake: Fake, e: E): Promise<boolean> {
    const hook = fake.hooks["agent.report"][0]?.[0];
    if (hook === undefined) throw new Error("no hook on agent.report");
    let passed = false;
    await hook(fake.$, e, async () => {
      passed = true;
      return { text: "delivered to the parent", review: "cleared" };
    });
    return passed;
  }
  async function reported<E>(fake: Fake, e: E): Promise<object> {
    const hook = fake.hooks["agent.report"][0]?.[0];
    if (hook === undefined) throw new Error("no hook on agent.report");
    return hook(fake.$, e, async () => ({ text: "delivered to the parent", review: "cleared" }));
  }
  async function spawnedFork(fake: Fake, count = 1): Promise<void> {
    for (let i = 0; i < 20 && fake.agentSpawns.length < count; i++) await settle();
    expect(fake.agentSpawns.length).toBe(count);
  }

  test("the prompt is forked as a background fork, its report taken, and its answer goes back with what it cost", async () => {
    const { fake } = await started();
    send(fake, ASK("f1", { key: "k1", prompt: "合言葉は?" }));
    await spawnedFork(fake);
    expect(fake.agentSpawns).toEqual([
      { subagentType: "fork", prompt: "合言葉は?", description: "ccmsg btw" },
    ]);
    await fireStep(fake, STEP("a1", "medium"), [], {});
    await fire(fake, "turn.complete", COMPLETE("a1", "BLUE-HERON-82"), async () => ({ text: "" }));
    // Taken: the parent (the main conversation) is told nothing and waits
    // for nothing (`{ consumed }`), so nothing of the btw joins it.
    expect(await reported(fake, REPORT("a1", "completed", "BLUE-HERON-82"))).toEqual({
      consumed: TAKEN,
    });
    expect(await nextReply(fake)).toEqual({
      id: "f1",
      ok: true,
      result: { outcome: "answered", text: "BLUE-HERON-82", usage: USAGE, effort: "medium" },
    });
  });

  // Every other agent's report is the main conversation's: the model's own
  // subagents report to it as they always do.
  test("a report of an agent the module did not start goes on as received", async () => {
    const { fake } = await started();
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    expect(await passedOn(fake, REPORT("a-model-spawned", "completed", "done"))).toBe(true);
    expect(await reported(fake, REPORT("a-model-spawned", "completed", "done"))).toEqual({
      text: "delivered to the parent",
      review: "cleared",
    });
    expect(fake.replies).toEqual([]);
  });

  // A fork's first events can come before its spawn resolved: the report of
  // an agent the module does not know yet waits for the spawn in flight.
  test("a report that comes while the fork's spawn is in flight is still taken", async () => {
    const spawn = Promise.withResolvers<{ model: string; agentId: string }>();
    const { fake } = await started({ agentSpawn: () => spawn.promise });
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    const step = fireStep(fake, STEP("a-early", "high"), [], {});
    const taken = reported(fake, REPORT("a-early", "completed", "early"));
    spawn.resolve({ model: "m", agentId: "a-early" });
    await step;
    expect(await taken).toEqual({ consumed: TAKEN });
    await fire(fake, "turn.complete", COMPLETE("a-early", "early"), async () => ({ text: "" }));
    expect(await nextReply(fake)).toMatchObject({
      result: { outcome: "answered", text: "early", effort: "high" },
    });
  });

  // A fork runs on the session's model and effort (it takes neither): its
  // requests go on as they are, and the level its first one went at is the
  // answer's.
  test("the fork's requests go on as they are, and its first request's effort is the answer's", async () => {
    const { fake } = await started();
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    const seen: ReturnType<typeof STEP>[] = [];
    const hook = fake.hooks["turn.step"][0]?.[0];
    if (hook === undefined) throw new Error("no hook on turn.step");
    const steps = [STEP("a1", "medium"), { ...STEP("a1", "high"), index: 1 }];
    for (const e of steps) {
      const stream = hook(fake.$, e, async function* (passed) {
        seen.push(passed);
        yield* [];
        return {};
      });
      for await (const chunk of stream) seen.push(chunk);
    }
    expect(seen).toEqual(steps);
    await fire(fake, "turn.complete", COMPLETE("a1", "a"), async () => ({ text: "" }));
    await reported(fake, REPORT("a1", "completed", "a"));
    expect(await nextReply(fake)).toMatchObject({
      result: { outcome: "answered", effort: "medium" },
    });
  });

  // 2026-11-23-btw-via-agent-fork §8: right after /compact or /clear a fork
  // wrote the cache anew and could lose the btw's prompt; once the main
  // thread sent its next request it read the cache and kept the prompt.
  test("after /compact or /clear no fork is started until the main thread's next request", async () => {
    const { fake } = await started();
    for (const [i, reset] of (["compact", "clear"] as const).entries()) {
      if (reset === "compact") await fire(fake, "session.compact", {}, async () => ({}));
      else await fire(fake, "command.run", command("clear"), async () => ({}));
      send(fake, ASK(`n-${reset}`, { key: `n-${reset}`, prompt: "q" }));
      expect(await nextReply(fake, i * 2)).toEqual({
        id: `n-${reset}`,
        ok: true,
        result: {
          outcome: "not_answered",
          reason: "not_ready",
          message: "the main conversation has sent no request since /compact or /clear",
        },
      });
      // A subagent's request does not settle the main conversation.
      await fireStep(fake, STEP("a-other", "low"), [], {});
      send(fake, ASK(`x-${reset}`, { key: `x-${reset}`, prompt: "q" }));
      expect(await nextReply(fake, i * 2 + 1)).toMatchObject({ result: { reason: "not_ready" } });
      await fireStep(fake, STEP(undefined, "low"), [], {});
      send(fake, ASK(`y-${reset}`, { key: `y-${reset}`, prompt: "q" }));
      await spawnedFork(fake, i + 1);
    }
  });

  // The report came first: the end waits for the turn's end, which carries
  // what it cost; with none in FORK_TURN_WAIT_MS it goes back without.
  test("a report before the turn's end waits for it, and goes back without usage past the wait", async () => {
    const { fake } = await started();
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    await reported(fake, REPORT("a1", "completed", "first"));
    await settle();
    expect(fake.replies).toEqual([]);
    await fire(fake, "turn.complete", COMPLETE("a1", "first"), async () => ({ text: "" }));
    expect(await nextReply(fake)).toMatchObject({ result: { text: "first", usage: USAGE } });

    send(fake, ASK("f2", { key: "k2", prompt: "q" }));
    await spawnedFork(fake, 2);
    await reported(fake, REPORT("a2", "completed", "alone"));
    const wait = fake.timers.find((t) => t.ms === FORK_TURN_WAIT_MS && !t.cancelled);
    if (wait === undefined) throw new Error("no wait for the turn's end");
    wait.fn();
    expect(await nextReply(fake, 1)).toEqual({
      id: "f2",
      ok: true,
      result: { outcome: "answered", text: "alone" },
    });
  });

  test("a run that failed, was stopped, or wrote nothing: not_answered with why", async () => {
    const { fake } = await started();
    const ends = [
      { status: "failed", text: "途中まで", result: { reason: "failed", message: "途中まで" } },
      { status: "stopped", text: "", result: { reason: "stopped" } },
      { status: "completed", text: "  ", result: { reason: "empty" } },
    ];
    for (const [i, end] of ends.entries()) {
      const agentId = `a${String(i + 1)}`;
      send(fake, ASK(`f${String(i)}`, { key: `k${String(i)}`, prompt: "q" }));
      await spawnedFork(fake, i + 1);
      await fire(
        fake,
        "turn.complete",
        { ...COMPLETE(agentId, ""), usage: undefined },
        async () => ({
          text: "",
        }),
      );
      await reported(fake, REPORT(agentId, end.status, end.text));
      expect(await nextReply(fake, i)).toEqual({
        id: `f${String(i)}`,
        ok: true,
        result: { outcome: "not_answered", ...end.result },
      });
    }
  });

  // Before 2.1.330 a plugin cannot fork the main conversation, nor take a
  // report: nothing is spawned (its report would land in the conversation).
  test("a Claude Code older than 2.1.330 is not asked to spawn: old_engine, with its version", async () => {
    const { fake } = await started({ engineVersion: { version: "2.1.329", base: "2.1.329" } });
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    expect(await nextReply(fake)).toEqual({
      id: "f1",
      ok: true,
      result: { outcome: "not_answered", reason: "old_engine", message: "2.1.329" },
    });
    expect(fake.agentSpawns).toEqual([]);
  });

  test("a refused spawn: denied, with the engine's words", async () => {
    const { fake } = await started({ agentSpawn: async () => ({ deny: "past the agent limit" }) });
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    expect(await nextReply(fake)).toEqual({
      id: "f1",
      ok: true,
      result: { outcome: "not_answered", reason: "denied", message: "past the agent limit" },
    });
  });

  test("fork.stop stops the running fork with TaskStop, and its ask is answered stopped", async () => {
    const { fake } = await started();
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    send(fake, STOP("s1", "k1"));
    expect(await nextReply(fake)).toEqual({ id: "s1", ok: true, result: { outcome: "stopped" } });
    expect(fake.agentCalls).toEqual([{ tool: "TaskStop", input: { task_id: "a1" } }]);
    await fire(
      fake,
      "turn.complete",
      { ...COMPLETE("a1", ""), reason: "aborted", usage: undefined },
      async () => ({ text: "" }),
    );
    await reported(fake, REPORT("a1", "stopped", ""));
    expect(await nextReply(fake, 1)).toMatchObject({ id: "f1", result: { reason: "stopped" } });
  });

  test("a stop while the spawn is in flight stops the fork once it started", async () => {
    const spawn = Promise.withResolvers<{ model: string; agentId: string }>();
    const { fake } = await started({ agentSpawn: () => spawn.promise });
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    send(fake, STOP("s1", "k1"));
    expect(await nextReply(fake)).toEqual({ id: "s1", ok: true, result: { outcome: "stopped" } });
    expect(fake.agentCalls).toEqual([]);
    spawn.resolve({ model: "m", agentId: "a9" });
    for (let i = 0; i < 20 && fake.agentCalls.length === 0; i++) await settle();
    expect(fake.agentCalls).toEqual([{ tool: "TaskStop", input: { task_id: "a9" } }]);
  });

  test("fork.stop of a key no fork runs under: not_running; a refused TaskStop: refused", async () => {
    const { fake } = await started({ agentCall: async () => ({ deny: "no such task" }) });
    send(fake, STOP("s1", "gone"));
    expect(await nextReply(fake)).toEqual({
      id: "s1",
      ok: true,
      result: { outcome: "not_running" },
    });
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    send(fake, STOP("s2", "k1"));
    expect(await nextReply(fake, 1)).toEqual({
      id: "s2",
      ok: true,
      result: { outcome: "refused", message: "no such task" },
    });
  });

  // 何を保証するか (DR-0062 §14): btw の fork は本体の tool を持つので comment_reply
  // を呼べるが、その答えは fork の本文であってコメントの返信ではない。fork の呼び出しは
  // daemon に尋ねずに断り、答えを本文に書くよう返す。他の subagent は今までどおり断り、
  // 本体の呼び出しは comment_reply の describe が持つ。
  test("comment_reply from a btw's fork is refused without asking the daemon, saying to answer in the text", async () => {
    const { fake } = await started();
    send(fake, ASK("f1", { key: "k1", prompt: "q" }));
    await spawnedFork(fake);
    const call = (agentId: string) =>
      callTool(fake, "mcp__ccmsg-v1__comment_reply", {
        tool: "mcp__ccmsg-v1__comment_reply",
        tool_use_id: "toolu_1",
        cid: "c7k2p",
        body: "答え",
        agentId,
      });
    expect(await call("a1")).toBe(
      "この btw の横道からは comment_reply を使えない。何も記録していない。答えは応答の本文に書く (本文がそのまま btw の答えになる)",
    );
    expect(await call("a-model-spawned")).toBe(
      "comment_reply は subagent / teammate からは使えない (コメントは本体のセッションに届く)。何も記録していない",
    );
    expect(fake.asked).toEqual([]);
  });

  // 何を保証するか: module が読み込み直されると、走っていた fork の待ち合わせは消える。
  // session が plugin の起こした fork として FORK_DESCRIPTION で並べる agent は、
  // 前の読み込みの btw の fork として報告を取り (本体に知らせを残さない)、comment_reply
  // も断る。model が起こした fork (spawnedBy が無い) は同じ description でも通す。
  test("a btw's fork of an earlier load is still known by how the session lists it", async () => {
    const { fake } = await started();
    fake.agents.push(
      {
        id: "a-old",
        description: "ccmsg btw",
        type: "fork",
        status: "running",
        spawnedBy: "ccmsg-v1",
      },
      { id: "a-model", description: "ccmsg btw", type: "fork", status: "running" },
      {
        id: "a-gp",
        description: "ccmsg btw",
        type: "general-purpose",
        status: "running",
        spawnedBy: "x",
      },
    );
    expect(await reported(fake, REPORT("a-old", "completed", "answer"))).toEqual({
      consumed: "ccmsg: a btw's fork the module started before it was reloaded",
    });
    expect(await passedOn(fake, REPORT("a-model", "completed", "answer"))).toBe(true);
    expect(await passedOn(fake, REPORT("a-gp", "completed", "answer"))).toBe(true);
    expect(
      await callTool(fake, "mcp__ccmsg-v1__comment_reply", {
        tool: "mcp__ccmsg-v1__comment_reply",
        tool_use_id: "toolu_1",
        cid: "c7k2p",
        body: "答え",
        agentId: "a-old",
      }),
    ).toContain("この btw の横道からは comment_reply を使えない");
    expect(fake.replies).toEqual([]);
  });

  // 何を保証するか: 本体の会話を変えない compaction では fork を止めない。precompute は
  // 何も入れ替えず、skip された compaction は会話をそのままにし、subagent の
  // compaction は subagent 自身の transcript を縮める。どれの後も本体の request を
  // 待たずに fork を起こす。
  test("a precompute, a skipped compaction and a subagent's compaction leave the forks ready", async () => {
    const { fake } = await started();
    const compact = (e: object, result: object) =>
      fire(fake, "session.compact", { messages: [], ...e }, async () => result);
    await compact({ trigger: "precompute" }, { messages: [] });
    await compact({ trigger: "manual" }, { skip: "a PreCompact hook blocked it" });
    await compact({ trigger: "auto", agentId: "a-sub" }, { messages: [] });
    send(fake, ASK("f0", { key: "k0", prompt: "q" }));
    await spawnedFork(fake);
  });

  test("forksForPlugins: 2.1.330 and later, a development build of it too", () => {
    expect(forksForPlugins("2.1.330")).toBe(true);
    expect(forksForPlugins("2.1.330-dev")).toBe(true);
    expect(forksForPlugins("2.1.331")).toBe(true);
    expect(forksForPlugins("2.2.0")).toBe(true);
    expect(forksForPlugins("3.0.0")).toBe(true);
    expect(forksForPlugins("2.1.329")).toBe(false);
    expect(forksForPlugins("2.0.999")).toBe(false);
    expect(forksForPlugins("not a version")).toBe(false);
  });
});

// Renaming the session from the web UI (DR-0047).
describe("renaming the session (session.rename)", () => {
  const RENAME = '{"v":1,"op":"session.rename","id":"r1","args":{"name":"新しい名前"}}';
  async function started(
    options: Parameters<typeof fakeEngine>[0] = {},
  ): Promise<{ fake: Fake; state: ModuleState }> {
    const fake = fakeEngine(options);
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    return { fake, state };
  }
  /** The daemon asks session.rename over the sidecar; the module's reply. */
  function rename(fake: Fake): Promise<SidecarReply> {
    const at = fake.replies.length;
    spawned(fake, 0).stream.push(`${RENAME}\n`);
    return nextReply(fake, at);
  }
  /** A `$.command.run` that ends only when the test says. */
  function held(): { run: () => Promise<unknown>; end: () => void; fail: (e: Error) => void } {
    let end = (): void => {};
    let fail = (_e: Error): void => {};
    const done = new Promise<unknown>((resolve, reject) => {
      end = () => resolve({});
      fail = reject;
    });
    return { run: () => done, end, fail };
  }

  test("an idle session: /rename runs with the name, and the reply is renamed", async () => {
    const { fake } = await started();
    expect(await rename(fake)).toEqual({ id: "r1", ok: true, result: { outcome: "renamed" } });
    expect(fake.commandRuns).toEqual([{ command: "rename", args: "新しい名前" }]);
    // The wait for the run is let go once it ended.
    expect(fake.timers.filter((t) => t.ms === RENAME_WAIT_MS && !t.cancelled)).toEqual([]);
  });

  // The engine runs a command once the session is idle: while the main loop
  // answers a turn the module asks for the run and answers at once, rather
  // than holding the reply until the turn ends.
  test("a main-loop turn running: /rename is asked for, and the reply is queued at once", async () => {
    const pending = held();
    const { fake } = await started({ commandRun: pending.run });
    await fire(fake, "turn.start", { text: "", turnId: "t1" }, async () => ({}));
    expect(await rename(fake)).toEqual({ id: "r1", ok: true, result: { outcome: "queued" } });
    expect(fake.commandRuns).toEqual([{ command: "rename", args: "新しい名前" }]);
    pending.end();
  });

  // A subagent's turn does not make the session busy for a slash command.
  test("only a subagent's turn running: the module waits for the run", async () => {
    const { fake } = await started();
    await fire(fake, "turn.start", { text: "", turnId: "s1", agentId: "a1" }, async () => ({}));
    expect(await rename(fake)).toMatchObject({ result: { outcome: "renamed" } });
  });

  // Busy in a way the module does not see (a turn running when it was loaded,
  // a dialog open): the run does not end, and the wait answers queued.
  test("a run that does not end within the wait: queued", async () => {
    const pending = held();
    const { fake } = await started({ commandRun: pending.run });
    const at = fake.replies.length;
    spawned(fake, 0).stream.push(`${RENAME}\n`);
    await settle();
    const timer = fake.timers.find((t) => t.ms === RENAME_WAIT_MS && !t.cancelled);
    if (timer === undefined) throw new Error("no wait for the run");
    timer.fn();
    expect(await nextReply(fake, at)).toEqual({
      id: "r1",
      ok: true,
      result: { outcome: "queued" },
    });
    pending.end();
  });

  test("the engine refusing: refused, with its words", async () => {
    const { fake } = await started({
      commandRun: async () => {
        throw new Error("HooksError: $.command.run: unknown command rename");
      },
    });
    expect(await rename(fake)).toEqual({
      id: "r1",
      ok: true,
      result: {
        outcome: "refused",
        message: "Error: HooksError: $.command.run: unknown command rename",
      },
    });
  });

  // A refusal after the queued answer has nobody to go to but the log.
  test("a queued run the engine refuses later is logged", async () => {
    const pending = held();
    const { fake } = await started({ commandRun: pending.run });
    await fire(fake, "turn.start", { text: "", turnId: "t1" }, async () => ({}));
    expect(await rename(fake)).toMatchObject({ result: { outcome: "queued" } });
    pending.fail(new Error("refused past a Stop"));
    await settle();
    expect(fake.logs.some((l) => l.includes("/rename refused: Error: refused past a Stop"))).toBe(
      true,
    );
  });
});

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

  // 何を保証するか: btw の fork は webui に btw の吹き出しとして出るので、subagent の
  // 一覧 (facts の subagents) には載せない。この読み込みが起こした fork と、session が
  // plugin の起こした fork として
  // "ccmsg btw" で並べるもの (読み込み直しの前の fork) の両方。model が起こした fork は載せる。
  test("a btw's fork is not one of the subagents", async () => {
    const fake = fakeEngine();
    fake.agents.push(
      { id: A, description: "ccmsg btw", type: "fork", status: "running", spawnedBy: "ccmsg-v1" },
      { id: B, description: "ccmsg btw", type: "fork", status: "running" },
    );
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await untilLastFacts(fake, (f) => f.subagents !== undefined);
    expect(lastFacts(fake).subagents).toEqual([{ id: B, description: "ccmsg btw", type: "fork" }]);

    spawned(fake, 0).stream.push(
      `${JSON.stringify({ v: 1, op: "fork.ask", id: "f1", args: { key: "k1", prompt: "q" } })}\n`,
    );
    for (let i = 0; i < 20 && fake.agentSpawns.length === 0; i++) await settle();
    // The new fork's turn.start (a1), and then a subagent the module did not
    // start.
    await fire(fake, "turn.start", { text: "q", turnId: "s1", agentId: "a1" }, async () => ({}));
    await fire(fake, "turn.start", { text: "", turnId: "s2", agentId: "c1" }, async () => ({}));
    await untilLastFacts(fake, (f) => (f.subagents ?? []).some((a) => a.id === "c1"));
    expect((lastFacts(fake).subagents ?? []).map((a) => a.id)).toEqual([B, "c1"]);
  });

  test("agent.append adds the text, marked as the person's, to the running subagent only", async () => {
    const fake = fakeEngine();
    fake.agents.push({ id: A, description: "d", type: "t", status: "running" });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    // Each request on the sidecar, and the reply the module sent for it.
    const append = async (agentId: string, text: string) => {
      const before = fake.replies.length;
      spawned(fake, 0).stream.push(
        `${JSON.stringify({ v: 1, op: "agent.append", id: "g1", args: { agentId, text } })}\n`,
      );
      return nextReply(fake, before);
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

  // The webui's Timeline knows a row of the subagent's transcript is the
  // person's words only by this mark line at the head of its text
  // (`AGENT_APPEND_MARK`): the row is an `isMeta` row of the plugin's origin,
  // as ccmsg's guidance and other plugins' injections are. If the module put
  // another line, the person's message would sink, unrecognized, into a fold
  // of the agent's Timeline, so the module's mark and the one the webui reads
  // are held to be the same line.
  test("agent.append marks the text with the line the webui reads as the person's", () => {
    expect(agentMessage("その方針で")).toBe(`${AGENT_APPEND_MARK}\nその方針で`);
  });

  // send with agent_id (DR-0039 §3): `$.session.send` to the agent, which
  // reaches it whether it runs, waits or has ended; the session that sent it
  // is named, not the person.
  describe("agent.send", () => {
    const SENDER = "11111111-2222-4333-8444-555555555555";
    const request = (id: string, agentId: string, text: string) =>
      JSON.stringify({ v: 1, op: "agent.send", id, args: { agentId, from: SENDER, text } });

    test("sends the text, marked as from the sender, to the agent whatever its loop does", async () => {
      const fake = fakeEngine();
      fake.agents.push(
        { id: A, description: "d", type: "t", status: "running" },
        { id: B, description: "tm", type: "t", status: "idle" },
        { id: "c0c0c0c0c0c0c0c0c", description: "done", type: "t", status: "completed" },
      );
      registerOn(fake);
      for (const [n, agentId] of [A, B, "c0c0c0c0c0c0c0c0c"].entries()) {
        expect(await replyTo(fake, request(`s${String(n)}`, agentId, "確認お願い"))).toEqual({
          id: `s${String(n)}`,
          ok: true,
          result: { outcome: "delivered" },
        });
      }
      const marked = `ccmsg:${SENDER} から:\n確認お願い`;
      expect(agentMessage("確認お願い", SENDER)).toBe(marked);
      expect(fake.agentSends).toEqual([
        { agentId: A, text: marked },
        { agentId: B, text: marked },
        { agentId: "c0c0c0c0c0c0c0c0c", text: marked },
      ]);
      // Nothing is appended, to the agent or to the main conversation.
      expect(fake.agentAppends).toEqual([]);
      expect(fake.appended).toEqual([]);
    });

    test("an id the session has no agent of is no_agent, with Claude Code's words", async () => {
      const fake = fakeEngine();
      registerOn(fake);
      expect(await replyTo(fake, request("s1", A, "x"))).toEqual({
        id: "s1",
        ok: true,
        result: {
          outcome: "not_delivered",
          reason: "no_agent",
          message: `Agent "${A}" could not be resumed: No transcript found for agent ID: ${A}.`,
        },
      });
      expect(fake.agentSends).toEqual([]);
    });

    test("a send not delivered for another reason, or one that rejects, is refused", async () => {
      const refusing = fakeEngine();
      refusing.$.session = {
        ...refusing.$.session,
        send: async () => ({ isDelivered: false, reason: "a hook said no" }),
      };
      registerOn(refusing);
      expect(await replyTo(refusing, request("s1", A, "x"))).toEqual({
        id: "s1",
        ok: true,
        result: { outcome: "not_delivered", reason: "refused", message: "a hook said no" },
      });
      const throwing = fakeEngine();
      throwing.$.session = {
        ...throwing.$.session,
        send: async () => {
          throw new Error("HooksError: $.session.send: boom");
        },
      };
      registerOn(throwing);
      expect(await replyTo(throwing, request("s2", A, "x"))).toEqual({
        id: "s2",
        ok: true,
        result: {
          outcome: "not_delivered",
          reason: "refused",
          message: "Error: HooksError: $.session.send: boom",
        },
      });
    });
  });

  // The wake after an agy response (DR-0066 §7): `$.session.send` of the
  // text of no content to the agent, as it is, with no sender's mark.
  describe("agent.wake", () => {
    const request = (id: string, agentId: string) =>
      JSON.stringify({ v: 1, op: "agent.wake", id, args: { agentId } });

    test("sends the bare text of no content to the agent whatever its loop does", async () => {
      const fake = fakeEngine();
      fake.agents.push(
        { id: A, description: "d", type: "t", status: "running" },
        { id: B, description: "tm", type: "t", status: "idle" },
      );
      registerOn(fake);
      for (const [n, agentId] of [A, B].entries()) {
        expect(await replyTo(fake, request(`w${String(n)}`, agentId))).toEqual({
          id: `w${String(n)}`,
          ok: true,
          result: { outcome: "delivered" },
        });
      }
      expect(fake.agentSends).toEqual([
        { agentId: A, text: "." },
        { agentId: B, text: "." },
      ]);
      expect(fake.agentAppends).toEqual([]);
      expect(fake.appended).toEqual([]);
    });

    test("an id the session has no agent of is no_agent, as agent.send's", async () => {
      const fake = fakeEngine();
      registerOn(fake);
      expect(await replyTo(fake, request("w1", A))).toEqual({
        id: "w1",
        ok: true,
        result: {
          outcome: "not_delivered",
          reason: "no_agent",
          message: `Agent "${A}" could not be resumed: No transcript found for agent ID: ${A}.`,
        },
      });
      expect(fake.agentSends).toEqual([]);
    });
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
    // That the web UI draws figures and math, and that they are the agent's
    // to use.
    for (const word of ["`svg`", "`mermaid`", "`$…$`", "積極的に使って良い"]) {
      expect(GUIDANCE).toContain(word);
    }
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
    expect(failing.logs).toContain("ccmsg: ping not answered: Error: timed out");
    // No daemon running is no URL to tell, and nothing to log.
    const stopped = await started({ sockets: "none" });
    await prompt(stopped, "one");
    expect(stopped.appended).toEqual([GUIDANCE]);
    expect(stopped.logs.filter((l) => l.includes("ping"))).toEqual([]);
  });

  // The prompt waits on the ping, once per conversation: a daemon that does
  // not answer holds it PING_TIMEOUT_MS at most.
  test("a ping with no reply holds the prompt no longer than its wait", async () => {
    const fake = await started({ webuiUrl: undefined });
    fake.$.http = {
      fetch: () => new Promise(() => {}),
    };
    const prompting = prompt(fake, "one");
    let timer: Timer | undefined;
    for (let i = 0; i < 20 && timer === undefined; i++) {
      await settle();
      timer = fake.timers.find((t) => t.ms === PING_TIMEOUT_MS && !t.cancelled);
    }
    if (timer === undefined) throw new Error("no ping wait");
    timer.fn();
    await prompting;
    expect(fake.appended).toEqual([GUIDANCE]);
    expect(fake.logs).toContain("ccmsg: ping not answered: no reply within 3 s");
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
  // の作り方"). comment_reply's also says how the response after the replies
  // ends, which an agent that has not read the skill keeps too (DR-0062 §5).
  test("an interactive session.start registers send, say, peers, launch, permit, comment_reply and agy, deferred, in a few words", async () => {
    const fake = toolFake(printing({}));
    await fire(fake, "session.start", START, async () => ({}));
    expect(fake.tools.map((t) => [t.name, t.description, t.isDeferred])).toEqual([
      ["send", "Message other sessions", true],
      ["say", "Speak to the person", true],
      ["peers", "List reachable sessions", true],
      ["launch", "Launch a Claude session", true],
      ["permit", "Ask the person for permission", true],
      [
        "comment_reply",
        "Reply to a comment. If the replies say it all, end the response with only nothing_to_reply",
        true,
      ],
      ["agy", "Ask an agy conversation", true],
    ]);
    // agy's fields are one object of their types, no top-level oneOf / anyOf
    // (DR-0066 §3, §14): which go together is the handler's to read.
    expect(fake.tools[6]?.inputSchema).toEqual({
      type: "object",
      properties: {
        op: { type: "string", enum: ["run", "status", "abort"] },
        agyid: { type: "string", description: "Id a run returned" },
        seq: { type: "integer" },
        prompt: { type: "string" },
        model: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        cwd: { type: "string" },
        dirs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              containerpath: { type: "string" },
              write: { type: "boolean" },
            },
            required: ["path", "write"],
          },
        },
        verbose: { type: "boolean" },
      },
      required: ["op"],
    });
    // comment_reply's fields are their types alone (DR-0062 §5: no field is
    // described; the skill says how to use it).
    expect(fake.tools[5]?.inputSchema).toEqual({
      type: "object",
      properties: { cid: { type: "string" }, body: { type: "string" } },
      required: ["cid", "body"],
    });
    // The model is shown the shape the handler reads, and no more: send's
    // session id and text required, the agent id beside them, each field its
    // type alone (the finer rules are the handler's); peers' prefix alone.
    expect(fake.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        session_id: { type: "string" },
        agent_id: { type: "string", description: "Subagent or teammate id" },
        text: { type: "string" },
      },
      required: ["session_id", "text"],
    });
    expect(fake.tools[2]?.inputSchema).toEqual({
      type: "object",
      properties: { cwd_prefix: { type: "string" } },
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
        project_permissions: {
          type: "array",
          items: {
            type: "object",
            properties: { add: { type: "string" }, remove: { type: "string" } },
          },
          description:
            "完全一致形を推奨 (完全一致形の allow は classifier を通らない)。ファイルの rule はパスをそのまま書けば ccmsg が当たる形に直す",
        },
        voice: { type: "string", description: "日本語" },
      },
      required: ["blocked", "voice"],
    });
    // say's text is spoken, so the model is told the language it is spoken in.
    expect(fake.tools[1]?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string", description: "日本語" } },
      required: ["text"],
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

  /** A module whose daemon answers each `POST /op` with `reply` as JSON,
   * status 200. */
  const replying = (reply: object) => async (): Promise<OpAnswer> => ({
    status: 200,
    text: JSON.stringify({ ...reply, request_id: "op" }),
  });

  function daemonFake(
    daemon: NonNullable<Parameters<typeof fakeEngine>[0]>["daemon"],
    options: Parameters<typeof fakeEngine>[0] = {},
  ): Fake {
    const fake = fakeEngine({ ...options, daemon });
    registerOn(fake);
    return fake;
  }

  /** What the module says of who asks: the session it means, the plugin's
   * version and the wire's protocol version. The daemon names the session by
   * the asking process (DR-0046 §3), so nothing else is said. */
  const HELLO = { sid: fake0, protocol: PROTOCOL_VERSION, ccmsg_version: "9.9.9" };

  // The tools ask the daemon over its socket (DR-0046): no ccmsg process is
  // started for them.
  test("send asks the daemon's POST /op send_message under the session's hello, and reads its result", async () => {
    const fake = daemonFake(
      replying({
        ok: true,
        results: [{ sid: OTHER, name: "n", cwd: "/w", outcome: "delivered" }],
      }),
    );
    const text = "long\nmessage `with` $chars";
    const result = await callTool(fake, "mcp__ccmsg-v1__send", {
      session_id: OTHER,
      text,
      tool: "mcp__ccmsg-v1__send",
      tool_use_id: "toolu_1",
    });
    expect(fake.asked).toEqual([
      {
        socketPath: "/home/k/.local/state/ccmsg/http.sock",
        body: { op: "send_message", to: { session_id: OTHER }, text, hello: HELLO },
      },
    ]);
    expect(fake.runs).toEqual([]);
    expect(result).toContain("1 件の宛先すべてに届いた");
    expect(result).toContain(`- session_id: ${OTHER}, name: "n", cwd: "/w": 届いた`);
  });

  test("a send to a session without a hooks module says it was not sent", async () => {
    const fake = daemonFake(
      replying({
        ok: true,
        results: [{ sid: "c", outcome: "not_delivered", reason: "no_module" }],
      }),
    );
    expect(await callTool(fake, "mcp__ccmsg-v1__send", { session_id: "c", text: "hi" })).toContain(
      "- session_id: c: 届かなかった。ccmsg の hooks module が動いていない",
    );
  });

  // A send that names a running subagent hands its agent_id on with the rest.
  test("send with agent_id hands it on in send_message", async () => {
    const fake = daemonFake(
      replying({ ok: true, results: [{ sid: OTHER, outcome: "delivered" }] }),
    );
    const result = await callTool(fake, "mcp__ccmsg-v1__send", {
      session_id: OTHER,
      agent_id: "a1b2",
      text: "hi",
    });
    expect(fake.asked.map((a) => a.body)).toEqual([
      { op: "send_message", to: { session_id: OTHER }, agent_id: "a1b2", text: "hi", hello: HELLO },
    ]);
    expect(result).toContain(`- session_id: ${OTHER}: 届いた`);
    expect(
      await callTool(fake, "mcp__ccmsg-v1__send", { session_id: OTHER, agent_id: "", text: "hi" }),
    ).toContain("send の入力が形に合わない");
  });

  // The socket is where the daemon binds it, by the rule the daemon's state
  // dir follows: CCMSG_STATE_DIR, else XDG_STATE_HOME, else HOME.
  test("the socket is the daemon's state dir's", async () => {
    const asking = async (env: Record<string, string>) => {
      const fake = daemonFake(replying({ ok: true, results: [] }), { env });
      await callTool(fake, "mcp__ccmsg-v1__send", { session_id: OTHER, text: "hi" });
      return fake.asked.map((a) => a.socketPath);
    };
    expect(await asking({ HOME: "/h", CCMSG_STATE_DIR: "/s", XDG_STATE_HOME: "/x" })).toEqual([
      "/s/http.sock",
    ]);
    expect(await asking({ HOME: "/h", XDG_STATE_HOME: "/x/" })).toEqual(["/x/ccmsg/http.sock"]);
    expect(await asking({ HOME: "/h", CCMSG_STATE_DIR: "" })).toEqual([
      "/h/.local/state/ccmsg/http.sock",
    ]);
  });

  // The plugin's version is read from its package.json, as `ccmsg version`
  // prints it; one that cannot be read leaves the field out and is logged.
  test("a plugin version that cannot be read is left out of the hello", async () => {
    const fake = daemonFake(replying({ ok: true, results: [] }), {
      files: { "/plugin/package.json": new Error("EACCES") },
    });
    await callTool(fake, "mcp__ccmsg-v1__send", { session_id: OTHER, text: "hi" });
    const { ccmsg_version: _version, ...rest } = HELLO;
    expect(fake.asked.map((a) => a.body.hello)).toEqual([rest]);
    expect(fake.logs).toContain("ccmsg: the plugin's version is not read: Error: EACCES");
  });

  // engine does not check the input against the schema (DR-0039 §3): the
  // handler reads it and answers what does not read, asking nothing.
  test("an input that is not send's is answered in text, and nothing is asked", async () => {
    const fake = daemonFake(replying({ ok: true, results: [] }));
    for (const input of [
      { text: 1, session_id: OTHER },
      { text: "hi" },
      { session_id: "", text: "hi" },
      { session_id: OTHER, text: "  " },
      {},
    ]) {
      expect(await callTool(fake, "mcp__ccmsg-v1__send", input)).toContain(
        "send の入力が形に合わない",
      );
    }
    expect(fake.asked).toEqual([]);
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
      ["send", "say", "peers", "launch", "permit", "comment_reply"].map(
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
      CCMSG_TOOLS.comment_reply,
    ]);
  });

  test("a send to the sender itself says so", async () => {
    const fake = daemonFake(
      replying({
        ok: true,
        results: [{ sid: fake0, outcome: "not_delivered", reason: "self" }],
      }),
    );
    expect(
      await callTool(fake, "mcp__ccmsg-v1__send", { session_id: fake0, text: "hi" }),
    ).toContain("宛先の session_id が送り主自身なので、送っていない");
  });

  test("a send that reached no live session says so", async () => {
    const fake = daemonFake(replying({ ok: true, results: [] }));
    expect(
      await callTool(fake, "mcp__ccmsg-v1__send", { session_id: fake0, text: "hi" }),
    ).toContain("宛先の session_id の生きているセッションが無い");
  });

  // Nothing went out when there was no socket to send to; what went to the
  // socket and got no reply may have reached someone.
  test("a send with no daemon, or one too old, was not sent; one with no reply is unconfirmed", async () => {
    const send = (fake: Fake) =>
      callTool(fake, "mcp__ccmsg-v1__send", { session_id: OTHER, text: "hi" });
    expect(await send(daemonFake(replying({}), { sockets: "none" }))).toBe(
      "ccmsg の daemon が居ないので、送っていない。daemon を起こす (`ccmsg daemon start`)",
    );
    expect(await send(daemonFake(replying({}), { sockets: "old" }))).toBe(
      "ccmsg の daemon がこの plugin より古いので、送っていない。daemon を更新する (`ccmsg daemon restart`)",
    );
    const aborted = daemonFake(async () => {
      throw new Error("HooksError: ccmsg: aborted: no complete answer within 30000ms");
    });
    expect(await send(aborted)).toBe(
      `ccmsg の daemon から返事が無く、届いたか確かめられなかった: Error: HooksError: ccmsg: aborted: no complete answer within 30000ms。${UNCONFIRMED_ADVICE}`,
    );
    const other = daemonFake(async () => ({ status: 502, text: "Bad Gateway" }));
    expect(await send(other)).toContain(
      "届いたか確かめられなかった: the socket answered HTTP 502。",
    );
    const unread = daemonFake(async () => ({ status: 200, text: "{}" }));
    expect(await send(unread)).toBe(
      `ccmsg が送信の結果を返さず、届いたか確かめられなかった。${UNCONFIRMED_ADVICE}`,
    );
  });

  // A refusal comes before any session is written to, so nothing went; one
  // from an op that threw part way leaves the send unconfirmed. The tool says
  // the refusal's msg in words, not its JSON.
  test("a send the daemon refused says the daemon's reason, not its JSON", async () => {
    const refusing = (code: string, status = 200) =>
      daemonFake(async () => ({
        status,
        text: JSON.stringify({ ok: false, error: { code, msg: "the body is not JSON" } }),
      }));
    const send = (fake: Fake) =>
      callTool(fake, "mcp__ccmsg-v1__send", { session_id: OTHER, text: "hi" });
    expect(await send(refusing("invalid_args"))).toBe(
      "ccmsg の daemon が送信を断ったので、送っていない: the body is not JSON",
    );
    expect(await send(refusing("bad_request", 400))).toBe(
      "ccmsg の daemon が送信を断ったので、送っていない: the body is not JSON",
    );
    const threw = await send(refusing("internal"));
    expect(threw).toBe(
      `ccmsg が送信の結果を返さず、届いたか確かめられなかった: the body is not JSON。${UNCONFIRMED_ADVICE}`,
    );
  });

  // A handler that throws (here its log) is answered by the `.catch`, never
  // by `next`, which would only reach core's "no tool.call hook answered".
  test("a send whose handler fails is answered by its .catch", async () => {
    const fake = daemonFake(async () => {
      throw new Error("fetch broke");
    });
    fake.$.ui = {
      log: () => {
        throw new Error("log broke");
      },
    };
    expect(
      await callTool(fake, "mcp__ccmsg-v1__send", { session_id: OTHER, text: "hi" }),
    ).toContain("send が途中で止まり");
  });

  // 何を保証するか: say の tool は入力を検査して「読み上げを依頼した」と返す
  // だけで、プロセスを起こさない (発声は daemon が push の行から起こす、
  // DR-0045 §6)。形に合わない入力は「何もしていない」と返す。
  test("say only reads the input: the daemon speaks it from the pushed row", async () => {
    const seen: (readonly string[])[] = [];
    const fake = toolFake(async (argv) => {
      seen.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    expect(await callTool(fake, "mcp__ccmsg-v1__say", { text: "終わりました 3 件" })).toBe(
      "読み上げを依頼した (daemon が読み上げ、webui に 🔔 で出る)",
    );
    expect(await callTool(fake, "mcp__ccmsg-v1__say", {})).toContain("say の入力が形に合わない");
    expect(seen).toEqual([]);
  });

  test("peers lists the sessions send can reach, by session id, with their name and cwd", async () => {
    const fake = daemonFake(
      replying({
        ok: true,
        peers: [
          { sid: fake0, module: true, self: true },
          { sid: OTHER, name: "n", cwd: "/w", module: true, self: false },
          { sid: "c", module: false, self: false },
        ],
      }),
    );
    const result = await callTool(fake, "mcp__ccmsg-v1__peers", { cwd_prefix: "/w/" });
    expect(fake.asked.map((a) => a.body)).toEqual([
      { op: "peer_list", cwd_prefix: "/w/", hello: HELLO },
    ]);
    expect(fake.runs).toEqual([]);
    expect(result.split("\n")).toEqual([
      "送れる相手のセッション (send には session_id をこのまま書く):",
      `- session_id: ${OTHER}, name: "n", cwd: "/w"`,
      "- session_id: c (ccmsg の hooks module が動いていないので送れない)",
    ]);
  });

  // launch (DR-0018 §3.7): the model is shown one flat object of claude's
  // options, since Claude Code leaves out a tool whose schema is a top-level
  // oneOf / anyOf (docs/findings/2026-10-25-launch-tool-input-schema.md).
  // Which options go together is the skill's to say and the handler's to
  // check, not the schema's.
  test("launch is shown one flat object of types, cwd required", async () => {
    const fake = toolFake(printing({}));
    await fire(fake, "session.start", START, async () => ({}));
    expect(fake.tools.find((t) => t.name === "launch")?.inputSchema).toEqual({
      type: "object",
      properties: {
        cwd: { type: "string" },
        model: { type: "string", enum: ["mythos", "fable", "opus", "sonnet", "haiku"] },
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

  const RESUMED = "cccccccc-0000-4000-8000-000000000003";
  const launched = {
    ok: true,
    outcome: "done",
    session_id: OTHER,
    exit_code: 0,
    stdout: "started\n",
    stderr: "",
  };

  // The engine puts the tool's name, the call's id, a subagent's agent id and
  // whatever it adds later beside the input; only the input goes to the
  // daemon, with the subagent's id the daemon tells a late result to.
  test("launch asks the daemon's launch_tool and answers what the command did as JSON", async () => {
    const fake = daemonFake(replying(launched));
    // In the schema's order, which is the order the handler writes it in.
    const input = { cwd: "/w", model: "opus", effort: "high", prompt: "a\n`b` $c" };
    const result = await callTool(fake, "mcp__ccmsg-v1__launch", {
      ...input,
      tool: "mcp__ccmsg-v1__launch",
      tool_use_id: "toolu_1",
      agentId: "a1",
      engine_field_of_tomorrow: { any: "shape" },
    });
    expect(fake.asked.map((a) => a.body)).toEqual([
      { op: "launch_tool", launch: input, agent_id: "a1", hello: HELLO },
    ]);
    expect(fake.runs).toEqual([]);
    expect(result).toBe(
      JSON.stringify({ session_id: OTHER, exit_code: 0, stdout: "started\n", stderr: "" }),
    );
    // A non-zero exit carries no session_id, and is answered as it came.
    const failed = daemonFake(
      replying({ ok: true, outcome: "done", exit_code: 2, stdout: "", stderr: "no such dir\n" }),
    );
    expect(await callTool(failed, "mcp__ccmsg-v1__launch", { cwd: "/w", resume: RESUMED })).toBe(
      JSON.stringify({ exit_code: 2, stdout: "", stderr: "no such dir\n" }),
    );
    expect(failed.asked.map((a) => a.body)).toEqual([
      { op: "launch_tool", launch: { cwd: "/w", resume: RESUMED }, hello: HELLO },
    ]);
  });

  // 何を保証するか: 起動コマンドが daemon の待ちの内に終わらなかった launch は、
  // 結果が後でこの会話に届くと答える (DR-0018 §3.7)。
  test("a launch still running when the daemon answers says its result comes later", async () => {
    const fake = daemonFake(replying({ ok: true, outcome: "running" }));
    expect(await callTool(fake, "mcp__ccmsg-v1__launch", { cwd: "/w", continue: true })).toBe(
      "起動コマンドがまだ終わっていない。結果は終わった時に ccmsg からこの会話に届く",
    );
  });

  // What a new session requires missing, a combination claude refuses, or a
  // field that does not read is answered in text, and nothing is asked.
  test("an input that is not a launch is answered in text, and nothing is asked", async () => {
    const fake = daemonFake(replying(launched));
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
    expect(fake.asked).toEqual([]);
    // The reason names the field to change.
    expect(
      await callTool(fake, "mcp__ccmsg-v1__launch", { cwd: "/w", continue: true, resume: RESUMED }),
    ).toBe(
      "launch の入力が形に合わないので何もしていない: resume: continue と resume は同時に指定できない",
    );
  });

  test("a launch the daemon refused or could not be asked was not started; else it is unconfirmed", async () => {
    const refusing = (code: string, msg: string) =>
      daemonFake(async () => ({
        status: 200,
        text: JSON.stringify({ ok: false, error: { code, msg }, request_id: "op" }),
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
    expect(
      await callTool(daemonFake(replying({}), { sockets: "none" }), "mcp__ccmsg-v1__launch", input),
    ).toBe("ccmsg の daemon が居ないので、起動していない。daemon を起こす (`ccmsg daemon start`)");
    expect(
      await callTool(daemonFake(replying({}), { sockets: "old" }), "mcp__ccmsg-v1__launch", input),
    ).toBe(
      "ccmsg の daemon がこの plugin より古いので、起動していない。daemon を更新する (`ccmsg daemon restart`)",
    );
    const silent = daemonFake(async () => ({ status: 200, text: "{}" }));
    expect(await callTool(silent, "mcp__ccmsg-v1__launch", input)).toBe(
      "ccmsg が起動の結果を返さなかった。起動したか確かめられなかった。`peers` で確かめる",
    );
    // The fetch failed with the socket there: it may have started.
    const broken = daemonFake(async () => {
      throw new Error("socket hang up");
    });
    expect(await callTool(broken, "mcp__ccmsg-v1__launch", input)).toBe(
      "ccmsg の daemon から返事が無かった: Error: socket hang up。起動したか確かめられなかった。`peers` で確かめる",
    );
  });

  test("a launch whose handler fails is answered by its .catch", async () => {
    const fake = daemonFake(async () => {
      throw new Error("fetch broke");
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
      voice: "push の許可をお願いします。",
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
          voice: "push の許可をお願いします。",
        }),
        timeoutMs: PERMIT_TIMEOUT_MS,
      },
    ]);
    // The model is told the request went out, nothing of the files.
    expect(result).toBe("許可依頼を出した");
  });

  // 何を保証するか: voice は依頼の一部として sidecar permit の標準入力に渡る
  // (読み上げるのは sidecar permit)。
  test("a permit hands its voice to ccmsg sidecar permit with the request", async () => {
    const seen: (string | undefined)[] = [];
    const fake = toolFake(async (_argv, init) => {
      seen.push(init?.stdin);
      return printing({ ok: true, id: "0f0f/1" })();
    });
    const permit = {
      blocked: "`git push` が止められた",
      commands: [{ command: "git push origin main" }],
      voice: "push の許可をお願いします。",
    };
    expect(await callTool(fake, "mcp__ccmsg-v1__permit", permit)).toBe("許可依頼を出した");
    expect(seen).toEqual([JSON.stringify(permit)]);
  });

  // 何を保証するか: project_permissions は依頼の一部として sidecar permit の
  // 標準入力に渡る (* を含む rule もそのまま。判断は人がバブルで見てする)。
  // add と remove の両方を持つ要素は入口で断り、何も起こさない。
  test("a permit hands its project permissions on, and refuses an entry with both", async () => {
    const seen: (string | undefined)[] = [];
    const fake = toolFake(async (_argv, init) => {
      seen.push(init?.stdin);
      return printing({ ok: true, id: "0f0f/1" })();
    });
    const permit = {
      blocked: "`just deploy` が止められた",
      commands: [{ command: "just deploy" }],
      project_permissions: [
        { add: "Bash(just deploy)" },
        { add: "Bash(find . -name \\*.json)" },
        { remove: "Bash(just deploy-old)" },
      ],
      voice: "deploy の許可をお願いします。",
    };
    expect(await callTool(fake, "mcp__ccmsg-v1__permit", permit)).toBe("許可依頼を出した");
    expect(seen).toEqual([JSON.stringify(permit)]);
    for (const project_permissions of [[{ add: "Bash(a)", remove: "Bash(b)" }], [{}]]) {
      expect(
        await callTool(fake, "mcp__ccmsg-v1__permit", { ...permit, project_permissions }),
      ).toContain("permit の入力が形に合わない");
    }
    expect(seen).toHaveLength(1);
  });

  // Nothing to permit, a path that is not absolute, a field of another
  // type, a command that is its text alone or has none, no voice: answered in
  // text, and nothing runs.
  test("an input that is not permit's is answered in text, and nothing runs", async () => {
    const fake = toolFake(printing({ ok: true, id: "0f0f/1" }));
    const voice = "ls の許可をお願いします。";
    for (const input of [
      { blocked: "x", voice },
      { blocked: "x", intents: [], commands: [], voice },
      { blocked: "", commands: [{ command: "ls" }], voice },
      { blocked: "x", commands: [{ command: "ls" }], attachments: ["rel/a.ts"], voice },
      { blocked: "x", commands: "ls", voice },
      { blocked: "x", commands: ["ls"], voice },
      { blocked: "x", commands: [{ description: "一覧" }], voice },
      { blocked: "x", commands: [{ command: "ls" }] },
      { blocked: "x", commands: [{ command: "ls" }], voice: "" },
      {
        blocked: "x",
        commands: [{ command: "ls" }],
        voice: "あ".repeat(PERMIT_VOICE_MAX_LENGTH + 1),
      },
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

  // 何を保証するか: voice の無い入力は、voice が要ると model に言って断る。
  test("a permit without a voice is refused, saying a voice is needed", async () => {
    const fake = toolFake(printing({ ok: true, id: "0f0f/1" }));
    expect(
      await callTool(fake, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        commands: [{ command: "ls" }],
      }),
    ).toContain("voice (読み上げる 1 文、日本語) が要る");
    expect(fake.runs).toEqual([]);
  });

  // 何を保証するか: intent と description が上限の文字数を超えた入力は、どの欄の
  // 何番目が何文字か・上限・短く書き直すことを model に言って断り、何も起こさない
  // (黙って切り詰めない)。コマンドの全文は長くても通る。
  test("a permit whose intent or description is too long is refused, saying where and the limit", async () => {
    const seen: (string | undefined)[] = [];
    const fake = toolFake(async (_argv, init) => {
      seen.push(init?.stdin);
      return printing({ ok: true, id: "0f0f/1" })();
    });
    const limit = PERMIT_ITEM_TEXT_MAX_LENGTH;
    const voice = "ls の許可をお願いします。";
    expect(
      await callTool(fake, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        intents: ["あ".repeat(limit), "あ".repeat(limit + 1)],
        commands: [{ command: "ls", description: "い".repeat(limit + 5) }],
        voice,
      }),
    ).toBe(
      `permit の入力が形に合わないので何もしていない: intents.1: ${String(limit + 1)} characters, over the limit of ${String(limit)}; write it shorter; commands.0.description: ${String(limit + 5)} characters, over the limit of ${String(limit)}; write it shorter`,
    );
    expect(seen).toEqual([]);
    expect(
      await callTool(fake, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        intents: ["あ".repeat(limit)],
        commands: [{ command: "echo ".repeat(limit), description: "い".repeat(limit) }],
        voice,
      }),
    ).toBe("許可依頼を出した");
    expect(seen).toHaveLength(1);
  });

  // 何を保証するか: ファイルの rule はどの形の add (Write(...)、/ 1 つで始まる
  // path、~/ と //) も、どの形の remove も、書かれたまま sidecar に渡る (当たる
  // 形に直すのは daemon で、model には何も返さない。DR-0040 §12)。
  test("a permit hands on a file rule of any form as written", async () => {
    const seen: (string | undefined)[] = [];
    const fake = toolFake(async (_argv, init) => {
      seen.push(init?.stdin);
      return printing({ ok: true, id: "0f0f/1" })();
    });
    const base = { blocked: "x", voice: "編集の許可をお願いします。" };
    const permissions = [
      { add: "Write(//w/a.toml)" },
      { add: "Edit(/w/b.toml)" },
      { add: "Edit(~/a.toml)" },
      { add: "Read(//w/a)" },
      { add: "Bash(ls ~/x)" },
      { remove: "Write(/w/a)" },
      { remove: "Edit(~/a)" },
    ];
    // In the order the module writes the fields: the request's, then voice.
    const permitOf = (permission: { add: string } | { remove: string }) => ({
      blocked: base.blocked,
      project_permissions: [permission],
      voice: base.voice,
    });
    for (const permission of permissions) {
      expect(await callTool(fake, "mcp__ccmsg-v1__permit", permitOf(permission))).toBe(
        "許可依頼を出した",
      );
    }
    expect(seen).toEqual(permissions.map((permission) => JSON.stringify(permitOf(permission))));
  });

  // 何を保証するか: daemon が断った依頼は、その理由 (複数行も) をそのまま model
  // に返す (固定文に丸めない)。
  test("a permit the daemon refused returns the daemon's reason", async () => {
    const msg = "permit request one: the first reason\nthe second reason";
    const fake = toolFake(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ ok: false, error: { code: "invalid_args", msg } })}\n`,
    }));
    expect(
      await callTool(fake, "mcp__ccmsg-v1__permit", {
        blocked: "x",
        voice: "編集の許可をお願いします。",
        project_permissions: [{ add: "Edit(~/l/a.toml)" }, { add: "Read(~/l/b)" }],
      }),
    ).toBe(`許可依頼を出せなかった: ${msg}`);
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
        voice: "ls の許可をお願いします。",
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
        voice: "ls の許可をお願いします。",
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
        voice: "ls の許可をお願いします。",
      }),
    ).toBe(
      `ccmsg sidecar permit が ${String(PERMIT_TIMEOUT_MS / 1000)} 秒以内に終わらなかったか起動できず、許可依頼が出たか確かめられなかった: Error: timed out`,
    );
  });

  // A field that picks sessions out another way, or the other tool's, is
  // refused rather than dropped, which would list every session (peers) or
  // send by the id alone what was meant for others (send).
  test("send refuses every field but session_id, agent_id and text, asking nothing", async () => {
    const fake = daemonFake(replying({ ok: true, results: [] }));
    const takes = "send takes session_id, agent_id, text";
    for (const [field, value] of [
      ["cwd", "/w"],
      ["name", "n"],
      ["pid", 7],
      ["cwd_prefix", "/w/"],
    ] as const) {
      expect(
        await callTool(fake, "mcp__ccmsg-v1__send", {
          session_id: OTHER,
          [field]: value,
          text: "hi",
        }),
      ).toBe(`send の入力が形に合わないので何もしていない: ${takes}; ${field} is not its field`);
    }
    // Refused for the field, before the session id it lacks.
    expect(await callTool(fake, "mcp__ccmsg-v1__send", { cwd: "/w", text: "hi" })).toBe(
      `send の入力が形に合わないので何もしていない: ${takes}; cwd is not its field`,
    );
    expect(fake.asked).toEqual([]);
  });

  test("peers refuses every field but cwd_prefix, asking nothing", async () => {
    const fake = daemonFake(replying({ ok: true, peers: [] }));
    const takes = "peers takes cwd_prefix";
    for (const [field, value] of [
      ["name", "n"],
      ["cwd", "/w"],
      ["session_id", OTHER],
      ["pid", 7],
      ["agent_id", "a1"],
      ["text", "hi"],
    ] as const) {
      expect(await callTool(fake, "mcp__ccmsg-v1__peers", { [field]: value })).toBe(
        `peers の入力が形に合わないので何もしていない: ${takes}; ${field} is not its field`,
      );
    }
    expect(fake.asked).toEqual([]);
  });

  test("peers the daemon refused says the daemon's reason, not its JSON", async () => {
    const fake = daemonFake(
      replying({ ok: false, error: { code: "invalid_args", msg: "op: unknown op: peer_list" } }),
    );
    expect(await callTool(fake, "mcp__ccmsg-v1__peers", {})).toBe(
      "一覧を返せなかった: op: unknown op: peer_list",
    );
  });

  test("peers with no daemon, one too old, or no reply says why there is no list", async () => {
    const peers = (fake: Fake) => callTool(fake, "mcp__ccmsg-v1__peers", {});
    expect(await peers(daemonFake(replying({}), { sockets: "none" }))).toBe(
      "一覧を返せなかった: ccmsg の daemon が居ない。daemon を起こす (`ccmsg daemon start`)",
    );
    expect(await peers(daemonFake(replying({}), { sockets: "old" }))).toBe(
      "一覧を返せなかった: ccmsg の daemon がこの plugin より古い。daemon を更新する (`ccmsg daemon restart`)",
    );
    const aborted = daemonFake(async () => {
      throw new Error("aborted: no complete answer within 30000ms");
    });
    expect(await peers(aborted)).toBe(
      "一覧を返せなかった: Error: aborted: no complete answer within 30000ms",
    );
  });

  // 何を保証するか (DR-0062 §5、P6): comment_reply は呼び出しの tool_use の id を
  // 添えて daemon の op comment_reply を 1 回だけ尋ね、記録できたら新しい cid と
  // 返信先の引用の文を返す。返信先になれない cid・daemon が居ない・入力が形に合わない
  // は次にすることを添えた文で返す。subagent / teammate の呼び出しと tool_use の id
  // の無い呼び出しは daemon に尋ねずに断る。
  describe("comment_reply", () => {
    const call = (fake: Fake, extra: object = {}) =>
      callTool(fake, "mcp__ccmsg-v1__comment_reply", {
        tool: "mcp__ccmsg-v1__comment_reply",
        tool_use_id: "toolu_1",
        cid: "c7k2p",
        body: "そう、undefined を返す",
        ...extra,
      });

    test("asks the daemon to keep the reply under the call's id, and says the reply's cid", async () => {
      const fake = daemonFake(replying({ ok: true, cid: "c8m1t", quote: "ここは?" }));
      expect(await call(fake)).toBe(
        'c7k2p (「ここは?」) への返信を記録した。この返信の cid は c8m1t (人がこれに返信すると "on":"comment:c8m1t" で届く)',
      );
      expect(fake.asked.map((a) => a.body)).toEqual([
        {
          op: "comment_reply",
          cid: "c7k2p",
          body: "そう、undefined を返す",
          tool_use_id: "toolu_1",
          hello: HELLO,
        },
      ]);
    });

    test("a cid that is not a comment the session was sent is answered with what to do", async () => {
      const fake = daemonFake(async () => ({
        status: 200,
        text: JSON.stringify({ ok: false, error: { code: "not_found", msg: "no" } }),
      }));
      expect(await call(fake)).toBe(
        'cid c7k2p はこのセッションの本体に届いたコメントに無いので記録していない。届いたコメントの "comment" の cid を確かめて書き直す',
      );
    });

    test("another refusal, no daemon and no answer each say so", async () => {
      const refusing = daemonFake(async () => ({
        status: 200,
        text: JSON.stringify({ ok: false, error: { code: "state_not_writable", msg: "disk" } }),
      }));
      expect(await call(refusing)).toBe(
        "ccmsg の daemon が返信の記録を断ったので、記録していない: disk",
      );
      expect(await call(daemonFake(replying({}), { sockets: "none" }))).toBe(
        "ccmsg の daemon が居ないので、返信を記録していない。daemon を起こす (`ccmsg daemon start`)",
      );
      const aborted = daemonFake(async () => {
        throw new Error("aborted");
      });
      expect(await call(aborted)).toContain("返信を記録したか確かめられなかった: Error: aborted");
    });

    test("a subagent's call, a call with no id and an input not of the tool's are not asked", async () => {
      const fake = daemonFake(replying({ ok: true, cid: "c8m1t", quote: "q" }));
      expect(await call(fake, { agentId: "a1b2" })).toBe(
        "comment_reply は subagent / teammate からは使えない (コメントは本体のセッションに届く)。何も記録していない",
      );
      expect(
        await callTool(fake, "mcp__ccmsg-v1__comment_reply", { cid: "c7k2p", body: "x" }),
      ).toBe("comment_reply の呼び出しの id が読めず、記録していない");
      expect(await call(fake, { body: "  " })).toContain(
        "comment_reply の入力が形に合わないので何もしていない",
      );
      expect(await call(fake, { cid: "7k2p" })).toContain(
        "comment_reply の入力が形に合わないので何もしていない",
      );
      expect(fake.asked).toEqual([]);
    });
  });

  // agy (DR-0066 §3): answered at tool.run, after permission (K12); the calls
  // go to the daemon's agy ops, and which fields go with which call is the
  // handler's to read.
  describe("agy", () => {
    const AGY = "mcp__ccmsg-v1__agy";

    test("agy is answered at tool.run only: permission sees its calls (K12)", () => {
      const fake = daemonFake(replying({}));
      expect(fake.hooks["tool.call"].some(([matcher]) => matcher.tool === AGY)).toBe(false);
      expect(fake.hooks["tool.run"].map(([matcher]) => matcher.tool)).toEqual([AGY]);
    });

    test("a new run asks agy_run with the tool's fields and the subagent's id, and answers agyid, seq, ahead", async () => {
      const fake = daemonFake(replying({ ok: true, agyid: "c1", seq: 1, ahead: 0 }));
      const result = await runTool(fake, AGY, {
        op: "run",
        prompt: "p",
        model: "gemini-3.8-flash",
        effort: "low",
        tool: AGY,
        tool_use_id: "toolu_1",
        agentId: "a1",
      });
      expect(fake.asked.map((a) => a.body)).toEqual([
        {
          op: "agy_run",
          run: { prompt: "p", model: "gemini-3.8-flash", effort: "low" },
          agent_id: "a1",
          hello: HELLO,
        },
      ]);
      expect(result).toBe(JSON.stringify({ agyid: "c1", seq: 1, ahead: 0 }));
    });

    test("status and abort go to their ops", async () => {
      const fake = daemonFake(replying({ ok: true, conversations: [] }));
      expect(await runTool(fake, AGY, { op: "status" })).toBe(
        JSON.stringify({ conversations: [] }),
      );
      const aborting = daemonFake(replying({ ok: true, outcome: "no_turn" }));
      expect(await runTool(aborting, AGY, { op: "abort", agyid: "c1" })).toBe(
        JSON.stringify({ outcome: "no_turn" }),
      );
      expect([...fake.asked, ...aborting.asked].map((a) => a.body)).toEqual([
        { op: "agy_status", status: null, hello: HELLO },
        { op: "agy_abort", abort: { agyid: "c1" }, hello: HELLO },
      ]);
    });

    test("a call whose fields do not go together is refused without asking (§3)", async () => {
      const fake = daemonFake(replying({}));
      for (const input of [
        { op: "run", prompt: "p" },
        { op: "run", agyid: "c1", prompt: "p", model: "m" },
        { op: "abort" },
        { op: "status", seq: 1 },
      ]) {
        expect(await runTool(fake, AGY, input)).toStartWith(
          "agy の入力が形に合わないので何もしていない",
        );
      }
      expect(fake.asked).toEqual([]);
    });

    test("a refusal says why and what to do next (§6's table)", async () => {
      const fake = daemonFake(
        replying({ ok: false, error: { code: "agy_unknown_conversation", msg: "agyid c9" } }),
      );
      const result = await runTool(fake, AGY, { op: "run", agyid: "c9", prompt: "p" });
      expect(result).toContain("この daemon が発行した agyid ではない");
      expect(result).toContain("agyid を付けない status");
    });
  });
});

// agy's responses (DR-0066 §7): the daemon's notice.append puts a response
// under its mark into the conversation that asked; an agent whose loop does
// not run keeps it for its next turn.start, ahead of the wake (K15).
describe("notice.append", () => {
  const RUNNING = "r1r2r3r4r5r6r7r8r";
  const WAITING = "w1w2w3w4w5w6w7w8w";

  async function started(): Promise<Fake> {
    const fake = fakeEngine();
    fake.agents.push({ id: RUNNING, description: "d", type: "t", status: "running" });
    fake.agents.push({ id: WAITING, description: "d", type: "t", status: "idle" });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    return fake;
  }

  async function append(fake: Fake, args: object) {
    const before = fake.replies.length;
    spawned(fake, 0).stream.push(
      `${JSON.stringify({ v: 1, op: "notice.append", id: "n1", args })}\n`,
    );
    return nextReply(fake, before);
  }

  test("into the main conversation and a running agent's, under the mark", async () => {
    const fake = await started();
    expect(await append(fake, { mark: "agyid:c1 から:", text: "{}" })).toEqual({
      id: "n1",
      ok: true,
      result: { outcome: "appended" },
    });
    expect(fake.appended).toEqual(["agyid:c1 から:\n{}"]);
    expect(await append(fake, { agentId: RUNNING, mark: "agyid:c1 から:", text: "{}" })).toEqual({
      id: "n1",
      ok: true,
      result: { outcome: "appended" },
    });
    expect(fake.agentAppends).toEqual([{ agentId: RUNNING, text: "agyid:c1 から:\n{}" }]);
  });

  test("a waiting agent's is kept, and goes in at its next turn.start before the turn goes on (K15)", async () => {
    const fake = await started();
    expect(await append(fake, { agentId: WAITING, mark: "agyid:c1 から:", text: "a" })).toEqual({
      id: "n1",
      ok: true,
      result: { outcome: "not_delivered", reason: "not_running" },
    });
    expect(fake.agentAppends).toEqual([]);
    // The wake starts the agent's turn: its loop runs from turn.start on.
    for (const agent of fake.agents) if (agent.id === WAITING) agent.status = "running";
    let appendedAtNext: number | undefined;
    await fire(fake, "turn.start", { text: ".", turnId: "t1", agentId: WAITING }, async () => {
      appendedAtNext = fake.agentAppends.length;
      return {};
    });
    expect(appendedAtNext).toBe(1);
    expect(fake.agentAppends).toEqual([{ agentId: WAITING, text: "agyid:c1 から:\na" }]);
    // Kept once: the agent's next turn adds nothing again.
    await fire(fake, "turn.start", { text: "", turnId: "t2", agentId: WAITING }, async () => ({}));
    expect(fake.agentAppends).toHaveLength(1);
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

  // As measured with user_prompt (2.1.330): the harness takes the prompt
  // with the whitespace at its two ends dropped (the leading one only when
  // it is entered during a turn), and nothing inside changed. prompt.submit's
  // text is held to the same allowance.
  test("samePrompt allows only the whitespace at the two ends dropped by the harness", () => {
    expect(samePrompt("a b\n", "a b\n")).toBe(true);
    expect(samePrompt("a b", "a b\n")).toBe(true);
    expect(samePrompt("a b", "a b \t　")).toBe(true);
    expect(samePrompt("a b", "  a b")).toBe(true);
    expect(samePrompt("a b", "\n\t a b \n")).toBe(true);
    expect(samePrompt("a\nb", "a\n\nb")).toBe(false);
    expect(samePrompt("a  b", "a b")).toBe(false);
    expect(samePrompt("a\n  b", "a\nb")).toBe(false);
  });

  test("lineSplitter joins pieces and drops blank lines", () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed("a\nb");
    feed("c\n\n");
    expect(lines).toEqual(["a", "bc"]);
  });
});

// 統括 (main の会話) に teammate の待機通知 (idle_notification) が届いた時に、
// module が会話に足す 1 文。待機通知のたびに統括が「やることは無い」と応答
// して TL の雑音になるので、伝えることが無ければ本文を nothing_to_reply の
// 1 語 (webui が畳む語、protocol の定数) にするよう促す (DR-0039 §10)。
// 行の見本は Claude Code 2.1.332 の実測 (findings 2026-11-26-idle-notification-
// events) の形: 待機通知は door `note`・origin `engine` の user の行として
// 会話に入り、text は "Another Claude session sent a message:" の後に
// `<teammate-message teammate_id="<名前>" ...>` の封筒が並び、中身が
// `{"type":"idle_notification",...}` の JSON。足す文は行が入った後に
// `$.session.append` で足す: この形だけが、main が待機中でも turn の途中に
// 届いた時でも、通知に応える turn の最初の request に載った (9/9)。
describe("the note on a teammate's idle notification", () => {
  const NOTE = `続く待機通知に新しい中身が無く、人に伝えることも無ければ、応答の本文は ${NOTHING_TO_REPLY_TEXT} の 1 語だけにする。`;
  const PEER_TAIL =
    "This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings.";
  const idle = (name: string, result: string) =>
    `<teammate-message teammate_id="${name}" color="blue">\n{"type":"idle_notification","from":"${name}","timestamp":"2026-11-26T03:48:37.544Z","idleReason":"available","result":"${result}"}\n</teammate-message>`;
  const message = (name: string, body: string) =>
    `<teammate-message teammate_id="${name}" color="green" summary="tm msg ${name}">\n${body}\n</teammate-message>`;
  /** The row a mailbox delivery goes in as, its envelopes in one text block. */
  const delivered = (...envelopes: string[]) => ({
    uuid: "9fd7dec6-9f2d-475d-acb5-f186bfcfdb4c",
    door: "note",
    origin: { kind: "engine" },
    message: {
      type: "user",
      role: "user",
      content: [
        {
          type: "text",
          text: `Another Claude session sent a message:\n${envelopes.join("\n\n")}\n\n${PEER_TAIL}`,
        },
      ],
    },
  });
  const STORED = { message: {}, uuid: "stored" };
  /** Pass the row through the module's session.append hook; how many rows
   * the module had appended when `next` ran is recorded too. */
  const append = async <E>(fake: Fake, row: E) => {
    let appendedAtNext: number | undefined;
    let calls = 0;
    const result = await fire(fake, "session.append", row, async () => {
      calls += 1;
      appendedAtNext = fake.appended.length;
      return STORED;
    });
    return { result, appendedAtNext, calls };
  };

  // 何を保証するか: 中身が待機通知だけの行には、行が会話に入った後 (next の
  // 後) に 1 文を足す。行より先に足すと、行が拒まれた時に文だけが残る。hook は
  // next を 1 回呼び、その結果をそのまま返す。
  test("a row of an idle notification alone gets the note, after it went in", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    const { result, appendedAtNext, calls } = await append(
      fake,
      delivered(idle("t1", "TM-REPLY-t1-0")),
    );
    expect(calls).toBe(1);
    expect(appendedAtNext).toBe(0);
    expect(fake.appended).toEqual([NOTE]);
    expect(result).toEqual(STORED);
  });

  // 何を保証するか: 絞らない。同じ teammate の待機通知が続いても、行ごとに毎回
  // 足す (覚えておく state を持たない)。
  test("each idle row gets it, the same teammate's again too", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await append(fake, delivered(idle("t1", "first")));
    await append(fake, delivered(idle("t1", "second")));
    expect(fake.appended).toEqual([NOTE, NOTE]);
  });

  // 何を保証するか: 待機通知が複数まとまった 1 行 (続けて待機した teammate
  // たち) には 1 回だけ足す。文は行に応える turn に 1 つあれば足りる。
  test("a row of several idle notifications gets it once", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await append(fake, delivered(idle("t1", "a"), idle("t2", "b")));
    expect(fake.appended).toEqual([NOTE]);
  });

  // 何を保証するか: teammate の普通のメッセージと待機通知が 1 行にまとまった
  // 時は足さない (実測で 3/3 まとまった)。返事の要るメッセージに「伝えること
  // が無ければ 1 語」の文を添えると、メッセージへの応答が畳まれうる。
  test("a row mixing a message with an idle notification gets nothing", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await append(fake, delivered(message("t2", "TM-MSG-t2"), idle("t2", "TM-AFTER-TOOL-t2")));
    expect(fake.appended).toEqual([]);
  });

  // 何を保証するか: teammate の普通のメッセージだけの行 (同じ door・origin・
  // 封筒) には足さない。本文が JSON でないもの、JSON でも type が
  // idle_notification でないものは待機通知でない。
  test("a row of teammates' messages alone gets nothing", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await append(fake, delivered(message("t2", "TM-MSG-t2")));
    await append(fake, delivered(message("t2", '{"type":"shutdown_request","from":"t2"}')));
    expect(fake.appended).toEqual([]);
  });

  // 何を保証するか: 別のセッションからの文 (door prompt・origin peer の
  // cross-session-message) と背景の task の通知 (door queue・origin engine の
  // 行と、door prompt・origin task-notification の行) には足さない。本文に
  // 待機通知の JSON があっても、teammate の配達の行でなければ待機通知でない。
  test("another session's message and a background task's notice get nothing", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await append(fake, {
      uuid: "u-peer",
      door: "prompt",
      origin: { kind: "peer" },
      message: {
        type: "user",
        role: "user",
        isMeta: true,
        content: [
          {
            type: "text",
            text: `Another Claude session sent a message:\n<cross-session-message from="ccmsg:x" from-name="probe-peer">\n${idle("t1", "x")}\n</cross-session-message>\n\n${PEER_TAIL}`,
          },
        ],
      },
    });
    const task =
      '<task-notification>\n<task-id>bebfge6xe</task-id>\n<status>completed</status>\n<summary>Background command "bg b1" completed (exit code 0)</summary>\n</task-notification>';
    await append(fake, {
      uuid: "u-queue",
      door: "queue",
      origin: { kind: "engine" },
      message: { type: "user", role: "user", content: [{ type: "text", text: task }] },
    });
    await append(fake, {
      uuid: "u-task",
      door: "prompt",
      origin: { kind: "task-notification" },
      message: { type: "user", role: "user", content: [{ type: "text", text: task }] },
    });
    expect(fake.appended).toEqual([]);
  });

  // 何を保証するか: main の会話だけ。subagent / teammate の会話 (agentId 付き)
  // に入る同じ形の行には、main にも agent にも足さない。
  test("a row in an agent's conversation gets nothing", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await append(fake, { ...delivered(idle("t1", "x")), agentId: "at1-fb91eca8f7775f8a" });
    expect(fake.appended).toEqual([]);
    expect(fake.agentAppends).toEqual([]);
  });

  // 何を保証するか: 読めない形の行は何も足さずに素通しする: 中身が text の
  // block でない、封筒が無い、封筒の中身が壊れた JSON、行そのものが形に
  // 合わない。どれも next は 1 回呼ばれ、結果はそのまま返る。
  test("a row that does not read passes on as received, with nothing added", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    const as = (content: object[]) => ({
      ...delivered(),
      message: { type: "user", role: "user", content },
    });
    const rows = [
      as([{ type: "image" }]),
      as([{ type: "text", text: "Another Claude session sent a message:" }]),
      as([
        {
          type: "text",
          text: '<teammate-message teammate_id="t1">\n{"type":"idle_notification",\n</teammate-message>',
        },
      ]),
      { door: 7, message: "not a row" },
    ];
    for (const row of rows) {
      const { result, calls } = await append(fake, row);
      expect(calls).toBe(1);
      expect(result).toEqual(STORED);
    }
    expect(fake.appended).toEqual([]);
  });

  // 何を保証するか: 文を足す append が断られても、通知の行は会話に入った
  // まま (hook は next の結果を返し、throw しない)。失敗は debug log に書く。
  test("an append that fails keeps the row in and is logged", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    fake.$.session.append = async () => {
      throw new Error("HooksError: $.session.append: refused: no");
    };
    const { result, calls } = await append(fake, delivered(idle("t1", "x")));
    expect(calls).toBe(1);
    expect(result).toEqual(STORED);
    expect(fake.logs.some((l) => l.includes("refused: no"))).toBe(true);
  });
});

// The rows that go into the conversation are passed on to the daemon as they
// went in (DR-0045 §2): the engine's `session.append`, unread.
describe("transcript_push", () => {
  const ROW = {
    uuid: "0fffe202-9b1e-4313-86b2-479d24bd37b0",
    door: "response",
    origin: { kind: "model", model: "claude-sonnet-5-5" },
    message: {
      type: "assistant",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
    },
  };
  const rowsOf = (body: JsonObject | undefined) => body?.["rows"];
  const PushedUuidsSchema = v.object({ rows: v.array(v.object({ uuid: v.string() })) });

  // 何を保証するか: 行は会話に入った後に、uuid・door・中身をそのまま渡す。
  // subagent の行は agent_id を付ける。module は中身を読まない。
  test("a row that went in is pushed as it is, a subagent's with its agent id", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.append", ROW, async () => ({}));
    await settle();
    await fire(
      fake,
      "session.append",
      { uuid: "u2", door: "prompt", agentId: "a0ea5ee99e172bc5c", message: { type: "user" } },
      async () => ({}),
    );
    await settle();
    expect(fake.pushes.map(rowsOf)).toEqual([
      [{ uuid: ROW.uuid, door: "response", message: ROW.message }],
      [{ uuid: "u2", door: "prompt", agent_id: "a0ea5ee99e172bc5c", message: { type: "user" } }],
    ]);
    expect(fake.pushes[0]?.["op"]).toBe("transcript_push");
  });

  // 何を保証するか: engine か下の plugin が拒んだ行は会話に無いので渡さない。
  test("a row refused beneath is not pushed", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.append", ROW, async () => ({ deny: "refused" }));
    await settle();
    expect(fake.pushes).toEqual([]);
  });

  // 何を保証するか: content が空の行 (何も言わずに終わった hook の hook_success)
  // は jsonl に行が書かれないので渡さない。content のある同じ種類の行は渡す。
  test("a row with empty content is not pushed, one with content is", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    const hook = (uuid: string, content: JsonObject[]) => ({
      uuid,
      door: "hook-context",
      message: { type: "attachment", role: "user", name: "hook_success", content },
    });
    await fire(fake, "session.append", hook("h-empty", []), async () => ({}));
    await settle();
    const said = [{ type: "text", text: "hook said this" }];
    await fire(fake, "session.append", hook("h-said", said), async () => ({}));
    await settle();
    expect(fake.pushes.map(rowsOf)).toEqual([
      [{ uuid: "h-said", door: "hook-context", message: hook("h-said", said).message }],
    ]);
  });

  // 何を保証するか: 送りは 1 本ずつ。送りの返事を待つ間に入った行は、次の
  // 1 回にまとめて入った順に送る (行の順を daemon が並べ直さずに済む)。
  test("rows that go in while a push is out go together in the next, in order", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const fake = fakeEngine({
      pushed: async () => {
        if (first) {
          first = false;
          await held;
        }
        return { status: 200, text: JSON.stringify({ ok: true, request_id: "op" }) };
      },
    });
    registerOn(fake);
    for (const uuid of ["r1", "r2", "r3"]) {
      await fire(fake, "session.append", { ...ROW, uuid }, async () => ({}));
    }
    await settle();
    release();
    await settle();
    const uuids = fake.pushes.map((body) => {
      const read = parseWith(PushedUuidsSchema, body);
      return read.ok ? read.value.rows.map((r) => r.uuid) : null;
    });
    expect(uuids).toEqual([["r1"], ["r2", "r3"]]);
  });

  // 何を保証するか: 届かない送りは捨てて debug log に書く。module は再送しない
  // (抜けた行は daemon が次の送りの時に jsonl から読む)。
  test("a push the daemon does not take is dropped and logged", async () => {
    const fake = fakeEngine({ sockets: "none" });
    registerOn(fake);
    await fire(fake, "session.append", ROW, async () => ({}));
    await settle();
    expect(fake.logs).toContain("ccmsg: transcript_push not delivered (no_daemon)");
    await fire(fake, "session.append", { ...ROW, uuid: "r2" }, async () => ({}));
    await settle();
    expect(fake.logs.filter((l) => l.startsWith("ccmsg: transcript_push"))).toHaveLength(2);
  });
});

/** The commands that check the terminal `id` is this claude's: hyoui's
 * status of it, and the parent pid of a shell the module runs, which is the
 * claude's (DR-0035 §3). */
function terminalChecks(id: string): string[][] {
  return [
    ["hyoui", "status", id, "--format", "json"],
    ["/bin/sh", "-c", "echo $PPID"],
  ];
}

/** hyoui's status of a terminal whose child is pid `group` and leads that
 * process group: a terminal that is not this claude's when `group` is not
 * 4242. */
function statusOf(group: number): CommandRun {
  return {
    exitCode: 0,
    stdout: `{"session_id":"term-1","daemon_pid":7000,"child_pid":${String(group)},"child_pgid":${String(group)},"child_stopped":false,"child_state":"running"}\n`,
    stderr: "",
  };
}

// 何を保証するか: HYOUI_SESSION_ID が指す hyoui の端末の子が自分の claude
// そのもの (子の pid と、module が走らせた shell の $PPID が一致) の時だけ、
// その端末にキーを押す。
// 一致しない (別のセッションから継いだ id) か確かめられない時は、端末の無い
// run と同じ扱いにする: Enter も `!` も押さず、composer に触らず
// `no_terminal` を返し、サイドカーの名乗りにも載せない。確かめは hyoui の
// status と $PPID を出す shell の 2 つのコマンドで行う (ps は使わない。
// sandbox-exec の下では setuid の ps が起動できない)。一致した・
// 一致しなかったと分かった結果は run の間持ち、確かめ直さない。読めなかった
// 時は結果を持たず、次の prompt.send とサイドカーの起こし直しで確かめ直す。
// 確かめ直して一致したら、サイドカーを起こし直して端末ありで名乗り直す。
describe("the terminal the module presses keys on is checked to be its own", () => {
  test("an inherited id (another terminal's child): no Enter, no_terminal", async () => {
    const fake = fakeEngine({ draft: "keep", hyouiStatus: statusOf(5179) });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "from the web"));
    await settle();
    expect(fake.runs).toEqual([]);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "no_terminal" });
    expect(fake.fills).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  test("an inherited id with a bash mode command: no `!`, the composer untouched", async () => {
    const fake = fakeEngine({ draft: "keep", hyouiStatus: statusOf(5179) });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queuedBash(fake, state, "ls"));
    await settle();
    expect(fake.runs).toEqual([]);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "no_terminal" });
    expect(fake.fills).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  test("an inherited id is not named to the daemon", async () => {
    const fake = fakeEngine({
      env: { CLAUDE_CONFIG_DIR: "/h/.claude-a", HYOUI_SESSION_ID: "term-1" },
      hyouiStatus: statusOf(5179),
    });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    const argv = spawned(fake, 0).argv;
    expect(argv).not.toContain("--hyoui-session-id");
    expect(flagOf(argv, "--config-dir")).toBe("/h/.claude-a");
  });

  test("its own terminal is checked before the sidecar is named, and named", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    expect(fake.checks).toEqual(terminalChecks("term-1"));
    expect(flagOf(spawned(fake, 0).argv, "--hyoui-session-id")).toBe("term-1");
  });

  test("checked once per run: the sidecar and every prompt.send after it share it", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    const state = registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    for (const text of ["one", "two"]) {
      expect(await handlePromptSend(fake.$, state, queued(fake, state, text))).toEqual({
        outcome: "accepted",
      });
    }
    expect(fake.checks).toEqual(terminalChecks("term-1"));
    expect(fake.runs).toEqual([hyouiEnterArgv("term-1"), hyouiEnterArgv("term-1")]);
  });

  test("a terminal that cannot be checked counts as none", async () => {
    const unchecked: {
      name: string;
      hyouiStatus?: CommandRun | Error;
      parentPid?: CommandRun | Error;
    }[] = [
      {
        name: "hyoui status fails",
        hyouiStatus: { exitCode: 1, stdout: "", stderr: "no such session\n" },
      },
      { name: "hyoui is not there", hyouiStatus: new Error("ENOENT: hyoui") },
      {
        name: "hyoui status is not JSON",
        hyouiStatus: { exitCode: 0, stdout: "session-id: term-1\n", stderr: "" },
      },
      {
        name: "the terminal's child has exited",
        hyouiStatus: {
          exitCode: 0,
          stdout: '{"session_id":"term-1","daemon_pid":7000,"child_state":"exited"}\n',
          stderr: "",
        },
      },
      {
        name: "hyoui status gives no child pid",
        hyouiStatus: {
          exitCode: 0,
          stdout: '{"session_id":"term-1","daemon_pid":7000,"child_state":"running"}\n',
          stderr: "",
        },
      },
      { name: "the shell fails", parentPid: { exitCode: 1, stdout: "", stderr: "sh: denied\n" } },
      { name: "the shell throws", parentPid: new Error("timed out") },
      { name: "the shell prints no pid", parentPid: { exitCode: 0, stdout: "\n", stderr: "" } },
    ];
    for (const { name, hyouiStatus, parentPid } of unchecked) {
      const fake = fakeEngine({
        draft: "keep",
        ...(hyouiStatus !== undefined ? { hyouiStatus } : {}),
        ...(parentPid !== undefined ? { parentPid } : {}),
      });
      const state = registerOn(fake);
      const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
      await settle();
      expect({ name, runs: fake.runs }).toEqual({ name, runs: [] });
      expect({ name, report: await report }).toEqual({
        name,
        report: { outcome: "not_delivered", reason: "no_terminal" },
      });
    }
  });

  test("an unreadable check is made again at the next prompt.send, which then goes through", async () => {
    const answers: (CommandRun | Error)[] = [new Error("timed out"), statusOf(4242)];
    const fake = fakeEngine({
      onEnter: submitComposer,
      hyouiStatus: () => answers.shift() ?? statusOf(4242),
    });
    const state = registerOn(fake);
    const first = handlePromptSend(fake.$, state, queued(fake, state, "one"));
    await settle();
    expect(fake.runs).toEqual([]);
    expect(await first).toEqual({ outcome: "not_delivered", reason: "no_terminal" });
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "two"))).toEqual({
      outcome: "accepted",
    });
    expect(fake.checks).toEqual([...terminalChecks("term-1"), ...terminalChecks("term-1")]);
    expect(fake.runs).toEqual([hyouiEnterArgv("term-1")]);
  });

  test("a terminal found to be another's is not checked again", async () => {
    const fake = fakeEngine({ hyouiStatus: statusOf(5179) });
    const state = registerOn(fake);
    for (const text of ["one", "two"]) {
      expect(await handlePromptSend(fake.$, state, queued(fake, state, text))).toEqual({
        outcome: "not_delivered",
        reason: "no_terminal",
      });
    }
    expect(fake.checks).toEqual(terminalChecks("term-1"));
    expect(fake.runs).toEqual([]);
  });

  // hyoui says the terminal's child has exited: this claude, which is alive,
  // is not that child, and a terminal does not get a child back.
  test("a terminal whose child has exited is not checked again", async () => {
    const fake = fakeEngine({
      hyouiStatus: {
        exitCode: 0,
        stdout: '{"session_id":"term-1","daemon_pid":7000,"child_state":"exited"}\n',
        stderr: "",
      },
    });
    const state = registerOn(fake);
    for (const text of ["one", "two"]) {
      await handlePromptSend(fake.$, state, queued(fake, state, text));
    }
    expect(fake.checks).toEqual(terminalChecks("term-1"));
  });

  test("an unreadable check at the sidecar's start is made again when it starts again", async () => {
    const answers: (CommandRun | Error)[] = [new Error("timed out")];
    const fake = fakeEngine({ hyouiStatus: () => answers.shift() ?? statusOf(4242) });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    expect(spawned(fake, 0).argv).not.toContain("--hyoui-session-id");
    spawned(fake, 0).stream.end();
    await settle();
    lastTimer(fake).fn();
    await settle();
    expect(flagOf(spawned(fake, 1).argv, "--hyoui-session-id")).toBe("term-1");
  });

  test("a prompt.send that confirms the terminal starts the sidecar again to name it", async () => {
    const answers: (CommandRun | Error)[] = [{ exitCode: 1, stdout: "", stderr: "busy\n" }];
    const fake = fakeEngine({
      onEnter: submitComposer,
      hyouiStatus: () => answers.shift() ?? statusOf(4242),
    });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    expect(spawned(fake, 0).argv).not.toContain("--hyoui-session-id");
    spawned(fake, 0).stream.push('{"v":1,"op":"prompt.send","id":"r9","args":{"text":"hello"}}\n');
    expect(await nextReply(fake)).toEqual({ id: "r9", ok: true, result: { outcome: "accepted" } });
    await settle();
    expect(spawned(fake, 0).stream.returned.value).toBe(true);
    lastTimer(fake).fn();
    await settle();
    expect(flagOf(spawned(fake, 1).argv, "--hyoui-session-id")).toBe("term-1");
  });

  // sandbox-exec refuses to run `/bin/ps` (setuid); the shell's own $PPID
  // still reads. A claude that is the terminal's child is found there too.
  test("under sandbox-exec, its own terminal is found and Enter goes in", async () => {
    const fake = fakeEngine({ sandboxed: true, onEnter: submitComposer });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "from the web"))).toEqual({
      outcome: "accepted",
    });
    expect(fake.runs).toEqual([hyouiEnterArgv("term-1")]);
  });

  // A wrapper that runs claude without exec leaves the wrapper as the
  // terminal's child: claude is its grandchild, in the same process group,
  // and is not taken as the terminal's.
  test("a claude that is not the terminal's child (a wrapper without exec): no_terminal", async () => {
    const fake = fakeEngine({
      draft: "keep",
      hyouiStatus: {
        exitCode: 0,
        stdout:
          '{"session_id":"term-1","daemon_pid":7000,"child_pid":4100,"child_pgid":4242,"child_stopped":false,"child_state":"running"}\n',
        stderr: "",
      },
    });
    const state = registerOn(fake);
    const report = handlePromptSend(fake.$, state, queued(fake, state, "x"));
    await settle();
    expect(fake.runs).toEqual([]);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "no_terminal" });
  });

  test("outside hyoui nothing is run to check", async () => {
    const fake = fakeEngine({ env: {} });
    const state = registerOn(fake);
    expect(await handlePromptSend(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "not_delivered",
      reason: "no_terminal",
    });
    expect(fake.checks).toEqual([]);
  });
});
