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
  type On,
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
}

/** An engine whose composer, environment and clock the test holds. `onEnter`
 * stands for what the terminal does with the Enter key. */
function fakeEngine(
  options: {
    draft?: string;
    env?: Record<string, string>;
    refusal?: "dialog" | "no_composer";
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
  } as Fake;
  const env = options.env ?? { HYOUI_SESSION_ID: "term-1", HYOUI_NAMESPACE: "ns-1" };
  let now = 0;
  fake.$ = {
    plugin: { root: "/plugin" },
    session: { id: async () => fake.sid.value },
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
    ui: { log: () => {} },
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
  }) as unknown as On;
  return register(on);
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
    const report = await handleFill(fake.$, state.fill, { id: "r1", text: "from the web" });
    expect(report).toEqual({ outcome: "accepted" });
    expect(fake.runs).toEqual([["hyoui", "input", "--namespace=ns-1", "term-1", "key:Enter"]]);
    expect(fake.composer.text).toBe("half typed 書きかけ");
    expect(state.fill).toEqual({ awaiting: undefined, restoring: undefined });
  });

  test("accepted with an empty composer leaves it empty", async () => {
    const fake = fakeEngine({ onEnter: submitComposer });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state.fill, { id: "r1", text: "hi" })).toEqual({
      outcome: "accepted",
    });
    expect(fake.composer.text).toBe("");
    expect(fake.fills).toEqual(["hi"]);
  });

  test("no hyoui terminal: no_terminal, and the composer is never touched", async () => {
    const fake = fakeEngine({ draft: "keep", env: {} });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state.fill, { id: "r1", text: "x" })).toEqual({
      outcome: "not_delivered",
      reason: "no_terminal",
    });
    expect(fake.fills).toEqual([]);
    expect(fake.runs).toEqual([]);
  });

  test("a dialog refuses the fill: no Enter, the reason is reported", async () => {
    const fake = fakeEngine({ draft: "keep", refusal: "dialog" });
    const state = registerOn(fake);
    expect(await handleFill(fake.$, state.fill, { id: "r1", text: "x" })).toEqual({
      outcome: "not_delivered",
      reason: "dialog",
    });
    expect(fake.runs).toEqual([]);
    expect(fake.composer.text).toBe("keep");
  });

  test("Enter that submits nothing: not_submitted, the draft goes back", async () => {
    const fake = fakeEngine({ draft: "keep" });
    const state = registerOn(fake);
    const report = handleFill(fake.$, state.fill, { id: "r1", text: "x" });
    await expireAcceptWait(fake);
    expect(await report).toEqual({ outcome: "not_delivered", reason: "not_submitted" });
    expect(fake.composer.text).toBe("keep");
  });

  test("hyoui failing with the text still in the composer: enter_failed", async () => {
    const fake = fakeEngine({ draft: "keep", onEnter: async () => 1 });
    const state = registerOn(fake);
    const report = handleFill(fake.$, state.fill, { id: "r1", text: "x" });
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
    const report = handleFill(fake.$, state.fill, { id: "r1", text: "x" });
    await expireAcceptWait(fake);
    expect(await report).toBeUndefined();
  });

  test("a prompt.submit of other text does not put the draft back", async () => {
    const fake = fakeEngine();
    const state = registerOn(fake);
    state.fill.restoring = { text: "mine", draft: "draft" };
    await fake.hooks.get("prompt.submit")!(
      fake.$,
      { text: "someone else's", origin: { kind: "composer" } },
      async () => ({}),
    );
    expect(fake.fills).toEqual([]);
    expect(state.fill.restoring).toEqual({ text: "mine", draft: "draft" });
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
      ["hyoui", "input", "--namespace=ns-1", "term-1", "key:Enter"],
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

  test("hyouiEnterArgv leaves the namespace out when there is none", () => {
    expect(hyouiEnterArgv("t", undefined)).toEqual(["hyoui", "input", "t", "key:Enter"]);
    expect(hyouiEnterArgv("t", "ns")).toEqual([
      "hyoui",
      "input",
      "--namespace=ns",
      "t",
      "key:Enter",
    ]);
  });

  test("reportArgv carries the reason only with not_delivered", () => {
    expect(
      reportArgv("/p", "s", "i", { outcome: "not_delivered", reason: "dialog" }).slice(-4),
    ).toEqual(["--outcome", "not_delivered", "--reason", "dialog"]);
  });

  test("samePrompt ignores surrounding whitespace only", () => {
    expect(samePrompt("a b\n", "a b")).toBe(true);
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
