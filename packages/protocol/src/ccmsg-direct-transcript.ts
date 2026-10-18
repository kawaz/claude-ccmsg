// How the standalone ccmsg (the peer-messaging-socket deliverer) shows up in a
// Claude Code transcript, and nothing else. Every pattern that recognizes it —
// the delivered envelope, the agent's `ccmsg post|reply|notify` Bash call and
// its result, the PushNotification tool call — lives here, so the day that
// shape changes there is one module to update (DR-0027 §6). The envelope
// this daemon writes itself (DR-0039 §3) is rendered here too, so what is
// written and what is read back are one definition.
//
// Three row shapes are recognized:
//
//   1. received: one delivery per row — one
//      `<cross-session-message from="ccmsg" … ccmsg-mid="…" ccmsg-from="…">`
//      envelope, carried by either
//      - a `type:"user"` row (`promptSource:"system"`, `origin.kind:"peer"`)
//        whose string content embeds it (the session was idle), or
//      - a `type:"attachment"` row whose `attachment` is
//        `{type:"queued_command", prompt, origin:{kind:"peer"}}` (the session
//        was mid-turn); `queuedCommandPrompt` reads it. Deliveries that
//        arrive during one turn become one such row each, not one row
//        holding several. The row's `rendered` system-reminder repeats the
//        envelope and is not read.
//      The same envelope is also written, bare, into a `queue-operation`
//      enqueue row before either; callers skip that copy.
//   2. sent: a Bash tool_use whose command is `ccmsg post|reply|notify …`,
//      paired with its tool_result (`{}` / `{"delivered":true}` on success,
//      exit DIRECT_SEND_UNCONFIRMED_EXIT when arrival could not be told).
//   3. PushNotification: a tool_use `{name:"PushNotification", input:{message}}`,
//      its input read where the call is known to be one.
//   4. sent through the hooks module's `send` tool (DR-0039 §3): a tool_use
//      `{name: CCMSG_TOOLS.send, input:{session_id?, cwd?, name?, pid?, text}}`,
//      paired with its tool_result, which peer-tools-text.ts reads back.
//
// String work over the transcript rows' schemas, importing nothing but valibot
// and the schema files beside it, so the browser bundle and the daemon share it
// as is.
import * as v from "valibot";
import { DIRECT_ADDRESS_PREFIX } from "./ccmsg-address.ts";
import { type JsonObject, JsonValueSchema } from "./json-value.ts";
import { JsonTextSchema, parseWith } from "./parse.ts";
import { CCMSG_TOOLS } from "./peer-tools.ts";
import { isKnownAttachment } from "./transcript-attachment.ts";
import { isKnownContentBlock } from "./transcript-content.ts";
import { isKnownTranscriptRow, type TranscriptRow } from "./transcript-row.ts";

/** One message as the envelope carries it. `from` is `"user"` for a person
 * (the web UI's sender) and the sender's session id otherwise. */
export interface DirectDeliveryEnvelope {
  mid: string;
  from: string;
  fromLabel: string;
  replyTo?: string;
  /** The sender's text with the envelope's own reply-instruction line removed. */
  text: string;
}

/** `ccmsg-from` of a message a person sent. */
export const DIRECT_DELIVERY_USER_SENDER = "user";

const TAG = "cross-session-message";
const CLOSING = `\n</${TAG}>`;
/** The first opening tag of the element, with or without attributes that
 * make it a ccmsg envelope. */
const OPENING_RE = new RegExp(`<${TAG}((?:\\s+[a-z-]+="[^"]*")*)\\s*>\\n`);
const ATTRIBUTE_RE = /([a-z-]+)="([^"]*)"/g;

function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The sid an address names: `ccmsg:<sid>` loses its prefix, a bare sid stays
 * as written. */
export function directAddressSid(address: string): string {
  return address.startsWith(DIRECT_ADDRESS_PREFIX)
    ? address.slice(DIRECT_ADDRESS_PREFIX.length)
    : address;
}

/** Characters a POSIX shell takes literally in an unquoted word. */
const SHELL_PLAIN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** `word` as one POSIX shell word: unchanged when every character is literal
 * to the shell, otherwise in single quotes (a `'` inside closes the quote,
 * adds an escaped one and reopens). */
