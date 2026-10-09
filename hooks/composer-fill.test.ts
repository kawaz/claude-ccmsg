// The hooks module of DR-0035 against a stand-in engine: what it does to the
// composer, what it runs, and what it replies, for each request and each way a
// prompt.send can go. What a request line must be to run, and which code
// refuses it, is the protocol's (packages/protocol/test/sidecar.test.ts); here
// it is how the module answers.
import { describe, expect, test } from "bun:test";
import { errorText, parseWith } from "@ccmsg/protocol/parse";
import {
  type DescribeResult,
  SIDECAR_OP_NAMES,
  type SidecarReply,
  SidecarReplyTextSchema,
} from "@ccmsg/protocol/sidecar";
import {
  ACCEPT_WAIT_MS,
  type Engine,
  type HookedEvent,
  type Hook,
  answer,
  handlePromptSend,
  hyouiEnterArgv,
  lineSplitter,
  type ModuleState,
  type On,
  type QueuedSend,
  register,
  replyArgv,
  RESPAWN_MIN_MS,
  samePrompt,
  type SpawnChunk,
  type SpawnEnd,
} from "./composer-fill.ts";

const START = { cwd: "/w", isInteractive: true, surface: "terminal" };
const CLASSIC_START = {
  session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};

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

/** The hooks the module registered, by event. */
type HookTable = Partial<Record<HookedEvent, Hook>>;

