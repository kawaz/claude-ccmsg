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
  | {
      kind: "file-read";
      toolUseId: string;
      path: string;
      offset: number | null;
      limit: number | null;
      content: string | null;
    }
  | { kind: "file-write"; path: string; content: string }
  | { kind: "file-edit"; path: string; oldString: string; newString: string }
  | { kind: "file-tool-result"; toolUseId: string; content: string }
  | {
      kind: "bash-use";
      toolUseId: string;
      command: string;
      description: string;
      background: boolean;
      result: { text: string; isError: boolean } | null;
      hasResult: boolean;
    }
  | {
      kind: "bash-result";
      toolUseId: string;
      text: string;
      isError: boolean;
      background: boolean;
      hasCommand: boolean;
    }
  | {
      kind: "agent-send";
      to: string;
      summary: string | null;
      message: string;
      messageType: string;
    }
  | {
      kind: "agent-spawn";
      name: string;
      agentType: string;
      description: string;
      prompt: string;
      background: boolean;
    }
  | { kind: "tool-result"; toolUseId: string; isError: boolean; text: string }
  | { kind: "unknown-segment"; type: string; raw: unknown };

export interface TurnLine {
  kind: "turn";
  ts: string | null;
  role: "user" | "assistant";
  segments: Segment[];
  /** classifyUserMessage's verdict for a role:"user" line — which pattern of
   * "type:user に見えるシステム由来メッセージ" (or a real human utterance,
   * "user-prompt") this line matches. Absent for role:"assistant"
   * (classification only concerns Claude Code's user-role injection
   * patterns; see classifyUserMessage's doc comment) and for hand-built
   * ParsedLine values elsewhere (e.g. test fixtures) that never went through
   * parseTranscriptLine. */
  userMessageKind?: UserMessageKind;
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

function stringField(obj: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    if (typeof obj[name] === "string") return obj[name];
  }
  return "";
}

function parseSpecialTool(name: string, toolUseId: string, input: unknown): Segment | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  const path = stringField(obj, "file_path", "path");
  if (name === "Bash") {
    return {
      kind: "bash-use",
      toolUseId,
      command: stringField(obj, "command"),
      description: stringField(obj, "description"),
      background: obj.run_in_background === true,
      result: null,
      hasResult: false,
    };
  }
  if (name === "Read" && path) {
    return {
      kind: "file-read",
      toolUseId,
      path,
      offset: typeof obj.offset === "number" ? obj.offset : null,
      limit: typeof obj.limit === "number" ? obj.limit : null,
      content: null,
    };
  }
  if (name === "Write" && path) {
    return { kind: "file-write", path, content: stringField(obj, "content") };
  }
  if (name === "Edit" && path) {
    return {
      kind: "file-edit",
      path,
      oldString: stringField(obj, "old_string"),
      newString: stringField(obj, "new_string"),
    };
  }
  if (name === "SendMessage") {
    return {
      kind: "agent-send",
      to: stringField(obj, "to", "recipient") || "?",
      summary: stringField(obj, "summary") || null,
      message: stringField(obj, "message", "content", "prompt"),
      messageType: stringField(obj, "type") || "message",
    };
  }
  if (name === "Agent") {
    const description = stringField(obj, "description");
    return {
      kind: "agent-spawn",
      name: stringField(obj, "name") || description || "agent",
      agentType: stringField(obj, "subagent_type", "model") || "agent",
      description,
      prompt: stringField(obj, "prompt"),
      background: obj.run_in_background === true,
    };
  }
  return null;
}

