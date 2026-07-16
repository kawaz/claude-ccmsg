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
export function isUserTextTurn(line: ParsedLine): boolean {
  if (line.kind !== "turn" || line.role !== "user") return false;
  if (line.userMessageKind !== undefined && line.userMessageKind !== "user-prompt") return false;
  if (line.userMessageKind === "user-prompt") return line.segments.length > 0;
  return line.segments.some((s) => s.kind === "text");
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
 * exclusively thinking blocks — split out of the generic "items" count so
 * `foldGroupLabel` can report "N thinkings + M items" (webui Timeline display
 * unification task, kawaz spec) instead of lumping thinking in with
 * tool_use/tool_result/meta/broken under one undifferentiated count.
 * 「thinking を含む」判定 (only ではない) なのは kawaz r17 mid=49: thinking
 * と tool_use が同一 turn 行に混在するケースがサブ fold 側に沈み、fold group
 * 直下に出るべき thinking が 1 段深く表示されていたため。 */
export function isThinkingEntry(entry: TimelineEntry): boolean {
  const { line } = entry;
  return line.kind === "turn" && line.segments.some((s) => s.kind === "thinking");
}

/** Folded-group summary label (kawaz spec, revised for the display
 * unification task): "N thinkings + M items" when the group mixes both,
 * "N thinkings" when every entry is thinking-only, otherwise "M items" — the
 * previous "N tools"/"N items" wording is retired since thinking is now
 * counted out on its own rather than lumped into one undifferentiated noun. */
export function foldGroupLabel(entries: TimelineEntry[]): string {
  const thinkingCount = entries.filter(isThinkingEntry).length;
  const itemCount = entries.length - thinkingCount;
  if (thinkingCount === 0) return `${itemCount} items`;
  if (itemCount === 0) return `${thinkingCount} thinkings`;
  return `${thinkingCount} thinkings + ${itemCount} items`;
}

/** fold group 展開時の中身の区切り (kawaz r17 mid=45、2026-07-15):
 * thinking は「作業の節目の語り」なので開いたら直接見せ、thinking と
 * thinking の間に挟まる tool 群 (tool_use/tool_result/meta/...) は
 * 「N items」のサブ fold (既定閉) に畳む — 従来はツール行の羅列の中に
 * thinking が埋もれ、展開直後に目で節目を探す必要があった。
 * 返り値は表示順のまま: {kind:"items"} (サブ fold 化する連続 run) と
 * {kind:"thinking"} (単独で直接表示) の交互列。 */
export type FoldSubgroup =
  | { kind: "items"; entries: TimelineEntry[] }
  | { kind: "thinking"; entry: TimelineEntry };

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
    if (isThinkingEntry(e)) {
      flush();
      out.push({ kind: "thinking", entry: e });
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
 * 1. array `content` — tool_result echo, `[Request interrupted...]`
 *    marker, Skill-tool invocation preamble (isMeta + specific prefix), or a
 *    real human utterance with an image/file paste (array of only text/image
 *    blocks, no tool_result — Claude Code emits this shape for a pasted
 *    image, with or without a caption)
 * 2. string `content` with a peer-relay prefix — peer-message, regardless of
 *    whether Claude Code also sets `isMeta:true`
 * 3. `isMeta === true` — remaining Claude Code CLI/harness UI injection
 *    (slash command caveat/invocation/stdout, malformed-tool-call retry hint)
 * 4. `isMeta` not true, string `content` with another literal system-
 *    injection prefix — task-notification (Monitor/Workflow/subagent),
 *    delivered as an ordinary prompt (`promptId`-bearing)
 * 5. anything else — a real human utterance
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
 * shape: `{type:"msg", mid, from, to?, ts, msg, r}` — `r` is the room id
 * DeliveredEvent flattening adds, `@ccmsg/protocol`). Every field this module
 * renders is checked; `mid` isn't (not used downstream) so its absence alone
 * doesn't reject an otherwise-valid message. False for any other event shape
 * this line might carry (`idle_notification`, `ev:"notify"`, member/leave/
 * title/... — anything whose `type`/`ev` isn't exactly `"msg"`), which is the
 * whole point: only a real room message becomes a chat bubble, everything
 * else stays inside the fold. */
function isCcmsgMsgEventLike(
  obj: unknown,
): obj is { type: "msg"; from: string; to?: string[]; r: string; msg: string; ts: string } {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    o.type === "msg" &&
    typeof o.from === "string" &&
    typeof o.r === "string" &&
    typeof o.msg === "string" &&
    typeof o.ts === "string" &&
    (o.to === undefined || (Array.isArray(o.to) && o.to.every((t) => typeof t === "string")))
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
  return { from: obj.from, to: obj.to, room: obj.r, msg: unescapeXmlEntities(obj.msg), ts: obj.ts };
}

/** Monitor 通知の <event> は長い msg を「...(truncated)」で切り詰めることが
 * あり (harness 側の通知サイズ上限)、その行は JSON として壊れて上の parse が
 * 落ちる — 従来はそのまま null → CcmsgBubble にならず生 JSON の fold 表示に
 * なっていた (kawaz r17 mid=43 の実観測)。切れていても field 順は固定
 * (type,mid,from,ts,msg,... — daemon の JSON.stringify 順) なので、msg の
 * 途中までを regex で抜けば「途中まで + 切り詰め注記」の bubble にできる。
 * 読める形が生 JSON より常に良い、が判断 (全文は webui の room 表示か read
 * で見られる)。
 *
 * room (`r`) は wire 上 msg より後ろの field なので truncation でほぼ必ず
 * 失われる — 呼び出し側 (extractCcmsgMessages) が同じ <event> ブロック内の
 * parse できた行から補完した `fallbackRoom` を渡す (subscribe の 1 通知は
 * room event のバッチで、実観測の形は kind/title/member 行が同居する)。
 * 補完も無ければ bubble は諦める (dedup key とアンカーに room が必須)。 */
function tryParseTruncatedCcmsgMessage(
  fragment: string,
  fallbackRoom?: string,
): CcmsgMessage | null {
  if (!fragment.endsWith("(truncated)")) return null;
  if (!fragment.startsWith('{"type":"msg"')) return null;
  const from = fragment.match(/"from":"((?:[^"\\]|\\.)*)"/)?.[1];
  const ts = fragment.match(/"ts":"((?:[^"\\]|\\.)*)"/)?.[1];
  const room = fragment.match(/"r":"((?:[^"\\]|\\.)*)"/)?.[1] ?? fallbackRoom;
  const msgMatch = fragment.match(/"msg":"((?:[^"\\]|\\.)*)/)?.[1];
  if (!from || !ts || !room || msgMatch === undefined) return null;
  let msg: string;
  try {
    // 抜き出した半端な JSON string 断片を JSON.parse でデコード (escape 解決)。
    // 断片が escape の途中で切れていたら最後の \ を落として再試行。
    msg = JSON.parse(`"${msgMatch.replace(/\\$/, "")}"`) as string;
  } catch {
    return null;
  }
  return { from, room, msg: `${unescapeXmlEntities(msg)}…(切り詰め — 全文は room で)`, ts };
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
  const text = line.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
  if (!text) return [];
  // 早期 return: どちらのタグも含まない (大半の user 行、システム注入行は
  // 本文が巨大になりがち) なら matchAll を 2 本走らせるまでもない — join
  // コスト自体は避けられないが、この関数は classifyBoundaryLine 経由で
  // groups が変わるたび (load older / tail 追記 / refresh, Timeline.tsx)
  // に呼ばれるので、軽いほど再分類コストが下がる。
  if (!text.includes("<teammate-message") && !text.includes("<event>")) return [];
  const results: CcmsgMessage[] = [];
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
export type SystemMessageRich =
  | { display: "fields"; heading: string | null; fields: SystemMessageField[] }
  | { display: "chip"; label: string; detail: string | null }
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

