// When each connected session last received input *from the user* — the
// ordering the sidebar's Sessions list is sorted by (kawaz 2026-08-31: "TL 上で
// 最後にユーザ入力した時間の新しい順").
//
// "From the user" is deliberately narrower than `PeerInfo.last_activity_at`,
// which is re-stamped by every ccmsg request a session makes (its own posts, a
// subscribe reconnect, an fs_read) and therefore tracks how busy the *agent*
// is, not when kawaz last said something. Two row kinds count, and nothing
// else:
//
//   1. a prompt the human typed into that session (`origin.kind === "human"`),
//   2. a ccmsg room message authored by the User admin (`from: "u1"`) arriving
//      through the session's `ccmsg subscribe` Monitor,
//   3. a standalone-ccmsg envelope from a person (`ccmsg-from="user"`), see
//      @ccmsg/protocol's ccmsg-direct-transcript.
//
// Structurally this is session-errors.ts' twin: the same one-pattern fold over
// the lines the transcript relay reads (DR-0045 §5), for the same reason
// (DR-0020 §2.1 (a) — the sidebar needs a field for *every* peer, so a per-sid
// session_status subscription is too expensive a source). A session is folded
// while its hooks module has a run named, so a prompt lands in the list as it
// is typed.
import {
  DIRECT_DELIVERY_USER_SENDER,
  isKnownTranscriptRow,
  mayContainDirectDelivery,
  parseDirectDeliveries,
  parseWith,
  queuedCommandPrompt,
  TranscriptRowLineSchema,
  type TranscriptRow,
} from "@ccmsg/protocol";
import type { LineFold } from "./transcript-relay.ts";

/** A ccmsg `type:"msg"` subscribe event authored by the User admin, as it
 * appears *inside* the `<event>` body of a `<task-notification>` row — so the
 * whole event JSON is a string value within the transcript row's own JSON and
 * every quote reaches us backslash-escaped. `[^{}]*` keeps the match inside a
 * single flat object: `from` precedes `msg` in the daemon's subscribe wire
 * order (`type,mid,from,ts,to?,r,seq,reply_via?,msg`), and every field before
 * it is a scalar, so no nested object can be crossed on the way.
 *
 * Matching the escaped form directly (rather than parsing the row, pulling the
 * `<event>` body out and JSON.parse-ing each line of it) is what keeps this
 * fold to one regex test per candidate line, the budget session-errors.ts
 * works to. A false positive would need a transcript row that quotes a ccmsg
 * msg event verbatim without it having been delivered — the sender-side
 * `ccmsg read` echo does exactly that, which is why classifyUserInputRow
 * requires the row to be a system-injected delivery as well. */
