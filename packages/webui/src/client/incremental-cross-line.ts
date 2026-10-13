// The cross-line half of the Timeline's transcript derivation — queue pairing,
// tool_use/tool_result joining, byte offsets, tools-folding — recomputed on
// every update but handed back with the *identity* of everything that did not
// actually change.
//
// incremental-line-map.ts already keeps the per-line parse of an untouched
// line, but everything downstream of it built fresh arrays and fresh objects
// on every live-tail append: `groups`, each fold group's `entries`, and (for
// any line whose segments were rewritten by the tool_result join) the
// ParsedLine itself. Preact compares props by reference, so a single appended
// line handed every FoldGroup in the transcript a new `entries` array and made
// the whole tree re-diff.
//
// Two things make identity recoverable cheaply rather than by re-deriving the
// passes incrementally:
//
//   1. The passes stay whole-window. They have to: appending a tool_result can
//      legitimately change a tool_use line thousands of lines back, and a
//      delivered user turn cancels a queued copy that appeared earlier. Any
//      "only recompute the tail" scheme would have to reproduce that reach,
//      and would be wrong in exactly the cases that are hardest to notice.
//   2. What the passes return is *mostly the previous objects*. Their inputs
//      (`perLine`) are reference-stable, and the passes return their input
//      line untouched unless they rewrite it. So a structural comparison that
//      short-circuits on `===` settles an unchanged line in one pointer
//      compare and a rewritten-but-equal line in a handful.
//
// So: recompute, then reconcile against the previous result and keep the old
// object wherever the new one is equal. The reconciliation is matched from
// both ends for the same reason incremental-line-map.ts is — a live tail
// appends, a "load older" page prepends.

import type { JsonObject, JsonValue } from "@ccmsg/protocol";
import {
  type AttachmentDetail,
  type AttachmentFile,
  type BashCommandOutput,
  byteOffsetsFromLengths,
  type FileToolResult,
  groupTimelineLines,
  pairQueuedTurns,
  type ParsedLine,
  resolveToolResults,
  type Segment,
  type SystemMessageField,
  type TimelineGroup,
} from "./transcript-model.ts";

/** Inputs and outputs of one cross-line derivation, kept so the next one can
 * reuse whatever it still agrees with. */
export interface CrossLineCache {
  parsed: readonly ParsedLine[];
  offsets: readonly number[];
  groups: readonly TimelineGroup[];
}

export function emptyCrossLineCache(): CrossLineCache {
  return { parsed: [], offsets: [], groups: [] };
}

export interface CrossLineInput {
  /** Absolute byte offset of the first cached line (`timeline.start`). */
  start: number;
  /** Raw transcript lines, index-aligned with `perLine` and `byteLengths`. */
  raws: readonly string[];
  /** Per-line parse, reference-stable for unchanged lines (see
   * incremental-line-map.ts). */
  perLine: readonly ParsedLine[];
  /** Per-line UTF-8 size, same provenance as `perLine`. */
  byteLengths: readonly number[];
}

// Field-by-field equality for each type a ParsedLine is made of. Every
// comparison starts with `===`: a leaf a pass did not rewrite is the *same
// object* as last time (the passes spread over their input rather than
// rebuilding it from the raw text), so an unchanged branch settles in one
// pointer compare. A line the tail really did change is walked in full, but
// there are only ever a handful of those per update and the walk is cheaper
// than the parse that produced it. A reload hands over fresh parses, where
// nothing matches by reference and the walk is what recovers the identity.

function equalArray<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a.at(i);
    const y = b.at(i);
    if (x === undefined || y === undefined || !equal(x, y)) return false;
  }
  return true;
}

function equalNullable<T>(a: T | null, b: T | null, equal: (x: T, y: T) => boolean): boolean {
  if (a === null || b === null) return a === b;
  return equal(a, b);
}

function equalOptional<T>(
  a: T | undefined,
  b: T | undefined,
  equal: (x: T, y: T) => boolean,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return equal(a, b);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function equalJsonValue(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (isJsonArray(a)) return isJsonArray(b) && equalArray(a, b, equalJsonValue);
  if (isJsonArray(b)) return false;
  return equalJsonObject(a, b);
}

function equalJsonObject(a: JsonObject, b: JsonObject): boolean {
  if (a === b) return true;
  // `Object.hasOwn` keeps an inherited name (`toString`, …) on the other side
  // from being read as a field: the index signature would type it JsonValue.
  let size = 0;
  for (const key in a) {
    if (!Object.hasOwn(a, key)) continue;
    size++;
    if (!Object.hasOwn(b, key)) return false;
    const x = a[key];
    const y = b[key];
    if (x === undefined || y === undefined || !equalJsonValue(x, y)) return false;
  }
  for (const key in b) {
    if (Object.hasOwn(b, key)) size--;
  }
  return size === 0;
}

function equalFileToolResult(a: FileToolResult, b: FileToolResult): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "text":
      return b.kind === "text" && a.content === b.content;
    case "image":
      return (
        b.kind === "image" &&
        a.mediaType === b.mediaType &&
        a.base64 === b.base64 &&
        a.width === b.width &&
        a.height === b.height
      );
    case "error":
      return b.kind === "error" && a.message === b.message;
  }
}

