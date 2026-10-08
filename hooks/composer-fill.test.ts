// The hooks module of DR-0035 against a stand-in engine: what it does to the
// composer, what it runs, and what it reports, for each way a fill can go.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  ACCEPT_WAIT_MS,
  type Engine,
  handleFill,
  hyouiEnterArgv,
  lineSplitter,
  type ModuleState,
  type On,
  type QueuedFill,
  parseFillRequest,
  register,
  reportArgv,
  RESPAWN_MIN_MS,
  samePrompt,
} from "./composer-fill.ts";

type Hook = (...args: any[]) => Promise<unknown>;

interface Timer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

/** A spawn stream the test feeds and ends. */
function controlledStream() {
  const queue: { stream: "stdout" | "stderr"; text: string }[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const returned = { value: false };
  const gen = (async function* () {
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

interface Fake {
  $: Engine;
  composer: { text: string };
  runs: string[][];
  spawns: { argv: readonly string[]; stream: ReturnType<typeof controlledStream> }[];
  timers: Timer[];
  hooks: Map<string, Hook>;
  sid: { value: string };
  fills: string[];
  logs: string[];
  catches: Set<string>;
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
  } = {},
): Fake {
  const fake = {
    composer: { text: options.draft ?? "" },
    runs: [] as string[][],
    spawns: [] as Fake["spawns"],
    timers: [] as Timer[],
    hooks: new Map<string, Hook>(),
    sid: { value: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    fills: [] as string[],
    logs: [] as string[],
    catches: new Set<string>(),
  } as Fake;
  // HYOUI_NAMESPACE is still exported by environments set up for older hyoui;
  // the default env carries it so every Enter below shows it is not passed on.
  const env = options.env ?? { HYOUI_SESSION_ID: "term-1", HYOUI_NAMESPACE: "ns-1" };
  let now = 0;
  fake.$ = {
    plugin: { root: "/plugin" },
    session: {
      id: async () => fake.sid.value,
      surfaces: async () => options.surfaces ?? ["terminal"],
    },
    prompt: {
      read: async () => ({ text: fake.composer.text, cursor: fake.composer.text.length }),
      fill: async ({ text }) => {
        if (options.refusal) {
          return { isFilled: false, refusal: options.refusal, text: fake.composer.text };
        }
        fake.fills.push(text);
        fake.composer.text = text;
        return { isFilled: true, text };
      },
    },
    process: {
      run: async (argv) => {
        fake.runs.push([...argv]);
        if (argv[0] === "hyoui") {
          const exitCode = options.onEnter ? await options.onEnter(fake) : 0;
          return { exitCode, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: ({ argv }) => {
        const stream = controlledStream();
        fake.spawns.push({ argv, stream });
        return stream.gen;
      },
    },
    env: { get: async (name) => env[name] },
    clock: {
      now: async () => (now += 1),
      after: (ms, fn) => {
        const timer = { ms, fn, cancelled: false };
        fake.timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
    ui: { log: (text) => fake.logs.push(text) },
  };
  return fake;
}

/** What the harness does on Enter with text in the composer: prompt.submit
 * through the module's hook (the composer clears beneath it), then
 * classic.UserPromptSubmit. */
async function submitComposer(fake: Fake): Promise<number> {
  const text = fake.composer.text;
  await fake.hooks.get("prompt.submit")!(
    fake.$,
    { text, origin: { kind: "composer" } },
    async () => {
      fake.composer.text = "";
      return {};
    },
  );
  await fake.hooks.get("classic.UserPromptSubmit")!(fake.$, { prompt: text }, async () => ({}));
  return 0;
}

function registerOn(fake: Fake) {
  const on = ((event: string, hook: Hook) => {
    fake.hooks.set(event, hook);
    return { catch: () => fake.catches.add(event) };
  }) as unknown as On;
  return register(on);
}

/** A fill as the module queues it, for the session as it is now. */
function queued(fake: Fake, state: ModuleState, text: string): QueuedFill {
  state.sid ??= fake.sid.value;
  return { id: "r1", text, sid: fake.sid.value, generation: state.generation };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fire the accept-wait timer once handleFill has set it. */
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

describe("handleFill", () => {
  test("accepted: Enter on its own terminal, then the draft goes back", async () => {
    const fake = fakeEngine({ draft: "half typed 書きかけ", onEnter: submitComposer });
    const state = registerOn(fake);
    const report = await handleFill(fake.$, state, queued(fake, state, "from the web"));
    expect(report).toEqual({ outcome: "accepted" });
    expect(fake.runs).toEqual([["hyoui", "input", "term-1", "key:Enter"]]);
    expect(fake.composer.text).toBe("half typed 書きかけ");
    expect(state.awaiting).toBeUndefined();
    expect(state.restoring).toBeUndefined();
  });

  test("accepted with an empty composer leaves it empty", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state, queued(fake, state, "hi"))).toEqual({
      outcome: "accepted",
    });
    expect(fake.composer.text).toBe("");
    expect(fake.fills).toEqual(["hi"]);
  });

  test("no hyoui terminal: no_terminal, and the composer is never touched", async () => {
    const fake = fakeEngine({ draft: "keep", env: {} });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "not_delivered",
      reason: "no_terminal",
    });
    expect(fake.fills).toEqual([]);
    expect(fake.runs).toEqual([]);
  });

  test("a dialog refuses the fill: no Enter, the reason is reported", async () => {
    const fake = fakeEngine({ draft: "keep", refusal: "dialog" });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "not_delivered",
      reason: "dialog",
    });
    expect(fake.runs).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  test("Enter that submits nothing: not_submitted, the draft goes back", async () => {
    const fake = fakeEngine({ draft: "keep" });
    const state = registerOn(fake);
    const report = handleFill(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "not_submitted" });
    expect(fake.composer.text).toBe("keep");
  });

  test("hyoui failing with the text still in the composer: enter_failed", async () => {
    const fake = fakeEngine({ draft: "keep", onEnter: async () => 1 });
    const state = registerOn(fake);
    const report = handleFill(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "enter_failed" });
    expect(fake.composer.text).toBe("keep");
  });

  // The composer moved on without UserPromptSubmit: nothing decisive to say,
  // so nothing is reported and the daemon answers unconfirmed.
  test("submitted without UserPromptSubmit: no report", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        f.composer.text = "";
        return 0;
      },
    });
    const state = registerOn(fake);
    const report = handleFill(fake.$, state, queued(fake, state, "x"));
    await expireAcceptWait(fake);
    expect(await report).toBeUndefined();
  });

  test("a prompt.submit of other text does not put the draft back", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.restoring = { text: "mine", draft: "draft" };
    await fake.hooks.get("prompt.submit")!(
      fake.$,
      { text: "someone else's", origin: { kind: "composer" } },
      async () => ({}),
    );
    expect(fake.fills).toEqual([]);
    expect(state.restoring).toEqual({ text: "mine", draft: "draft" });
  });
});

