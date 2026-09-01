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
//      through the session's `ccmsg subscribe` Monitor.
//
// Structurally this is session-errors.ts' twin: the same one-pattern fold over
// the same shared transcript tail, for the same reason (DR-0020 §2.1 (a) — the
// sidebar needs a field for *every* peer, so a per-sid session_status
// subscription is too expensive a source). It tails rather than polls: a
// prompt lands in the list as it is typed.
import { scanTranscriptLines } from "./session-status.ts";
import {
  resolveConnectedTranscript,
  subscribeTranscriptLines,
  unsubscribeTranscriptLines,
  type SessionLookup,
  type TailLog,
  type TranscriptLineListener,
  type TranscriptTailStore,
} from "./transcript.ts";

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
  return line.includes('"kind":"human"') || line.includes("u1") || line.includes("<command-args>");
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
export function classifyUserInputRow(row: Record<string, unknown>): string | undefined {
  if (row.type !== "user" || row.isSidechain === true) return undefined;
  const timestamp = row.timestamp;
  if (typeof timestamp !== "string" || timestamp === "") return undefined;

  const origin = isRecord(row.origin) ? row.origin : null;
  if (origin?.kind === "human") return timestamp;

  // A slash command the user typed with arguments (kawaz r244m18: a /clear
  // whose <command-args> carries the next task's actual prompt). These rows
  // are command plumbing — no origin, no promptSource — but a non-empty args
  // body is text the user wrote, so it counts. A bare command (<command-args>
  // empty or absent) stays out: it repositions the session without saying
  // anything, and the plumbing around it is not the user talking.
  {
    const content = isRecord(row.message) ? row.message.content : undefined;
    if (
      typeof content === "string" &&
      content.includes("<command-name>") &&
      hasNonEmptyCommandArgs(content)
    ) {
      return timestamp;
    }
  }

  if (row.promptSource !== "system") return undefined;
  const content = isRecord(row.message) ? row.message.content : undefined;
  if (typeof content !== "string") return undefined;
  return U1_MSG_EVENT_RE.test(content) || U1_MSG_EVENT_RAW_RE.test(content) ? timestamp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The folded state itself, separable from the watch so a rescan can build a
 * detached one and swap it in only when it completes. */
interface UserInputFold {
  lastAt?: string;
}

interface UserInputWatch extends UserInputFold {
  /** Transcript path this watch and its folded state describe. A re-hello
   * pointing the sid at a different file invalidates both. */
  file: string;
  listener: TranscriptLineListener;
  /** Bumped per rescan; a scan that finds its generation stale on completion
   * was superseded by a later reset and drops its result. */
  rescanGen: number;
  /** True while a rescan is walking the file. Tail lines are buffered rather
   * than folded, since the scan is about to replace the state wholesale. */
  scanning: boolean;
  /** Lines the tail delivered during a rescan, folded in order once it lands. */
  pending: string[];
}

export interface SessionUserInputStore {
  watches: Map<string, UserInputWatch>;
  /** Rescans still walking their transcript, so a caller that needs a settled
   * answer (the `peers` op, tests) can wait for the initial fold instead of
   * reading a list that fills in moments later. */
  inflight: Set<Promise<void>>;
}

export function createSessionUserInputStore(): SessionUserInputStore {
  return { watches: new Map(), inflight: new Set() };
}

/** Resolve once every rescan started so far has folded. */
export async function sessionUserInputsReady(store: SessionUserInputStore): Promise<void> {
  await Promise.all(store.inflight);
}

/** Last user-input time for `sid`, or undefined while the fold has found none
 * (no watch, a transcript too old to carry the wire fields, or a session
 * nobody has typed into yet). */
export function lastUserInputAt(store: SessionUserInputStore, sid: string): string | undefined {
  return store.watches.get(sid)?.lastAt;
}

/** Every known value, sid-sorted, for snapshot comparison by value. */
export function userInputEntries(store: SessionUserInputStore): [string, string][] {
  const entries: [string, string][] = [];
  for (const [sid, watch] of store.watches) {
    if (watch.lastAt) entries.push([sid, watch.lastAt]);
  }
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Fold one line, returning whether the state moved. Takes the maximum rather
 * than the last match: transcript rows are appended in order, but a resumed or
 * forked session can splice an older turn in behind a newer one, and "when did
 * the user last speak" must not travel backwards because of it. */
function foldLine(fold: UserInputFold, line: string): boolean {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord(row)) return false;
  const at = classifyUserInputRow(row);
  if (at === undefined) return false;
  if (fold.lastAt !== undefined && at <= fold.lastAt) return false;
  fold.lastAt = at;
  return true;
}

/** Refold `file` from the start, up to `endOffset` when the caller knows how
 * far the tail has already delivered. Mirrors session-errors.ts' rescan: it
 * folds into a detached state, swaps that in on completion and only then fires
 * `onChange`, so the watch keeps serving its previous value meanwhile. */
function rescan(
  store: SessionUserInputStore,
  watch: UserInputWatch,
  endOffset: number | undefined,
  onChange: () => void,
  log: TailLog,
): void {
  watch.rescanGen += 1;
  const gen = watch.rescanGen;
  watch.scanning = true;
  watch.pending = [];
  const fold: UserInputFold = {};
  const scan = (async () => {
    try {
      await scanTranscriptLines(watch.file, endOffset, (line) => {
        if (isUserInputCandidate(line)) foldLine(fold, line);
      });
    } catch {
      // leave empty
    }
    if (gen !== watch.rescanGen) return;
    watch.lastAt = fold.lastAt;
    watch.scanning = false;
    const pending = watch.pending;
    watch.pending = [];
    for (const line of pending) {
      if (isUserInputCandidate(line)) foldLine(watch, line);
    }
    onChange();
  })();
  const tracked = scan.catch((e: unknown) => {
    watch.scanning = false;
    log.error(`session_user_input rescan failed file=${watch.file}: ${String(e)}`);
  });
  store.inflight.add(tracked);
  void tracked.finally(() => store.inflight.delete(tracked));
}

/**
 * Bring the watched set in line with `sids` (the currently connected peers):
 * start folding newly connected sessions, drop gone ones, and rebuild any
 * whose transcript path changed. Fires `onChange` at most once synchronously,
 * and only when the resulting entry list differs — including the "a watched
 * session disconnected" case, where it shrinks with no transcript event. A
 * newly started watch folds asynchronously and fires `onChange` again when
 * that lands.
 *
 * Sessions with no resolvable transcript are skipped rather than recorded with
 * no value: not knowing is the same outcome either way, and a skipped sid costs
 * nothing to retry on the next sync.
 */
export function syncUserInputWatches(
  store: SessionUserInputStore,
  transcriptTail: TranscriptTailStore,
  sessions: SessionLookup,
  sids: Iterable<string>,
  log: TailLog,
  onChange: () => void,
): void {
  const before = JSON.stringify(userInputEntries(store));
  const wanted = new Set(sids);

  for (const [sid, watch] of store.watches) {
    const resolved = resolveConnectedTranscript(sessions, sid);
    const stillValid = wanted.has(sid) && resolved.ok && resolved.file === watch.file;
    if (stillValid) continue;
    unsubscribeTranscriptLines(transcriptTail, sid, watch.listener);
    store.watches.delete(sid);
  }

  for (const sid of wanted) {
    if (store.watches.has(sid)) continue;
    const resolved = resolveConnectedTranscript(sessions, sid);
    if (!resolved.ok) continue;
    const watch: UserInputWatch = {
      file: resolved.file,
      rescanGen: 0,
      scanning: false,
      pending: [],
      listener(payload) {
        if (payload.lines.length === 0) {
          // Watch reset (truncate / replacement file): the folded state
          // describes bytes that no longer exist.
          rescan(store, watch, payload.size, onChange, log);
          return;
        }
        if (watch.scanning) {
          watch.pending.push(...payload.lines);
          return;
        }
        let changed = false;
        for (const line of payload.lines) {
          if (isUserInputCandidate(line) && foldLine(watch, line)) changed = true;
        }
        if (changed) onChange();
      },
    };
    const subscribed = subscribeTranscriptLines(transcriptTail, sessions, sid, watch.listener, log);
    if (!subscribed.ok) continue;
    watch.file = subscribed.data.file;
    rescan(store, watch, subscribed.data.size, onChange, log);
    store.watches.set(sid, watch);
  }

  if (JSON.stringify(userInputEntries(store)) !== before) onChange();
}

/** Drop every watch (daemon shutdown). */
export function stopAllUserInputs(
  store: SessionUserInputStore,
  transcriptTail: TranscriptTailStore,
): void {
  for (const [sid, watch] of store.watches) {
    unsubscribeTranscriptLines(transcriptTail, sid, watch.listener);
  }
  store.watches.clear();
}