function equalBashCommandOutput(a: BashCommandOutput, b: BashCommandOutput): boolean {
  if (a === b) return true;
  return (
    a.stdout === b.stdout &&
    a.stderr === b.stderr &&
    equalNullable(
      a.persisted,
      b.persisted,
      (x, y) => x.note === y.note && x.path === y.path && x.preview === y.preview,
    )
  );
}

function equalBashResult(
  a: { text: string; isError: boolean },
  b: { text: string; isError: boolean },
): boolean {
  return a.text === b.text && a.isError === b.isError;
}

function equalSegment(a: Segment, b: Segment): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "text":
      return b.kind === "text" && a.role === b.role && a.text === b.text;
    case "thinking":
      return b.kind === "thinking" && a.text === b.text;
    case "thinking-hidden":
      return b.kind === "thinking-hidden" && a.reason === b.reason;
    case "tool-use":
      return b.kind === "tool-use" && a.name === b.name && equalJsonObject(a.input, b.input);
    case "file-read":
      return (
        b.kind === "file-read" &&
        a.toolUseId === b.toolUseId &&
        a.path === b.path &&
        a.offset === b.offset &&
        a.limit === b.limit &&
        equalNullable(a.result, b.result, equalFileToolResult)
      );
    case "file-write":
      return b.kind === "file-write" && a.path === b.path && a.content === b.content;
    case "file-edit":
      return (
        b.kind === "file-edit" &&
        a.path === b.path &&
        a.oldString === b.oldString &&
        a.newString === b.newString
      );
    case "file-tool-result":
      return (
        b.kind === "file-tool-result" &&
        a.toolUseId === b.toolUseId &&
        equalFileToolResult(a.result, b.result) &&
        equalOptional(a.toolUseResult, b.toolUseResult, equalJsonValue)
      );
    case "bash-use":
      return (
        b.kind === "bash-use" &&
        a.toolUseId === b.toolUseId &&
        a.command === b.command &&
        a.description === b.description &&
        a.background === b.background &&
        a.hasResult === b.hasResult &&
        equalNullable(a.result, b.result, equalBashResult)
      );
    case "bash-result":
      return (
        b.kind === "bash-result" &&
        a.toolUseId === b.toolUseId &&
        a.text === b.text &&
        a.isError === b.isError &&
        a.background === b.background &&
        a.hasCommand === b.hasCommand
      );
    case "agent-send":
      return (
        b.kind === "agent-send" &&
        a.to === b.to &&
        a.summary === b.summary &&
        a.message === b.message &&
        a.messageType === b.messageType
      );
    case "agent-spawn":
      return (
        b.kind === "agent-spawn" &&
        a.name === b.name &&
        a.agentType === b.agentType &&
        a.model === b.model &&
        a.description === b.description &&
        a.prompt === b.prompt &&
        a.background === b.background
      );
    case "slash-command-prefix":
      return b.kind === "slash-command-prefix" && a.command === b.command;
    case "bash-command":
      return (
        b.kind === "bash-command" &&
        a.command === b.command &&
        equalNullable(a.output, b.output, equalBashCommandOutput)
      );
    case "bash-command-output":
      return (
        b.kind === "bash-command-output" &&
        a.hasCommand === b.hasCommand &&
        equalBashCommandOutput(a, b)
      );
    case "tool-result":
      return (
        b.kind === "tool-result" &&
        a.toolUseId === b.toolUseId &&
        a.isError === b.isError &&
        a.text === b.text &&
        equalOptional(a.toolUseResult, b.toolUseResult, equalJsonValue)
      );
    case "unknown-segment":
      return b.kind === "unknown-segment" && a.type === b.type && equalJsonValue(a.raw, b.raw);
  }
}

function equalSystemMessageField(a: SystemMessageField, b: SystemMessageField): boolean {
  return a.name === b.name && a.value === b.value;
}

function equalAttachmentFile(a: AttachmentFile, b: AttachmentFile): boolean {
  return a.path === b.path && a.content === b.content && a.startLine === b.startLine;
}

