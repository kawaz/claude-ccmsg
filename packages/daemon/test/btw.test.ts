// The btw store (DR-0060 §4, §5, §9): how the fork's stream-json becomes the
// btw's answer, where the anchor is taken from, how the records are kept and
// read back, and what the tabs that follow a session are sent. The btw
// command is a fake process the test feeds line by line.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BTW_MAX_CONCURRENCY,
  BTW_PROMPT_PREFIX,
  BtwStreamEventSchema,
  BtwsStreamEventSchema,
  jsonText,
  parseWith,
  type BtwCommandInput,
  type BtwRecord,
} from "@ccmsg/protocol";
import {
  BtwAnswer,
  BtwStore,
  btwCommandOf,
  btwModelOf,
  btwRunsAs,
  btwFile,
  configDirOfTranscript,
  lastRowUuid,
  readBtwFile,
  type BtwProcess,
  type BtwTarget,
} from "../src/btw.ts";
import { defaultBtwCommand } from "../src/config.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";

// --- the fork's stream-json, as `claude -p --output-format stream-json
// --verbose --include-partial-messages` writes it (the shapes of a real run of
// 2.1.330, trimmed to the fields read) ---

const line = (row: object): string => JSON.stringify(row);
const init = line({ type: "system", subtype: "init", session_id: "fork-sid" });
const messageStart = (id: string, parent: string | null = null) =>
  line({
    type: "stream_event",
    parent_tool_use_id: parent,
    event: { type: "message_start", message: { id } },
  });
const blockStart = (index: number, block: object, parent: string | null = null) =>
  line({
    type: "stream_event",
    parent_tool_use_id: parent,
    event: { type: "content_block_start", index, content_block: block },
  });
const textDelta = (index: number, text: string, parent: string | null = null) =>
  line({
    type: "stream_event",
    parent_tool_use_id: parent,
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  });
const assistant = (id: string, content: object[], parent: string | null = null) =>
  line({ type: "assistant", parent_tool_use_id: parent, message: { id, content } });
const result = (isError: boolean, text: string, subtype = isError ? "error" : "success") =>
  line({ type: "result", subtype, is_error: isError, result: text });

describe("BtwAnswer: the answer read off the fork's stream-json", () => {
  test("the deltas grow the text block, and the assistant line of the same message adds nothing", () => {
    const answer = new BtwAnswer();
    for (const l of [init, messageStart("m1"), blockStart(0, { type: "text", text: "" })]) {
      expect(answer.take(l)).toBeUndefined();
    }
    answer.take(textDelta(0, "pel"));
    expect(answer.text).toBe("pel");
    answer.take(textDelta(0, "ican"));
    expect(answer.text).toBe("pelican");
    answer.take(assistant("m1", [{ type: "text", text: "pelican" }]));
    expect(answer.text).toBe("pelican");
    expect(answer.take(result(false, "pelican"))).toEqual({ status: "done" });
  });

  test("text blocks of several messages are joined with a blank line, the tool between them is the one running", () => {
    const answer = new BtwAnswer();
    answer.take(messageStart("m1"));
    answer.take(blockStart(0, { type: "text", text: "" }));
    answer.take(textDelta(0, "読んでみる"));
    answer.take(blockStart(1, { type: "tool_use", name: "Read" }));
    expect(answer.tool).toBe("Read");
    answer.take(messageStart("m2"));
    answer.take(blockStart(0, { type: "text", text: "" }));
    expect(answer.tool).toBeUndefined();
    answer.take(textDelta(0, "こう書いてある"));
    expect(answer.text).toBe("読んでみる\n\nこう書いてある");
  });

  test("a subagent's lines (parent_tool_use_id set) are not the answer", () => {
    const answer = new BtwAnswer();
    answer.take(messageStart("m1"));
    answer.take(blockStart(0, { type: "text", text: "" }));
    answer.take(textDelta(0, "main"));
    answer.take(messageStart("s1", "toolu_1"));
    answer.take(blockStart(0, { type: "text", text: "" }, "toolu_1"));
    answer.take(textDelta(0, "sub", "toolu_1"));
    answer.take(assistant("s1", [{ type: "text", text: "sub" }], "toolu_1"));
    expect(answer.text).toBe("main");
  });

  test("without partial messages the assistant lines give the text, in order", () => {
    const answer = new BtwAnswer();
    answer.take(assistant("m1", [{ type: "text", text: "一つ目" }]));
    answer.take(assistant("m1", [{ type: "tool_use", name: "Grep" }]));
    expect(answer.tool).toBe("Grep");
    answer.take(assistant("m2", [{ type: "text", text: "二つ目" }]));
    expect(answer.text).toBe("一つ目\n\n二つ目");
  });

  test("a result with is_error is a failure carrying its text, or its subtype when it has none", () => {
    expect(new BtwAnswer().take(result(true, "Prompt is too long"))).toEqual({
      status: "failed",
      error: "Prompt is too long",
    });
    expect(new BtwAnswer().take(result(true, " ", "error_during_execution"))).toEqual({
      status: "failed",
      error: "error_during_execution",
    });
  });

  test("lines that are not JSON or not of a known type are passed over", () => {
    const answer = new BtwAnswer();
    for (const l of ["", "not json", line({ type: "user" }), line({ type: "result" })]) {
      expect(answer.take(l)).toBeUndefined();
    }
    expect(answer.text).toBe("");
  });
});

