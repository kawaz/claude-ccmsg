// Pure jsonl-line -> renderable-event transform for the Timeline view
// (DR-0009). Kept out of Timeline.tsx so the fold logic is unit-testable
// without preact/DOM, mirroring store.ts's reducer/effect split (DR-0005 §1).
//
// Design rationale: Claude Code's transcript jsonl schema is explicitly NOT
// guaranteed stable across versions (DR-0009 "jsonl フォーマットの安定性").
// Rather than hardcode a whitelist of "known" non-turn top-level `type`s
// (`file-history-snapshot` / `queue-operation` / `system` / ... observed in a
// real transcript during implementation) that would need updating every time
// Claude Code adds one, every line whose top-level `type` isn't
// "user"/"assistant" folds through ONE generic one-line-summary path
// (`summarizeMeta`) that reads only duck-typed, optional fields (`subtype`,
// `operation`) already seen across the current type zoo. A genuinely new/
// unseen type degrades to the same one-line + raw-JSON-expand rendering with
// no special-case needed — "safe fallback for unknown types" and "compact
// display for the other known types" are the same code path, not two.

/** One block inside a user/assistant turn's `message.content`, normalized
 * across the shapes Claude Code emits (string content, array of typed
 * blocks). `unknown-segment` is the forward-compat catch-all for a content
 * block whose `type` (or shape) this module has never seen. */
export type Segment =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool-use"; name: string; input: unknown }
  | { kind: "tool-result"; toolUseId: string; isError: boolean; text: string }
  | { kind: "unknown-segment"; type: string; raw: unknown };

export interface TurnLine {
  kind: "turn";
  ts: string | null;
  role: "user" | "assistant";
  segments: Segment[];
}

/** Any top-level `type` other than "user"/"assistant" — see module doc
 * comment for why known and unknown types share this one shape. */
export interface MetaLine {
  kind: "meta";
  ts: string | null;
  type: string;
  summary: string;
  raw: string;
}

/** JSON.parse failure, or a parsed value that isn't a JSON object at all
 * (array, string, number, null) — the line is shown verbatim, never thrown. */
export interface BrokenLine {
  kind: "broken";
  raw: string;
  error: string;
}

export type ParsedLine = TurnLine | MetaLine | BrokenLine;

/** Duck-typed text extraction used both for a top-level message body and for
 * a `tool_result` block's own (independently-shaped) `content` field — both
 * are "string | array of blocks" in the wild, so one helper covers both call
 * sites. Any block this doesn't recognize as `{type:"text", text}` falls back
 * to its raw JSON rather than being dropped. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (
          item &&
          typeof item === "object" &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return (item as Record<string, unknown>).text as string;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (content === undefined) return "";
  return JSON.stringify(content);
}

function parseSegments(content: unknown, role: "user" | "assistant"): Segment[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", role, text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return content === undefined
      ? []
      : [{ kind: "unknown-segment", type: typeof content, raw: content }];
  }
  return content.map((block): Segment => {
    if (!block || typeof block !== "object") {
      return { kind: "unknown-segment", type: typeof block, raw: block };
    }
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text":
        return { kind: "text", role, text: typeof b.text === "string" ? b.text : "" };
      case "thinking":
        return { kind: "thinking", text: typeof b.thinking === "string" ? b.thinking : "" };
      case "tool_use":
        return {
          kind: "tool-use",
          name: typeof b.name === "string" ? b.name : "?",
          input: b.input,
        };
      case "tool_result":
        return {
          kind: "tool-result",
          toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
          isError: Boolean(b.is_error),
          text: contentToText(b.content),
        };
      default:
        return {
          kind: "unknown-segment",
          type: typeof b.type === "string" ? b.type : "?",
          raw: block,
        };
    }
  });
}

function summarizeMeta(obj: Record<string, unknown>): string {
  const parts = [typeof obj.type === "string" ? obj.type : "?"];
  if (typeof obj.subtype === "string") parts.push(obj.subtype);
  if (typeof obj.operation === "string") parts.push(obj.operation);
  return parts.join(": ");
}

/**
 * Absolute byte offset (in the transcript file) of each cached line's start,
 * given the cache's current `start` (TimelineState.start: byte offset of the
 * earliest loaded line, DR-0009). Each line consumed `byteLength(line) + 1`
 * bytes on disk (jsonl: the line's own content plus the `\n` transcript_read
 * strips before returning it).
 *
 * Used as Preact `key`s (Timeline.tsx) instead of the array index: an index
 * key would make a "load older" prepend renumber every already-rendered
 * line, so an open `<details>` fold would jump to a *different* line after
 * the prepend. A line's absolute byte offset never changes once loaded —
 * only `start` (and the offsets recomputed from it) shrinks when an older
 * page is spliced in front — so offsets computed this way stay stable across
 * prepends for every line that was already cached.
 */
export function lineByteOffsets(start: number, lines: string[]): number[] {
  const encoder = new TextEncoder();
  const offsets: number[] = [];
  let pos = start;
  for (const line of lines) {
    offsets.push(pos);
    pos += encoder.encode(line).length + 1;
  }
  return offsets;
}

/**
 * True for a real human utterance — a "user" turn holding at least one text
 * segment — as opposed to a tool_result-only user turn (Anthropic API
 * convention wraps tool results in a user-typed line, see the
 * parseTranscriptLine/user-turns test above) or any non-turn line. Shared by
 * Timeline.tsx's chat-bubble styling and its "👤 N/M" user-turn nav counter,
 * so a turn can't count toward one and not the other — kawaz's spec ties both
 * to the same "ユーザ発言 (tool_result は除く)" definition.
 */
