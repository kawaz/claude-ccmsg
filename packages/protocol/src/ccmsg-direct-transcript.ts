// How the standalone ccmsg (the peer-messaging-socket deliverer) shows up in a
// Claude Code transcript, and nothing else. Every pattern that recognizes it —
// the delivered envelope, the agent's `ccmsg post|reply|notify` Bash call and
// its result, the PushNotification tool call — lives here, so the day that
// shape changes there is one module to update (DR-0027 §6). The direct
// envelope this daemon writes itself (DR-0036 §1) is rendered here too, so
// what is written and what is read back are one definition.
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
//   3. PushNotification: a tool_use `{name:"PushNotification", input:{message}}`.
//
// Pure string work with no imports, so the browser bundle and the daemon share
// it as is.

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

/** The namespace a session is addressed in: `ccmsg:<sid>`. The envelope's
 * `from` / `from-name` carry the sender in it, and a recipient may be written
 * either this way or as the bare sid. */
export const DIRECT_ADDRESS_PREFIX = "ccmsg:";

/** The sid an address names: `ccmsg:<sid>` loses its prefix, a bare sid stays
 * as written. */
export function directAddressSid(address: string): string {
  return address.startsWith(DIRECT_ADDRESS_PREFIX)
    ? address.slice(DIRECT_ADDRESS_PREFIX.length)
    : address;
}

/** `<instance id>/<counter>`: the id of one direct message, there so a reply's
 * `reply_to` can point at it. Distinct from a room message's `r<N>m<M>`. */
const DIRECT_MID_RE = /^[0-9a-f]{32}\/\d+$/;