/** A `result` line with `usage`, as claude writes it (the counts read, and
 * fields that are not). */
const resultWithUsage = (usage: object, isError = false) =>
  line({
    type: "result",
    subtype: isError ? "error" : "success",
    is_error: isError,
    result: isError ? "Prompt is too long" : "ok",
    usage,
  });

const FULL_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 364,
  cache_read_input_tokens: 60849,
  output_tokens: 5,
  service_tier: "standard",
  cache_creation: { ephemeral_5m_input_tokens: 364 },
};

describe("BtwAnswer: the result's usage (DR-0060 §6)", () => {
  test("the four counts are taken, the rest of the usage left", () => {
    expect(new BtwAnswer().take(resultWithUsage(FULL_USAGE))).toEqual({
      status: "done",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 60849,
        cache_creation_input_tokens: 364,
        output_tokens: 5,
      },
    });
  });

  test("a failed run's counts are taken too", () => {
    expect(new BtwAnswer().take(resultWithUsage({ input_tokens: 7 }, true))).toEqual({
      status: "failed",
      error: "Prompt is too long",
      usage: { input_tokens: 7 },
    });
  });

  test("a usage that does not read names no counts, and the end is read as it is", () => {
    expect(new BtwAnswer().take(resultWithUsage({ input_tokens: "2" }))).toEqual({
      status: "done",
    });
    expect(new BtwAnswer().take(result(false, "ok"))).toEqual({ status: "done" });
  });
});

describe("btwModelOf: the model id the session answered as, [1m] kept (DR-0060 §2)", () => {
  test("a session started by a family name with [1m] gets the id the transcript answered as, with [1m]", () => {
    expect(
      btwModelOf({ spelled: "sonnet[1m]", answered: "claude-sonnet-5-5", window: undefined }),
    ).toBe("claude-sonnet-5-5[1m]");
  });

  test("a session not on the 1M context gets the id without [1m]", () => {
    expect(btwModelOf({ spelled: "haiku", answered: "claude-haiku-5-5", window: 200_000 })).toBe(
      "claude-haiku-5-5",
    );
    expect(
      btwModelOf({ spelled: "claude-haiku-5-5", answered: "claude-haiku-5-5", window: undefined }),
    ).toBe("claude-haiku-5-5");
  });

  test("a 1M window the module measured is the 1M context too, the spelling naming none", () => {
    expect(btwModelOf({ spelled: undefined, answered: "claude-opus-5-5", window: 1_000_000 })).toBe(
      "claude-opus-5-5[1m]",
    );
    expect(btwModelOf({ spelled: "opus", answered: "claude-opus-5-5", window: 1_000_000 })).toBe(
      "claude-opus-5-5[1m]",
    );
  });

  test("a suffix the transcript's id carries is not doubled", () => {
    expect(
      btwModelOf({ spelled: "fable[1m]", answered: "claude-fable-5-2[1m]", window: undefined }),
    ).toBe("claude-fable-5-2[1m]");
  });

  test("no answer of the session's family (none yet, or the model moved since): the spelling as it is", () => {
    expect(btwModelOf({ spelled: "opus[1m]", answered: undefined, window: undefined })).toBe(
      "opus[1m]",
    );
    expect(
      btwModelOf({ spelled: "opus[1m]", answered: "claude-sonnet-5-5", window: undefined }),
    ).toBe("opus[1m]");
    expect(btwModelOf({ spelled: undefined, answered: "<synthetic>", window: undefined })).toBe(
      undefined,
    );
  });
});