describe("the sidecar the module keeps", () => {
  test("session.start spawns it; a line becomes a fill and a report", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    registerOn(fake);
    await fake.hooks.get("session.start")!(fake.$, {}, async () => ({}));
    await settle();
    expect(fake.spawns.map((s) => s.argv)).toEqual([
      ["/plugin/bin/ccmsg", "sidecar", "--sid", fake.sid.value],
    ]);
    fake.spawns[0]!.stream.push('{"kind":"prompt.fill","id":"r9",');
    fake.spawns[0]!.stream.push('"text":"hello"}\n');
    for (let i = 0; i < 10 && fake.runs.length < 2; i++) await settle();
    expect(fake.runs).toEqual([
      ["hyoui", "input", "term-1", "key:Enter"],
      [
        "/plugin/bin/ccmsg",
        "sidecar",
        "report",
        "--sid",
        fake.sid.value,
        "--id",
        "r9",
        "--outcome",
        "accepted",
      ],
    ]);
  });

  test("session.start and classic.SessionStart together start one sidecar", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await Promise.all([
      fake.hooks.get("session.start")!(fake.$, {}, async () => ({})),
      fake.hooks.get("classic.SessionStart")!(fake.$, {}, async () => ({})),
    ]);
    await settle();
    expect(fake.spawns.length).toBe(1);
  });

  test("a sidecar that ends is started again after a delay", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fake.hooks.get("session.start")!(fake.$, {}, async () => ({}));
    await settle();
    fake.spawns[0]!.stream.end();
    await settle();
    expect(fake.spawns.length).toBe(1);
    const respawn = fake.timers.at(-1)!;
    expect(respawn.ms).toBe(RESPAWN_MIN_MS);
    respawn.fn();
    await settle();
    expect(fake.spawns.length).toBe(2);
    // Dying young again doubles the wait.
    fake.spawns[1]!.stream.end();
    await settle();
    expect(fake.timers.at(-1)!.ms).toBe(RESPAWN_MIN_MS * 2);
  });

  test("a new session id (/clear) replaces the sidecar", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fake.hooks.get("session.start")!(fake.$, {}, async () => ({}));
    await settle();
    fake.sid.value = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await fake.hooks.get("classic.SessionStart")!(fake.$, {}, async () => ({}));
    await settle();
    expect(fake.spawns[0]!.stream.returned.value).toBe(true);
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
      await fake.hooks.get("session.start")!(fake.$, e, async () => ({}));
      await fake.hooks.get("classic.SessionStart")!(fake.$, {}, async () => ({}));
      await settle();
      expect(fake.spawns).toEqual([]);
    });
  }

  // After a reload the first event may be classic.SessionStart: the session
  // itself is asked whether it draws anywhere.
  test("classic.SessionStart first, in a session that draws nowhere", async () => {
    const fake = fakeEngine({ surfaces: [] });
    registerOn(fake);
    await fake.hooks.get("classic.SessionStart")!(fake.$, {}, async () => ({}));
    await settle();
    expect(fake.spawns).toEqual([]);
  });

  test("an interactive session.start does start one", async () => {
    const fake = fakeEngine();
    registerOn(fake);
    await fake.hooks.get("session.start")!(
      fake.$,
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
    await fake.hooks.get("session.start")!(fake.$, {}, async () => ({}));
    await settle();
    const before = state.generation;
    await fake.hooks.get("session.end")!(fake.$, { reason: "other" }, async () => ({}));
    expect(state.generation).toBe(before);
    await fake.hooks.get("session.end")!(fake.$, { reason: "clear" }, async () => ({}));
    expect(state.generation).toBe(before + 1);
  });

  // The id changed between the fill and Enter: no Enter, the draft goes
  // back, and nothing is reported.
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
    expect(await handleFill(fake.$, state, request)).toBeUndefined();
    expect(fake.runs).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  // Enter went out, then the session moved on before the event: not this
  // request's to report.
  test("a new generation after Enter is not reported", async () => {
    const fake = fakeEngine({
      onEnter: async (f) => {
        state.generation += 1;
        return submitComposer(f);
      },
    });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state, queued(fake, state, "x"))).toBeUndefined();
  });

  test("a fill queued under the old id is dropped, unfilled and unreported", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    registerOn(fake);
    await fake.hooks.get("session.start")!(fake.$, {}, async () => ({}));
    await settle();
    fake.spawns[0]!.stream.push('{"kind":"prompt.fill","id":"old","text":"late"}\n');
    await fake.hooks.get("session.end")!(fake.$, { reason: "clear" }, async () => ({}));
    await settle();
    expect(fake.fills).toEqual([]);
    expect(fake.runs).toEqual([]);
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
        await f.hooks.get("prompt.submit")!(
          f.$,
          { text, origin: { kind: "composer" } },
          async () => {
            f.composer.text = "typed meanwhile";
            return {};
          },
        );
        await f.hooks.get("classic.UserPromptSubmit")!(f.$, { prompt: text }, async () => ({}));
        return 0;
      },
    });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state, queued(fake, state, "x"))).toEqual({
      outcome: "accepted",
    });
    expect(fake.composer.text).toBe("typed meanwhile");
    expect(fake.logs.some((l) => l.includes("old draft"))).toBe(true);
  });

  test("every hook carries a .catch that passes the event on", () => {
    const fake = fakeEngine();
    registerOn(fake);
    expect([...fake.catches].toSorted()).toEqual([...fake.hooks.keys()].toSorted());
  });
});

