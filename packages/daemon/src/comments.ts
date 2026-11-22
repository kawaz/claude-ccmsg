// Comments on a session's Timeline (DR-0062): the person's comments and the
// threads they make, kept in `<stateDir>/sessions/<sid>.comments.jsonl`,
// pushed to the tabs that look at the session (session_status_subscribe),
// sent to the session as the person's prompt (the composer's fill, the
// caller's `sendPrompt`), and seen delivered when the session's transcript
// has their blocks.
//
// Two lines per session keep its work in order (DR-0062 §7, §9, §11):
//
// - The records' line: every stretch that reads a session's records, decides
//   and writes (an op, a send's marks, the delivered check, a turn's end)
//   runs in it, one after another, awaits and all. A stretch is short: it
//   never waits on the session.
// - The sends' line: a prompt put into the session (a comment sent, the FAB's
//   direct prompt) begins once the one before it has its answer, so
//   user_prompt's deadline counts from its own turn in line. While a send
//   waits for its answer the records' line runs on: a change, a delete or a
//   resolve is answered at once.
//
// A line is written to the file before the op answers and the tabs are told
// (§8).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyUserMessage,
  commentBlockOf,
  commentBlockText,
  commentOnlyBlocks,
  CommentsFileLineSchema,
  commentsPromptText,
  ErrorCode,
  errorText,
  isKnownContentBlock,
  isKnownTranscriptRow,
  parseWith,
  msgStartWithOf,
  queuedPersonPrompt,
  TranscriptRowLineSchema,
  type AgentReply,
  type CommentBlock,
  type CommentAnchor,
  type CommentRecord,
  type QueueSendItem,
  type QueueSendRefusal,
  type QueueSendResult,
  type ThreadState,
  type UserComment,
  type UserCommentStatus,
  type UserPromptReason,
} from "@ccmsg/protocol";
import { wireLine } from "./wire-line.ts";

/** `<stateDir>/sessions/<sid>.comments.jsonl`. `sid` is a session id's shape
 * (the ops' schema holds to it), so the file is in that directory. */