export function shellQuote(word: string): string {
  if (SHELL_PLAIN_RE.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The instruction line a direct envelope ends with: a command the recipient
 * runs in a shell, so every word in it that comes from outside this module —
 * the launcher path, the mid and the sender's sid — is quoted as one shell
 * word. For the values this protocol issues (a plain path, `<hex>/<n>`, a
 * UUID) quoting changes nothing and the line is the v2 contract's. A message
 * from a person names no `--to`. */
export function directDeliveryReplyLine(mid: string, from: string, launcher = "ccmsg"): string {
  const to = from === DIRECT_DELIVERY_USER_SENDER ? "" : ` --to ${shellQuote(from)}`;
  return `Reply with: ${shellQuote(launcher)} reply ${shellQuote(mid)}${to} <text>`;
}

/** One message as `renderAddressedDelivery` words it. `from` is the
 * sender's sid. */
export interface DirectDeliveryMessage {
  mid: string;
  from: string;
  text: string;
}

/** The envelope a message from another session reaches its recipient in
 * (DR-0039 §3): the sender as `ccmsg:<sid>` in both `from` and `from-name`,
 * the ccmsg identity attributes, the text untouched and nothing under it. The
 * recipient answers with the `send` tool, naming the sid of `from`, as the
 * plugin's skill tells it to, so no reply line names a command. */
export function renderAddressedDelivery(m: DirectDeliveryMessage): string {
  const address = `${DIRECT_ADDRESS_PREFIX}${m.from}`;
  const attributes = [
    `from="${escapeAttribute(address)}"`,
    `from-name="${escapeAttribute(address)}"`,
    `from-mode="prompting"`,
    `ccmsg-mid="${escapeAttribute(m.mid)}"`,
    `ccmsg-from="${escapeAttribute(m.from)}"`,
  ];
  return `<${TAG} ${attributes.join(" ")}>\n${m.text}\n</${TAG}>`;
}

/** True for the reply line of a direct envelope for `mid` from `from`, naming
 * either the bare `ccmsg` or a launcher by absolute path (quoted or not). */
function isDirectReplyLine(line: string, mid: string, from: string): boolean {
  const prefix = "Reply with: ";
  const bare = directDeliveryReplyLine(mid, from);
  const tail = bare.slice(`${prefix}ccmsg`.length);
  if (!line.startsWith(prefix) || !line.endsWith(tail)) return false;
  const launcher = shellWords(line.slice(prefix.length, line.length - tail.length));
  return launcher?.length === 1 && isLauncherWord(launcher[0], true);
}

/** `ccmsg`, or a path ending in `/ccmsg` (absolute only, when `absolute`). */
function isLauncherWord(word: string, absolute = false): boolean {
  if (word === "ccmsg") return true;
  return word.endsWith("/ccmsg") && (!absolute || word.startsWith("/"));
}

/** The reply instruction a room message delivered into a session ends with:
 * `Reply with: <path>/ccmsg reply r<N>m<M> <text>`, or the instruction to
 * answer in the transcript for a 1on1 message from the User. */
const ROOM_REPLY_LINE_RE =
  /^(?:Reply with: (?:\S*\/)?ccmsg reply r\d+m\d+ <text>|Reply in your normal assistant response\.)$/;

function isRoomMid(mid: string): boolean {
  return /^r\d+m\d+$/.test(mid);
}

/** The sender's text, with the reply line the envelope added removed. */
function stripReplyLine(body: string, mid: string, from: string): string {
  const cut = body.lastIndexOf("\n\n");
  const last = cut === -1 ? body : body.slice(cut + 2);
  if (isDirectReplyLine(last, mid, from)) return cut === -1 ? "" : body.slice(0, cut);
  if (!isRoomMid(mid)) return body;
  if (
    !ROOM_REPLY_LINE_RE.test(last) ||
    (last.startsWith("Reply with:") && !last.includes(` ${mid} `))
  ) {
    return body;
  }
  return cut === -1 ? "" : body.slice(0, cut);
}

/** Cheap test before `parseDirectDeliveries`: true for any text that could
 * hold an envelope. Works on raw jsonl lines too (the attribute name carries no
 * quote, so JSON escaping does not hide it). */
export function mayContainDirectDelivery(text: string): boolean {
  return text.includes(`<${TAG}`) && text.includes("ccmsg-mid=");
}

/** The prompt of a transcript row that queued a peer message while the
 * session was mid-turn (`type:"attachment"`, `attachment.type:
 * "queued_command"`), or null for any other row. A present `origin` must be a
 * peer's. A prompt that carries an image is blocks; its text is the text
 * blocks', one per line. */
export function queuedCommandPrompt(row: TranscriptRow): string | null {
  if (!isKnownTranscriptRow(row) || row.type !== "attachment") return null;
  const attachment = row.attachment;
  if (!isKnownAttachment(attachment) || attachment.type !== "queued_command") return null;
  if (attachment.origin !== undefined && attachment.origin.kind !== "peer") return null;
  const prompt = attachment.prompt;
  if (typeof prompt === "string") return prompt;
  return prompt
    .flatMap((block) => (isKnownContentBlock(block) && block.type === "text" ? [block.text] : []))
    .join("\n");
}

/** The envelope `text` carries — one transcript row's content, or one queued
 * command's prompt — as a list of none or one.
 *
 * The envelope opens at the first `<cross-session-message …>` in the text and
 * its body runs to the last closing tag. The body is the sender's, carried
 * unescaped, so a tag inside it is part of it: an opening tag there is not a
 * second envelope (a sender cannot pose as another by writing one), and a
 * closing tag there does not end it. A first `<cross-session-message>` lacking
 * the ccmsg identity attributes is a plain Claude Code peer message, and the
 * text carries none of these. */
export function parseDirectDeliveries(text: string): DirectDeliveryEnvelope[] {
  if (!mayContainDirectDelivery(text)) return [];
  const opening = OPENING_RE.exec(text);
  if (!opening) return [];
  const bodyStart = opening.index + opening[0].length;
  const end = text.lastIndexOf(CLOSING);
  if (end < bodyStart - 1) return [];
  const attributes = new Map<string, string>();
  for (const [, key, value] of (opening[1] ?? "").matchAll(ATTRIBUTE_RE)) {
    attributes.set(key, unescapeAttribute(value));
  }
  const mid = attributes.get("ccmsg-mid");
  const from = attributes.get("ccmsg-from");
  if (mid === undefined || from === undefined) return [];
  const body = stripReplyLine(end >= bodyStart ? text.slice(bodyStart, end) : "", mid, from);
  const replyTo = attributes.get("ccmsg-reply-to");
  return [
    {
      mid,
      from,
      fromLabel: attributes.get("from-name") ?? from,
      ...(replyTo !== undefined ? { replyTo } : {}),
      text: body,
    },
  ];
}

/** A `ccmsg post|reply|notify` call as written in a Bash command.
 *
 * - post: `to` is the addressed session's sid (a `ccmsg:<sid>` address is
 *   read as its sid)
 * - reply: `replyTo` is the mid answered; `to` is the `--to` session's sid,
 *   absent when the answer goes to a person
 * - notify: `about` is the `--about` session, absent for the caller itself */
export interface CcmsgSendCommand {
  verb: (typeof SEND_VERBS)[number];
  to?: string;
  replyTo?: string;
  about?: string;
  text: string;
}

/** The verbs of a send, as SEND_COMMAND_RE matches them. */
const SEND_VERBS = ["post", "reply", "notify"] as const;

/** A command word at the start of the command or after a shell separator —
 * bare, or quoted as `shellQuote` writes a path with spaces — then a verb.
 * Whether the word is `ccmsg` is checked on its unquoted form. */
const SEND_COMMAND_RE =
  /(?:^|[;&|\n])\s*((?:'[^']*'|"(?:[^"\\$`]|\\.)*"|\\.|[^\s;&|'"\\<>$`])+)\s+(post|reply|notify)(?=\s|$)/g;

/** Splits shell words with single quotes, double quotes (backslash escapes
 * inside) and backslash escapes outside quotes. Stops at an unquoted shell
 * separator or redirection. Returns null for anything it does not model (unterminated quote,
 * `$(…)`, backticks, heredoc) so the caller can keep the raw text instead of a
 * wrong one. */
function shellWords(input: string): string[] | null {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += input.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < input.length && input[j] !== '"'; j++) {
        const d = input[j];
        if (d === "$" || d === "`") return null;
        if (d === "\\" && j + 1 < input.length && '"\\$`'.includes(input[j + 1])) {
          cur += input[++j];
        } else cur += d;
      }
      if (j >= input.length) return null;
      inWord = true;
      i = j;
    } else if (c === "\\" && i + 1 < input.length) {
      cur += input[++i];
      inWord = true;
    } else if (c === "$" || c === "`" || c === "<") {
      return null;
    } else if (c === ">") {
      if (/^\d*$/.test(cur)) inWord = false;
      break;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n") {
      break;
    } else if (c === " " || c === "\t") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** The options a transcript's `ccmsg post` / `ccmsg reply` call carries:
 * those carrying a value, and flags. */
export const SEND_VALUE_OPTIONS: readonly string[] = ["--to", "--sid", "--as-session"];
export const SEND_FLAG_OPTIONS: readonly string[] = ["--help", "-h"];

/** The words after `post` / `reply`, split the way the CLI that ran the call
 * read them. */
export interface SendWords {
  /** The words before the body: the target of `post`, the mid of `reply`. */
  leading: string[];
  /** Options by name as written (`--to`); a flag's value is true. */
  options: Map<string, string | true>;
  /** The body's words, as given. The body is these joined by one space. */
  body: string[];
}

/** Split the words after `post` / `reply` into the `leadingCount` words
 * before the body, the options, and the body, as the CLI that ran the call
 * read them, so the timeline and the dump show what was sent.
 *
 * Before the body, a word starting with `--` is an option (`--name=value`,
 * a known value option and the word after it, or a flag). From the body's
 * position on, a word is an option only when it is exactly a known option
 * name (SEND_VALUE_OPTIONS with a word after it, or SEND_FLAG_OPTIONS);
 * anything else — `--foo`, `--foo bar` as one word, a lone `-` — is body, as
 * written. The first `--` makes every later word literal (leading words,
 * then body) and is itself dropped, so a body that starts with a known option
 * name is sent as `-- --to …`. */
export function splitSendWords(words: readonly string[], leadingCount: number): SendWords {
  const leading: string[] = [];
  const options = new Map<string, string | true>();
  const body: string[] = [];
  let literal = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const word = (): void => {
      if (leading.length < leadingCount) leading.push(w);
      else body.push(w);
    };
    if (literal) {
      word();
      continue;
    }
    if (w === "--") {
      literal = true;
      continue;
    }
    if (SEND_VALUE_OPTIONS.includes(w) && i + 1 < words.length) {
      options.set(w, words[++i]);
      continue;
    }
    if (SEND_FLAG_OPTIONS.includes(w)) {
      options.set(w, true);
      continue;
    }
    if (leading.length < leadingCount && w.startsWith("--")) {
      const eq = w.indexOf("=");
      if (eq > 2) options.set(w.slice(0, eq), w.slice(eq + 1));
      else options.set(w, true);
      continue;
    }
    word();
  }
  return { leading, options, body };
}

const NOTIFY_VALUE_OPTIONS = new Set(["--sid", "--about"]);

/** Reads the ccmsg send call out of a Bash `command`, or null when there is
 * none (a `--help` call sends nothing). When the arguments use shell syntax this does not model, `text` is the
 * raw argument string after the verb rather than a guess. `post` / `reply`
 * are read by splitSendWords, as the CLI that ran them read them. */
export function parseCcmsgSendCommand(command: string): CcmsgSendCommand | null {
  const m = [...command.matchAll(SEND_COMMAND_RE)].find((candidate) => {
    const word = shellWords(candidate[1]);
    return word?.length === 1 && isLauncherWord(word[0]);
  });
  if (!m) return null;
  const verb = SEND_VERBS.find((name) => name === m[2]);
  if (verb === undefined) return null;
  const rest = command.slice(m.index + m[0].length);
  const words = shellWords(rest);
  if (words === null) return { verb, text: rest.trim() };
  if (verb === "post" || verb === "reply") {
    const split = splitSendWords(words, 1);
    if (split.options.has("--help") || split.options.has("-h")) return null;
    const first = split.leading[0];
    const text = split.body.join(" ");
    if (verb === "post") {
      return { verb, ...(first !== undefined ? { to: directAddressSid(first) } : {}), text };
    }
    const address = split.options.get("--to");
    const to = typeof address === "string" ? directAddressSid(address) : undefined;
    return {
      verb,
      ...(first !== undefined ? { replyTo: first } : {}),
      ...(to !== undefined ? { to } : {}),
      text,
    };
  }
  if (words.includes("--help") || words.includes("-h")) return null;
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const eq = w.indexOf("=");
    if (w.startsWith("--") && eq > 0 && NOTIFY_VALUE_OPTIONS.has(w.slice(0, eq))) {
      options.set(w.slice(0, eq), w.slice(eq + 1));
    } else if (NOTIFY_VALUE_OPTIONS.has(w) && i + 1 < words.length) {
      options.set(w, words[++i]);
    } else positional.push(w);
  }
  const about = options.get("--about");
  return { verb, ...(about !== undefined ? { about } : {}), text: positional.join(" ") };
}

