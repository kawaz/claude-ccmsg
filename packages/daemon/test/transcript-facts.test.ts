// The whole read of a session's transcript (DR-0053 §3): what it says of the session as of its last line, for the Sessions list's row when the daemon first knows the session.
//
// 何を保証するか:
//   - 最後の活動時刻 = timestamp を持つ行の最大。transcript の最後の行は timestamp を持たない metadata 行 (custom-title / last-prompt / cost-state 等。Claude Code が末尾近くに繰り返し書く) であることが多いので、「最後の行」ではなく「timestamp を持つ行」で取る
//   - model / effort = main thread の、Claude Code 自身の行 (`<synthetic>`) でない最後の assistant 行の `message.model` と行直下の `effort` の組。 subagent の行 (isSidechain) はそのセッション自身の model ではない。effort を書かない版の行なら model だけ (前の行の effort を組み合わせない)
//   - 最終プロンプト時刻 = live の fold と同じ判定 (classifyUserInputRow) で人の入力とされた行の timestamp の最大。後ろにある task-notification 等は人の入力ではない
//   - 読めない行は飛ばして数え、読める行から値を取る。空のファイルは値なし、ファイルが無ければ読めなかったと答える (reject しない)
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonObject } from "@ccmsg/protocol";
import { isLater, readTranscriptFacts } from "../src/transcript-facts.ts";
import {
  assistantRow,
  customTitleRow,
  line,
  metadataRow,
  queueOperationRow,
  systemRow,
  userContentRow,
  assistantMessage,
} from "../../protocol/test/transcript-rows.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmpDir = perTestTmpDir();

const T1 = "2026-11-16T01:00:00.000Z";
const T2 = "2026-11-16T02:00:00.000Z";
const T3 = "2026-11-16T03:00:00.000Z";
const T4 = "2026-11-16T04:00:00.000Z";

/** A transcript holding `rows`, one per line, each ending in a newline. */
function transcript(rows: readonly (JsonObject | string)[]): string {
  const file = path.join(tmpDir("ccmsg-tfacts-"), "s.jsonl");
  fs.writeFileSync(
    file,
    rows.map((row) => `${typeof row === "string" ? row : line(row)}\n`).join(""),
  );
  return file;
}

/** A prompt the person typed (`origin.kind: "human"`), at `timestamp`. */
function typed(text: string, timestamp: string): JsonObject {
  return userContentRow(text, { promptSource: "typed", origin: { kind: "human" }, timestamp });
}

/** An assistant turn of the main thread that ran as `model` at `effort` (none when `effort` is undefined: a row written before Claude Code recorded it). */
function answered(model: string, effort: string | undefined, timestamp: string): JsonObject {
  const row = assistantRow({ message: assistantMessage({ model }), timestamp });
  if (effort === undefined) {
    const { effort: _dropped, ...rest } = row;
    return rest;
  }
  return { ...row, effort };
}

/** A task-notification Claude Code delivers as the user's (a background task ended): not the person speaking. */
function taskNotification(timestamp: string): JsonObject {
  return userContentRow("<task-notification>\n<task-id>b1</task-id>\n</task-notification>", {
    promptSource: "system",
    origin: { kind: "task-notification" },
    timestamp,
  });
}

