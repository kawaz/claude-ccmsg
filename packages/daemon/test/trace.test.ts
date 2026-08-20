// Transcript latency trace: the writer that persists component-boundary
// timestamps, and the entry-timestamp extraction that ties a traced delivery
// back to the transcript row that caused it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TraceWriter } from "../src/trace.ts";
import { extractEntryTimestamp } from "../src/transcript.ts";

const readLines = (file: string): Record<string, unknown>[] =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("TraceWriter", () => {
  let dir: string;
  let file: string;
  // Each test owns exactly one writer; closing it here (rather than per-test)
  // keeps the "create it, use it" line the only thing tests need to write.
  let writer: TraceWriter | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-trace-"));
    file = path.join(dir, "trace.jsonl");
    writer = undefined;
  });

  afterEach(async () => {
    // Bun 1.4+ turns an unclosed FileHandle reaped by GC into a hard error,
    // so the descriptor this test opened must be released before the temp
    // dir it lives in is removed.
    await writer?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("appends one JSON object per line, stamping ts when the caller has none", async () => {
    writer = new TraceWriter(file);
    void writer.write({
      comp: "daemon",
      edge: "in",
      kind: "transcript_detect",
      sid: "s1",
      start: 0,
      end: 10,
    });
    await writer.write({
      comp: "daemon",
      edge: "out",
      kind: "wire_write",
      sid: "s1",
      start: 0,
      end: 10,
    });

    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.kind).toBe("transcript_detect");
    expect(typeof lines[0]!.ts).toBe("string");
    expect(Date.parse(lines[0]!.ts as string)).not.toBeNaN();
  });

  // Browser points are timestamped in the tab; re-stamping them on arrival would
  // erase the very delay (network / event loop) the trace exists to show.
  test("keeps a caller-supplied ts", async () => {
    writer = new TraceWriter(file);
    await writer.write({
      ts: "2026-07-29T00:00:00.000Z",
      comp: "webui",
      edge: "in",
      kind: "dom_commit",
      sid: "s1",
      start: 0,
      end: 10,
    });
    expect(readLines(file)[0]!.ts).toBe("2026-07-29T00:00:00.000Z");
  });

  // An explicit `ts: undefined` reaches here whenever a caller forwards an
  // optional field, and must still produce a timestamped line.
  test("stamps ts when the caller passes it as undefined", async () => {
    writer = new TraceWriter(file);
    await writer.write({
      ts: undefined,
      comp: "webui",
      edge: "in",
      kind: "ws_receive",
      sid: "s1",
      start: 0,
      end: 10,
    });
    expect(typeof readLines(file)[0]!.ts).toBe("string");
  });

  // Extra keys are how each boundary carries its own detail (source, mtime_ms,
  // entry_ts...), so they must survive verbatim for jq to filter on.
  test("preserves caller-supplied extra fields", async () => {
    writer = new TraceWriter(file);
    await writer.write({
      comp: "daemon",
      edge: "in",
      kind: "transcript_detect",
      sid: "s1",
      start: 0,
      end: 10,
      source: "fs_watch",
      mtime_ms: 1234.5,
    });
    const line = readLines(file)[0]!;
    expect(line.source).toBe("fs_watch");
    expect(line.mtime_ms).toBe(1234.5);
  });

  test("rotates to .1 once the next line would exceed the limit, and keeps writing", async () => {
    const activeWriter = new TraceWriter(file, 400);
    writer = activeWriter;
    // Awaited per line: rotation is decided per flush, and this test is about
    // which line triggers it, so each line has to be its own flush.
    const write = (sid: string): Promise<void> =>
      activeWriter.write({
        comp: "daemon",
        edge: "out",
        kind: "wire_write",
        sid,
        start: 0,
        end: 1,
      });

    await write("first");
    const oneLine = fs.statSync(file).size;
    const perFile = Math.floor(400 / oneLine);
    for (let i = 1; i < perFile; i++) await write(`fill${i}`);
    expect(fs.existsSync(`${file}.1`)).toBe(false);

    await write("overflow");
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    // rotation must not lose the line that triggered it
    const current = readLines(file);
    expect(current).toHaveLength(1);
    expect(current[0]!.sid).toBe("overflow");
    expect(readLines(`${file}.1`)[0]!.sid).toBe("first");
  });

  // Only one generation is kept: a second rotation replaces .1 rather than
  // growing an unbounded chain of trace files in the state dir.
  test("a second rotation replaces the previous .1", async () => {
    writer = new TraceWriter(file, 200);
    for (let i = 0; i < 40; i++) {
      await writer.write({
        comp: "daemon",
        edge: "out",
        kind: "wire_write",
        sid: `s${i}`,
        start: 0,
        end: 1,
      });
    }
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
  });

  // Tracing is diagnostics: an unwritable path must degrade to no trace, never
  // throw into the delivery path that called it.
  test("swallows write failures", async () => {
    writer = new TraceWriter(path.join(dir, "missing-subdir", "trace.jsonl"));
    // The failure surfaces inside the flush, so "does not throw" now means the
    // returned promise resolves rather than rejecting into the delivery path.
    await writer.write({
      comp: "daemon",
      edge: "in",
      kind: "transcript_detect",
      sid: "s1",
      start: 0,
      end: 1,
    });
    expect(fs.existsSync(path.join(dir, "missing-subdir"))).toBe(false);
  });
});

describe("extractEntryTimestamp", () => {
  // The newest row is the one whose latency we care about, so the scan runs
  // backwards and reports the last complete entry in the batch.
  test("returns the last row's timestamp", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-07-29T00:00:00.000Z" }),
      JSON.stringify({ timestamp: "2026-07-29T00:00:01.000Z" }),
    ];
    expect(extractEntryTimestamp(lines)).toBe("2026-07-29T00:00:01.000Z");
  });

  // A trailing row without a usable timestamp (a summary row, or a shape we
  // don't model) must not blank out the batch — fall back to an older row.
  test("falls back past rows that carry no string timestamp", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-07-29T00:00:00.000Z" }),
      JSON.stringify({ type: "summary" }),
      JSON.stringify({ timestamp: 12345 }),
    ];
    expect(extractEntryTimestamp(lines)).toBe("2026-07-29T00:00:00.000Z");
  });

  // Malformed rows are still delivered to clients, so extraction skips them
  // instead of throwing.
  test("skips unparsable rows", () => {
    expect(
      extractEntryTimestamp(["{broken", JSON.stringify({ timestamp: "2026-07-29T00:00:02.000Z" })]),
    ).toBe("2026-07-29T00:00:02.000Z");
    expect(extractEntryTimestamp(["{broken"])).toBeUndefined();
  });

  test("returns undefined for an empty batch", () => {
    expect(extractEntryTimestamp([])).toBeUndefined();
  });
});