describe("btwRunsAs: the effort the session runs on now", () => {
  const facts = (fields: object) => ({ at: 1, ...fields });

  test("the session's own effort, not the last answer's (a one-shot's)", () => {
    expect(
      btwRunsAs(
        facts({
          model: "claude-haiku-5-5",
          effort: "low",
          request_override: {
            session: { model: "claude-haiku-5-5", effort: "low" },
            once: { model: null, effort: null },
          },
        }),
        { model: "claude-haiku-5-5", effort: "max" },
      ),
    ).toEqual({ model: "claude-haiku-5-5", effort: "low" });
  });

  test("a session override's effort wins over the session's own", () => {
    expect(
      btwRunsAs(
        facts({
          model: "sonnet[1m]",
          effort: "low",
          request_override: {
            session: { model: "sonnet[1m]", effort: "high" },
            once: { model: null, effort: "max" },
          },
        }),
        { model: "claude-sonnet-5-5", effort: "max" },
      ),
    ).toEqual({ model: "claude-sonnet-5-5[1m]", effort: "high" });
  });

  test("without facts, the transcript's last answer", () => {
    expect(btwRunsAs(undefined, { model: "claude-opus-5-5", effort: "medium" })).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
    });
    expect(btwRunsAs(undefined, {})).toEqual({});
  });
});

describe("lastRowUuid: the anchor", () => {
  test("the last row with a uuid that is not a sidechain's, past rows without one", async () => {
    const dir = tmp("btw-anchor-");
    const file = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(
      file,
      [
        line({ type: "user", uuid: "u-1" }),
        line({ type: "assistant", uuid: "u-2" }),
        line({ type: "assistant", uuid: "side", isSidechain: true }),
        line({ type: "last-prompt", leafUuid: "u-2" }),
        "",
      ].join("\n"),
    );
    expect(await lastRowUuid(file)).toBe("u-2");
  });

  test("none for a file with no row of a uuid, or no file", async () => {
    const dir = tmp("btw-anchor-");
    const file = path.join(dir, "empty.jsonl");
    fs.writeFileSync(file, `${line({ type: "agent-name" })}\n`);
    expect(await lastRowUuid(file)).toBeUndefined();
    expect(await lastRowUuid(path.join(dir, "missing.jsonl"))).toBeUndefined();
  });
});

describe("where the btw runs from", () => {
  test("configDirOfTranscript: <config dir>/projects/<project>/<sid>.jsonl", () => {
    expect(configDirOfTranscript("/h/.claude-x/projects/-p/s.jsonl")).toBe("/h/.claude-x");
    expect(configDirOfTranscript("/h/elsewhere/p/s.jsonl")).toBeUndefined();
  });

  test("btwCommandOf: the config's, else the built-in one, and none for a test's daemon given none", () => {
    expect(btwCommandOf(["/bin/fake"], { CCMSG_TEST_LIFELINE: "x" })).toEqual(["/bin/fake"]);
    expect(btwCommandOf(undefined, { CCMSG_TEST_LIFELINE: "x" })).toBeNull();
    expect(btwCommandOf(undefined, {})).toEqual(defaultBtwCommand());
  });
});

// --- the store, with a fake btw command ---

