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