interface Fake {
  $: Engine;
  composer: { text: string };
  runs: string[][];
  /** What each run got on standard input, by the index of the run. */
  stdins: (string | undefined)[];
  /** The env each run was given, by the index of the run. */
  envs: (Record<string, string> | undefined)[];
  spawns: { argv: readonly string[]; stream: ReturnType<typeof controlledStream> }[];
  timers: Timer[];
  hooks: HookTable;
  /** The `.catch` handler of each hook, by event. */
  catchers: HookTable;
  sid: { value: string };
  fills: string[];
  logs: string[];
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
  const stdins: (string | undefined)[] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const spawns: Fake["spawns"] = [];
  const timers: Timer[] = [];
  const sid = { value: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  const fills: string[] = [];
  const logs: string[] = [];
  const $: Engine = {
    plugin: { root: "/plugin" },
    session: {
      id: async () => sid.value,
      surfaces: async () => options.surfaces ?? ["terminal"],
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
        runs.push([...argv]);
        stdins.push(init?.stdin);
        envs.push(init?.env);
        if (argv[0] === "hyoui") {
          const exitCode = options.onEnter ? await options.onEnter(fake) : 0;
          return { exitCode, stdout: "", stderr: "" };
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
    runs,
    stdins,
    envs,
    spawns,
    timers,
    hooks: {},
    sid,
    fills,
    logs,
    catchers: {},
  };
  return fake;
}

/** Run the module's hook on `event` as the engine would: when the hook
 * throws, its `.catch` handler runs in its place with a replay-safe `next`,
 * which answers what the hook's own call settled to and runs nothing beneath
 * again (the engine's `Caught`). */
async function fire<E, R>(
  fake: Fake,
  event: HookedEvent,
  e: E,
  next: (e: E) => Promise<R>,
): Promise<R> {
  const hook = fake.hooks[event];
  if (hook === undefined) throw new Error(`no hook on ${event}`);
  let called: Promise<R> | undefined;
  const once = (input: E): Promise<R> => {
    called ??= next(input);
    return called;
  };
  try {
    return await hook(fake.$, e, once);
  } catch (error) {
    const handler = fake.catchers[event];
    if (handler === undefined) throw error;
    return handler(fake.$, e, once);
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
 * through the module's hook (the composer clears beneath it), then
 * classic.UserPromptSubmit. */
async function submitComposer(fake: Fake): Promise<number> {
  const text = fake.composer.text;
  await fire(fake, "prompt.submit", { text, origin: { kind: "composer" } }, async () => {
    fake.composer.text = "";
    return {};
  });
  await fire(fake, "classic.UserPromptSubmit", { prompt: text }, async () => ({}));
  return 0;
}

function registerOn(fake: Fake): ModuleState {
  const on: On = (event, hook) => {
    fake.hooks[event] = hook;
    return {
      catch: (handler) => {
        fake.catchers[event] = handler;
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

  // The composer moved on without UserPromptSubmit: nothing decisive to say.
  test("submitted without UserPromptSubmit: unconfirmed", async () => {
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

describe("the sidecar the module keeps", () => {
  test("session.start spawns it; a prompt.send line becomes a fill and a reply", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    expect(fake.spawns.map((s) => s.argv)).toEqual([
      ["/plugin/bin/ccmsg", "sidecar", "--sid", fake.sid.value],
    ]);
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

  test("session.start and classic.SessionStart together start one sidecar", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await Promise.all([
      fire(fake, "session.start", START, async () => ({})),
      fire(fake, "classic.SessionStart", CLASSIC_START, async () => ({})),
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

  test("a new session id (/clear) replaces the sidecar", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fire(fake, "session.start", START, async () => ({}));
    await settle();
    fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await fire(fake, "classic.SessionStart", CLASSIC_START, async () => ({}));
    await settle();
    expect(spawned(fake, 0).stream.returned.value).toBe(true);
    expect(fake.spawns.map((s) => s.argv.at(-1))).toEqual([
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]);
    // The replaced sidecar's end is not answered with a respawn.
    expect(fake.timers).toEqual([]);
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
      await fire(fake, "classic.SessionStart", CLASSIC_START, async () => ({}));
      await settle();
      expect(fake.spawns).toEqual([]);
    });
  }

  // After a reload the first event may be classic.SessionStart: the session
  // itself is asked whether it draws anywhere.
  test("classic.SessionStart first, in a session that draws nowhere", async () => {
    const fake = fakeEngine({ surfaces: [] });
    registerOn(fake);
    await fire(fake, "classic.SessionStart", CLASSIC_START, async () => ({}));
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
    const result: DescribeResult = { v: [1], ops: ["describe", "prompt.send"], version: "1.2.3" };
    expect(reply).toEqual({ id: "d1", ok: true, result });
    expect(fake.runs[0]).toEqual(["/plugin/bin/ccmsg", "version"]);
    // The launcher must not hand over to a newer ccmsg on PATH, whose version
    // would not be this module's.
    expect(fake.envs[0]).toEqual({ CCMSG_NO_SELF_EXEC: "1" });
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
    await fire(fake, "prompt.submit", { text: "mine", origin: "composer" }, next);
    expect(calls.count).toBe(1);
    expect(fake.fills).toEqual([]);
    expect(fake.logs.some((l) => l.startsWith("ccmsg: prompt.submit not read: origin"))).toBe(true);
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
        (l) => l === "ccmsg: prompt.submit failed after the event: Error: engine gone",
      ),
    ).toBe(true);
  });

  test("a failure before next is logged and the event goes on once", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.awaiting = {
      text: "x",
      accept: () => {
        throw new Error("accept broke");
      },
    };
    const { calls, next } = countingNext();
    await fire(fake, "classic.UserPromptSubmit", { prompt: "x" }, next);
    expect(calls.count).toBe(1);
    expect(fake.logs.some((l) => l.includes("failed before the event: Error: accept broke"))).toBe(
      true,
    );
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
      "classic.SessionStart",
      "classic.UserPromptSubmit",
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
});

describe("putting the draft back", () => {
  // The person started typing something new while the filled prompt went in:
  // what they type now wins, and the old draft goes to the debug log.
  test("does not overwrite text typed meanwhile", async () => {
    const fake = fakeEngine({
      draft: "old draft",
      onEnter: async (f) => {
        const text = f.composer.text;
        await fire(f, "prompt.submit", { text, origin: { kind: "composer" } }, async () => {
          f.composer.text = "typed meanwhile";
          return {};
        });
        await fire(f, "classic.UserPromptSubmit", { prompt: text }, async () => ({}));
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

  test("every hook carries a .catch that passes the event on", () => {
    const fake = fakeEngine();
    registerOn(fake);
    expect(Object.keys(fake.catchers).toSorted()).toEqual(Object.keys(fake.hooks).toSorted());
  });
});

describe("pure helpers", () => {
  test("hyouiEnterArgv names the terminal by its session id alone", () => {
    expect(hyouiEnterArgv("t")).toEqual(["hyoui", "input", "t", "key:Enter"]);
  });

  test("replyArgv names the session and carries nothing of the reply", () => {
    expect(replyArgv("/p", "s")).toEqual(["/p/bin/ccmsg", "sidecar", "reply", "--sid", "s"]);
  });

  // As measured: the harness hands UserPromptSubmit the prompt with trailing
  // whitespace dropped, and nothing else changed.
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
