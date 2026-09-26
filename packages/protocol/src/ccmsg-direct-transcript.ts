// How the standalone ccmsg (the peer-messaging-socket deliverer) shows up in a
// Claude Code transcript, and nothing else. Every pattern that recognizes it —
// the delivered envelope, the agent's `ccmsg post|reply|notify` Bash call and
// its result, the PushNotification tool call — lives here, so the day that
// shape changes there is one module to update (DR-0027 §6).
//
// Three row shapes are recognized:
//
//   1. received: a `type:"user"` row (`promptSource:"system"`, `origin.kind:
//      "peer"`) whose string content embeds one or more
//      `<cross-session-message from="ccmsg" … ccmsg-mid="…" ccmsg-from="…">`
//      envelopes. The same envelope is also written, bare, into the
//      `queue-operation` enqueue row just before it; callers skip that copy.
//   2. sent: a Bash tool_use whose command is `ccmsg post|reply|notify …`,
//      paired with its tool_result (`{}` / `{"delivered":true}` on success).
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
const OPENING_RE = new RegExp(`<${TAG}((?:\\s+[a-z-]+="[^"]*")*)\\s*>\\n`, "g");
const ATTRIBUTE_RE = /([a-z-]+)="([^"]*)"/g;

function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function replyLine(mid: string, from: string): string {
  const to = from === DIRECT_DELIVERY_USER_SENDER ? "" : ` --to ${from}`;
  return `Reply with: ccmsg reply ${mid}${to} <text>`;
}

/** Cheap test before `parseDirectDeliveries`: true for any text that could
 * hold an envelope. Works on raw jsonl lines too (the attribute name carries no
 * quote, so JSON escaping does not hide it). */
export function mayContainDirectDelivery(text: string): boolean {
  return text.includes(`<${TAG}`) && text.includes("ccmsg-mid=");
}

/** Every envelope in `text`, in order. An envelope's body runs to the last
 * closing tag before the next envelope opens, so a body quoting the closing
 * tag survives. A `<cross-session-message>` lacking the ccmsg identity
 * attributes (a plain Claude Code peer message) is not one of these and is
 * skipped. */
export function parseDirectDeliveries(text: string): DirectDeliveryEnvelope[] {
  if (!mayContainDirectDelivery(text)) return [];
  const openings = [...text.matchAll(OPENING_RE)];
  const out: DirectDeliveryEnvelope[] = [];
  openings.forEach((opening, i) => {
    const bodyStart = opening.index! + opening[0].length;
    const limit = i + 1 < openings.length ? openings[i + 1]!.index! : text.length;
    const end = text.lastIndexOf(CLOSING, limit - CLOSING.length);
    if (end < bodyStart - 1) return;
    const attributes = new Map<string, string>();
    for (const [, key, value] of (opening[1] ?? "").matchAll(ATTRIBUTE_RE)) {
      attributes.set(key!, unescapeAttribute(value!));
    }
    const mid = attributes.get("ccmsg-mid");
    const from = attributes.get("ccmsg-from");
    if (mid === undefined || from === undefined) return;
    let body = end >= bodyStart ? text.slice(bodyStart, end) : "";
    const suffix = `\n\n${replyLine(mid, from)}`;
    if (body.endsWith(suffix)) body = body.slice(0, -suffix.length);
    else if (body === replyLine(mid, from)) body = "";
    const replyTo = attributes.get("ccmsg-reply-to");
    out.push({
      mid,
      from,
      fromLabel: attributes.get("from-name") ?? from,
      ...(replyTo !== undefined ? { replyTo } : {}),
      text: body,
    });
  });
  return out;
}

/** A `ccmsg post|reply|notify` call as written in a Bash command.
 *
 * - post: `to` is the addressed session
 * - reply: `replyTo` is the mid answered; `to` is the `--to` session, absent
 *   when the answer goes to a person
 * - notify: `about` is the `--about` session, absent for the caller itself */
export interface CcmsgSendCommand {
  verb: "post" | "reply" | "notify";
  to?: string;
  replyTo?: string;
  about?: string;
  text: string;
}

/** `ccmsg` (bare or path-qualified) at the start of the command or after a
 * shell separator, then the verb. */
const SEND_COMMAND_RE = /(?:^|[;&|\n])\s*(?:[^\s;&|'"]*\/)?ccmsg\s+(post|reply|notify)(?=\s|$)/;

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
  const m = SEND_COMMAND_RE.exec(command);
  if (!m) return null;
  const verb = m[1] as CcmsgSendCommand["verb"];
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
        ...(positional[0] !== undefined ? { to: positional[0] } : {}),
        text: positional.slice(1).join(" "),
      };
    case "reply": {
      const to = options.get("--to");
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
 * - `sent`: `{}` or `{"delivered":…}` (the successful answers)
 * - `failed`: anything else, with the result text as `detail`
 * - `other-ccmsg`: `{"ok":…}` — the web UI's own room CLI answering, whose
 *   message reaches the timeline through the room path instead */
export type CcmsgSendOutcome =
  | { status: "sent" }
  | { status: "failed"; detail: string }
  | { status: "other-ccmsg" };

export function classifyCcmsgSendResult(text: string, isError: boolean): CcmsgSendOutcome {
  const trimmed = text.trim();
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
