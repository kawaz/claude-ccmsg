// The contract of incremental-cross-line.ts is an equivalence, not a
// behaviour: whatever the incremental path returns after any sequence of
// window updates must equal what the plain passes return when called on the
// final window from scratch. Every test here is that comparison, run over
// windows built to hit the cases where the cross-line passes reach backwards
// — a tool_result landing long after its tool_use, a delivered user turn
// cancelling a queued copy, a fold run growing across an appended boundary.
//
// The second half of the contract is the identity reuse that makes the whole
// thing worth doing, so each case also asserts *which* objects survived.
import { describe, expect, test } from "bun:test";
import {
  crossLineIncrementally,
  emptyCrossLineCache,
  type CrossLineCache,
} from "../src/client/incremental-cross-line.ts";
import {
  byteOffsetsFromLengths,
  groupTimelineLines,
  pairQueuedTurns,
  parseTranscriptLine,
  resolveToolResults,
  utf8ByteLength,
  type TimelineGroup,
} from "../src/client/transcript-model.ts";

const START = 1000;

/** The reference implementation: the three passes exactly as Timeline.tsx
 * called them before this module existed. */
function fromScratch(raws: readonly string[]) {
  const perLine = raws.map(parseTranscriptLine);
  const offsets = byteOffsetsFromLengths(START, raws.map(utf8ByteLength));
  const parsed = resolveToolResults(pairQueuedTurns(perLine, raws));
  return { parsed, offsets, groups: groupTimelineLines(parsed, offsets) };
}

/** Feeds `raws` through the incremental path, reusing the per-line parse of
 * every carried-over line the way incremental-line-map.ts does for the real
 * Timeline — without that reference stability there is nothing to reconcile. */
function step(
  cache: CrossLineCache,
  raws: readonly string[],
  parses: Map<string, ReturnType<typeof parseTranscriptLine>>,
) {
  const perLine = raws.map((raw) => {
    const cached = parses.get(raw);
    if (cached) return cached;
    const parsed = parseTranscriptLine(raw);
    parses.set(raw, parsed);
    return parsed;
  });
  return crossLineIncrementally(cache, {
    start: START,
    raws,
    perLine,
    byteLengths: raws.map(utf8ByteLength),
  });
}

/** Runs a sequence of windows through the incremental path and checks the
 * final result against a from-scratch derivation of the final window. */
function replay(windows: readonly (readonly string[])[]): CrossLineCache {
  const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
  let cache = emptyCrossLineCache();
  for (const window of windows) cache = step(cache, window, parses);
  const expected = fromScratch(windows[windows.length - 1]!);
  expect(cache.parsed).toEqual(expected.parsed);
  expect(cache.offsets).toEqual(expected.offsets);
  expect(cache.groups).toEqual(expected.groups);
  return cache;
}

// --- line builders (raw jsonl, since the pipeline starts at the raw text) ---

let clock = 0;
function ts(): string {
  clock += 1;
  return `2026-08-12T00:00:${String(clock).padStart(2, "0")}.000Z`;
}
function userPrompt(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp: ts(),
  });
}
function assistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(),
  });
}
function thinking(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
    timestamp: ts(),
  });
}
function toolUse(id: string, name = "Bash"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input: { command: `echo ${id}` } }],
    },
    timestamp: ts(),
  });
}
function toolResult(id: string, text = "ok"): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }],
    },
    timestamp: ts(),
  });
}
function enqueue(content: string): string {
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    content,
    timestamp: ts(),
  });
}

/** Offsets of every group, the coarse "did the grouping come out the same"
 * signal used where a full toEqual would be noise. */
function groupOffsets(groups: readonly TimelineGroup[]): number[] {
  return groups.map((g) => (g.kind === "entry" ? g.offset : g.entries[0]!.offset));
}

/** How many of `next`'s groups are the *same objects* as `previous`'s. */
function sharedGroupCount(previous: readonly TimelineGroup[], next: readonly TimelineGroup[]) {
  const before = new Set<TimelineGroup>(previous);
  return next.filter((group) => before.has(group)).length;
}

const CONVERSATION = [
  userPrompt("first question"),
  thinking("considering"),
  toolUse("tu_1"),
  toolResult("tu_1"),
  toolUse("tu_2"),
  toolResult("tu_2"),
  assistantText("first answer"),
  userPrompt("second question"),
  thinking("considering again"),
  toolUse("tu_3"),
  toolResult("tu_3"),
  assistantText("second answer"),
];