function parseSegments(
  content: unknown,
  role: "user" | "assistant",
  toolUseResult?: unknown,
): Segment[] {
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
      case "tool_use": {
        const name = typeof b.name === "string" ? b.name : "?";
        const toolUseId = typeof b.id === "string" ? b.id : "";
        return (
          parseSpecialTool(name, toolUseId, b.input) ?? { kind: "tool-use", name, input: b.input }
        );
      }
      case "tool_result": {
        const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
        const result =
          toolUseResult && typeof toolUseResult === "object" && !Array.isArray(toolUseResult)
            ? (toolUseResult as Record<string, unknown>)
            : null;
        const file =
          result?.file && typeof result.file === "object" && !Array.isArray(result.file)
            ? (result.file as Record<string, unknown>)
            : null;
        if (typeof file?.content === "string") {
          return { kind: "file-tool-result", toolUseId, content: file.content };
        }
        return {
          kind: "tool-result",
          toolUseId,
          isError: Boolean(b.is_error),
          text: contentToText(b.content),
        };
      }
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

/** Joins tool_use segments with matching tool_result segments by id. Result
 * lines remain in the array so transcript byte offsets stay aligned; foreground
 * Read/Bash results are omitted by groupTimelineLines after their content has
 * been attached to the command card. Background Bash results stay visible and
 * link back to their command card. */
export function resolveToolResults(lines: ParsedLine[]): ParsedLine[] {
  const fileContents = new Map<string, string>();
  const genericResults = new Map<string, { text: string; isError: boolean }>();
  const bashUses = new Map<string, { background: boolean }>();
  for (const line of lines) {
    if (line.kind !== "turn") continue;
    for (const segment of line.segments) {
      if (segment.kind === "file-tool-result") {
        fileContents.set(segment.toolUseId, segment.content);
      } else if (segment.kind === "tool-result") {
        genericResults.set(segment.toolUseId, { text: segment.text, isError: segment.isError });
      } else if (segment.kind === "bash-use") {
        bashUses.set(segment.toolUseId, { background: segment.background });
      }
    }
  }
  return lines.map((line) => {
    if (line.kind !== "turn") return line;
    let changed = false;
    const segments = line.segments.map((segment): Segment => {
      if (segment.kind === "file-read") {
        const content = fileContents.get(segment.toolUseId);
        if (content === undefined) return segment;
        changed = true;
        return { ...segment, content };
      }
      if (segment.kind === "bash-use") {
        const result = genericResults.get(segment.toolUseId) ?? null;
        if (result !== null) changed = true;
        return { ...segment, result, hasResult: result !== null };
      }
      if (segment.kind === "tool-result") {
        const use = bashUses.get(segment.toolUseId);
        if (!use) return segment;
        changed = true;
        return {
          kind: "bash-result",
          toolUseId: segment.toolUseId,
          text: segment.text,
          isError: segment.isError,
          background: use.background,
          hasCommand: true,
        };
      }
      return segment;
    });
    return changed ? { ...line, segments } : line;
  });
}

export const resolveFileToolResults = resolveToolResults;

function isConsumedToolResult(line: ParsedLine): boolean {
  return (
    line.kind === "turn" &&
    line.segments.length > 0 &&
    line.segments.every(
      (segment) =>
        segment.kind === "file-tool-result" ||
        (segment.kind === "bash-result" && !segment.background && segment.hasCommand),
    )
  );
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
 * True for a real human utterance — a "user" turn classified (or, for
 * hand-built fixtures, assumed) as `userMessageKind === "user-prompt"` — as
 * opposed to a tool_result-only user turn (Anthropic API convention wraps
 * tool results in a user-typed line, see the parseTranscriptLine/user-turns
 * test above), a system-origin "type:user" line (teammate-message /
 * task-notification / slash-command plumbing / etc., see
 * `classifyUserMessage`), or any non-turn line. `userMessageKind` is only
 * `undefined` for hand-built `ParsedLine` values that never went through
 * `parseTranscriptLine` (test fixtures, see `TurnLine.userMessageKind`'s doc
 * comment) — those fall back to the text-segment check below rather than
 * being unconditionally excluded.
 *
 * A classified `"user-prompt"` counts even with zero *text* segments as long
 * as it has *some* segment: an image-only paste (no caption) is real human
 * input per `classifyUserMessage` (an array of only text/image blocks), but
 * `parseSegments` has no `image` case yet, so an image block yields an
 * `unknown-segment` rather than `{kind:"text"}` — requiring a text segment
 * specifically would wrongly fold it. The `segments.length > 0` guard still
 * excludes a `content: ""` turn (zero segments, `classifyUserMessage` even
 * classifies empty string as `"user-prompt"` since no exclusion pattern
 * matches) from counting as a real utterance.
 *
 * Shared by Timeline.tsx's chat-bubble styling, its "👤 N/M" user-turn nav
 * counter, and `isBoundaryLine` below — so a turn can't count toward one and
 * not the others: kawaz's U2 spec ties all three to the same "本物のユーザ
 * 発話 (tool_result・システム由来メッセージは除く)" definition (U2:
 * previously this only excluded tool_result-only turns, letting
 * system-origin messages both stand outside tools-folding *and* pollute the
 * nav counter — kawaz: "システムメッセージも tool や thinking と同じで
 * folding しといて").
 */
/** 👤 nav (n/N ジャンプ) の対象: 人間のユーザプロンプトに加えて、ccmsg 経由の
 * kawaz 発メッセージ (from:"u1") も「ユーザメッセージ」として数える
 * (kawaz r38 mid=51 — 1on1 運用では指示が ccmsg で届くため、prompt だけの
 * カウントでは実質のユーザ発話を辿れない)。 */
export function isUserNavTurn(line: ParsedLine): boolean {
  if (isUserTextTurn(line)) return true;
  return extractCcmsgMessages(line).some((m) => m.from === "u1");
}

export function isUserTextTurn(line: ParsedLine): boolean {
  if (line.kind !== "turn" || line.role !== "user") return false;
  if (line.userMessageKind !== undefined && line.userMessageKind !== "user-prompt") return false;
  if (line.userMessageKind === "user-prompt") return line.segments.length > 0;
  return line.segments.some((s) => s.kind === "text");
}

/**
 * Plain-text projection of a Segment for in-view search (DR-0022 §3: "TL は
 * text/thinking/tool セグメント" — every Segment variant, not just text/
 * thinking). tool-use/unknown-segment have no natural "text" field, so this
 * mirrors what SegmentView actually renders for them (`JSON.stringify(...,
 * null, 2)`) so a search hit corresponds to something visibly on screen once
 * the fold is expanded, rather than searching raw unrendered JSON shape.
 */
export function segmentSearchText(segment: Segment): string {
  switch (segment.kind) {
    case "text":
    case "thinking":
    case "tool-result":
      return segment.text;
    case "tool-use":
      return JSON.stringify(segment.input, null, 2);
    case "file-read":
      return [segment.path, segment.content].filter(Boolean).join("\n");
    case "file-write":
      return `${segment.path}\n${segment.content}`;
    case "file-edit":
      return `${segment.path}\n${segment.oldString}\n${segment.newString}`;
    case "file-tool-result":
      return segment.content;
    case "bash-use":
      return [segment.description, segment.command, segment.result?.text]
        .filter(Boolean)
        .join("\n");
    case "bash-result":
      return segment.text;
    case "agent-send":
      return [segment.to, segment.summary, segment.message].filter(Boolean).join("\n");
    case "agent-spawn":
      return [segment.name, segment.agentType, segment.description, segment.prompt]
        .filter(Boolean)
        .join("\n");
    case "unknown-segment":
      return JSON.stringify(segment.raw, null, 2);
  }
}

/** The three checkboxes SearchBar's TL-only target toggles expose (kawaz r26
 * mid=97 spec): whether a real human utterance, an assistant text/thinking
 * response, and a ccmsg room message respectively count as in-view search
 * units. */
export interface SearchTargets {
  user: boolean;
  ai: boolean;
  ccmsg: boolean;
}

/**
 * Whether a Segment belonging to a user-prompt or assistant `TurnLine` (never
 * a system-origin line — those are excluded by Timeline.tsx's `sysKind` check
 * before this is ever consulted, same guard `segmentSearchText`'s callers
 * apply) counts as an in-view search unit given TL's target toggles.
 *
 * `tool-use`/`tool-result`/`unknown-segment` are excluded unconditionally,
 * regardless of `targets` — kawaz r26 mid=97 bug report: TL search was
 * matching a `Bash` tool_use's raw command JSON, which the spec says must
 * never be a search target (only 👤 human text / 🤖 assistant text+thinking /
 * 💬 ccmsg messages are). `thinking` has no `role` field (it's always an
 * assistant artifact) so it follows `targets.ai` alone; `text` splits on its
 * own `role` since a user-prompt turn's text segment and an assistant turn's
 * text segment share the same Segment variant.
 */
export function isSearchableSegment(segment: Segment, targets: SearchTargets): boolean {
  switch (segment.kind) {
    case "text":
      return segment.role === "user" ? targets.user : targets.ai;
    case "thinking":
      return targets.ai;
    case "tool-use":
    case "file-read":
    case "file-write":
    case "file-edit":
    case "file-tool-result":
    case "bash-use":
    case "bash-result":
    case "agent-send":
    case "agent-spawn":
    case "tool-result":
    case "unknown-segment":
      return false;
  }
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

/** Which of the three chat-bubble kinds (webui Timeline display unification
 * task, kawaz spec) a boundary line renders as — `null` for every non-boundary
 * line (folds instead). The single source of truth both `isBoundaryLine`
 * (groupTimelineLines' fold/no-fold split) and Timeline.tsx (which bubble
 * component + alignment to render) key off of, so the two can never disagree
 * about which lines are boundaries. */
export type BoundaryKind =
  | { kind: "user-prompt" }
  | { kind: "assistant-response" }
  | { kind: "ccmsg"; messages: CcmsgMessage[] };

/**
 * Classifies a boundary line (kawaz spec order, first match wins): a real
 * user utterance (`isUserTextTurn`, which — U2 — already excludes
 * system-origin "type:user" messages such as teammate-message/
 * task-notification/slash-command plumbing, so those fold like any other
 * intermediate entry instead of standing alone) is `"user-prompt"`; an
 * assistant turn carrying at least one `text` segment — the "次のユーザ向け
 * アシスタント最終レスポンス" that ends a run of intermediate entries — is
 * `"assistant-response"`; a system-origin "type:user" line that itself
 * carries at least one ccmsg room message (`extractCcmsgMessages`, checked
 * last since it's the least common case and the function does its own
 * `kind==="turn"` guard) is `"ccmsg"`. Anything else — including an assistant
 * turn with only thinking/tool_use segments (no text yet), which folds with
 * the rest of the run until a text-bearing turn or the next user prompt
 * closes it — is `null` (not a boundary).
 */
export function classifyBoundaryLine(line: ParsedLine): BoundaryKind | null {
  if (isUserTextTurn(line)) return { kind: "user-prompt" };
  if (
    line.kind === "turn" &&
    line.role === "assistant" &&
    line.segments.some((s) => s.kind === "text")
  )
    return { kind: "assistant-response" };
  const ccmsgMessages = extractCcmsgMessages(line);
  return ccmsgMessages.length > 0 ? { kind: "ccmsg", messages: ccmsgMessages } : null;
}

/** True for a line that should render on its own (never folded into a tools
 * group) — see `classifyBoundaryLine`'s doc comment for the three cases this
 * covers. Kept as its own boolean predicate (rather than making every caller
 * check `!== null`) since `groupTimelineLines` only needs the yes/no split,
 * not which kind. */
function isBoundaryLine(line: ParsedLine): boolean {
  return classifyBoundaryLine(line) !== null;
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
    if (isConsumedToolResult(line)) return;
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

/** True when an entry contains a thinking segment. A mixed thinking+tool
 * turn is intentionally classified as thinking so its narrative marker does
 * not sink into an items sub-fold. */
export function isThinkingEntry(entry: TimelineEntry): boolean {
  const { line } = entry;
  return line.kind === "turn" && line.segments.some((s) => s.kind === "thinking");
}

/** Outgoing agent communication segments: SendMessage and Agent calls. */
export function isAgentCommunicationSegment(segment: Segment): boolean {
  return segment.kind === "agent-send" || segment.kind === "agent-spawn";
}

/** Incoming peer relays use a user-role transcript line rather than a Segment. */
export function isPeerMessageLine(line: ParsedLine): boolean {
  return line.kind === "turn" && line.userMessageKind === "peer-message";
}

/** True for a peer relay whose body is an idle_notification. Idle state is
 * operational noise rather than agent conversation, so it stays in items. */
function isIdlePeerMessageEntry(entry: TimelineEntry): boolean {
  const { line } = entry;
  if (!isPeerMessageLine(line) || line.kind !== "turn") return false;
  const rawText = line.segments
    .filter((segment): segment is Extract<Segment, { kind: "text" }> => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n");
  const rich = parseSystemMessageFields("peer-message", rawText);
  return rich.display === "peer" && rich.category === "idle";
}

/** Number of agent communication messages represented by one entry. Outgoing
 * calls are counted per segment; a non-idle incoming peer relay is one message. */
export function agentCommunicationCount(entry: TimelineEntry): number {
  const { line } = entry;
  if (line.kind !== "turn") return 0;
  if (isPeerMessageLine(line)) return isIdlePeerMessageEntry(entry) ? 0 : 1;
  return line.segments.filter(isAgentCommunicationSegment).length;
}

/** Entries rendered directly between items runs instead of being counted and
 * hidden inside an items sub-fold. Thinking and agent communication stay at
 * the same level inside the outer fold and split adjacent items runs. */
export function isDirectFoldEntry(entry: TimelineEntry): boolean {
  const { line } = entry;
  if (line.kind !== "turn") return false;
  return isThinkingEntry(entry) || agentCommunicationCount(entry) > 0;
}

/** Folded-group summary label: each present category is listed in the fixed
 * order "N thinking + N agent messages + N items". */
export function foldGroupLabel(entries: TimelineEntry[]): string {
  const thinkingCount = entries.filter(isThinkingEntry).length;
  const agentMessageCount = entries.reduce(
    (count, entry) => count + agentCommunicationCount(entry),
    0,
  );
  const itemCount = entries.filter((entry) => !isDirectFoldEntry(entry)).length;
  return [
    thinkingCount > 0 ? `${thinkingCount} thinking` : null,
    agentMessageCount > 0 ? `${agentMessageCount} agent messages` : null,
    itemCount > 0 ? `${itemCount} items` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" + ");
}

/** fold group 展開時の中身の区切り。thinking と agent 通信は直接見せ、
 * その間に挟まる tool 群 (tool_use/tool_result/meta/...) は「N items」の
 * サブ fold (既定閉) に畳む。返り値は表示順のまま: {kind:"items"}
 * (サブ fold 化する連続 run) と {kind:"direct"} (単独で直接表示) の列。 */
export type FoldSubgroup =
  | { kind: "items"; entries: TimelineEntry[] }
  | { kind: "direct"; entry: TimelineEntry };

/** Whether a fold group needs its outer, turn-level fold in addition to items
 * sub-folds. Thinking and agent communication are direct children of this
 * closed-by-default fold; an all-items run remains flat to avoid a redundant
 * `N items` outer fold containing only an `N items` sub-fold. */
export function foldGroupNeedsOuterFold(entries: TimelineEntry[]): boolean {
  return entries.some(isDirectFoldEntry);
}

export function splitFoldSubgroups(entries: TimelineEntry[]): FoldSubgroup[] {
  const out: FoldSubgroup[] = [];
  let run: TimelineEntry[] = [];
  const flush = () => {
    if (run.length > 0) {
      out.push({ kind: "items", entries: run });
      run = [];
    }
  };
  for (const e of entries) {
    if (isDirectFoldEntry(e)) {
      flush();
      out.push({ kind: "direct", entry: e });
    } else {
      run.push(e);
    }
  }
  flush();
  return out;
}

/**
 * Classification of a `type:"user"` jsonl entry's actual origin (webui
 * Timeline UI improvement, kawaz spec): Claude Code's harness injects
 * several kinds of system-generated content under the wire-protocol "user"
 * role (slash-command plumbing, Monitor/Task notifications, ccmsg
 * teammate-message relays, tool_result echoes, ...), which would otherwise
 * render identically to a real human utterance. See
 * `docs/findings/2026-07-1?-jsonl-user-message-patterns.md`-style research
 * (scratchpad `jsonl-user-message-patterns.md`, U2 delegation) for the full
 * sample-derived pattern catalog this mirrors — kept as one flat union
 * rather than a nested taxonomy so a genuinely new/unseen pattern degrades
 * to "unknown-meta"/"unknown-array" (both still rendered, not dropped)
 * instead of needing a new case to compile.
 */
export type UserMessageKind =
  | "user-prompt"
  | "tool-result"
  | "user-interrupt-marker"
  | "skill-invocation-preamble"
  | "system-caveat"
  | "slash-command-invocation"
  | "slash-command-stdout"
  | "tool-retry-hint"
  | "task-notification"
  | "peer-message"
  | "unknown-meta"
  | "unknown-array";

/** True if `content` contains at least one `{type:"tool_result"}` block —
 * shared by classifyUserMessage's array branch. */
function hasToolResultBlock(content: unknown[]): boolean {
  return content.some(
    (b) =>
      b !== null && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
  );
}

/** True for a `{type:"text"}` or `{type:"image"}` content block — the two
 * block kinds Claude Code emits for a real human utterance (a plain typed
 * message, and an image paste, which arrives as one or more `image` blocks
 * alongside an optional `text` block). Shared by classifyUserMessage's array
 * branch to recognize a real-utterance array shape without hardcoding the
 * two-block-exactly case. */
function isTextOrImageBlock(b: unknown): boolean {
  if (b === null || typeof b !== "object") return false;
  const t = (b as Record<string, unknown>).type;
  return t === "text" || t === "image";
}

/**
 * Classifies one raw jsonl `type:"user"` entry (the full top-level parsed
 * object, so both `isMeta` and `message.content` are visible) into a
 * `UserMessageKind`. Judged in this order, matching the research's
 * discriminating axes:
 *
 * 1. `promptSource === "system"` — authoritative system-origin metadata;
 *    known `origin.kind` values preserve task-notification/peer-message, and
 *    unknown kinds safely degrade to unknown-meta
 * 2. array `content` — tool_result echo, `[Request interrupted...]`
 *    marker, Skill-tool invocation preamble (isMeta + specific prefix), or a
 *    real human utterance with an image/file paste (array of only text/image
 *    blocks, no tool_result — Claude Code emits this shape for a pasted
 *    image, with or without a caption)
 * 3. string `content` with a peer-relay prefix — peer-message, regardless of
 *    whether Claude Code also sets `isMeta:true`
 * 4. `isMeta === true` — remaining Claude Code CLI/harness UI injection
 *    (slash command caveat/invocation/stdout, malformed-tool-call retry hint)
 * 5. `isMeta` not true, string `content` with another literal system-
 *    injection prefix — task-notification (Monitor/Workflow/subagent),
 *    delivered as an ordinary prompt (`promptId`-bearing)
 * 6. anything else — a real human utterance
 *
 * Known false-negative (documented in the research, not fixed here): a real
 * user who types text starting with one of the exact literal prefixes below
 * (`<task-notification>`, `Another Claude session sent a message:`) is
 * misclassified as the system kind — `isMeta` doesn't distinguish this case
 * from the wire. Accepted per the research's own limits section; not
 * observed in any sampled real transcript.
 */
export function classifyUserMessage(entry: Record<string, unknown>): UserMessageKind {
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const isMeta = entry.isMeta === true;

  if (entry.promptSource === "system") {
    const origin =
      entry.origin !== null && typeof entry.origin === "object" && !Array.isArray(entry.origin)
        ? (entry.origin as Record<string, unknown>)
        : null;
    if (origin?.kind === "task-notification") return "task-notification";
    if (origin?.kind === "peer") return "peer-message";
    return "unknown-meta";
  }

  if (Array.isArray(content)) {
    if (hasToolResultBlock(content)) return "tool-result";
    if (content.length === 1) {
      const block = content[0];
      if (
        block !== null &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text"
      ) {
        const text = (block as Record<string, unknown>).text;
        const t = typeof text === "string" ? text : "";
        if (t.startsWith("[Request interrupted by user")) return "user-interrupt-marker";
        if (isMeta && t.startsWith("Base directory for this skill:"))
          return "skill-invocation-preamble";
        // A lone text block matching none of the above stays the
        // conservative unknown-array fallback below — real plain-text
        // prompts arrive as a bare string `content`, not a single-element
        // array (see the "single text block ... unknown-array" tests), so
        // this shape has no confirmed real-utterance reading to fall back to.
        return "unknown-array";
      }
    }
    // A real human utterance carrying an image/file paste (with or without a
    // caption): Claude Code emits these as an array made up entirely of
    // text/image blocks, no tool_result. Any block type this module hasn't
    // seen (alone or mixed in) keeps the safe unknown-array fallback instead
    // — this module's forward-compat design (see the module doc comment).
    if (content.length > 0 && content.every(isTextOrImageBlock)) return "user-prompt";
    return "unknown-array";
  }

  const text = typeof content === "string" ? content : "";

  // A peer relay may carry isMeta:true while retaining the fixed peer banner.
  // The decisive peer wrapper must run before the generic isMeta catch.
  if (text.startsWith("Another Claude session sent a message:")) return "peer-message";
  if (text.startsWith("<agent-message") || text.startsWith("<teammate-message")) {
    return "peer-message";
  }

  if (isMeta) {
    if (text.startsWith("<local-command-caveat>")) return "system-caveat";
    if (text.startsWith("<command-name>")) return "slash-command-invocation";
    if (text.startsWith("<local-command-stdout>")) return "slash-command-stdout";
    if (text === "Your tool call was malformed and could not be parsed. Please retry.")
      return "tool-retry-hint";
    return "unknown-meta";
  }

  // slash command の invocation/stdout は isMeta 付きが通常形だが、isMeta
  // なしで届く transcript もある (kawaz r20、2026-07-15 実観測 — /reload-plugins
  // 等が緑のユーザ発話バブルで表示された)。タグ prefix は人間の発話が取り得
  // ない形なので、meta フラグに依らず同じ分類に落とす。
  if (text.startsWith("<command-name>") || text.startsWith("<command-message>")) {
    return "slash-command-invocation";
  }
  if (text.startsWith("<local-command-stdout>")) return "slash-command-stdout";

  if (text.startsWith("<task-notification>")) return "task-notification";
  // The harness prefixes background-task notifications with a fixed banner
  // line ("[SYSTEM NOTIFICATION - NOT USER INPUT]\n...") before the
  // <task-notification> block — a decisive injected-content marker no human
  // prompt starts with. Without this branch such lines fall through to
  // "user-prompt" and render as a (huge, green) user bubble instead of
  // folding (observed on this very session's transcript, 2026-07-12).
  if (text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]")) {
    return text.includes("<task-notification>") ? "task-notification" : "unknown-meta";
  }
  return "user-prompt";
}

/** One ccmsg room message recovered from inside a `teammate-message`/
 * `task-notification` system line (webui Timeline chat-bubble task, kawaz
 * spec) — a trimmed-down `MsgEvent` (`@ccmsg/protocol`): `room` is that
 * event's `r` field (room id), renamed here since this module has no
 * dependency on `@ccmsg/protocol`'s wire types and `extractCcmsgMessages`
 * only needs the fields the bubble UI renders. */
export interface CcmsgMessage {
  from: string;
  to?: string[];
  room: string;
  msg: string;
  ts: string;
  /** DR-0027 §2: canonical (room, mid) pair to look the daemon-stored full
   * message up with (webui's `ws.read(room, [mid])` — CcmsgBubble does this
   * lazily on mount). Present for every wire-format ccmsg extraction the
   * daemon actually emitted a mid for (subscribe teammate-message relay,
   * task-notification `<event>` body, tool_result `{ok:true,room,mid}` post/
   * reply response — even the truncated-fragment recovery when the fragment
   * still carries `"mid":N` before the truncation point). Absent only when
   * the fragment lost the mid to truncation before we could parse it — those
   * still render with the recovered body (救済 parse), just without the
   * canonical read-fallback path. */
  mid?: number;
}

/** Dedup key for a `CcmsgMessage` (kawaz r15 mid=21: the same room event can
 * be extracted twice from one transcript — a `queue-operation` enqueue line
 * and its `task-notification` Monitor tool_result echo both carry it,
 * DR-0027 §2.2 extends this to also cover the sender-side echo: an AI post/
 * reply's tool_result `{ok:true,room,mid}` response, and the same message
 * arriving back through the subscribe teammate-message relay, are the same
 * canonical `(room, mid)`). Shared by Timeline.tsx's bubble-list render and
 * its in-view search unit list so the two dedup identically — a message the
 * render side drops as a duplicate must never still count toward the search
 * "[N/M]" total (a ghost match with no bubble to highlight/scroll to).
 *
 * When `mid` is present the key is `${room}|m${mid}` — canonical per daemon
 * (rooms/*.jsonl mid is unique per room), so two extractions of the same
 * message from different transcript wrappers collapse regardless of whether
 * their transcript body copies still match verbatim (truncation, XML entity
 * escaping differences, DR-0027 §2 lazy-read replacement). Falls back to the
 * old `${room}|${ts}|${from}|${msg}` form for pre-DR-0027 extractions and
 * for fragments that lost their mid to truncation. */
export function ccmsgDedupKey(m: CcmsgMessage): string {
  if (m.mid !== undefined) return `${m.room}|m${m.mid}`;
  return `${m.room}|${m.ts}|${m.from}|${m.msg}`;
}

/** Matches Claude Code's Task-tool teammate relay wrapper (see
 * `classifyUserMessage`'s "Another Claude session sent a message:" prefix,
 * `peer-message` kind) — one tag per relayed teammate turn, body is normally
 * one JSON object. Global so a single line carrying several relays (observed
 * in practice: a session going idle twice in a row) yields one match per tag. */
const TEAMMATE_MESSAGE_RE = /<teammate-message[^>]*>([\s\S]*?)<\/teammate-message>/g;

/** Matches the `<event>...</event>` body Claude Code's Monitor-tool
 * `task-notification` wrapper carries (see `classifyUserMessage`'s
 * `task-notification` kind) — a ccmsg `subscribe` Monitor prints one JSON
 * event per stdout line, so this tag's body can itself be multi-line jsonl,
 * not a single JSON value like `teammate-message`'s. */
const EVENT_TAG_RE = /<event>([\s\S]*?)<\/event>/g;

/** Duck-types `obj` as a ccmsg `MsgEvent` delivered over `subscribe` (wire
 * shape: `{type:"msg", mid, from, to?, ts, msg|msg_via, r}` — `r` is the room
 * id DeliveredEvent flattening adds. `msg_via` is accepted only with a numeric
 * mid, producing a placeholder that the existing daemon read path hydrates.
 * False for any other event shape
 * this line might carry (`idle_notification`, `ev:"notify"`, member/leave/
 * title/... — anything whose `type`/`ev` isn't exactly `"msg"`), which is the
 * whole point: only a real room message becomes a chat bubble, everything
 * else stays inside the fold. */
function isCcmsgMsgEventLike(obj: unknown): obj is {
  type: "msg";
  mid?: number;
  from: string;
  to?: string[];
  r: string;
  msg?: string;
  msg_via?: string;
  ts: string;
} {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    o.type === "msg" &&
    typeof o.from === "string" &&
    typeof o.r === "string" &&
    (typeof o.msg === "string" || (typeof o.msg_via === "string" && typeof o.mid === "number")) &&
    typeof o.ts === "string" &&
    (o.to === undefined || (Array.isArray(o.to) && o.to.every((t) => typeof t === "string"))) &&
    // `mid` is now surfaced (DR-0027 §2 lazy-read key), still not required for
    // shape validity — pre-DR-0027 fixtures without mid must keep flowing
    // through (they degrade to no read-fallback, see CcmsgMessage.mid doc).
    (o.mid === undefined || typeof o.mid === "number")
  );
}

/** Parses one candidate fragment (a `teammate-message` tag body, or one line
 * of a `task-notification`'s `<event>` jsonl body) into a `CcmsgMessage`.
 * Returns null — never throws — for invalid JSON or a validly-parsed value
 * that isn't a ccmsg `type:"msg"` event (kawaz spec: "壊れた JSON は空で
 * fallback", and non-msg events like `idle_notification` must NOT become a
 * bubble). */
/** Reverses the XML entity escaping Claude Code's harness applies when it
 * wraps Monitor stdout into a `<task-notification><event>` block (kawaz r26
 * mid=30: a literal ">" in a room message showed as "&gt;" in Timeline).
 * The daemon's stored jsonl carries the raw text — the escaping exists only
 * inside the transcript copy — so unescaping here restores the original.
 * Only the five XML predefined entities are reversed (that's the harness's
 * escape set); &amp; last so "&amp;gt;" round-trips to "&gt;" correctly. */
function unescapeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tryParseCcmsgMessage(fragment: string, fallbackRoom?: string): CcmsgMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(fragment.trim());
  } catch {
    return tryParseTruncatedCcmsgMessage(fragment.trim(), fallbackRoom);
  }
  if (!isCcmsgMsgEventLike(obj)) return null;
  return {
    from: obj.from,
    to: obj.to,
    room: obj.r,
    msg: obj.msg !== undefined ? unescapeXmlEntities(obj.msg) : "",
    ts: obj.ts,
    ...(obj.mid !== undefined ? { mid: obj.mid } : {}),
  };
}

/** Monitor 通知の <event> は長い msg を「...(truncated)」で切り詰めることが
 * あり (harness 側の通知サイズ上限)、その行は JSON として壊れて上の parse が
 * 落ちる — 従来はそのまま null → CcmsgBubble にならず生 JSON の fold 表示に
 * なっていた (kawaz r17 mid=43 の実観測)。切れていても field 順は固定
 * (daemon の subscribe wire order:
 * `type,mid,from,ts,to?,r,seq,reply_via?,msg` — msg が必ず最後、
 * docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md) なので、msg の
 * 途中までを regex で抜けば「途中まで + 切り詰め注記」の bubble にできる。
 * 読める形が生 JSON より常に良い、が判断 (全文は webui の room 表示か read
 * で見られる)。
 *
 * room (`r`) は msg より前の field なので、truncation が msg 本文側で起きる
 * 限り通常は失われない — ただし単独 msg 通知で `r` 自体が何らかの理由で
 * 欠けた場合の保険として、呼び出し側 (extractCcmsgMessages) が同じ <event>
 * ブロック内の parse できた行から補完した `fallbackRoom` を渡す (subscribe
 * の 1 通知は room event のバッチで、実観測の形は kind/title/member 行が
 * 同居する)。それも無い単独 msg 通知では `?` を room 表示に使い、復元できた
 * 本文を bubble として保持する。 */
function tryParseTruncatedCcmsgMessage(
  fragment: string,
  fallbackRoom?: string,
): CcmsgMessage | null {
  if (!fragment.endsWith("(truncated)")) return null;
  if (!fragment.startsWith('{"type":"msg"')) return null;
  const from = fragment.match(/"from":"((?:[^"\\]|\\.)*)"/)?.[1];
  const ts = fragment.match(/"ts":"((?:[^"\\]|\\.)*)"/)?.[1];
  const knownRoom = fragment.match(/"r":"((?:[^"\\]|\\.)*)"/)?.[1] ?? fallbackRoom;
  const room = knownRoom ?? "?";
  // mid は subscribe wire order (docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md
  // 済) では msg より前 (`type,mid,from,ts,to?,r,seq,reply_via?,msg`) なので
  // truncation 前に必ず来る — 拾えれば DR-0027 §2 の read-fallback パスに乗る。
  // ただし canonical lookup key は (r, mid) の**組**: room が復元できなかった
  // fragment (`room === "?"`) に mid だけ付けると、`ws.read("?", [mid])` の
  // 無意味な発火と、別 room の同 mid truncated fragment との dedup 偽衝突
  // (`?|m99` が room を跨いで同キー化) を起こす。room 不明時は mid を捨てて
  // 救済 parse 本文だけの最終フォールバックに落とす (DR-0027 §2.1)。
  const midMatch = knownRoom !== undefined ? fragment.match(/"mid":(\d+)/)?.[1] : undefined;
  const mid = midMatch !== undefined ? Number(midMatch) : undefined;
  const msgMatch = fragment.match(/"msg":"((?:[^"\\]|\\.)*)/)?.[1];
  if (!from || !ts || msgMatch === undefined) return null;
  let msg: string;
  try {
    // 抜き出した半端な JSON string 断片を JSON.parse でデコード (escape 解決)。
    // 断片が escape の途中で切れていたら最後の \ を落として再試行。
    msg = JSON.parse(`"${msgMatch.replace(/\\$/, "")}"`) as string;
  } catch {
    return null;
  }
  return {
    from,
    room,
    msg: `${unescapeXmlEntities(msg)}…(切り詰め — 全文は room で)`,
    ts,
    ...(mid !== undefined ? { mid } : {}),
  };
}