/** A btw command the test drives: what it wrote to stdout, line by line, and
 * how it ends. */
class FakeCommand implements BtwProcess {
  readonly input: BtwCommandInput;
  stopped = 0;
  readonly #out: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #err: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #exit = Promise.withResolvers<number>();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;

  constructor(input: BtwCommandInput) {
    this.input = input;
    let out: ReadableStreamDefaultController<Uint8Array> | undefined;
    let err: ReadableStreamDefaultController<Uint8Array> | undefined;
    this.stdout = new ReadableStream({ start: (c) => void (out = c) });
    this.stderr = new ReadableStream({ start: (c) => void (err = c) });
    this.#out = out;
    this.#err = err;
    this.exited = this.#exit.promise;
  }

  write(...lines: string[]): void {
    for (const l of lines) this.#out?.enqueue(new TextEncoder().encode(`${l}\n`));
  }

  #ended = false;

  end(code: number, stderr = ""): void {
    if (this.#ended) return;
    this.#ended = true;
    if (stderr !== "") this.#err?.enqueue(new TextEncoder().encode(stderr));
    this.#out?.close();
    this.#err?.close();
    this.#exit.resolve(code);
  }

  stop(): void {
    this.stopped += 1;
    this.end(143);
  }
}

interface Harness {
  store: BtwStore;
  commands: FakeCommand[];
  /** The pushes waiting for their interval, fired by the test. */
  timers: (() => void)[];
  logs: string[];
  stateDir: string;
}

function harness(options: { stateDir?: string; startFails?: boolean } = {}): Harness {
  const stateDir = options.stateDir ?? tmp("btw-state-");
  const commands: FakeCommand[] = [];
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  let id = 0;
  let clock = Date.parse("2026-11-22T00:00:00.000Z");
  const store = new BtwStore({
    stateDir,
    start: (input) => {
      if (options.startFails === true) throw new Error("spawn ENOENT");
      const command = new FakeCommand(input);
      commands.push(command);
      return command;
    },
    now: () => new Date((clock += 1000)),
    newId: () => `btw-${String(++id)}`,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    afterPushInterval: (fire) => {
      timers.push(fire);
      return {
        cancel: () => {
          const at = timers.indexOf(fire);
          if (at >= 0) timers.splice(at, 1);
        },
      };
    },
  });
  return { store, commands, timers, logs, stateDir };
}

const target: BtwTarget = {
  sessionId: SID,
  cwd: "/work/repo",
  configDir: "/h/.claude-x",
  model: "opus[1m]",
  effort: "medium",
  transcript: undefined,
};

/** A tab's connection: the pushes it was sent. */
function tab(): { write(line: string): void; btws: BtwRecord[][]; btw: BtwRecord[] } {
  const btws: BtwRecord[][] = [];
  const btw: BtwRecord[] = [];
  return {
    btws,
    btw,
    write(text: string) {
      const many = parseWith(jsonText(BtwsStreamEventSchema), text.trim());
      if (many.ok) btws.push([...many.value.btws]);
      const one = parseWith(jsonText(BtwStreamEventSchema), text.trim());
      if (one.ok) btw.push(one.value.btw);
    },
  };
}

function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

/** Lets the store read what the fake command wrote: the stream's chunks reach
 * the store's reader through promise jobs, all run before the next task.
 * Nothing in the test does I/O meanwhile, so one task is enough. */
const readerCatchesUp = (): Promise<void> => Bun.sleep(0);

/** Resolves once every btw has ended and its record is on disk. */
async function settled(store: BtwStore): Promise<void> {
  await store.settled();
}

describe("BtwStore", () => {
  test("ask: the command gets the session's place, its model spelled whole, the chosen effort and the prefixed prompt", async () => {
    const h = harness();
    const asked = h.store.ask(target, "この関数は?", "high", "u-9");
    expect(asked.ok).toBe(true);
    const input = defined(h.commands[0], "command").input;
    expect(input).toEqual({
      cwd: "/work/repo",
      config_dir: "/h/.claude-x",
      resume: SID,
      model: "opus[1m]",
      effort: "high",
      prompt: `${BTW_PROMPT_PREFIX}\n\nこの関数は?`,
    });
    expect(asked).toMatchObject({ ok: true });
    expect(asked.ok ? asked.btw : undefined).toMatchObject({
      id: "btw-1",
      session_id: SID,
      after_uuid: "u-9",
      prompt: "この関数は?",
      response: "",
      status: "running",
      model: "opus[1m]",
      effort: "high",
    });
    await h.store.stopAll();
  });

  test("ask with no effort chosen runs on the session's", async () => {
    const h = harness();
    h.store.ask(target, "q", undefined, undefined);
    expect(defined(h.commands[0], "command").input.effort).toBe("medium");
    await h.store.stopAll();
  });

  test("a followed session's tab gets its btws as it follows, then each change; the answer's growth waits for the interval", async () => {
    const h = harness();
    const conn = tab();
    await h.store.watch(SID, conn);
    expect(conn.btws).toEqual([[]]);
    h.store.ask(target, "q", undefined, "u-1");
    expect(conn.btw.at(-1)?.status).toBe("running");
    const command = defined(h.commands[0], "command");
    command.write(messageStart("m1"), blockStart(0, { type: "text", text: "" }), textDelta(0, "a"));
    await readerCatchesUp();
    command.write(textDelta(0, "b"));
    await readerCatchesUp();
    // Two growths, one push waiting.
    expect(h.timers).toHaveLength(1);
    expect(conn.btw).toHaveLength(1);
    defined(h.timers.shift(), "timer")();
    expect(conn.btw.at(-1)?.response).toBe("ab");
    command.write(result(false, "ab"));
    command.end(0);
    await settled(h.store);
    const last = defined(conn.btw.at(-1), "last push");
    expect(last.status).toBe("done");
    expect(last.response).toBe("ab");
    expect(last.ended_at).toBeDefined();
  });

  test("a tab that stopped following gets nothing more", async () => {
    const h = harness();
    const conn = tab();
    await h.store.watch(SID, conn);
    h.store.unwatchAll(conn);
    h.store.ask(target, "q", undefined, undefined);
    expect(conn.btw).toEqual([]);
    await h.store.stopAll();
  });

  test("the record is written when it starts and when it ends, and a store started anew reads the last", async () => {
    const h = harness();
    h.store.ask(target, "q", undefined, "u-1");
    const command = defined(h.commands[0], "command");
    command.write(assistant("m1", [{ type: "text", text: "答え" }]), result(false, "答え"));
    command.end(0);
    await settled(h.store);
    const lines = fs.readFileSync(btwFile(h.stateDir, SID), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const again = harness({ stateDir: h.stateDir });
    const listed = await again.store.list(SID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "btw-1", status: "done", response: "答え" });
  });

  test("the btw_end line names the result's token counts, in a fixed order, and only those it gave", async () => {
    const h = harness();
    h.store.ask(target, "q", undefined, undefined);
    defined(h.commands[0], "command").write(resultWithUsage(FULL_USAGE));
    defined(h.commands[0], "command").end(0);
    h.store.ask(target, "q", undefined, undefined);
    defined(h.commands[1], "command").write(resultWithUsage({ input_tokens: 3, output_tokens: 9 }));
    defined(h.commands[1], "command").end(0);
    await settled(h.store);
    const ends = h.logs.filter((l) => l.startsWith("btw_end:"));
    expect(ends).toHaveLength(2);
    expect(ends[0]).toEndWith(
      " response_bytes=0 input_tokens=2 cache_read_input_tokens=60849" +
        " cache_creation_input_tokens=364 output_tokens=5",
    );
    expect(ends[1]).toEndWith(" response_bytes=0 input_tokens=3 output_tokens=9");
  });

  test("the btw_end line names no counts when the result has no usage, or none came", async () => {
    const h = harness();
    h.store.ask(target, "the question", undefined, undefined);
    defined(h.commands[0], "command").write(
      assistant("m1", [{ type: "text", text: "the answer" }]),
      result(false, "the answer"),
    );
    defined(h.commands[0], "command").end(0);
    h.store.ask(target, "q", undefined, undefined);
    defined(h.commands[1], "command").end(1);
    await settled(h.store);
    const ends = h.logs.filter((l) => l.startsWith("btw_end:"));
    expect(ends).toHaveLength(2);
    for (const end of ends) expect(end).not.toContain("_tokens=");
    // Neither the question nor the answer is written.
    expect(h.logs.join("\n")).not.toContain("the question");
    expect(h.logs.join("\n")).not.toContain("the answer");
  });

  test("a command that ends before its result fails with its exit code and the end of its stderr", async () => {
    const h = harness();
    h.store.ask(target, "q", undefined, undefined);
    defined(h.commands[0], "command").end(1, "line one\nNo conversation found\n");
    await settled(h.store);
    const [record] = await h.store.list(SID);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("exit 1");
    expect(record?.error).toContain("No conversation found");
  });

  test("cancel stops the command's group and the btw ends canceled; an id with no record is false", async () => {
    const h = harness();
    const asked = h.store.ask(target, "q", undefined, undefined);
    if (!asked.ok) throw new Error("not asked");
    expect(await h.store.cancel(asked.btw.id)).toBe(true);
    await h.store.stopAll();
    expect(defined(h.commands[0], "command").stopped).toBe(1);
    const [record] = await h.store.list(SID);
    expect(record).toMatchObject({ status: "canceled", error: "取り消した" });
    // An ended one is left as it is.
    expect(await h.store.cancel(asked.btw.id)).toBe(true);
    expect(await h.store.cancel("no-such-btw")).toBe(false);
  });

  test("a record left running by a daemon that stopped is read as failed, and that is written", async () => {
    const stateDir = tmp("btw-state-");
    const file = btwFile(stateDir, SID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const running: BtwRecord = {
      id: "old",
      session_id: SID,
      ts: "2026-11-21T00:00:00.000Z",
      prompt: "q",
      response: "途中",
      status: "running",
    };
    fs.writeFileSync(file, `${JSON.stringify(running)}\n`);
    const h = harness({ stateDir });
    const [record] = await h.store.list(SID);
    expect(record).toMatchObject({ id: "old", status: "failed", error: "daemon が止まった" });
    await settled(h.store);
    const read = await readBtwFile(file, () => {});
    expect(read.get("old")?.status).toBe("failed");
  });

  test("stopAll (the daemon stops) ends the running ones canceled", async () => {
    const h = harness();
    h.store.ask(target, "q", undefined, undefined);
    await h.store.stopAll();
    const [record] = await h.store.list(SID);
    expect(record).toMatchObject({ status: "canceled", error: "daemon が止まった" });
  });

  test(`no more than ${String(BTW_MAX_CONCURRENCY)} run at once: one more is btw_busy and starts nothing`, async () => {
    const h = harness();
    for (let i = 0; i < BTW_MAX_CONCURRENCY; i += 1) {
      expect(h.store.ask(target, "q", undefined, undefined).ok).toBe(true);
    }
    const refused = h.store.ask(target, "q", undefined, undefined);
    expect(refused).toMatchObject({ ok: false, code: "btw_busy" });
    expect(h.commands).toHaveLength(BTW_MAX_CONCURRENCY);
    await h.store.stopAll();
  });

  test("a command that cannot be started is btw_command_unavailable, with no record", async () => {
    const h = harness({ startFails: true });
    const refused = h.store.ask(target, "q", undefined, undefined);
    expect(refused).toMatchObject({ ok: false, code: "btw_command_unavailable" });
    expect(await h.store.list(SID)).toEqual([]);
  });

  test("a line of the file that does not read is passed over and logged", async () => {
    const dir = tmp("btw-file-");
    const file = path.join(dir, "x.btw.jsonl");
    fs.writeFileSync(file, `not json\n${JSON.stringify({ id: "a" })}\n`);
    const warned: string[] = [];
    expect((await readBtwFile(file, (m) => warned.push(m))).size).toBe(0);
    expect(warned).toHaveLength(2);
  });
});