/** Matches Claude Code's `<teammate-message teammate_id="..." color="...">`
 * wrapper (see `TEAMMATE_MESSAGE_RE` above) but — unlike that regex — also
 * captures the opening tag's attribute string (group 1) alongside the body
 * (group 2), since the rich "peer-message" display needs both. Not `g`: only
 * the first relay in a line is shown in rich mode (a line carrying several
 * relays is a rare "idle twice in a row" case per `TEAMMATE_MESSAGE_RE`'s doc
 * comment, and the raw tab still shows the full text for that case). */
const TEAMMATE_MESSAGE_ATTRS_RE = /<teammate-message([^>]*)>([\s\S]*?)<\/teammate-message>/;

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

/** JSON.parse + pretty-print `text` if it parses, otherwise returns `text`
 * unchanged (never throws) — shared by any rich-display case whose body may
 * or may not be JSON (currently just peer-message's body, kawaz spec: 「ボディ
 * が JSON なら pretty-print」). */
function prettyJsonOrRaw(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
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
    case "peer-message": {
      const m = rawText.match(TEAMMATE_MESSAGE_ATTRS_RE);
      if (!m) return { display: "text", text: rawText };
      const attrs = parseXmlAttrs(m[1]!);
      const body = prettyJsonOrRaw(m[2]!.trim());
      return {
        display: "fields",
        heading: null,
        fields: [...attrs, { name: "body", value: body }],
      };
    }
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
    const segments = message ? parseSegments(message.content, role) : [];
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