export function commentsFile(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.comments.jsonl`);
}

/** What putting a prompt into a session came to (user_prompt's outcome). */
export type PromptOutcome =
  | { outcome: "accepted" }
  | { outcome: "unconfirmed" }
  | { outcome: "not_delivered"; reason: UserPromptReason };

/** A prompt the session's transcript holds: its row and its text. */
export interface LandedPrompt {
  uuid: string;
  text: string;
}

/** Where a comment op's writes go: a tab's connection. */
export interface CommentConn {
  write(line: string): void;
}

export interface CommentStoreDeps {
  stateDir: string;
  now(): Date;
  /** A new comment id (`c` and four letters or digits, CID_PATTERN). */
  newCid(): string;
  log: { info(msg: string): void; warn(msg: string): void };
  /** The uuid of session `sid`'s transcript's last row now (DR-0060 §4's
   * anchor), undefined when it has none or cannot be read. */
  lastRowUuid(sid: string): Promise<string | undefined>;
  /** Put `text` into session `sid` as the person's prompt. */
  sendPrompt(sid: string, text: string): Promise<PromptOutcome>;
  /** The person's prompts of session `sid`'s transcript written at or after
   * `since` (ms since the epoch). */
  landedPrompts(sid: string, since: number): Promise<LandedPrompt[]>;
}

export type CommentOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; msg: string };

/** One session's comments as memory holds them. */
export interface SessionComments {
  /** By cid, in the order they were made. */
  records: Map<string, CommentRecord>;
  /** By the thread's first cid. */
  threads: Map<string, ThreadState>;
}

/** The most records a thread is followed up through, a guard against a
 * file that makes a reply answer itself. */
const MAX_THREAD_DEPTH = 1000;

const PENDING_STATUSES: ReadonlySet<UserCommentStatus> = new Set([
  "sending",
  "sent",
  "unconfirmed",
]);

/** How an op's line is kept: `strict` answers a failed write as the op's
 * failure and changes nothing; `lenient` (what the session did, not the
 * person: a send's answer, a delivered row, a turn's end) logs it and keeps
 * the change in memory, as the session did change. */
type WriteMode = "strict" | "lenient";

/** Run `task` after the one `chains` holds for `sid`, and hold it there. */
function chain<T>(chains: Map<string, Promise<unknown>>, sid: string, task: () => Promise<T>) {
  const before = chains.get(sid) ?? Promise.resolve();
  const next = before.catch(() => {}).then(task);
  chains.set(sid, next);
  void next
    .catch(() => {})
    .then(() => {
      if (chains.get(sid) === next) chains.delete(sid);
    });
  return next;
}

export class CommentStore {
  readonly #deps: CommentStoreDeps;
  readonly #sessions = new Map<string, SessionComments>();
  /** A session's read of its file in flight. */
  readonly #loading = new Map<string, Promise<SessionComments>>();
  readonly #watchers = new Map<string, Set<CommentConn>>();
  /** A session's records' line (DR-0062 §7, §9). */
  readonly #records = new Map<string, Promise<unknown>>();
  /** A session's line of sends (DR-0062 §11). */
  readonly #sends = new Map<string, Promise<unknown>>();
  /** A session's look for delivered blocks in flight, and whether another
   * is asked for after it. */
  readonly #confirming = new Map<string, { again: boolean; done: Promise<void> }>();
  /** When each session's last turn that ended began (ms since the epoch):
   * where the turn that ends next starts to count as the first after a send
   * (DR-0062 P35). Memory only: after a restart the first turn to end counts
   * as the first after every send before it. */
  readonly #lastTurnBegan = new Map<string, number>();

  constructor(deps: CommentStoreDeps) {
    this.#deps = deps;
  }

  // --- the tabs ---

  /** `conn` looks at session `sid`: it gets every comment and thread state
   * now (ev:"comments") and each change from here. */
  async watch(sid: string, conn: CommentConn): Promise<void> {
    const watchers = this.#watchers.get(sid) ?? new Set();
    watchers.add(conn);
    this.#watchers.set(sid, watchers);
    const session = await this.#session(sid);
    if (!this.#watchers.get(sid)?.has(conn)) return;
    conn.write(
      wireLine({
        ev: "comments",
        session_id: sid,
        comments: [...session.records.values()].filter(
          (record) => !(record.author === "user" && record.status === "deleted"),
        ),
        threads: [...session.threads.values()],
      }),
    );
  }

  unwatch(sid: string, conn: CommentConn): void {
    const watchers = this.#watchers.get(sid);
    if (watchers === undefined) return;
    watchers.delete(conn);
    if (watchers.size === 0) this.#watchers.delete(sid);
  }

  /** `conn` closed. */
  unwatchAll(conn: CommentConn): void {
    for (const sid of this.#watchers.keys()) this.unwatch(sid, conn);
  }

  /** Every comment of session `sid` (deleted ones too), in the order made. */
  async list(sid: string): Promise<CommentRecord[]> {
    return [...(await this.#session(sid)).records.values()];
  }

  /** Every thread state of session `sid`. */
  async threads(sid: string): Promise<ThreadState[]> {
    return [...(await this.#session(sid)).threads.values()];
  }

  /** Run `send` (a prompt put into session `sid`) in the session's line of
   * sends, after the ones before it have their answers (DR-0062 §11, P27). */
  inSendLine<T>(sid: string, send: () => Promise<T>): Promise<T> {
    return chain(this.#sends, sid, send);
  }

  // --- the ops (DR-0062 §9) ---

  /** comment_add: keep a new comment, and with `sendNow` send it. */
  async add(
    sid: string,
    input: { anchor: CommentAnchor; body: string; sendNow: boolean },
  ): Promise<CommentOutcome<{ comment: UserComment; outcome?: QueueSendResult }>> {
    const session = await this.#session(sid);
    const added = await this.#locked(sid, async (): Promise<CommentOutcome<UserComment>> => {
      if (input.anchor.kind === "comment" && !repliable(session, input.anchor.cid)) {
        return {
          ok: false,
          code: ErrorCode.not_found,
          msg: `comment ${input.anchor.cid} is not one of session ${sid}'s sent comments`,
        };
      }
      const afterUuid = await this.#deps.lastRowUuid(sid);
      const now = this.#deps.now().toISOString();
      const comment: UserComment = {
        kind: "comment",
        author: "user",
        cid: this.#newCid(session),
        session_id: sid,
        anchor: input.anchor,
        body: input.body,
        written: { at: now, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) },
        updated_at: now,
        btw: false,
        status: "draft",
      };
      const kept = await this.#put(session, [comment], "strict");
      if (!kept.ok) return kept;
      this.#logOp("comment_add", sid, comment.cid, `anchor=${comment.anchor.kind}`, comment.body);
      // A thread that comes alive again is not left hidden (DR-0062 U13, as
      // its recommendation goes).
      await this.#reopen(session, comment.cid);
      return { ok: true, value: comment };
    });
    if (!added.ok) return added;
    const comment = added.value;
    if (!input.sendNow) return { ok: true, value: { comment } };
    const sent = await this.send(sid, [
      { kind: "comment", cid: comment.cid, seen_updated_at: comment.updated_at },
    ]);
    if (!sent.ok) return sent;
    const [outcome] = sent.value;
    const current = session.records.get(comment.cid);
    return {
      ok: true,
      value: {
        comment: current?.author === "user" ? current : comment,
        ...(outcome !== undefined ? { outcome } : {}),
      },
    };
  }

  /** comment_update: change an unsent comment's body. */
  async update(
    sid: string,
    input: { cid: string; seenUpdatedAt: string; body: string },
  ): Promise<CommentOutcome<UserComment>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async () => {
      const found = this.#draft(session, sid, input.cid, input.seenUpdatedAt);
      if (!found.ok) return found;
      const changed: UserComment = {
        ...found.value,
        body: input.body,
        updated_at: this.#deps.now().toISOString(),
      };
      const kept = await this.#put(session, [changed], "strict");
      if (!kept.ok) return kept;
      this.#logOp("comment_update", sid, changed.cid, "", changed.body);
      return { ok: true, value: changed };
    });
  }

  /** comment_delete: take an unsent comment back. */
  async delete(
    sid: string,
    input: { cid: string; seenUpdatedAt: string },
  ): Promise<CommentOutcome<null>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async () => {
      const found = this.#draft(session, sid, input.cid, input.seenUpdatedAt);
      if (!found.ok) return found;
      const kept = await this.#put(
        session,
        [{ ...found.value, status: "deleted", updated_at: this.#deps.now().toISOString() }],
        "strict",
      );
      if (!kept.ok) return kept;
      this.#logOp("comment_delete", sid, input.cid, "");
      return { ok: true, value: null };
    });
  }

  /** comment_resolve: mark the thread `cid` is in resolved, or take the mark
   * off (DR-0062 §6). */
  async resolve(
    sid: string,
    input: { cid: string; resolved: boolean; seenCid: string },
  ): Promise<CommentOutcome<ThreadState>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async (): Promise<CommentOutcome<ThreadState>> => {
      if (!session.records.has(input.cid)) {
        return { ok: false, code: ErrorCode.not_found, msg: `no comment ${input.cid} in ${sid}` };
      }
      const root = this.#rootOf(session, input.cid);
      const rootRecord = session.records.get(root);
      if (
        rootRecord?.author === "user" &&
        (rootRecord.status === "draft" || rootRecord.status === "deleted")
      ) {
        return {
          ok: false,
          code: ErrorCode.invalid_args,
          msg: "a thread whose first comment is not sent is not resolved",
        };
      }
      const members = this.#threadOf(session, root);
      if (input.resolved && members.some((r) => r.author === "user" && r.status === "draft")) {
        return {
          ok: false,
          code: ErrorCode.invalid_args,
          msg: "a thread with an unsent comment is not resolved",
        };
      }
      const newest = members.at(-1)?.cid;
      if (newest !== input.seenCid) {
        return {
          ok: false,
          code: ErrorCode.conflict,
          msg: `the thread has ${newest ?? "nothing"} newer than ${input.seenCid}`,
        };
      }
      const held = session.threads.get(root) ?? { kind: "thread", session_id: sid, root };
      if ((held.resolved_at !== undefined) === input.resolved) return { ok: true, value: held };
      const { resolved_at: _resolvedAt, seen_cid: _seenCid, ...rest } = held;
      const thread: ThreadState = input.resolved
        ? { ...rest, resolved_at: this.#deps.now().toISOString(), seen_cid: input.seenCid }
        : rest;
      const kept = await this.#putThread(session, thread, "strict");
      if (!kept.ok) return kept;
      this.#logOp("comment_resolve", sid, root, `resolved=${String(input.resolved)}`);
      return { ok: true, value: thread };
    });
  }

  /** queue_send: send the items, in their order (DR-0062 §11). The comments
   * that may be sent go as one prompt; the others are refused, each with
   * why. Waits for the session's sends before it. */
  async send(
    sid: string,
    items: readonly QueueSendItem[],
  ): Promise<CommentOutcome<QueueSendResult[]>> {
    const session = await this.#session(sid);
    const marked = await this.#locked(sid, async () => this.#markSending(session, sid, items));
    if (!marked.ok) return marked;
    const { results, sending } = marked.value;
    if (sending.length > 0) {
      const sent = await this.inSendLine(sid, () => this.#sendComments(sid, session, sending));
      for (const [cid, result] of sent) results.set(cid, result);
    }
    return {
      ok: true,
      value: items.flatMap((item) => {
        const result = results.get(item.cid);
        if (result === undefined) return [];
        results.delete(item.cid);
        return [result];
      }),
    };
  }

  /** unconfirmed_settle: make an unconfirmed comment a draft again, or take
   * it as sent (DR-0062 §11, P32). */
  async settle(
    sid: string,
    input: { cid: string; action: "back_to_draft" | "mark_sent"; seenUpdatedAt: string },
  ): Promise<CommentOutcome<UserComment>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async (): Promise<CommentOutcome<UserComment>> => {
      const record = session.records.get(input.cid);
      if (record === undefined || record.author !== "user" || record.status === "deleted") {
        return { ok: false, code: ErrorCode.not_found, msg: `no comment ${input.cid} in ${sid}` };
      }
      // The version first: one another tab settled first is that tab's.
      if (record.updated_at !== input.seenUpdatedAt) {
        return { ok: false, code: ErrorCode.conflict, msg: `comment ${input.cid} changed` };
      }
      if (record.status !== "unconfirmed") {
        return {
          ok: false,
          code: ErrorCode.invalid_args,
          msg: `comment ${input.cid} is ${record.status}, not unconfirmed`,
        };
      }
      const now = this.#deps.now().toISOString();
      let settled: UserComment;
      if (input.action === "back_to_draft") {
        const { sent: _sent, ...rest } = record;
        settled = { ...rest, status: "draft", updated_at: now };
      } else {
        settled = { ...record, status: "sent", updated_at: now };
      }
      const kept = await this.#put(session, [settled], "strict");
      if (!kept.ok) return kept;
      this.#logOp("unconfirmed_settle", sid, input.cid, `action=${input.action}`);
      return { ok: true, value: settled };
    });
  }

  /** comment_reply: keep the agent's reply (its call `toolUseId`) to the
   * comment `cid` (DR-0062 §5), with a new cid. A call already kept answers
   * as it did. What it may answer is a comment the session's own
   * conversation was given (repliableByAgent). */
  async reply(
    sid: string,
    input: { cid: string; body: string; toolUseId: string },
  ): Promise<CommentOutcome<{ cid: string; quote: string }>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async (): Promise<CommentOutcome<{ cid: string; quote: string }>> => {
      const replied = session.records.get(input.cid);
      // The call kept already, whatever became of what it answers since.
      for (const record of session.records.values()) {
        if (record.author === "agent" && record.tool_use_id === input.toolUseId) {
          return {
            ok: true,
            value: { cid: record.cid, quote: replied !== undefined ? recordQuote(replied) : "" },
          };
        }
      }
      if (replied === undefined || !repliableByAgent(replied)) {
        return {
          ok: false,
          code: ErrorCode.not_found,
          msg: `comment ${input.cid} is not one of the comments session ${sid}'s conversation was given`,
        };
      }
      const quote = recordQuote(replied);
      const afterUuid = await this.#deps.lastRowUuid(sid);
      const now = this.#deps.now().toISOString();
      const reply: AgentReply = {
        kind: "comment",
        author: "agent",
        cid: this.#newCid(session),
        session_id: sid,
        anchor: { kind: "comment", cid: input.cid },
        body_start: msgStartWithOf(input.body),
        written: { at: now, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) },
        updated_at: now,
        tool_use_id: input.toolUseId,
      };
      const kept = await this.#put(session, [reply], "strict");
      if (!kept.ok) return kept;
      this.#logOp("comment_reply", sid, reply.cid, `reply_to=${input.cid}`, input.body);
      // A thread that comes alive again is not left hidden (DR-0062 U13, as
      // its recommendation goes).
      await this.#reopen(session, reply.cid);
      return { ok: true, value: { cid: reply.cid, quote } };
    });
  }

  // --- what the session does ---

  /** Rows went into session `sid`'s conversation: when a comment waits to be
   * seen delivered, look for it. */
  rowsPushed(sid: string): void {
    const session = this.#sessions.get(sid);
    if (session === undefined || !hasPending(session)) return;
    void this.confirm(sid);
  }

  /** Session `sid`'s turn that began at `began` (ms since the epoch) ended.
   * What is still `sent` and not seen in the transcript, sent before this
   * turn began and not before the turn that ended last began, is
   * unconfirmed: this turn is the first to end after it was sent (DR-0062
   * P35). One sent during a turn waits for the turn after it, whose prompt
   * row comes at that turn's end. One the person took as sent after its turn
   * ended stays sent. The transcript is looked at first. */
  async turnEnded(sid: string, began: number): Promise<void> {
    const previous = this.#lastTurnBegan.get(sid);
    this.#lastTurnBegan.set(sid, began);
    const session = this.#sessions.get(sid);
    if (session === undefined || !hasPending(session)) return;
    await this.confirm(sid);
    await this.#locked(sid, async () => {
      const now = this.#deps.now().toISOString();
      const dropped: UserComment[] = [];
      for (const record of session.records.values()) {
        if (record.author !== "user" || record.status !== "sent" || record.sent === undefined) {
          continue;
        }
        const sentAt = Date.parse(record.sent.at);
        if (!Number.isFinite(sentAt) || sentAt >= began) continue;
        if (previous !== undefined && sentAt < previous) continue;
        dropped.push({ ...record, status: "unconfirmed", updated_at: now });
      }
      if (dropped.length > 0) await this.#put(session, dropped, "lenient");
    });
  }

  /** Look in session `sid`'s transcript for the blocks of the comments sent
   * and not seen yet, and mark the ones found delivered. One look at a time
   * per session; one asked for meanwhile runs after it. */
  confirm(sid: string): Promise<void> {
    const running = this.#confirming.get(sid);
    if (running !== undefined) {
      running.again = true;
      return running.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await this.#confirmOnce(sid);
        } while (entry.again);
      } finally {
        this.#confirming.delete(sid);
      }
    })();
    this.#confirming.set(sid, entry);
    return entry.done;
  }

  /** Resolves once the sends in line have their answers, the looks for
   * delivered blocks are done and every line written so far is on disk. */
  async settled(): Promise<void> {
    await Promise.all(this.#sends.values());
    await Promise.all([...this.#confirming.values()].map((entry) => entry.done));
    await this.written();
  }

  /** Resolves once every stretch in the records' lines so far is done, and
   * with it its lines on disk. */
  async written(): Promise<void> {
    await Promise.all(this.#loading.values());
    await Promise.all(this.#records.values());
  }

  // --- inside ---

  /** Run `task` in session `sid`'s records' line. */
  #locked<T>(sid: string, task: () => Promise<T>): Promise<T> {
    return chain(this.#records, sid, task);
  }

  /** queue_send's first stretch: each item that may be sent is marked
   * `sending` (one line for them all), the others get why not. */
  async #markSending(
    session: SessionComments,
    sid: string,
    items: readonly QueueSendItem[],
  ): Promise<CommentOutcome<{ results: Map<string, QueueSendResult>; sending: string[] }>> {
    const results = new Map<string, QueueSendResult>();
    const now = this.#deps.now().toISOString();
    const marks: UserComment[] = [];
    for (const item of items) {
      const record = session.records.get(item.cid);
      const taken = marks.some((mark) => mark.cid === item.cid);
      if (record === undefined || record.author !== "user" || record.status === "deleted") {
        results.set(item.cid, refused(item.cid, "not_found"));
      } else if (taken || record.status !== "draft") {
        results.set(item.cid, refused(item.cid, "not_sendable", taken ? "sending" : record.status));
      } else if (record.updated_at !== item.seen_updated_at) {
        results.set(item.cid, refused(item.cid, "conflict"));
      } else if (record.anchor.kind === "comment" && !repliable(session, record.anchor.cid)) {
        // What it replies to went back to a draft (or away) after it was
        // written: its block would name a cid the agent never got.
        results.set(item.cid, refused(item.cid, "not_found"));
      } else {
        marks.push({ ...record, status: "sending", updated_at: now });
      }
    }
    if (marks.length > 0) {
      const kept = await this.#put(session, marks, "strict");
      if (!kept.ok) return kept;
    }
    const refusedCount = results.size;
    this.#deps.log.info(
      `queue_send: session_id=${sid} cids=${items.map((item) => item.cid).join(",")}` +
        ` sending=${String(marks.length)} refused=${String(refusedCount)}`,
    );
    return { ok: true, value: { results, sending: marks.map((mark) => mark.cid) } };
  }

  async #confirmOnce(sid: string): Promise<void> {
    const session = await this.#session(sid);
    const pending = [...session.records.values()].flatMap((record) =>
      record.author === "user" && PENDING_STATUSES.has(record.status) ? [record] : [],
    );
    if (pending.length === 0) return;
    // One left by a send that never had its turn has no `sent`: what it was
    // written at bounds it as well.
    const since = Math.min(...pending.map((c) => Date.parse((c.sent ?? c.written).at)));
    if (!Number.isFinite(since)) return;
    let landed: LandedPrompt[];
    try {
      landed = await this.#deps.landedPrompts(sid, since);
    } catch (e) {
      this.#deps.log.warn(`comments: ${sid}'s transcript was not read: ${errorText(e)}`);
      return;
    }
    await this.#locked(sid, async () => {
      const now = this.#deps.now().toISOString();
      const delivered = new Map<string, UserComment>();
      for (const prompt of landed) {
        // Only a prompt of nothing but comment blocks, as the daemon sends
        // them and the Timeline draws them (DR-0062 §11, §12): one rule for
        // both.
        for (const block of commentOnlyBlocks(prompt.text) ?? []) {
          const record = session.records.get(block.comment);
          if (record?.author !== "user" || !PENDING_STATUSES.has(record.status)) continue;
          if (delivered.has(block.comment)) continue;
          // The block the daemon sent for it (DR-0062 §11 「そのブロックを見たら」):
          // every key alike, not the cid alone, so a row of another text that
          // happens to name a waiting cid is not taken for it.
          if (
            !sameBlock(
              block,
              commentBlockOf(record, (cid) => session.records.get(cid)),
            )
          ) {
            continue;
          }
          delivered.set(block.comment, {
            ...record,
            status: "delivered",
            row_uuid: prompt.uuid,
            updated_at: now,
          });
        }
      }
      if (delivered.size > 0) await this.#put(session, [...delivered.values()], "lenient");
    });
  }

  /** Put the comments in as one prompt and keep what came of it, each
   * comment's result by its cid. Runs in the session's line of sends. A reply
   * whose parent went back to a draft (or away) while it waited in line is a
   * draft again, refused, and not put in. */
  async #sendComments(
    sid: string,
    session: SessionComments,
    queued: readonly string[],
  ): Promise<Map<string, QueueSendResult>> {
    const results = new Map<string, QueueSendResult>();
    const turn = await this.#locked(sid, async () => {
      const afterUuid = await this.#deps.lastRowUuid(sid);
      const now = this.#deps.now().toISOString();
      const point = { at: now, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) };
      const stamped: UserComment[] = [];
      const orphans: UserComment[] = [];
      for (const cid of queued) {
        const record = session.records.get(cid);
        if (record?.author !== "user" || record.status !== "sending") continue;
        if (record.anchor.kind === "comment" && !repliable(session, record.anchor.cid)) {
          orphans.push({ ...record, status: "draft", updated_at: now });
          results.set(cid, refused(cid, "not_found"));
        } else {
          stamped.push({ ...record, sent: point });
        }
      }
      await this.#put(session, [...orphans, ...stamped], "lenient");
      return {
        cids: stamped.map((comment) => comment.cid),
        text: commentsPromptText(
          stamped.map((comment) => commentBlockOf(comment, (cid) => session.records.get(cid))),
        ),
      };
    });
    if (turn.cids.length === 0) return results;
    const { cids, text } = turn;
    let outcome: PromptOutcome;
    try {
      outcome = await this.#deps.sendPrompt(sid, text);
    } catch (e) {
      this.#deps.log.warn(`comments: sending to ${sid} failed: ${errorText(e)}`);
      outcome = { outcome: "unconfirmed" };
    }
    this.#deps.log.info(
      `comment_send: session_id=${sid} cids=${cids.join(",")}` +
        ` outcome=${outcome.outcome}${outcome.outcome === "not_delivered" ? ` (${outcome.reason})` : ""}` +
        ` text_bytes=${String(Buffer.byteLength(text))}`,
    );
    await this.#locked(sid, async () => {
      const now = this.#deps.now().toISOString();
      const settled = cids.flatMap((cid): UserComment[] => {
        const record = session.records.get(cid);
        // Seen in the transcript while the answer was on its way: it stays so.
        if (record?.author !== "user" || record.status !== "sending") return [];
        if (outcome.outcome === "accepted") {
          const { send_error: _error, ...rest } = record;
          return [{ ...rest, status: "sent", updated_at: now }];
        }
        if (outcome.outcome === "unconfirmed") {
          return [{ ...record, status: "unconfirmed", updated_at: now }];
        }
        const { sent: _sent, ...rest } = record;
        return [{ ...rest, status: "draft", send_error: outcome.reason, updated_at: now }];
      });
      if (settled.length > 0) await this.#put(session, settled, "lenient");
    });
    if (outcome.outcome !== "not_delivered") void this.confirm(sid);
    for (const cid of cids) results.set(cid, sendResult(cid, outcome));
    return results;
  }

  /** The unsent comment `cid` at the version `seen`. The version is looked
   * at before the status: a comment another tab sent or changed first is a
   * conflict (DR-0062 §9). */
  #draft(
    session: SessionComments,
    sid: string,
    cid: string,
    seen: string,
  ): CommentOutcome<UserComment> {
    const record = session.records.get(cid);
    if (record === undefined || record.author !== "user" || record.status === "deleted") {
      return { ok: false, code: ErrorCode.not_found, msg: `no comment ${cid} in ${sid}` };
    }
    if (record.updated_at !== seen) {
      return { ok: false, code: ErrorCode.conflict, msg: `comment ${cid} changed` };
    }
    if (record.status !== "draft") {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: `comment ${cid} is ${record.status}: only an unsent comment changes`,
      };
    }
    return { ok: true, value: record };
  }

  #newCid(session: SessionComments): string {
    for (;;) {
      const cid = this.#deps.newCid();
      if (!session.records.has(cid)) return cid;
    }
  }

  /** The first cid of the thread `cid` is in. */
  #rootOf(session: SessionComments, cid: string): string {
    let at = cid;
    for (let depth = 0; depth < MAX_THREAD_DEPTH; depth += 1) {
      const anchor = session.records.get(at)?.anchor;
      if (anchor?.kind !== "comment" || !session.records.has(anchor.cid)) return at;
      at = anchor.cid;
    }
    return at;
  }

  /** The records of the thread that starts at `root`, in the order made,
   * deleted ones left out. */
  #threadOf(session: SessionComments, root: string): CommentRecord[] {
    return [...session.records.values()].filter(
      (record) =>
        !(record.author === "user" && record.status === "deleted") &&
        this.#rootOf(session, record.cid) === root,
    );
  }

  /** `cid` was added to a thread that is resolved: take the mark off. */
  async #reopen(session: SessionComments, cid: string): Promise<void> {
    const root = this.#rootOf(session, cid);
    if (root === cid) return;
    const held = session.threads.get(root);
    if (held?.resolved_at === undefined) return;
    const { resolved_at: _resolvedAt, seen_cid: _seenCid, ...rest } = held;
    await this.#putThread(session, rest, "lenient");
  }

  /** Keep `records` (of one session): on disk first, then in memory and on
   * the tabs. */
  async #put(
    session: SessionComments,
    records: readonly CommentRecord[],
    mode: WriteMode,
  ): Promise<CommentOutcome<null>> {
    const [first] = records;
    if (first === undefined) return { ok: true, value: null };
    const written = await this.#write(first.session_id, records, mode);
    if (!written.ok) return written;
    for (const record of records) {
      session.records.set(record.cid, record);
      this.#broadcast(record.session_id, { ev: "comment", comment: record });
    }
    return written;
  }

  async #putThread(
    session: SessionComments,
    thread: ThreadState,
    mode: WriteMode,
  ): Promise<CommentOutcome<null>> {
    const written = await this.#write(thread.session_id, [thread], mode);
    if (!written.ok) return written;
    session.threads.set(thread.root, thread);
    this.#broadcast(thread.session_id, { ev: "comment_thread", thread });
    return written;
  }

  #broadcast(
    sid: string,
    frame:
      | { ev: "comment"; comment: CommentRecord }
      | { ev: "comment_thread"; thread: ThreadState },
  ): void {
    const watchers = this.#watchers.get(sid);
    if (watchers === undefined || watchers.size === 0) return;
    const line = wireLine(frame);
    for (const conn of watchers) conn.write(line);
  }

  /** Append `lines` to session `sid`'s file in one write. A failure is the
   * op's (`strict`) or a warning (`lenient`). */
  async #write(
    sid: string,
    lines: readonly (CommentRecord | ThreadState)[],
    mode: WriteMode,
  ): Promise<CommentOutcome<null>> {
    const file = commentsFile(this.#deps.stateDir, sid);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.appendFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      return { ok: true, value: null };
    } catch (e) {
      const msg = `the comments of session ${sid} were not written to ${file}: ${errorText(e)}`;
      this.#deps.log.warn(`comments: ${msg}`);
      if (mode === "lenient") return { ok: true, value: null };
      return { ok: false, code: ErrorCode.state_not_writable, msg };
    }
  }

  /** One line of daemon.log for a comment op: the session, the cid, and the
   * body's size, not the body (DR-0062 §9). */
  #logOp(op: string, sid: string, cid: string, detail: string, body?: string): void {
    this.#deps.log.info(
      `${op}: session_id=${sid} cid=${cid}${detail === "" ? "" : ` ${detail}`}` +
        (body !== undefined ? ` body_bytes=${String(Buffer.byteLength(body))}` : ""),
    );
  }

  /** Session `sid`'s comments, read once from its file. A comment the file
   * leaves being sent was sent by a daemon that stopped before its answer:
   * whether it went in is not known (DR-0062 §8). One sent and not seen
   * delivered is looked for in the transcript as the file is read (§11). */
  #session(sid: string): Promise<SessionComments> {
    const held = this.#sessions.get(sid);
    if (held !== undefined) return Promise.resolve(held);
    const loading = this.#loading.get(sid);
    if (loading !== undefined) return loading;
    const load = (async () => {
      const session = await readCommentsFile(commentsFile(this.#deps.stateDir, sid), (msg) =>
        this.#deps.log.warn(msg),
      );
      const now = this.#deps.now().toISOString();
      const stopped = [...session.records.values()].flatMap((record): UserComment[] =>
        record.author === "user" && record.status === "sending"
          ? [{ ...record, status: "unconfirmed", updated_at: now }]
          : [],
      );
      await this.#put(session, stopped, "lenient");
      this.#sessions.set(sid, session);
      this.#loading.delete(sid);
      if (hasPending(session)) void this.confirm(sid);
      return session;
    })();
    this.#loading.set(sid, load);
    return load;
  }
}