describe("readTranscriptFacts", () => {
  // A transcript as Claude Code leaves it: the turn's rows, then metadata rows that carry no timestamp. The last activity is the turn's last row, not the file's last line.
  test("the last activity is the latest timestamp, past the metadata rows at the end", async () => {
    const file = transcript([
      typed("go", T1),
      answered("claude-fable-5-2", "low", T2),
      systemRow({ timestamp: T3 }),
      customTitleRow(),
      metadataRow("last-prompt", { lastPrompt: "go", leafUuid: "u" }),
      metadataRow("cost-state", { totalCostUsd: 1 }),
    ]);
    const read = await readTranscriptFacts(file);
    expect(read).toEqual({
      kind: "read",
      unreadableLines: 0,
      facts: {
        lastActivityAt: T3,
        lastUserInputAt: T1,
        engine: { model: "claude-fable-5-2", effort: "low" },
      },
    });
  });

  // The maximum, not the last seen: a resumed or forked session can have an older turn spliced in behind a newer one. A queue-operation (a prompt typed during a turn) has a timestamp and counts as activity too.
  test("the last activity is the maximum timestamp, not the last one written", async () => {
    const file = transcript([
      answered("claude-opus-5", "high", T2),
      queueOperationRow({ timestamp: T4 }),
      answered("claude-opus-5", "high", T1),
    ]);
    const read = await readTranscriptFacts(file);
    expect(read.kind === "read" && read.facts.lastActivityAt).toBe(T4);
  });

  // The model and effort are the main thread's last ones: the turn switched model and effort midway, a subagent's row (isSidechain) and Claude Code's own error row (`<synthetic>`) come after it, and neither is the session running as something.
  test("the model and effort are the main thread's last, past sidechain and <synthetic> rows", async () => {
    const file = transcript([
      answered("claude-opus-5", "high", T1),
      answered("claude-fable-5-2", "low", T2),
      { ...answered("claude-haiku-5", "medium", T3), isSidechain: true },
      answered("<synthetic>", undefined, T4),
    ]);
    const read = await readTranscriptFacts(file);
    expect(read.kind === "read" && read.facts.engine).toEqual({
      model: "claude-fable-5-2",
      effort: "low",
    });
    // The activity still counts those rows: they are the session working.
    expect(read.kind === "read" && read.facts.lastActivityAt).toBe(T4);
  });

  // The last row names no effort: the pair is taken from that row alone, so the earlier row's effort is not put beside a model it did not run with.
  test("an assistant row without an effort gives the model alone", async () => {
    const file = transcript([
      answered("claude-opus-5", "high", T1),
      answered("claude-fable-5-2", undefined, T2),
    ]);
    const read = await readTranscriptFacts(file);
    expect(read.kind === "read" && read.facts.engine).toEqual({ model: "claude-fable-5-2" });
  });

  // The person's last prompt is earlier than what came into the conversation after it on its own (a task-notification, a tool result): those are not the person speaking, by the same judgment the live fold makes.
  test("the last user input is the person's prompt, not the task-notification after it", async () => {
    const file = transcript([
      typed("first", T1),
      typed("second", T2),
      answered("claude-fable-5-2", "low", T3),
      taskNotification(T4),
    ]);
    const read = await readTranscriptFacts(file);
    expect(read.kind === "read" && read.facts.lastUserInputAt).toBe(T2);
    expect(read.kind === "read" && read.facts.lastActivityAt).toBe(T4);
  });

  // A line that does not read (not JSON, a timestamp that is not a string) is skipped and counted; the values come from the rest of the file. An empty line is nothing and not counted.
  test("lines that do not read are skipped and counted, the rest read", async () => {
    const file = transcript([
      typed("go", T1),
      "{not json",
      "",
      { type: "user", timestamp: 12345 },
      answered("claude-fable-5-2", "low", T2),
    ]);
    const read = await readTranscriptFacts(file);
    expect(read).toEqual({
      kind: "read",
      unreadableLines: 2,
      facts: {
        lastActivityAt: T2,
        lastUserInputAt: T1,
        engine: { model: "claude-fable-5-2", effort: "low" },
      },
    });
  });

  // A line still being written (no newline yet) is not read: it is the writer mid-append, not a broken row.
  test("a last line without its newline is not read", async () => {
    const file = transcript([typed("go", T1)]);
    fs.appendFileSync(file, line(answered("claude-fable-5-2", "low", T2)));
    const read = await readTranscriptFacts(file);
    expect(read).toEqual({
      kind: "read",
      unreadableLines: 0,
      facts: { lastActivityAt: T1, lastUserInputAt: T1 },
    });
  });

  // A session's transcript before anything was typed into it: no values.
  test("an empty file reads, with no values", async () => {
    const file = transcript([]);
    expect(await readTranscriptFacts(file)).toEqual({
      kind: "read",
      unreadableLines: 0,
      facts: {},
    });
  });

  // A file that is not there (a session nothing has been typed into yet: Claude Code creates the file with the first prompt) answers `missing`, apart from a file that cannot be read: the daemon reads a missing one again later, and does not log it. Neither rejects: the reads of the other sessions go on.
  test("a file that is not there answers missing, without rejecting", async () => {
    const read = await readTranscriptFacts(path.join(tmpDir("ccmsg-tfacts-"), "gone.jsonl"));
    expect(read).toEqual({ kind: "missing" });
  });

  // Something at the path that is not a file (a directory) is a failure with why, not `missing`: reading it again would fail the same way.
  test("a path that is not a file answers failed, with why", async () => {
    const dir = path.join(tmpDir("ccmsg-tfacts-"), "s.jsonl");
    fs.mkdirSync(dir);
    const read = await readTranscriptFacts(dir);
    expect(read.kind).toBe("failed");
    expect(read.kind === "failed" && read.reason).not.toBe("");
  });

  // JSON with spaces after its colons is the same row: the assistant row is read for its model and effort however its JSON is spaced.
  test("an assistant row whose JSON has spaces is read", async () => {
    const row = JSON.stringify(answered("claude-fable-5-2", "low", T2), null, 1).replaceAll(
      "\n",
      "",
    );
    expect(row).toContain('"type": "assistant"');
    const file = transcript([typed("go", T1), row]);
    const read = await readTranscriptFacts(file);
    expect(read.kind === "read" && read.facts.engine).toEqual({
      model: "claude-fable-5-2",
      effort: "low",
    });
  });

  // A JSON string may spell a character as an escape (`\u0061` for `a`): the row is still an assistant row, and only parsing the line tells it, not a substring test on its text.
  test("an assistant row whose type is spelled with a JSON escape is read", async () => {
    // Both the row's type and its message's role, where the word appears.
    const row = line(answered("claude-fable-5-2", "low", T2)).replaceAll(
      '"assistant"',
      '"\\u0061ssistant"',
    );
    expect(row).not.toContain('"assistant"');
    const file = transcript([typed("go", T1), row]);
    const read = await readTranscriptFacts(file);
    expect(read.kind === "read" && read.facts.engine).toEqual({
      model: "claude-fable-5-2",
      effort: "low",
    });
  });
});

// isLater decides whether a read time replaces the one held: by instant, not by spelling, and a time that does not read never wins (so an odd timestamp in a transcript cannot push a live value aside).
describe("isLater", () => {
  test("compares instants, and anything is later than nothing", () => {
    expect(isLater(T2, T1)).toBe(true);
    expect(isLater(T1, T2)).toBe(false);
    expect(isLater(T1, T1)).toBe(false);
    expect(isLater(T1, undefined)).toBe(true);
    // The same instant in another spelling is not later.
    expect(isLater("2026-11-16T10:00:00+09:00", T1)).toBe(false);
  });

  test("a time that does not read is never later, and loses to nothing that reads", () => {
    expect(isLater("not a time", undefined)).toBe(false);
    expect(isLater("not a time", T1)).toBe(false);
    expect(isLater(T1, "not a time")).toBe(true);
  });
});
