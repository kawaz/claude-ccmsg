// How a `type:"user"` transcript row is classified by where it came from
// (a person's prompt, a harness injection, a relay, ...): one rule the webui's
// Timeline draws by and the daemon tells a person's prompt by (DR-0062 §11,
// the delivered check of a comment sent), so the two never disagree on which
// rows are the person's.
import { AGENT_APPEND_MARK } from "./sidecar.ts";
import { isKnownContentBlock, type ContentBlock } from "./transcript-content.ts";
import type { UserRow } from "./transcript-row.ts";

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
  /** A slash command the user submitted with arguments — `/clear <次タスクの
   * 本文>` のような形 (kawaz r244m18)。コマンド行の体裁は harness の配管だが、
   * `<command-args>` の中身はユーザが書いた文章そのものなので、fold に沈める
   * 配管ではなく本物のユーザ発話として扱う (引数なしの裸コマンドは
   * `slash-command-invocation` のまま — セッションを動かすだけで何も喋って
   * いない)。daemon 側 prompt 判定 (packages/daemon/src/session-user-input.ts
   * の classifyUserInputRow) と同じ「非空 command-args」規則。 */
  | "slash-command-prompt"
  | "slash-command-stdout"
  | "bash-command-invocation"
  | "bash-command-stdout"
  | "tool-retry-hint"
  /** The summary a compaction left in place of the earlier conversation
   * (`isCompactSummary`): Claude Code's text in a `type:"user"` row. */
  | "compact-summary"
  | "task-notification"
  | "workflow-resume"
  | "peer-message"
  | "cross-session-notice"
  | "spawn-prompt"
  | "unknown-meta"
  | "unknown-array";

/** True for a `{type:"tool_result"}` block — shared by classifyUserMessage's
 * array branch. */
function isToolResultBlock(block: ContentBlock): boolean {
  return isKnownContentBlock(block) && block.type === "tool_result";
}

/** True for a `{type:"text"}` or `{type:"image"}` content block — the two
 * block kinds Claude Code emits for a real human utterance (a plain typed
 * message, and an image paste, which arrives as one or more `image` blocks
 * alongside an optional `text` block). Shared by classifyUserMessage's array
 * branch to recognize a real-utterance array shape without hardcoding the
 * two-block-exactly case. */
function isTextOrImageBlock(block: ContentBlock): boolean {
  return isKnownContentBlock(block) && (block.type === "text" || block.type === "image");
}

/** `<command-name>` と、中身が空でない `<command-args>` を持つ user 行から、
 * コマンド名と引数本文を取り出す (どちらか欠けていれば null = 引数なしの裸
 * コマンド、または slash command ですらない行)。
 *
 * 引数本文に `<` が含まれていても拾えるよう非貪欲マッチで書いてある
 * (コード片や XML を /clear に渡す形が普通にあるため)。daemon 側の同じ規則は
 * packages/daemon/src/session-user-input.ts の hasNonEmptyCommandArgs — TL の
 * 表示と prompt 件数の判定がずれないよう、両者は同じ「非空 command-args」で
 * 揃える (パッケージ境界を跨ぐ共有ではなく、相互参照で同期を保つ)。 */
const COMMAND_NAME_TAG_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_TAG_RE = /<command-args>([\s\S]*?)<\/command-args>/;

export function parseSlashCommandPrompt(text: string): { command: string; args: string } | null {
  const name = text.match(COMMAND_NAME_TAG_RE)?.[1]?.trim();
  if (!name) return null;
  const args = text.match(COMMAND_ARGS_TAG_RE)?.[1]?.trim();
  if (!args) return null;
  return { command: name, args };
}

/** What a person wrote to a subagent through ccmsg, when `row` is the row the
 * module's `agent.append` added to the subagent's conversation (DR-0039 §6),
 * else null.
 *
 * The person's text goes in with `$.session.append`, which Claude Code keeps
 * in the subagent's transcript as an `isMeta` user row of the plugin's origin
 * (`origin.kind: "plugin"`, `name` the plugin's as installed) holding one
 * text block. The same row shape carries ccmsg's own guidance and other
 * plugins' injections, so what makes it the person's is the mark line the
 * module puts above the text (`AGENT_APPEND_MARK`). The mark is for the model
 * (a word from outside its task), not something the person wrote, so the
 * text returned is what follows it. */