describe("pure helpers", () => {
  test("parseFillRequest takes only well-formed fill lines", () => {
    expect(parseFillRequest('{"kind":"prompt.fill","id":"1","text":"a"}')).toEqual({
      id: "1",
      text: "a",
    });
    expect(parseFillRequest('{"kind":"other","id":"1","text":"a"}')).toBeUndefined();
    expect(parseFillRequest('{"kind":"prompt.fill","id":"","text":"a"}')).toBeUndefined();
    expect(parseFillRequest('{"kind":"prompt.fill","id":"1","text":"  "}')).toBeUndefined();
    expect(parseFillRequest("not json")).toBeUndefined();
  });

  test("hyouiEnterArgv names the terminal by its session id alone", () => {
    expect(hyouiEnterArgv("t")).toEqual(["hyoui", "input", "t", "key:Enter"]);
  });

  test("reportArgv carries the reason only with not_delivered", () => {
    expect(
      reportArgv("/p", "s", "i", { outcome: "not_delivered", reason: "dialog" }).slice(-4),
    ).toEqual(["--outcome", "not_delivered", "--reason", "dialog"]);
  });

  // As measured: the harness hands UserPromptSubmit the prompt with trailing
  // whitespace dropped, and nothing else changed.
  test("samePrompt allows only trailing whitespace dropped by the harness", () => {
    expect(samePrompt("a b\n", "a b\n")).toBe(true);
    expect(samePrompt("a b", "a b\n")).toBe(true);
    expect(samePrompt("a b", "a b \t\u3000")).toBe(true);
    expect(samePrompt("a b\n", "a b")).toBe(false);
    expect(samePrompt("a b", "  a b")).toBe(false);
    expect(samePrompt("a\nb", "a\n\nb")).toBe(false);
    expect(samePrompt("a  b", "a b")).toBe(false);
    expect(samePrompt(undefined, "a")).toBe(false);
  });

  test("lineSplitter joins pieces and drops blank lines", () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed("a\nb");
    feed("c\n\n");
    expect(lines).toEqual(["a", "bc"]);
  });

  // The module loader runs no imports, so the file has to stand alone.
  test("the module imports nothing at run time", () => {
    const source = fs.readFileSync(new URL("./composer-fill.ts", import.meta.url), "utf8");
    expect(source.match(/^import (?!type )/m)).toBeNull();
  });
});