export function isDirectMid(mid: string): boolean {
  return DIRECT_MID_RE.test(mid);
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

/** One direct message as `renderDirectDelivery` words it. `from` is the
 * sender's sid. */
export interface DirectDeliveryMessage {
  mid: string;
  from: string;
  replyTo?: string;
  text: string;
}

/** The envelope a direct message reaches its recipient in: the sender as
 * `ccmsg:<sid>` in both `from` and `from-name`, the ccmsg identity attributes,
 * the text untouched, then the reply line naming `launcher`. */
export function renderDirectDelivery(m: DirectDeliveryMessage, launcher: string): string {
  const address = `${DIRECT_ADDRESS_PREFIX}${m.from}`;
  const attributes = [
    `from="${escapeAttribute(address)}"`,
    `from-name="${escapeAttribute(address)}"`,
    `from-mode="prompting"`,
    `ccmsg-mid="${escapeAttribute(m.mid)}"`,
    `ccmsg-from="${escapeAttribute(m.from)}"`,
    ...(m.replyTo !== undefined ? [`ccmsg-reply-to="${escapeAttribute(m.replyTo)}"`] : []),
  ];
  const body = `${m.text}\n\n${directDeliveryReplyLine(m.mid, m.from, launcher)}`;
  return `<${TAG} ${attributes.join(" ")}>\n${body}\n</${TAG}>`;
}

/** True for the reply line of a direct envelope for `mid` from `from`, naming
 * either the bare `ccmsg` or a launcher by absolute path (quoted or not). */
function isDirectReplyLine(line: string, mid: string, from: string): boolean {
  const prefix = "Reply with: ";
  const bare = directDeliveryReplyLine(mid, from);
  const tail = bare.slice(`${prefix}ccmsg`.length);
  if (!line.startsWith(prefix) || !line.endsWith(tail)) return false;
  const launcher = shellWords(line.slice(prefix.length, line.length - tail.length));
  return launcher?.length === 1 && isLauncherWord(launcher[0]!, true);
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
 * peer's. */
export function queuedCommandPrompt(row: Record<string, unknown>): string | null {
  if (row.type !== "attachment") return null;
  const a = row.attachment;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const attachment = a as Record<string, unknown>;
  if (attachment.type !== "queued_command" || typeof attachment.prompt !== "string") return null;
  const origin = attachment.origin;
  if (origin !== undefined && (origin as { kind?: unknown } | null)?.kind !== "peer") return null;
  return attachment.prompt;
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
    attributes.set(key!, unescapeAttribute(value!));
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
  verb: "post" | "reply" | "notify";
  to?: string;
  replyTo?: string;
  about?: string;
  text: string;
}

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
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += input.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < input.length && input[j] !== '"'; j++) {
        const d = input[j]!;
        if (d === "$" || d === "`") return null;
        if (d === "\\" && j + 1 < input.length && '"\\$`'.includes(input[j + 1]!)) {
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

const VALUE_OPTIONS = new Set(["--to", "--sid", "--about"]);

/** Reads the ccmsg send call out of a Bash `command`, or null when there is
 * none (a `--help` call sends nothing). When the arguments use shell syntax this does not model, `text` is the
 * raw argument string after the verb rather than a guess. */
export function parseCcmsgSendCommand(command: string): CcmsgSendCommand | null {
  const m = [...command.matchAll(SEND_COMMAND_RE)].find((candidate) => {
    const word = shellWords(candidate[1]!);
    return word?.length === 1 && isLauncherWord(word[0]!);
  });
  if (!m) return null;
  const verb = m[2] as CcmsgSendCommand["verb"];
  const rest = command.slice(m.index + m[0].length);
  const words = shellWords(rest);
  if (words === null) return { verb, text: rest.trim() };
  if (words.includes("--help") || words.includes("-h")) return null;
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const eq = w.indexOf("=");
    if (w.startsWith("--") && eq > 0 && VALUE_OPTIONS.has(w.slice(0, eq))) {
      options.set(w.slice(0, eq), w.slice(eq + 1));
    } else if (VALUE_OPTIONS.has(w) && i + 1 < words.length) {
      options.set(w, words[++i]!);
    } else positional.push(w);
  }
  switch (verb) {
    case "post":
      return {
        verb,
        ...(positional[0] !== undefined ? { to: directAddressSid(positional[0]) } : {}),
        text: positional.slice(1).join(" "),
      };
    case "reply": {
      const address = options.get("--to");
      const to = address === undefined ? undefined : directAddressSid(address);
      return {
        verb,
        ...(positional[0] !== undefined ? { replyTo: positional[0] } : {}),
        ...(to !== undefined ? { to } : {}),
        text: positional.slice(1).join(" "),
      };
    }
    case "notify": {
      const about = options.get("--about");
      return { verb, ...(about !== undefined ? { about } : {}), text: positional.join(" ") };
    }
  }
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

/** The exit status of `ccmsg post` / `ccmsg reply` for a direct message whose
 * arrival could not be told (message_send `unconfirmed`): it may have arrived,
 * so it is neither sent nor failed. A message that did not arrive exits 1. */
export const DIRECT_SEND_UNCONFIRMED_EXIT = 3;

/** How a Bash tool_result of a non-zero exit begins, with the status. */
const UNCONFIRMED_RESULT_RE = new RegExp(`^Exit code ${DIRECT_SEND_UNCONFIRMED_EXIT}\\n`);

export function classifyCcmsgSendResult(text: string, isError: boolean): CcmsgSendOutcome {
  const trimmed = text.trim();
  if (isError && UNCONFIRMED_RESULT_RE.test(trimmed) && trimmed.includes("(unconfirmed)")) {
    return { status: "unconfirmed", detail: trimmed };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { status: "failed", detail: trimmed };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if ("ok" in o) return { status: "other-ccmsg" };
    if (!isError && (Object.keys(o).length === 0 || "delivered" in o)) return { status: "sent" };
  }
  return { status: "failed", detail: trimmed };
}

/** The text of a PushNotification tool call, or null for any other tool. */
export function pushNotificationText(name: string, input: unknown): string | null {
  if (name !== "PushNotification" || !input || typeof input !== "object") return null;
  const message = (input as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}