export function agentAppendedText(row: UserRow): string | null {
  if (row.isMeta !== true || row.origin?.kind !== "plugin") return null;
  const content = row.message.content;
  if (typeof content === "string" || content.length !== 1) return null;
  const [block] = content;
  if (block === undefined || !isKnownContentBlock(block) || block.type !== "text") return null;
  const head = `${AGENT_APPEND_MARK}\n`;
  return block.text.startsWith(head) ? block.text.slice(head.length) : null;
}

/** Relay tag names, in the shape `classifyUserMessage`'s bare-prefix check and
 * `queuePairingKey`'s tail search need them. */
export const PEER_MESSAGE_TAGS = [
  "teammate-message",
  "agent-message",
  "cross-session-message",
] as const;

/** Harness notices about a cross-session subscription, delivered as their own
 * injected user turn rather than inside a relay tag. The observed wording is
 * `[Cross-session idle notice] "<name>", which you asked to be notified
 * about, is idle now — ...`; the bracket label is matched by its
 * `[Cross-session …]` shape instead of the one exact phrase so a sibling
 * notice of the same family (a subscription that expired before the peer went
 * idle) lands in the same compact row instead of falling back to a raw
 * unknown-meta fold. */
export const CROSS_SESSION_NOTICE_RE = /^\[Cross-session [^\]]*\]/;

/**
 * Classifies one `type:"user"` row (the whole row, so both `isMeta` and
 * `message.content` are visible) into a `UserMessageKind`. Judged in this
 * order, matching the research's discriminating axes:
 *
 * 1. `promptSource === "system"` — authoritative system-origin metadata;
 *    known `origin.kind` values preserve task-notification/peer-message, and
 *    unknown kinds safely degrade to unknown-meta
 * 2. a person's message to a subagent through ccmsg (`agentAppendedText`) —
 *    user-prompt
 * 3. array `content` — tool_result echo, `[Request interrupted...]`
 *    marker, Skill-tool invocation preamble (isMeta + specific prefix), or a
 *    real human utterance with an image/file paste (array of only text/image
 *    blocks, no tool_result — Claude Code emits this shape for a pasted
 *    image, with or without a caption)
 * 4. string `content`: `classifyUserText`
 *
 * Known false-negative (documented in the research, not fixed here): a real
 * user who types text starting with one of the exact literal prefixes below
 * (`<task-notification>`, `Another Claude session sent a message:`) is
 * misclassified as the system kind — `isMeta` doesn't distinguish this case
 * from the wire. Accepted per the research's own limits section; not
 * observed in any sampled real transcript.
 */
