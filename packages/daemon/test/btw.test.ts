// What a btw's answer is made of apart from the comments (DR-0060): the model
// and the effort it names, the anchor (the transcript's last row when it is
// asked), and how the fork's end becomes the answer's last record and its
// line in daemon.log.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { btwEndFields, btwEndLogFields, btwModelOf, btwRunsAs, lastRowUuid } from "../src/btw.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";

const line = (row: object): string => JSON.stringify(row);

describe("btwModelOf: the model id the session answered as, [1m] kept (DR-0060 §6)", () => {
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

const USAGE = {
  input_tokens: 2,
  output_tokens: 5,
  cache_read_input_tokens: 60_849,
  cache_creation_input_tokens: 364,
};

describe("the end of a btw's fork", () => {
  // The answer's last record: the text of one that answered, with what it
  // cost and the level it ran at; none for one that did not, with why.
  test("an answer, a failure and a stop as the answer's fields", () => {
    expect(
      btwEndFields({ status: "done", text: "the answer", usage: USAGE, effort: "medium" }),
    ).toEqual({ text: "the answer", status: "done", usage: USAGE, effort: "medium" });
    expect(
      btwEndFields({
        status: "failed",
        reason: "api-error",
        error: "API がエラーを返した (status 529, overloaded)。少し待ってからもう一度",
        usage: USAGE,
      }),
    ).toEqual({
      text: "",
      status: "failed",
      error: "API がエラーを返した (status 529, overloaded)。少し待ってからもう一度",
      usage: USAGE,
    });
    expect(btwEndFields({ status: "canceled", error: "取り消した" })).toEqual({
      text: "",
      status: "canceled",
      error: "取り消した",
    });
  });

  // The end's log line says how long the fork took, the effort it ran at and
  // what it cost (whether it read the session's prompt cache), and for a
  // failure why; never the question or the answer.
  test("the log words name the time, the effort run at, the usage, and a failure's reason", () => {
    expect(
      btwEndLogFields(
        { status: "done", text: "the answer", usage: USAGE, effort: "medium" },
        1_000,
        3_500,
      ),
    ).toEqual([
      "elapsed_ms=2500",
      "ran_effort=medium",
      "input_tokens=2",
      "cache_read_input_tokens=60849",
      "cache_creation_input_tokens=364",
      "output_tokens=5",
    ]);
    expect(
      btwEndLogFields(
        { status: "failed", reason: "no_module", error: "no_module: このセッションには…" },
        1_000,
        1_200,
      ),
    ).toEqual(["reason=no_module", "elapsed_ms=200"]);
    expect(btwEndLogFields({ status: "canceled", error: "取り消した" }, 1_000, 900)).toEqual([
      "elapsed_ms=0",
    ]);
  });
});
