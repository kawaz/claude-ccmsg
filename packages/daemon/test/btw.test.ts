// The btw store (DR-0060 §4, §5, §9): how the fork's stream-json becomes the
// btw's answer, where the anchor is taken from, how the records are kept and
// read back, and what the tabs that follow a session are sent. The launch
// command a btw's fork runs through is a fake process the test feeds line by
// line.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BTW_PROMPT_PREFIX,
  BtwStreamEventSchema,
  BtwsStreamEventSchema,
  jsonText,
  parseWith,
  type BtwRecord,
} from "@ccmsg/protocol";
import {
  BtwAnswer,
  BtwStore,
  btwLaunchCommandOf,
  btwModelOf,
  btwRunsAs,
  btwFile,
  lastRowUuid,
  readBtwFile,
  type BtwTarget,
} from "../src/btw.ts";
import type { BtwForkEnd } from "../src/btw-fork.ts";
import { DEFAULT_LAUNCH_COMMAND_SCRIPT, defaultLaunchCommand } from "../src/config.ts";
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
    expect(
      btwModelOf({
        spelled: "haiku",
        answered: "claude-haiku-5-5",
        window: 200_000,
      }),
    ).toBe("claude-haiku-5-5");
    expect(
      btwModelOf({
        spelled: "claude-haiku-5-5",
        answered: "claude-haiku-5-5",
        window: undefined,
      }),
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
    expect(
      btwModelOf({
        spelled: "opus[1m]",
        answered: undefined,
        window: undefined,
      }),
    ).toBe("opus[1m]");
    expect(
      btwModelOf({
        spelled: "opus[1m]",
        answered: "claude-sonnet-5-5",
        window: undefined,
      }),
    ).toBe("opus[1m]");
    expect(
      btwModelOf({
        spelled: undefined,
        answered: "<synthetic>",
        window: undefined,
      }),
    ).toBe(undefined);
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

// DR-0064 §4: the launch command, also without a session_launcher section
// (the built-in one); a test's daemon never runs the built-in one.
describe("where the btw runs from", () => {
  test("btwLaunchCommandOf: the config's launch command, else the built-in one, and none for a test's daemon but its own", () => {
    expect(btwLaunchCommandOf(["/bin/fake"], { CCMSG_TEST_LIFELINE: "x" })).toEqual(["/bin/fake"]);
    expect(btwLaunchCommandOf(["/bin/fake"], {})).toEqual(["/bin/fake"]);
    expect(btwLaunchCommandOf(undefined, {})).toEqual(defaultLaunchCommand());
    expect(btwLaunchCommandOf(undefined, { CCMSG_TEST_LIFELINE: "x" })).toBeNull();
    // A section whose launch_command was left out reads as the built-in one.
    expect(
      btwLaunchCommandOf(["/bin/zsh", "-f", DEFAULT_LAUNCH_COMMAND_SCRIPT], {
        CCMSG_TEST_LIFELINE: "x",
      }),
    ).toBeNull();
  });
});

// --- the store, with a fake launch command ---

/** One fork the store asked of the session's module: what it asked, and the
 * end the test gives it. */
interface AskedFork {
  sid: string;
  prompt: string;
  end(end: BtwForkEnd): void;
}

interface Harness {
  store: BtwStore;
  forks: AskedFork[];
  logs: string[];
  stateDir: string;
}

function harness(options: { stateDir?: string } = {}): Harness {
  const stateDir = options.stateDir ?? tmp("btw-state-");
  const forks: AskedFork[] = [];
  const logs: string[] = [];
  let id = 0;
  let clock = Date.parse("2026-11-22T00:00:00.000Z");
  const store = new BtwStore({
    stateDir,
    fork: (sid, prompt) => {
      const ended = Promise.withResolvers<BtwForkEnd>();
      forks.push({ sid, prompt, end: ended.resolve });
      return ended.promise;
    },
    now: () => new Date((clock += 1000)),
    newId: () => `btw-${String(++id)}`,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { store, forks, logs, stateDir };
}

const target: BtwTarget = {
  sessionId: SID,
  cwd: "/work/repo",
  model: "opus[1m]",
  effort: "medium",
  transcript: undefined,
};

const USAGE = {
  input_tokens: 2,
  output_tokens: 5,
  cache_read_input_tokens: 60_849,
  cache_creation_input_tokens: 364,
};

/** A tab's connection: the pushes it was sent. */
function tab(): {
  write(line: string): void;
  btws: BtwRecord[][];
  btw: BtwRecord[];
} {
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

/** Resolves once every btw has ended and its record is on disk. */
async function settled(store: BtwStore): Promise<void> {
  await store.settled();
}

describe("BtwStore", () => {
  // DR-0060 §2: the session's module is asked to fork with the prefixed
  // prompt; the fork runs on the session's model and effort, which the record
  // names.
  test("ask: the session's module is asked a fork with the prefixed prompt, and the record names the session's model and effort", async () => {
    const h = harness();
    const asked = h.store.ask(target, "この関数は?", "u-9");
    const fork = defined(h.forks[0], "fork");
    expect({ sid: fork.sid, prompt: fork.prompt }).toEqual({
      sid: SID,
      prompt: `${BTW_PROMPT_PREFIX}\n\nこの関数は?`,
    });
    expect(asked.ok ? asked.btw : undefined).toMatchObject({
      id: "btw-1",
      session_id: SID,
      after_uuid: "u-9",
      prompt: "この関数は?",
      response: "",
      status: "running",
      model: "opus[1m]",
      effort: "medium",
    });
    await h.store.stopAll();
  });

  test("a session that names no model or effort: the record names none", async () => {
    const h = harness();
    const bare = h.store.ask({ ...target, model: "", effort: "" }, "q", undefined);
    expect(bare.ok && ("model" in bare.btw || "effort" in bare.btw)).toBe(false);
    await h.store.stopAll();
  });

  // Forks of the session's module run side by side: none waits for room.
  test("many btws at once are each asked at once", async () => {
    const h = harness();
    for (let i = 0; i < 6; i += 1) {
      expect(h.store.ask(target, `q${String(i)}`, undefined).ok).toBe(true);
    }
    expect(h.forks).toHaveLength(6);
    expect(h.store.running).toBe(6);
    await h.store.stopAll();
  });

  test("a followed session's tab gets its btws as it follows, then the start and the end", async () => {
    const h = harness();
    const conn = tab();
    await h.store.watch(SID, conn);
    expect(conn.btws).toEqual([[]]);
    h.store.ask(target, "q", "u-1");
    expect(conn.btw.at(-1)?.status).toBe("running");
    defined(h.forks[0], "fork").end({ status: "done", text: "ab", usage: USAGE, effort: "low" });
    await settled(h.store);
    expect(conn.btw).toHaveLength(2);
    const last = defined(conn.btw.at(-1), "last push");
    expect(last).toMatchObject({ status: "done", response: "ab", usage: USAGE, effort: "low" });
    expect(last.ended_at).toBeDefined();
    expect(last.error).toBeUndefined();
  });

  test("a tab that stopped following gets nothing more", async () => {
    const h = harness();
    const conn = tab();
    await h.store.watch(SID, conn);
    h.store.unwatchAll(conn);
    h.store.ask(target, "q", undefined);
    expect(conn.btw).toEqual([]);
    await h.store.stopAll();
  });

  test("the record is written when it starts and when it ends, and a store started anew reads the last", async () => {
    const h = harness();
    h.store.ask(target, "q", "u-1");
    defined(h.forks[0], "fork").end({ status: "done", text: "答え", usage: USAGE });
    await settled(h.store);
    const lines = fs.readFileSync(btwFile(h.stateDir, SID), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const again = harness({ stateDir: h.stateDir });
    const listed = await again.store.list(SID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "btw-1",
      status: "done",
      response: "答え",
      usage: USAGE,
    });
  });

  // DR-0060 §6: the end's line says how long the fork took, the effort it
  // ran at and what it cost (whether it read the session's prompt cache),
  // and for a failure why; never the question or the answer.
  test("the btw_end line names the time, the effort run at, the usage, and a failure's reason", async () => {
    const h = harness();
    h.store.ask(target, "the question", undefined);
    defined(h.forks[0], "fork").end({
      status: "done",
      text: "the answer",
      usage: USAGE,
      effort: "medium",
    });
    h.store.ask(target, "q", undefined);
    defined(h.forks[1], "fork").end({
      status: "failed",
      reason: "nothing-to-fork",
      error: "本体がまだ 1 回も応答していないので聞けない",
    });
    await settled(h.store);
    const ends = h.logs.filter((l) => l.startsWith("btw_end:"));
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatch(
      / status=done response_bytes=10 elapsed_ms=\d+ ran_effort=medium input_tokens=2 cache_read_input_tokens=60849 cache_creation_input_tokens=364 output_tokens=5$/,
    );
    expect(ends[1]).toMatch(
      / status=failed response_bytes=0 reason=nothing-to-fork elapsed_ms=\d+$/,
    );
    expect(h.logs.join("\n")).not.toContain("the question");
    expect(h.logs.join("\n")).not.toContain("the answer");
  });

  test("a fork that gives no answer fails with its words, and what it cost when said", async () => {
    const h = harness();
    h.store.ask(target, "q", undefined);
    defined(h.forks[0], "fork").end({
      status: "failed",
      reason: "api-error",
      error: "API がエラーを返した (status 529, overloaded)。少し待ってからもう一度",
      usage: USAGE,
    });
    await settled(h.store);
    const [record] = await h.store.list(SID);
    expect(record).toMatchObject({
      status: "failed",
      response: "",
      error: "API がエラーを返した (status 529, overloaded)。少し待ってからもう一度",
      usage: USAGE,
    });
  });

  // The module has no way to stop a fork: a cancel ends the btw here, and the
  // answer that comes after is dropped.
  test("cancel ends the btw canceled at once, and an answer that comes later is dropped", async () => {
    const h = harness();
    const asked = h.store.ask(target, "q", undefined);
    if (!asked.ok) throw new Error("not asked");
    expect(await h.store.cancel(asked.btw.id)).toBe(true);
    await settled(h.store);
    defined(h.forks[0], "fork").end({ status: "done", text: "late", usage: USAGE });
    await settled(h.store);
    const [record] = await h.store.list(SID);
    expect(record).toMatchObject({ status: "canceled", error: "取り消した", response: "" });
    expect(fs.readFileSync(btwFile(h.stateDir, SID), "utf8")).not.toContain("late");
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
    h.store.ask(target, "q", undefined);
    await h.store.stopAll();
    const [record] = await h.store.list(SID);
    expect(record).toMatchObject({ status: "canceled", error: "daemon が止まった" });
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