/** What the paired tool_result says about a send.
 *
 * - `sent`: `{}` or `{"delivered":…}` (the successful answers; this plugin's
 *   own direct send answers `{"delivered":true,"mid":…}`)
 * - `unconfirmed`: this plugin's direct send exited
 *   DIRECT_SEND_UNCONFIRMED_EXIT saying `(unconfirmed)` — the message may or
 *   may not have arrived — with the result text as `detail`
 * - `failed`: anything else, with the result text as `detail` (this plugin's
 *   direct send reports a message that did not arrive as text on stderr,
 *   never as JSON carrying `ok`)
 * - `other-ccmsg`: `{"ok":…}` — the web UI's own room CLI answering, whose
 *   message reaches the timeline through the room path instead */
export type CcmsgSendOutcome =
  | { status: "sent" }
  | { status: "failed"; detail: string }
  | { status: "unconfirmed"; detail: string }
  | { status: "other-ccmsg" };

/** The exit status of a transcript's `ccmsg post` / `ccmsg reply` call for a
 * direct message whose arrival could not be told: it may have arrived, so it
 * is neither sent nor failed. A message that did not arrive exits 1. */
export const DIRECT_SEND_UNCONFIRMED_EXIT = 3;

/** How a Bash tool_result of a non-zero exit begins, with the status. */
const UNCONFIRMED_RESULT_RE = new RegExp(`^Exit code ${DIRECT_SEND_UNCONFIRMED_EXIT}\\n`);