const U1_MSG_EVENT_RE = /\{\\"type\\":\\"msg\\"[^{}]*?\\"from\\":\\"u1\\"/;

/** Same event shape in a row whose content was *not* re-escaped — the form a
 * hand-written fixture (and any future non-string delivery wrapper) carries.
 * Kept separate from the escaped pattern rather than folded into one
 * alternation so each stays a plain literal-anchored scan. */
const U1_MSG_EVENT_RAW_RE = /\{"type":"msg"[^{}]*?"from":"u1"/;

/** `<command-args>` whose body holds at least one non-whitespace character —
 * the "the user actually wrote something" half of the slash-command rule in
 * classifyUserInputRow. The body is matched lazily rather than as "no `<`
 * allowed", so args carrying code or markup still count. The webui mirrors
 * this rule for its timeline display (packages/webui/src/client/transcript-model.ts
 * の parseSlashCommandPrompt) — the two are kept in sync so a row shown as a
 * user utterance is the same row counted as a prompt. */
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

function hasNonEmptyCommandArgs(content: string): boolean {
  return (content.match(COMMAND_ARGS_RE)?.[1] ?? "").trim() !== "";
}

/** Cheap string prefilter before JSON.parse, mirroring isApiErrorCandidate's
 * role: only rows that could carry one of the two counted kinds are worth
 * parsing. `"kind":"human"` is the typed-prompt marker and `"u1"` admits the
 * ccmsg deliveries (plus the `ccmsg read` echoes the classifier then rejects —
 * a prefilter is allowed to be generous, only cheap). */
export function isUserInputCandidate(line: string): boolean {
  return (
    line.includes('"kind":"human"') ||
    line.includes("u1") ||
    line.includes("<command-args>") ||
    mayContainDirectDelivery(line)
  );
}

/** The timestamp to credit `row` with as user input, or undefined when the row
 * is not user input at all.
 *
 * The two accepted kinds are recognized by wire fields, never by a catalog of
 * system-injection text prefixes (the approach webui's `classifyUserMessage`
 * needs because it must name *every* kind): asking only "is this the user
 * talking?" has an inclusion answer, and an inclusion rule cannot rot the way
 * an exclusion list does when the harness invents a new injection wrapper.
 *
 *   - `origin.kind === "human"` covers a typed prompt and a queued one
 *     (`promptSource` "typed"/"queued"), whatever content shape it carries —
 *     plain text, or the array a pasted image arrives as. Measured across the
 *     200 most recently written transcripts: every genuine prompt has it, and
 *     nothing else does (interrupt markers, `! <cmd>` rows, slash-command
 *     plumbing, teammate relays and tool_result echoes all lack `origin`).
 *   - a `from:"u1"` ccmsg msg event in a system-injected delivery covers kawaz
 *     speaking through the web UI. `promptSource === "system"` is required so
 *     the session's own `ccmsg read` tool_result — which quotes the very same
 *     event JSON — is not counted a second time as fresh input.
 *   - a standalone-ccmsg envelope with `ccmsg-from="user"` in a
 *     system-injected row is a person speaking through that route. The
 *     queue-operation copy of the same envelope is not a `type:"user"` row, so
 *     it is never counted. A message that arrived mid-turn is delivered by a
 *     `queued_command` attachment row instead, which counts the same way.
 *
 * Transcripts written before Claude Code carried `origin`/`promptSource` at
 * all (observed through 2026-01) yield nothing here. That is the honest answer
 * for them: those rows have no wire signal separating a prompt from a relay,
 * and a session old enough to predate the field is not one whose ordering is
 * being watched. Sessions with no value sort last (see webui's cmpByTsDesc).
 *
 * The row's own `timestamp` is credited, not the ccmsg event's `ts`: the
 * question is when the message landed in *this* session's timeline, which is
 * what the reader is ordering by. The two differ by the subscribe delivery
 * latency (~200ms in practice). */
export function classifyUserInputRow(row: TranscriptRow): string | undefined {
  if (!isKnownTranscriptRow(row)) return undefined;
  if (row.type !== "user" && row.type !== "attachment") return undefined;
  if (row.isSidechain) return undefined;
  const timestamp = row.timestamp;
  if (timestamp === "") return undefined;
  const queued = queuedCommandPrompt(row);
  if (queued !== null) return isFromUser(queued) ? timestamp : undefined;
  if (row.type !== "user") return undefined;

  if (row.origin?.kind === "human") return timestamp;

  // A slash command the user typed with arguments (kawaz r244m18: a /clear
  // whose <command-args> carries the next task's actual prompt). These rows
  // are command plumbing — no origin, no promptSource — but a non-empty args
  // body is text the user wrote, so it counts. A bare command (<command-args>
  // empty or absent) stays out: it repositions the session without saying
  // anything, and the plumbing around it is not the user talking.
  const content = row.message.content;
  if (typeof content !== "string") return undefined;
  if (content.includes("<command-name>") && hasNonEmptyCommandArgs(content)) return timestamp;

  if (row.promptSource !== "system") return undefined;
  if (U1_MSG_EVENT_RE.test(content) || U1_MSG_EVENT_RAW_RE.test(content)) return timestamp;
  return isFromUser(content) ? timestamp : undefined;
}

function isFromUser(text: string): boolean {
  return parseDirectDeliveries(text).some((d) => d.from === DIRECT_DELIVERY_USER_SENDER);
}

interface UserInputFold {
  lastAt?: string;
}

export interface SessionUserInputStore {
  /** The settled fold of each live session. */
  folds: Map<string, UserInputFold>;
}

export function createSessionUserInputStore(): SessionUserInputStore {
  return { folds: new Map() };
}

/** Last user-input time for `sid`, or undefined while the fold has found none
 * (the session is not live, a transcript too old to carry the wire fields,
 * or a session nobody has typed into yet). */
export function lastUserInputAt(store: SessionUserInputStore, sid: string): string | undefined {
  return store.folds.get(sid)?.lastAt;
}

/** Every known value, sid-sorted, for snapshot comparison by value. */
export function userInputEntries(store: SessionUserInputStore): [string, string][] {
  const entries: [string, string][] = [];
  for (const [sid, fold] of store.folds) {
    if (fold.lastAt) entries.push([sid, fold.lastAt]);
  }
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Fold one line, returning whether the state moved. Takes the maximum rather
 * than the last match: transcript rows are appended in order, but a resumed or
 * forked session can splice an older turn in behind a newer one, and "when did
 * the user last speak" must not travel backwards because of it. */
function foldLine(fold: UserInputFold, line: string): boolean {
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok) return false;
  const at = classifyUserInputRow(read.value);
  if (at === undefined) return false;
  if (fold.lastAt !== undefined && at <= fold.lastAt) return false;
  fold.lastAt = at;
  return true;
}

/** `sid`'s last-user-input fold, for the transcript relay. Like
 * session-errors.ts' fold, a catch-up folds into a detached state that
 * replaces the settled one only when it lands. `onChange` is told when the
 * session's value may have moved. */
export function sessionUserInputFold(
  store: SessionUserInputStore,
  sid: string,
  onChange: () => void,
): LineFold {
  let settled: UserInputFold | undefined;
  let next: UserInputFold | undefined;
  let moved = false;
  return {
    restart() {
      next = {};
    },
    take(line) {
      const fold = next ?? settled;
      if (fold !== undefined && isUserInputCandidate(line) && foldLine(fold, line)) moved = true;
    },
    settle() {
      if (next !== undefined) {
        moved ||= next.lastAt !== settled?.lastAt;
        settled = next;
        next = undefined;
        store.folds.set(sid, settled);
      }
      if (!moved) return;
      moved = false;
      onChange();
    },
    close() {
      if (store.folds.get(sid) === settled) store.folds.delete(sid);
      if (settled?.lastAt !== undefined) onChange();
      settled = undefined;
      next = undefined;
    },
  };
}
