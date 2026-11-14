// What a resume is started with (DR-0018 §3.2, DR-0028 「restart」 step 3):
// what the session runs as now, from the hooks module's facts over the
// transcript's tail, and how the fields a resume names and leaves out are
// carried onto it.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionFacts } from "@ccmsg/protocol";
import { assistantMessage, assistantRow, line } from "../../protocol/test/transcript-rows.ts";
import { carriedRunsAs, sessionRunsAs } from "../src/session-runs-as.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();

/** A transcript whose newest main-context assistant row answered as
 * `claude-opus-5-5[1m]` at `high`. */
function opusHighTranscript(): string {
  const file = path.join(tmp("runs-as-"), "s.jsonl");
  fs.writeFileSync(
    file,
    line(
      assistantRow({ effort: "high", message: assistantMessage({ model: "claude-opus-5-5[1m]" }) }),
    ) + "\n",
  );
  return file;
}

const quiet = { warn: () => {} };

describe("sessionRunsAs", () => {
  test("under a session override, the override's values the module reports", async () => {
    const facts: SessionFacts = {
      at: 1,
      model: "fable[1m]",
      effort: "low",
      request_override: {
        session: { model: "sonnet", effort: "xhigh" },
        once: { model: "haiku", effort: "max" },
      },
    };
    // The one-shot override holds for one turn, and is not taken.
    expect(await sessionRunsAs(facts, opusHighTranscript(), quiet)).toEqual({
      model: "sonnet",
      effort: "xhigh",
    });
  });

  test("without an override, the session's own as the module names it, over the transcript", async () => {
    expect(
      await sessionRunsAs(
        { at: 1, model: "fable[1m]", effort: "low" },
        opusHighTranscript(),
        quiet,
      ),
    ).toEqual({ model: "fable", effort: "low" });
  });

  test("a field the module does not know yet is the transcript's", async () => {
    expect(await sessionRunsAs({ at: 1, model: "haiku" }, opusHighTranscript(), quiet)).toEqual({
      model: "haiku",
      effort: "high",
    });
  });

  test("without facts, the transcript's newest main-context answer", async () => {
    expect(await sessionRunsAs(undefined, opusHighTranscript(), quiet)).toEqual({
      model: "opus",
      effort: "high",
    });
  });

  test("neither facts nor a transcript that reads names nothing", async () => {
    expect(await sessionRunsAs(undefined, undefined, quiet)).toEqual({});
    const missing = path.join(tmp("runs-as-"), "gone.jsonl");
    expect(await sessionRunsAs(undefined, missing, quiet)).toEqual({});
  });
});

describe("carriedRunsAs", () => {
  const runsAs = { model: "opus", effort: "high" } as const;

  test("an ask that names both is carried as it is", () => {
    expect(carriedRunsAs({ model: "haiku", effort: "max" }, runsAs)).toEqual({
      carried: { model: "haiku", effort: "max" },
      unread: [],
    });
  });

  test("an ask that names neither goes on as the session runs", () => {
    expect(carriedRunsAs({}, runsAs)).toEqual({ carried: runsAs, unread: [] });
  });

  test("an effort alone keeps the session's model", () => {
    expect(carriedRunsAs({ effort: "low" }, runsAs)).toEqual({
      carried: { model: "opus", effort: "low" },
      unread: [],
    });
  });

  test("the model the session runs as, named alone, keeps the session's effort", () => {
    expect(carriedRunsAs({ model: "opus" }, runsAs)).toEqual({ carried: runsAs, unread: [] });
  });

  // DR-0018 §3.9: a model chosen anew takes its own effort, which the launch
  // command chooses; it is not one the daemon failed to read.
  test("another model named alone leaves the effort to the launch command", () => {
    expect(carriedRunsAs({ model: "sonnet" }, runsAs)).toEqual({
      carried: { model: "sonnet" },
      unread: [],
    });
  });

  test("a field neither the ask nor the session names is left out, and said to be unread", () => {
    expect(carriedRunsAs({}, {})).toEqual({ carried: {}, unread: ["model", "effort"] });
    expect(carriedRunsAs({}, { effort: "low" })).toEqual({
      carried: { effort: "low" },
      unread: ["model"],
    });
  });
});