export function isUserTextTurn(line: ParsedLine): boolean {
  return (
    line.kind === "turn" && line.role === "user" && line.segments.some((s) => s.kind === "text")
  );
}

/**
 * Given the vertical pixel offsets (ascending, top-to-bottom) of every
 * currently-loaded user-text turn inside the Timeline's scroll container, and
 * the container's current `scrollTop`, returns how many of those turns sit at
 * or above the current scroll position — the 1-based "you're currently past
 * turn N" count behind the toolbar's "👤 N/M" indicator (Timeline.tsx).
 * Returns 0 when scrolled above every turn (or none are loaded).
 *
 * Turning DOM refs into `topOffsets` (impure, `getBoundingClientRect`) lives
 * in Timeline.tsx; this is the pure, unit-testable half of that calculation
 * per kawaz's spec ("位置算出ロジックは可能な範囲で純関数に切り出して単体テスト").
 */
export function scrollPositionToUserTurnIndex(topOffsets: number[], scrollTop: number): number {
  let idx = 0;
  for (const top of topOffsets) {
    if (top > scrollTop) break;
    idx++;
  }
  return idx;
}

/** One cached line paired with its stable Preact key (see `lineByteOffsets`
 * doc comment) — the unit `groupTimelineLines` operates on and emits inside
 * a fold group. */
export interface TimelineEntry {
  offset: number;
  line: ParsedLine;
}

/** Timeline.tsx's render unit after tools-folding (kawaz spec): either a
 * boundary line rendered directly (a real user prompt, or the assistant's
 * next user-facing final response), or a run of everything in between
 * (thinking / tool_use / tool_result / meta lines / broken lines) collapsed
 * into one foldable group. */
export type TimelineGroup =
  | { kind: "entry"; offset: number; line: ParsedLine }
  | { kind: "fold"; entries: TimelineEntry[] };

/** True for a line that should render on its own (never folded into a tools
 * group): a real user utterance (`isUserTextTurn`), or an assistant turn
 * carrying at least one `text` segment — the "次のユーザ向けアシスタント最終
 * レスポンス" that ends a run of intermediate entries. An assistant turn
 * with only thinking/tool_use segments (no text yet) is NOT a boundary, so
 * it folds with the rest of the run until a text-bearing turn (or the next
 * user prompt) closes it. */
function isBoundaryLine(line: ParsedLine): boolean {
  if (isUserTextTurn(line)) return true;
  return (
    line.kind === "turn" &&
    line.role === "assistant" &&
    line.segments.some((s) => s.kind === "text")
  );
}

/**
 * Groups the run of entries strictly between one boundary line and the next
 * into `{kind:"fold"}` groups, leaving boundary lines (user prompts, and the
 * assistant's user-facing final responses) as standalone `{kind:"entry"}`
 * groups in their original order (kawaz spec: "tools folding"). A trailing
 * run with no closing boundary yet (an in-progress turn) still folds — there
 * is simply no following boundary entry after it.
 *
 * `offsets` must be the same length as `lines` (Timeline.tsx's
 * `lineByteOffsets` output) so each entry keeps its stable Preact key.
 */
export function groupTimelineLines(lines: ParsedLine[], offsets: number[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let pending: TimelineEntry[] = [];
  const flushPending = () => {
    if (pending.length > 0) {
      groups.push({ kind: "fold", entries: pending });
      pending = [];
    }
  };
  lines.forEach((line, i) => {
    const offset = offsets[i]!;
    if (isBoundaryLine(line)) {
      flushPending();
      groups.push({ kind: "entry", offset, line });
    } else {
      pending.push({ offset, line });
    }
  });
  flushPending();
  return groups;
}

/** True if every entry in a fold group is a turn line whose segments are
 * exclusively tool-use/tool-result (no thinking, no meta/broken lines mixed
 * in) — the "▶︎ N tools" wording. A mixed group (thinking / meta / broken
 * lines present) falls back to the generic "▶︎ N items" wording since "tools"
 * would misdescribe what's inside. */
function isToolOnlyEntry(entry: TimelineEntry): boolean {
  const { line } = entry;
  return (
    line.kind === "turn" &&
    line.segments.length > 0 &&
    line.segments.every((s) => s.kind === "tool-use" || s.kind === "tool-result")
  );
}

/** Folded-group summary label (kawaz spec: "▶︎ 13 tools" style, count = number
 * of intermediate entries in the group). */
export function foldGroupLabel(entries: TimelineEntry[]): string {
  const noun = entries.every(isToolOnlyEntry) ? "tools" : "items";
  return `${entries.length} ${noun}`;
}

/** Parse one raw jsonl line (as returned by `transcript_read`, DR-0009) into
 * a renderable event. Never throws — a malformed line becomes `BrokenLine`,
 * an unrecognized-but-valid shape becomes `MetaLine`/`unknown-segment`. */
export function parseTranscriptLine(raw: string): ParsedLine {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { kind: "broken", raw, error: e instanceof Error ? e.message : "parse error" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { kind: "broken", raw, error: "not a JSON object" };
  }
  const o = obj as Record<string, unknown>;
  const ts = typeof o.timestamp === "string" ? o.timestamp : null;
  if (o.type === "user" || o.type === "assistant") {
    const role = o.type;
    const message = o.message as Record<string, unknown> | undefined;
    const segments = message ? parseSegments(message.content, role) : [];
    return { kind: "turn", ts, role, segments };
  }
  return {
    kind: "meta",
    ts,
    type: typeof o.type === "string" ? o.type : "?",
    summary: summarizeMeta(o),
    raw,
  };
}