describe("incremental cross-line derivation", () => {
  test("a cold cache matches a from-scratch derivation", () => {
    replay([CONVERSATION]);
  });

  test("appending one line at a time ends where one shot would", () => {
    const windows = CONVERSATION.map((_, i) => CONVERSATION.slice(0, i + 1));
    replay(windows);
  });

  test("a tool_result arriving after its tool_use rewrites only that line's group", () => {
    const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
    const before = CONVERSATION.slice(0, 5); // ends at the un-answered tu_2
    let cache = step(emptyCrossLineCache(), before, parses);
    const groupsBefore = cache.groups;
    const parsedBefore = cache.parsed;

    cache = step(cache, CONVERSATION.slice(0, 6), parses); // tu_2's result lands
    expect(cache.parsed).toEqual(fromScratch(CONVERSATION.slice(0, 6)).parsed);

    // The tool_use line is rewritten (it now carries its result) and so is the
    // fold group holding it; the user prompt ahead of them is untouched.
    expect(cache.parsed[0]).toBe(parsedBefore[0]!);
    expect(cache.parsed[4]).not.toBe(parsedBefore[4]!);
    expect(cache.groups[0]).toBe(groupsBefore[0]!);
    expect(cache.groups[1]).not.toBe(groupsBefore[1]!);
  });

  test("a live-tail append keeps every group ahead of the tail", () => {
    const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
    let cache = step(emptyCrossLineCache(), CONVERSATION, parses);
    const before = cache.groups;
    const appended = [...CONVERSATION, userPrompt("third question")];
    cache = step(cache, appended, parses);

    expect(cache.groups).toEqual(fromScratch(appended).groups);
    // The appended line is a boundary, so it becomes a new group and every
    // earlier group is carried over untouched.
    expect(cache.groups).toHaveLength(before.length + 1);
    expect(sharedGroupCount(before, cache.groups)).toBe(before.length);
  });

  test("an append that extends a fold run keeps every group before it", () => {
    const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
    const base = [...CONVERSATION, userPrompt("third question"), thinking("hm")];
    let cache = step(emptyCrossLineCache(), base, parses);
    const before = cache.groups;
    const appended = [...base, toolUse("tu_4")];
    cache = step(cache, appended, parses);

    expect(cache.groups).toEqual(fromScratch(appended).groups);
    // Only the trailing fold group grows; the rest are the same objects.
    expect(cache.groups).toHaveLength(before.length);
    expect(sharedGroupCount(before, cache.groups)).toBe(before.length - 1);
    expect(cache.groups[before.length - 1]).not.toBe(before[before.length - 1]!);
  });

  test("a queued turn cancelled by a later delivery re-derives from scratch identically", () => {
    const text = "run the thing";
    const queued = [...CONVERSATION, enqueue(text)];
    const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
    let cache = step(emptyCrossLineCache(), queued, parses);
    const before = cache.groups;

    // The delivery demotes the queued row to a meta line — a change to a line
    // that is *not* the appended one, which is the case a tail-only scheme
    // would miss.
    const delivered = [...queued, userPrompt(text)];
    cache = step(cache, delivered, parses);
    const expected = fromScratch(delivered);
    expect(cache.parsed).toEqual(expected.parsed);
    expect(cache.groups).toEqual(expected.groups);
    expect(groupOffsets(cache.groups)).toEqual(groupOffsets(expected.groups));
    // Everything up to the demoted row survives.
    expect(sharedGroupCount(before, cache.groups)).toBe(before.length - 1);
  });

  test("a load-older prepend keeps the groups it pushed down", () => {
    const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
    const tail = CONVERSATION.slice(7);
    // A prepend keeps each already-cached line's absolute offset and only
    // moves `start`, so the reconciliation has to match from the far end.
    const head = CONVERSATION.slice(0, 7);
    const headBytes = head.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0);

    let cache = crossLineIncrementally(emptyCrossLineCache(), {
      start: START + headBytes,
      raws: tail,
      perLine: tail.map((raw) => {
        const parsed = parseTranscriptLine(raw);
        parses.set(raw, parsed);
        return parsed;
      }),
      byteLengths: tail.map(utf8ByteLength),
    });
    const before = cache.groups;
    cache = step(cache, CONVERSATION, parses);

    expect(cache.groups).toEqual(fromScratch(CONVERSATION).groups);
    expect(sharedGroupCount(before, cache.groups)).toBe(before.length);
  });

  test("an unchanged update returns the previous arrays themselves", () => {
    const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
    const cache = step(emptyCrossLineCache(), CONVERSATION, parses);
    const again = step(cache, CONVERSATION, parses);
    expect(again.parsed).toBe(cache.parsed);
    expect(again.offsets).toBe(cache.offsets);
    expect(again.groups).toBe(cache.groups);
  });

  test("a replace re-read of identical content still reuses every group", () => {
    // A "更新" reload arrives as fresh string objects and fresh per-line
    // parses, so nothing matches by reference — the structural comparison is
    // the only thing that can recover the identity here.
    const parses = new Map<string, ReturnType<typeof parseTranscriptLine>>();
    const cache = step(emptyCrossLineCache(), CONVERSATION, parses);
    const again = step(cache, [...CONVERSATION], new Map());

    expect(again.groups).toEqual(fromScratch(CONVERSATION).groups);
    expect(sharedGroupCount(cache.groups, again.groups)).toBe(cache.groups.length);
  });
});