/** The room CLI's answer to a send: an object carrying `ok`. */
const RoomCliAnswerSchema = v.looseObject({ ok: JsonValueSchema });

/** A direct send's answer when the message arrived: `{}`, or an object
 * carrying `delivered`. */
const DirectSendAnswerSchema = v.union([
  v.strictObject({}),
  v.looseObject({ delivered: JsonValueSchema }),
]);

export function classifyCcmsgSendResult(text: string, isError: boolean): CcmsgSendOutcome {
  const trimmed = text.trim();
  if (isError && UNCONFIRMED_RESULT_RE.test(trimmed) && trimmed.includes("(unconfirmed)")) {
    return { status: "unconfirmed", detail: trimmed };
  }
  const json = parseWith(JsonTextSchema, trimmed);
  if (!json.ok) return { status: "failed", detail: trimmed };
  if (parseWith(RoomCliAnswerSchema, json.value).ok) return { status: "other-ccmsg" };
  if (!isError && parseWith(DirectSendAnswerSchema, json.value).ok) return { status: "sent" };
  return { status: "failed", detail: trimmed };
}

/** The input of a PushNotification call, read for its text. */
const PushNotificationInputSchema = v.looseObject({ message: v.string() });

/** The text of a PushNotification tool call (`name` and the input as the
 * model wrote it), or null for any other tool, or a call whose input carries
 * no text. */
export function pushNotificationText(name: string, input: JsonObject): string | null {
  if (name !== "PushNotification") return null;
  const read = parseWith(PushNotificationInputSchema, input);
  return read.ok ? read.value.message : null;
}

/** The input of a `send` tool call, read for what a reader shows of it. */
const SendCallInputSchema = v.looseObject({
  text: v.string(),
  session_id: v.optional(v.string()),
});

/** A `send` tool call (`name` and the input as the model wrote it): its text,
 * and the session it named by id when it did. Null for any other tool, or a
 * call whose input carries no text. */
export function ccmsgSendCall(
  name: string,
  input: JsonObject,
): { text: string; sessionId?: string } | null {
  if (name !== CCMSG_TOOLS.send) return null;
  const read = parseWith(SendCallInputSchema, input);
  if (!read.ok) return null;
  const { text, session_id } = read.value;
  return session_id !== undefined ? { text, sessionId: session_id } : { text };
}