function equalAttachmentDetail(a: AttachmentDetail, b: AttachmentDetail): boolean {
  if (a === b) return true;
  return (
    a.type === b.type &&
    a.trailing === b.trailing &&
    equalArray(a.fields, b.fields, equalSystemMessageField) &&
    equalOptional(a.file, b.file, equalAttachmentFile)
  );
}

function equalParsedLine(a: ParsedLine, b: ParsedLine): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "turn":
      return (
        b.kind === "turn" &&
        a.ts === b.ts &&
        a.uuid === b.uuid &&
        a.parentUuid === b.parentUuid &&
        a.role === b.role &&
        a.userMessageKind === b.userMessageKind &&
        a.assistantMessageKind === b.assistantMessageKind &&
        a.queuedContent === b.queuedContent &&
        equalArray(a.segments, b.segments, equalSegment)
      );
    case "meta":
      return (
        b.kind === "meta" &&
        a.ts === b.ts &&
        a.uuid === b.uuid &&
        a.parentUuid === b.parentUuid &&
        a.type === b.type &&
        a.summary === b.summary &&
        a.raw === b.raw &&
        equalOptional(a.attachment, b.attachment, equalAttachmentDetail)
      );
    case "broken":
      return b.kind === "broken" && a.raw === b.raw && a.error === b.error;
  }
}

/** Number of leading elements two arrays share under `equal`. */
function sharedPrefix<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && equal(a[i], b[i])) i++;
  return i;
}

/** Number of trailing elements two arrays share under `equal`, capped by
 * `limit` so an element already claimed by the prefix is never counted twice. */
function sharedSuffix<T>(
  a: readonly T[],
  b: readonly T[],
  limit: number,
  equal: (x: T, y: T) => boolean,
): number {
  let i = 0;
  while (i < limit && equal(a[a.length - 1 - i], b[b.length - 1 - i])) i++;
  return i;
}

/**
 * Replaces each element of `next` with the equal element of `previous`,
 * matching the two arrays from both ends. Elements between the two matched
 * runs — the part that really changed — are kept as computed.
 *
 * Returns `previous` itself when nothing changed at all, so a redundant update
 * (a websocket push that adds no lines, a re-render with the same store state)
 * propagates no new identity anywhere.
 */
function reuseUnchanged<T>(
  previous: readonly T[],
  next: T[],
  equal: (x: T, y: T) => boolean,
): readonly T[] {
  const prefix = sharedPrefix(previous, next, equal);
  if (prefix === previous.length && prefix === next.length) return previous;
  const suffix = sharedSuffix(
    previous,
    next,
    Math.min(previous.length, next.length) - prefix,
    equal,
  );
  for (let i = 0; i < prefix; i++) next[i] = previous[i];
  for (let i = 0; i < suffix; i++) next[next.length - 1 - i] = previous[previous.length - 1 - i];
  return next;
}

function equalNumber(a: number, b: number): boolean {
  return a === b;
}

/** Two groups render identically: same kind, same byte offsets, and the same
 * ParsedLine objects (already reconciled by the time this runs, so `===` here
 * is the full test rather than an approximation of one). */
function equalGroup(a: TimelineGroup, b: TimelineGroup): boolean {
  if (a === b) return true;
  if (a.kind === "entry") {
    return b.kind === "entry" && a.offset === b.offset && a.line === b.line;
  }
  if (b.kind !== "fold" || a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i];
    const y = b.entries[i];
    if (x.offset !== y.offset || x.line !== y.line) return false;
  }
  return true;
}

/**
 * Runs the cross-line passes over the whole window and returns their results
 * with unchanged parts carried over from `cache` by identity.
 *
 * The three outputs are equal, element for element, to what
 * `resolveToolResults(pairQueuedTurns(...))` / `byteOffsetsFromLengths` /
 * `groupTimelineLines` return when called directly — the reconciliation only
 * chooses *which* of two equal objects to hand back. That equivalence is what
 * the property test in test/incremental-cross-line.test.ts pins down.
 */
export function crossLineIncrementally(
  cache: CrossLineCache,
  { start, raws, perLine, byteLengths }: CrossLineInput,
): CrossLineCache {
  const offsets = reuseUnchanged(
    cache.offsets,
    byteOffsetsFromLengths(start, byteLengths),
    equalNumber,
  );
  const parsed = reuseUnchanged(
    cache.parsed,
    resolveToolResults(pairQueuedTurns(perLine, raws)),
    equalParsedLine,
  );
  // Nothing downstream can have changed if neither input to the grouping did,
  // and the grouping is the expensive half.
  const groups =
    parsed === cache.parsed && offsets === cache.offsets
      ? cache.groups
      : reuseUnchanged(cache.groups, groupTimelineLines(parsed, offsets), equalGroup);
  return { parsed, offsets, groups };
}