export function classifyUserMessage(row: UserRow): UserMessageKind {
  const content = row.message.content;
  const isMeta = row.isMeta === true;

  // Agent (subagent) transcript の先頭 user 行 = Agent tool の spawn prompt
  // (親セッションから渡された指示書)。wire signal は `isSidechain: true` と
  // `parentUuid: null` の組。`isSidechain` は subagent 転写の全行で true、通常
  // セッションの全行で false (agentId を持つのも subagent 転写の行だけ)。
  // `parentUuid: null` だけでは足りない: 通常セッションの最初の user 行 (人の
  // prompt も sdk 経由の prompt も) も `parentUuid: null` で書かれることがある。
  // string 直接値 + プレフィックスマッチではなく wire フィールドで判定して、
  // 「plain text spawn」「<teammate-message> wrapper 付き spawn」の両ケースを
  // 同一 kind に落とす (peer-message 経路は「会話中に届いた relay」用として
  // 温存)。
  if (row.isSidechain && row.parentUuid === null) return "spawn-prompt";

  // The wire field decides, not the summary's opening sentence: the text is
  // Claude Code's and may be reworded, the flag is what marks the row.
  if (row.isCompactSummary === true) return "compact-summary";

  if (row.promptSource === "system") {
    if (row.origin?.kind === "task-notification") return "task-notification";
    if (row.origin?.kind === "peer") return "peer-message";
    // A cross-session notice is injected by this session's own harness (the
    // subscription is ours), so it carries no `origin` naming a peer — the
    // bracket label is the only wire signal it has.
    if (typeof content === "string" && CROSS_SESSION_NOTICE_RE.test(content)) {
      return "cross-session-notice";
    }
    return "unknown-meta";
  }

  // A person's message to a subagent through ccmsg is the person speaking,
  // as a prompt typed into the session is.
  if (agentAppendedText(row) !== null) return "user-prompt";

  if (typeof content !== "string") {
    if (content.some(isToolResultBlock)) return "tool-result";
    if (content.length === 1) {
      const [block] = content;
      if (block !== undefined && isKnownContentBlock(block) && block.type === "text") {
        const t = block.text;
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

  return classifyUserText(content, isMeta);
}

/**
 * Classifies the text of a user turn — a `type:"user"` row's string content,
 * or the prompt a `queue-operation` row queued — into a `UserMessageKind`:
 *
 * 1. a peer-relay prefix — peer-message, regardless of whether Claude Code
 *    also sets `isMeta:true`
 * 2. `isMeta` — remaining Claude Code CLI/harness UI injection (slash command
 *    caveat/invocation/stdout, malformed-tool-call retry hint)
 * 3. not `isMeta`, another literal system-injection prefix —
 *    task-notification (Monitor/Workflow/subagent), delivered as an ordinary
 *    prompt (`promptId`-bearing)
 * 4. anything else — a real human utterance
 */
export function classifyUserText(text: string, isMeta: boolean): UserMessageKind {
  // A peer relay may carry isMeta:true while retaining the fixed peer banner.
  // The decisive peer wrapper must run before the generic isMeta catch.
  if (text.startsWith("Another Claude session sent a message:")) return "peer-message";
  if (PEER_MESSAGE_TAGS.some((tag) => text.startsWith(`<${tag}`))) return "peer-message";
  // Same decisive-prefix reasoning as the peer wrapper above: the queued copy
  // of a notice (a `queue-operation` row) has no `promptSource`/`origin` at
  // all, so it reaches here rather than the system branch.
  if (CROSS_SESSION_NOTICE_RE.test(text)) return "cross-session-notice";

  // TUI の `! <cmd>` (bash モード) 実行。ハーネスは入力を `<bash-input>`、
  // 直後の結果を `<bash-stdout>`+`<bash-stderr>` の別 `type:"user"` 行として
  // 書く (2026-07-25 実観測、`isMeta` は付かない)。slash command 系と同じく
  // タグ prefix は人間の発話が取り得ない形なので meta フラグに依らず判定し、
  // isMeta 分岐の前に置いて両形を 1 箇所で拾う。
  if (text.startsWith("<bash-input>")) return "bash-command-invocation";
  if (text.startsWith("<bash-stdout>") || text.startsWith("<bash-stderr>")) {
    return "bash-command-stdout";
  }

  // 引数付き slash command はユーザ発話 (classifyUserMessage の doc comment
  // 参照)。isMeta の有無に依らないので、slash-command-invocation を拾う 2 経路
  // (isMeta 分岐とその下の bare prefix 判定) の両方より前に置く。
  if (parseSlashCommandPrompt(text) !== null) return "slash-command-prompt";

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
  // TUI で workflow を pause → resume した際にハーネスが注入する定型再開命令。
  // 実 transcript では `promptSource:"typed"` / `origin:{kind:"human"}` / `isMeta`
  // なし、で通常のタイプ入力と wire 上区別できず、文字列 prefix で判定するしかない
  // (kawaz r46 mid=14、本セッションの transcript で 2 件実観測)。
  // 誤爆リスク: 人間が手打ちで `Resume the paused workflow by calling: Workflow({`
  // で始まる文章を送ると誤分類されるが、`{`まで含んだこの厳密 prefix を能動的に
  // 打つケースは実用上ゼロ (=`<task-notification>` prefix 判定と同種の accepted
  // false-negative)。
  if (text.startsWith("Resume the paused workflow by calling: Workflow({")) {
    return "workflow-resume";
  }
  return "user-prompt";
}