/** Whether a comment may reply to `cid` (DR-0062 §9): a record of the
 * session's that is not an unsent or taken back comment of the person's. */
function repliable(session: SessionComments, cid: string): boolean {
  const replied = session.records.get(cid);
  return (
    replied !== undefined &&
    !(replied.author === "user" && (replied.status === "draft" || replied.status === "deleted"))
  );
}

/** Whether the agent may answer `record` with comment_reply (DR-0062 §5): a
 * comment of the person's its session's conversation was given (sent, and
 * not as a btw, which goes to a fork), or a reply of its own. Not an unsent
 * or taken back comment, nor a btw's question or answer. */
function repliableByAgent(record: CommentRecord): boolean {
  switch (record.author) {
    case "user":
      return (
        !record.btw &&
        (record.status === "sent" ||
          record.status === "delivered" ||
          record.status === "unconfirmed")
      );
    case "agent":
      return true;
    case "btw":
      return false;
  }
}

/** Whether two blocks say the same, key by key: their lines, each written in
 * the one order commentBlockText keeps. */
function sameBlock(a: CommentBlock, b: CommentBlock): boolean {
  return commentBlockText(a) === commentBlockText(b);
}

/** The start of what `record` says, as a reply to it quotes it: a person's
 * comment's text, or the start a reply was kept with (its text is the
 * transcript's). */