/** DR-0027 §2.2: matches a ccmsg CLI `post`/`reply` success response as it
 * appears in a Bash tool_result content. The daemon returns
 * `{"ok":true,"room":"rN","mid":M}\n` for `post` and
 * `{"ok":true,"room":"rN","mid":M,"to":["a1","u1"]}\n` for `reply`
 * (server.ts's reply handler appends the computed delivery list — observed
 * shapes: post at bbc718cd line 184, reply per PostResponse/reply send in
 * packages/daemon/src/server.ts), and Claude Code's Bash tool wraps the
 * stdout verbatim as the tool_result's content. The optional `to` group
 * accepts exactly a JSON string array (quoted ids, no escapes — daemon ids
 * are `aN`/`uN` shaped) so the reply shape is captured without loosening
 * the tail anchor. Anchored with `\s*$` so a trailing newline is fine but
 * longer noise (a `2>&1`-piped error banner mixed with the JSON, help text
 * on argv misuse) doesn't false-match. Any other extra JSON key is rejected
 * (`\}\s*$`), so an unrelated daemon op that carries `ok:true,room,mid` but
 * adds different fields fails the match (design-priority: reject unknown
 * keys rather than assume they don't come). */
const CCMSG_POST_RESPONSE_RE =
  /^\s*\{"ok":true,"room":"([^"\\]+)","mid":(\d+)(?:,"to":\["[^"\\]*"(?:,"[^"\\]*")*\])?\}\s*$/;

/** DR-0027 §2.2 送信側: scans this user turn's `tool-result` segments for a
 * ccmsg `post`/`reply` success response, and returns one placeholder
 * `CcmsgMessage` per match with just `(room, mid)` populated (from/to/msg
 * empty, ts filled from the line — CcmsgBubble does a lazy `ws.read(room,
 * [mid])` and replaces the placeholder body with the daemon-canonical
 * message on resolve, DR-0027 §2). A tool_result whose content isn't
 * exactly the response JSON — anything with pre/postfix noise from `2>&1`,
 * a `{"ok":false,...}` error response, or an unrelated Bash output — falls
 * through unmatched and stays in the normal fold path. Non-turn / non-user
 * lines and turns with no tool_result segments return `[]`.
 *
 * The line's `ts` (transcript timestamp, when the tool_result was written)
 * is used as the placeholder ts so the bubble sorts / date-groups correctly
 * before the read resolves — the real send ts (daemon's authoritative one)
 * overwrites it once the lazy read comes back. Absent line.ts (test
 * fixtures with `ts: null`) degrades to an empty string, same convention
 * as the wrapper-parse path (`tryParseCcmsgMessage` requires `ts`, but the
 * tool_result path can't require one — the daemon knows, we don't yet).
 */
export function extractCcmsgToolResultRefs(line: ParsedLine): CcmsgMessage[] {
  if (line.kind !== "turn" || line.role !== "user") return [];
  const out: CcmsgMessage[] = [];
  for (const seg of line.segments) {
    if (seg.kind !== "tool-result") continue;
    if (seg.isError) continue;
    const m = seg.text.match(CCMSG_POST_RESPONSE_RE);
    if (!m) continue;
    out.push({
      from: "",
      room: m[1]!,
      msg: "",
      ts: line.ts ?? "",
      mid: Number(m[2]!),
    });
  }
  return out;
}

/**
 * Recovers every ccmsg room message (`type:"msg"` events) embedded in a
 * `role:"user"` line's text, regardless of which system-injection wrapper
 * carries it — a `teammate-message` relay (Task-tool teammate turn) or a
 * `task-notification`'s `<event>` body (a ccmsg `subscribe` Monitor's stdout,
 * which is itself jsonl and can hold several events per notification). Both
 * patterns are scanned unconditionally rather than gating on
 * `classifyUserMessage`'s verdict first: a tag that doesn't match either
 * regex contributes nothing, so the result is the same either way, and this
 * keeps the function self-contained (works on a hand-built `ParsedLine` too,
 * not only ones that went through `parseTranscriptLine`/`classifyUserMessage`).
 *
 * Non-turn lines, assistant turns, and any fragment that isn't a `type:"msg"`
 * event (an `idle_notification` teammate-message body, a `task-notification`
 * `<event>` with no ccmsg activity at all, ...) all yield `[]` — the caller
 * (Timeline.tsx's chat-bubble rendering, and `isBoundaryLine` above) treats
 * an empty result as "render this line the ordinary way", not as an error.
 *
 * Known false-negative (accepted, not fixed here — same category as
 * `classifyUserMessage`'s documented false-negative above): `TEAMMATE_MESSAGE_RE`/
 * `EVENT_TAG_RE` are non-greedy, so if a `msg` field's *value* itself contains
 * the literal closing-tag text (e.g. someone pastes `</event>` into a ccmsg
 * message), the regex closes early at that literal occurrence instead of the
 * wrapper's real closing tag. The truncated fragment fails `JSON.parse`
 * (`tryParseCcmsgMessage` returns `null`, never throws), so that one message
 * silently falls back to the ordinary fold-line rendering instead of becoming
 * a chat bubble — degrades safely, doesn't crash or corrupt other messages in
 * the same line. No JSON-escaping trick can hide the literal (the value is
 * substring-matched against the raw wrapper text, not the JSON-decoded
 * string), so fixing this for real would need tag-aware scanning (e.g.
 * last-closing-tag-wins) rather than a regex tweak.
 */
export function extractCcmsgMessages(line: ParsedLine): CcmsgMessage[] {
  if (line.kind !== "turn" || line.role !== "user") return [];
  // DR-0027 §2.2 送信側: assistant が Bash 経由で叩いた `ccmsg post` /
  // `ccmsg reply` の response (tool_result の content が `{"ok":true,"room":
  // "rN","mid":M}` の JSON) を検出して placeholder CcmsgMessage にする。
  // 実本文は CcmsgBubble が (room, mid) で lazy read するので from/to/msg は
  // 空のまま (ts は line.ts で補完)。tool_result は同 turn 内に複数並ぶことが
  // あり (Anthropic API のバッチ)、非 ccmsg のものは pattern に合致せずスキップ。
  const fromToolResults = extractCcmsgToolResultRefs(line);
  const text = line.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
  if (!text) return fromToolResults;
  // 早期 return: どちらのタグも含まない (大半の user 行、システム注入行は
  // 本文が巨大になりがち) なら matchAll を 2 本走らせるまでもない — join
  // コスト自体は避けられないが、この関数は classifyBoundaryLine 経由で
  // groups が変わるたび (load older / tail 追記 / refresh, Timeline.tsx)
  // に呼ばれるので、軽いほど再分類コストが下がる。
  if (!text.includes("<teammate-message") && !text.includes("<event>")) return fromToolResults;
  const results: CcmsgMessage[] = [...fromToolResults];
  for (const m of text.matchAll(TEAMMATE_MESSAGE_RE)) {
    const parsed = tryParseCcmsgMessage(m[1]!);
    if (parsed) results.push(parsed);
  }
  for (const m of text.matchAll(EVENT_TAG_RE)) {
    // truncated 行の room 補完用: 同じ <event> ブロック内で parse できた
    // event の r (subscribe の 1 通知は同一 room のバッチが普通)。
    let blockRoom: string | undefined;
    for (const eventLine of m[1]!.split("\n")) {
      const trimmed = eventLine.trim();
      if (!trimmed) continue;
      try {
        const o = JSON.parse(trimmed) as { r?: unknown };
        if (typeof o.r === "string") blockRoom = o.r;
      } catch {
        // truncated 等の壊れ行 — blockRoom はそのまま
      }
      const parsed = tryParseCcmsgMessage(trimmed, blockRoom);
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

// --- rich|raw タブの rich 側パース (U2 kawaz spec: 「分類済みシステム
// メッセージの details 展開時の本文に rich | raw のタブ切替を追加、ccmsg
// 吹き出しの msg/raw タブと同じ UI 流儀」) ---
//
// 対象は Timeline.tsx の LineView が `sysKind` (= role:"user" かつ
// userMessageKind !== "user-prompt") と判定した全 fold — task-notification /
// peer-message / slash-command-invocation / slash-command-stdout / それ以外
// すべて。「壊れた入力は raw fallback」(throw しない) という要件を満たすため、
// 認識できないタグ形状は常に `{display:"text", text: rawText}` に degrade する
// — raw タブ (LineView が今までどおり描画する segments) と同じ生テキストを
// 保持するので、rich タブが空振りしても情報は失われない。

/** One name/value pair recovered from an XML-ish `<tag>...</tag>` child (or
 * an opening tag's attribute) inside a system-origin line's raw text. `value`
 * is trimmed but otherwise untouched — JSON pretty-printing (peer-message's
 * body) happens at the call site, not here, since only some fields are JSON. */
export interface SystemMessageField {
  name: string;
  value: string;
}

/** Rich-display shape `parseSystemMessageFields` returns — `SystemMessageBody`
 * (Timeline.tsx) renders one of these three layouts. `"text"` is also the
 * universal fallback for a kind with no dedicated layout (system-caveat,
 * tool-retry-hint, user-interrupt-marker, unknown-meta, unknown-array,
 * skill-invocation-preamble, tool-result, and any unmatched/malformed input)
 * — kawaz spec bullet 5: 「定型文はそのまま <pre> (rich と raw が同じでも
 * タブは出して構造統一)」. */
export type PeerMessageCategory = "message" | "idle" | "task-assignment" | "lifecycle" | "unknown";

export type SystemMessageRich =
  | { display: "fields"; heading: string | null; fields: SystemMessageField[] }
  | { display: "chip"; label: string; detail: string | null }
  | {
      display: "peer";
      from: string;
      summary: string | null;
      category: PeerMessageCategory;
      body: string;
    }
  | { display: "text"; text: string };

/** Matches a top-level (non-nested) `<tag>...</tag>` pair — the backreference
 * `\1` ties the close tag to the same name as the open tag it matched, so
 * this only needs one pass regardless of which tag names actually appear
 * (task-id/summary/event/output-file/... for task-notification,
 * command-name/command-message/command-args/... for
 * slash-command-invocation — no whitelist, matching this module's existing
 * "no hardcoded whitelist of known fields" design, see the module doc
 * comment). Doesn't handle same-name tags nested inside each other (not
 * observed in any sampled pattern), and a tag's own content containing the
 * literal closing-tag text truncates the match early — same accepted
 * false-negative shape as `TEAMMATE_MESSAGE_RE`/`EVENT_TAG_RE` above,
 * degrading to a missing field rather than a throw. */
const XML_CHILD_TAG_RE = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;

function extractXmlFields(text: string): SystemMessageField[] {
  const fields: SystemMessageField[] = [];
  for (const m of text.matchAll(XML_CHILD_TAG_RE)) {
    fields.push({ name: m[1]!, value: m[2]!.trim() });
  }
  return fields;
}

/** Strips one specific outer `<tagName>...</tagName>` wrapper (e.g.
 * `<task-notification>`, whose banner-prefixed variant per
 * `classifyUserMessage`'s doc comment still contains this tag somewhere, not
 * necessarily at index 0 — hence a search, not an anchored match) and returns
 * only its inner content, so a follow-up `extractXmlFields` call sees the
 * *children* (task-id/summary/event/...) as top-level matches instead of the
 * whole wrapper consuming itself as one match. Returns null (not `text`
 * itself) when the wrapper isn't found, so callers can tell "unwrapped" from
 * "wrapper missing" apart rather than silently scanning the un-unwrapped text
 * for children that were never there. */
function unwrapOuterTag(text: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`);
  const m = text.match(re);
  return m ? m[1]! : null;
}

/** Matches the first `<teammate-message>` or `<agent-message>` relay and captures
 * its tag name, opening-tag attributes, and body. A line can contain several
 * relays; rich mode shows the first while the raw tab preserves the full line. */
const PEER_MESSAGE_ATTRS_RE = /<(teammate-message|agent-message)([^>]*)>([\s\S]*?)<\/\1>/;

const XML_ATTR_RE = /([\w-]+)="([^"]*)"/g;

function parseXmlAttrs(attrString: string): SystemMessageField[] {
  const fields: SystemMessageField[] = [];
  for (const m of attrString.matchAll(XML_ATTR_RE)) {
    fields.push({ name: m[1]!, value: m[2]! });
  }
  return fields;
}

// ANSI CSI escape sequences (color codes, cursor movement, DEC private modes
// like cursor hide/show, ...) — a `<local-command-stdout>` body can carry these
// verbatim when the local command's own stdout was terminal-color-coded (kawaz
// spec: 「ANSI エスケープ除去」). Matches the full ECMA-48 CSI shape: `ESC [`,
// then parameter bytes 0x30-0x3F (digits/`;`/`?`/`<`/`=`/`>` — `?` covers the
// DEC private mode prefix spinner-style CLIs use for `\x1b[?25l`/`\x1b[?25h`
// cursor hide/show), then intermediate bytes 0x20-0x2F, then a final byte
// 0x40-0x7E. Doesn't attempt to handle every ECMA-48 escape family (OSC/DCS),
// which this harness's local commands haven't been observed to emit.
// oxlint-disable-next-line no-control-regex -- ESC は ANSI CSI の定義そのもので意図的
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Strips ANSI CSI escape sequences from `text` — exported since it's a
 * generically useful primitive, not only used by `parseSystemMessageFields`. */
export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_CSI_RE, "");
}

function parsePeerMessage(rawText: string): Extract<SystemMessageRich, { display: "peer" }> | null {
  const match = rawText.match(PEER_MESSAGE_ATTRS_RE);
  if (!match) return null;
  const attrs = Object.fromEntries(
    parseXmlAttrs(match[2]!).map((field) => [field.name, field.value]),
  );
  const from = attrs.from || attrs.teammate_id || "agent";
  const summary = attrs.summary || null;
  const rawBody = match[3]!.trim();
  let category: PeerMessageCategory = "message";
  let body = rawBody;
  try {
    const value = JSON.parse(rawBody) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const type = typeof obj.type === "string" ? obj.type : "";
      if (type === "idle_notification") {
        category = "idle";
        const reason = typeof obj.idleReason === "string" ? obj.idleReason : "idle";
        body = `待機通知 · ${reason}`;
      } else if (type === "task_assignment") {
        category = "task-assignment";
        const subject = typeof obj.subject === "string" ? obj.subject : "タスク割り当て";
        const description = typeof obj.description === "string" ? obj.description : "";
        body = description ? `${subject}\n${description}` : subject;
      } else if (
        type === "shutdown_request" ||
        type === "shutdown_approved" ||
        type === "teammate_terminated"
      ) {
        category = "lifecycle";
        body = [
          type,
          typeof obj.reason === "string" ? obj.reason : "",
          typeof obj.message === "string" ? obj.message : "",
        ]
          .filter(Boolean)
          .join(" · ");
      } else {
        category = "unknown";
        body = JSON.stringify(value, null, 2);
      }
    } else {
      category = "unknown";
      body = JSON.stringify(value, null, 2);
    }
  } catch {
    // Plain relayed reports and instructions are already readable as-is.
  }
  return { display: "peer", from, summary, category, body };
}

/**
 * Rich-display parsing for a `sysKind` fold's "rich" tab (U2 kawaz spec:
 * task-notification / teammate-message / system-caveat / slash-command-
 * invocation / slash-command-stdout / skill-invocation-preamble 等の details
 * 展開時の本文に rich | raw のタブ切替、デフォルト rich). Given the line's
 * `userMessageKind` (Timeline.tsx's `sysKind` — any classified kind other
 * than `"user-prompt"`) and the line's raw text (joined text segments, same
 * input `extractCcmsgMessages` reads), returns one of the three
 * `SystemMessageRich` shapes. Never throws — any tag this doesn't recognize,
 * or a kind with no dedicated layout, degrades to `{display:"text", text:
 * rawText}` (see the module-level comment above this section).
 *
 * Delegation-note mismatch (reported per policy, not silently resolved): the
 * U2 spec names one target kind "teammate-message", but this module's
 * `UserMessageKind` union (`classifyUserMessage`) has no such value — the
 * kind that actually carries a `<teammate-message>`-wrapped body is
 * `"peer-message"` (Claude Code's Task-tool relay, "Another Claude session
 * sent a message:" prefix, see `classifyUserMessage`'s doc comment). This
 * function's `"peer-message"` case is what the spec's "teammate-message"
 * bullet describes; `type:"msg"` ccmsg events inside it never reach here at
 * all — `classifyBoundaryLine` promotes those lines to a standalone `"ccmsg"`
 * boundary (`CcmsgBubble`) before Timeline.tsx's fold path ever runs, so the
 * peer-message case here only ever sees the non-ccmsg bodies (idle
 * notifications, plain relayed text, ...).
 */
export function parseSystemMessageFields(
  kind: UserMessageKind | undefined,
  rawText: string,
): SystemMessageRich {
  switch (kind) {
    case "task-notification": {
      const inner = unwrapOuterTag(rawText, "task-notification") ?? rawText;
      const fields = extractXmlFields(inner);
      const summary = fields.find((f) => f.name === "summary")?.value ?? null;
      return {
        display: "fields",
        heading: summary,
        fields: fields.filter((f) => f.name !== "summary"),
      };
    }
    case "peer-message":
      return parsePeerMessage(rawText) ?? { display: "text", text: rawText };
    case "slash-command-invocation": {
      const fields = extractXmlFields(rawText);
      const command = fields.find((f) => f.name === "command-name")?.value ?? null;
      if (command === null) return { display: "text", text: rawText };
      const detail =
        fields.find((f) => f.name === "command-args")?.value ??
        fields.find((f) => f.name === "command-message")?.value ??
        null;
      return { display: "chip", label: command, detail };
    }
    case "slash-command-stdout": {
      const inner = unwrapOuterTag(rawText, "local-command-stdout") ?? rawText;
      return { display: "text", text: stripAnsiEscapes(inner) };
    }
    default:
      return { display: "text", text: rawText };
  }
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
    const segments = message ? parseSegments(message.content, role, o.toolUseResult) : [];
    const userMessageKind = role === "user" ? classifyUserMessage(o) : undefined;
    return { kind: "turn", ts, role, segments, userMessageKind };
  }
  // queue-operation enqueue は「作業中に user が送ったメッセージが queue に
  // 積まれた記録」で、`content` field が queue に積まれた prompt 文字列。
  // 通常の type:user 行と同じ classifier を必ず通すことで、peer relay / task
  // notification / slash command 等の prefix catalog が二重実装で drift せず、
  // system wrapper も user-prompt と同じ turn shape のまま正しく fold される。
  if (o.type === "queue-operation" && o.operation === "enqueue" && typeof o.content === "string") {
    const content = o.content;
    const userMessageKind = classifyUserMessage({
      type: "user",
      message: { role: "user", content },
    });
    return {
      kind: "turn",
      ts,
      role: "user",
      segments: [{ kind: "text", role: "user", text: content }],
      userMessageKind,
    };
  }
  return {
    kind: "meta",
    ts,
    type: typeof o.type === "string" ? o.type : "?",
    summary: summarizeMeta(o),
    raw,
  };
}