function recordQuote(record: CommentRecord): string {
  return record.author === "agent" ? (record.body_start ?? "") : msgStartWithOf(record.body);
}

function sendResult(cid: string, outcome: PromptOutcome): QueueSendResult {
  switch (outcome.outcome) {
    case "accepted":
      return { kind: "comment", id: cid, outcome: "sent" };
    case "unconfirmed":
      return { kind: "comment", id: cid, outcome: "unconfirmed" };
    case "not_delivered":
      return { kind: "comment", id: cid, outcome: "not_delivered", reason: outcome.reason };
  }
}

function refused(
  cid: string,
  reason: QueueSendRefusal,
  status?: UserCommentStatus,
): QueueSendResult {
  return {
    kind: "comment",
    id: cid,
    outcome: "refused",
    reason,
    ...(status !== undefined ? { status } : {}),
  };
}

function hasPending(session: SessionComments): boolean {
  for (const record of session.records.values()) {
    if (record.author === "user" && PENDING_STATUSES.has(record.status)) return true;
  }
  return false;
}

/** The comments and thread states of a comments file, a later line over an
 * earlier one of the same cid (or thread). A missing file is none; a line
 * that does not read is passed over and logged. */
export async function readCommentsFile(
  file: string,
  warn: (msg: string) => void,
): Promise<SessionComments> {
  const session: SessionComments = { records: new Map(), threads: new Map() };
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    return session;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const read = parseWith(CommentsFileLineSchema, line);
    if (!read.ok) {
      warn(`comments: a line of ${file} does not read: ${read.failure.summary}`);
      continue;
    }
    const value = read.value;
    if (value.kind === "thread") session.threads.set(value.root, value);
    else session.records.set(value.cid, value);
  }
  return session;
}

/** The person's prompt a transcript line holds, null for any other line
 * (DR-0062 §11's three shapes): a user row the Timeline draws as the
 * person's prompt (`classifyUserMessage`, the one rule the webui draws by),
 * or a `queued_command` row's prompt. */
export function promptTextOfLine(line: string): string | null {
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok || !isKnownTranscriptRow(read.value)) return null;
  const row = read.value;
  if (row.type === "attachment") return queuedPersonPrompt(row);
  if (row.type !== "user" || classifyUserMessage(row) !== "user-prompt") return null;
  const { content } = row.message;
  if (typeof content === "string") return content;
  const texts = content.flatMap((block) =>
    isKnownContentBlock(block) && block.type === "text" ? [block.text] : [],
  );
  return texts.length === 0 ? null : texts.join("\n");
}

const CID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random comment id: `c` and four letters or digits. */
export function randomCid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `c${[...bytes].map((b) => CID_ALPHABET[b % CID_ALPHABET.length] ?? "a").join("")}`;
}
