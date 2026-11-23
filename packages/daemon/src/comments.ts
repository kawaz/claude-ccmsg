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
//
// The FAB's drafts (§15) are kept here too, in `<sid>.queue.jsonl`
// (prompt-queue.ts): they go through the same two lines, and a send of
// everything puts the comments in first and the drafts after, one prompt per
// draft.
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
  pairLandedPrompts,
  promptDraftText,
  queuedPersonPrompt,
  TranscriptRowLineSchema,
  type AgentReply,
  type CommentBlock,
  type CommentAnchor,
  type CommentRecord,
  type PromptDraftAttachment,
  type PromptDraftRecord,
  type PromptDraftStatus,
  type QueueFileLine,
  type QueueSendItem,
  type QueueSendRefusal,
  type QueueSendResult,
  type ThreadState,
  type UserComment,
  type UserCommentStatus,
  type UserPromptReason,
} from "@ccmsg/protocol";
import {
  appendQueueLines,
  draftAttachmentFile,
  missingAttachment,
  moveFile,
  placeholderNumbers,
  queueFile,
  readQueueFile,
  renumberPlaceholders,
} from "./prompt-queue.ts";
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

/** A prompt the session's transcript holds: its row, its text, and when the
 * row was written (ISO-8601; empty when the row has no time). */
export interface LandedPrompt {
  uuid: string;
  text: string;
  at: string;
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
  /** A new FAB's draft id (a UUID). */
  newDraftId(): string;
  /** Where POST /attachment puts the files uploaded: the only place a draft's
   * new attachment is taken from (attachment.ts). */
  uploadDir: string;
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
  /** The FAB's drafts by id, in the order put (DR-0062 §15). */
  drafts: Map<string, PromptDraftRecord>;
  /** The `[FILE<n>]` number the session's next attachment (a FAB's draft's
   * or a comment's) gets. */
  nextFile: number;
}

/** The most records a thread is followed up through, a guard against a
 * file that makes a reply answer itself. */
const MAX_THREAD_DEPTH = 1000;

const PENDING_STATUSES: ReadonlySet<UserCommentStatus> = new Set([
  "sending",
  "sent",
  "unconfirmed",
]);

/** A draft put in (or being put in, its time stamped) and not seen in the
 * transcript yet: what the delivered check pairs with the person's rows. */
function draftPending(draft: PromptDraftRecord): boolean {
  return (
    draft.status === "sent" ||
    draft.status === "unconfirmed" ||
    (draft.status === "sending" && draft.sent !== undefined)
  );
}

/** A queue_send item's key in its results: its kind and its id. */
function itemKey(item: { kind: "comment" | "draft"; id: string }): string {
  return `${item.kind}:${item.id}`;
}

function keyOf(item: QueueSendItem): string {
  return itemKey(item.kind === "comment" ? { kind: "comment", id: item.cid } : item);
}

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
        // A sent draft is on its way to being gone (DR-0062 §10).
        drafts: [...session.drafts.values()].filter((draft) => draft.status !== "sent"),
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

  /** comment_add: keep a new comment, and with `sendNow` send it. Its
   * attachments move under the state dir and get the session's next numbers
   * (the FAB's drafts' line of numbers), its body's `[FILE<n>]` with them
   * (DR-0062 §15). */
  async add(
    sid: string,
    input: {
      anchor: CommentAnchor;
      body: string;
      /** None when absent. */
      attachments?: readonly PromptDraftAttachment[] | undefined;
      sendNow: boolean;
    },
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
      const taken = await this.#takeAttachments(
        session,
        sid,
        { text: input.body, attachments: input.attachments ?? [] },
        [],
      );
      if (!taken.ok) return taken;
      const afterUuid = await this.#deps.lastRowUuid(sid);
      const now = this.#deps.now().toISOString();
      const comment: UserComment = {
        kind: "comment",
        author: "user",
        cid: this.#newCid(session),
        session_id: sid,
        anchor: input.anchor,
        body: taken.value.text,
        ...(taken.value.attachments.length > 0 ? { attachments: taken.value.attachments } : {}),
        written: { at: now, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) },
        updated_at: now,
        btw: false,
        status: "draft",
      };
      const kept = await this.#putWithFiles(session, sid, comment, taken.value);
      if (!kept.ok) return kept;
      this.#logOp(
        "comment_add",
        sid,
        comment.cid,
        `anchor=${comment.anchor.kind} attachments=${String(taken.value.attachments.length)}`,
        comment.body,
      );
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

  /** comment_update: change an unsent comment's body and attachments. An
   * attachment it holds (the same path) keeps its number; a new one moves
   * and gets the session's next. No `attachments` keeps the ones it holds. */
  async update(
    sid: string,
    input: {
      cid: string;
      seenUpdatedAt: string;
      body: string;
      attachments?: readonly PromptDraftAttachment[] | undefined;
    },
  ): Promise<CommentOutcome<UserComment>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async (): Promise<CommentOutcome<UserComment>> => {
      const found = this.#draft(session, sid, input.cid, input.seenUpdatedAt);
      if (!found.ok) return found;
      const held = found.value.attachments ?? [];
      const taken = await this.#takeAttachments(
        session,
        sid,
        { text: input.body, attachments: input.attachments ?? held },
        held,
      );
      if (!taken.ok) return taken;
      const { attachments: _held, ...rest } = found.value;
      const changed: UserComment = {
        ...rest,
        body: taken.value.text,
        ...(taken.value.attachments.length > 0 ? { attachments: taken.value.attachments } : {}),
        updated_at: this.#deps.now().toISOString(),
      };
      const kept = await this.#putWithFiles(session, sid, changed, taken.value);
      if (!kept.ok) return kept;
      this.#logOp(
        "comment_update",
        sid,
        changed.cid,
        `attachments=${String(taken.value.attachments.length)}`,
        changed.body,
      );
      return { ok: true, value: changed };
    });
  }

  /** Keep `comment`, whose attachments `taken` moved: the session's next
   * number first (the queue file's `file_seq`, so a number given is never
   * given again even when the comment's line is not written), then the
   * comment. The files go back when the comment is not kept. */
  async #putWithFiles(
    session: SessionComments,
    sid: string,
    comment: UserComment,
    taken: { nextFile: number; undo(): Promise<void> },
  ): Promise<CommentOutcome<null>> {
    const numbered = await this.#putDrafts(session, sid, [], "strict", taken.nextFile);
    const kept = numbered.ok ? await this.#put(session, [comment], "strict") : numbered;
    if (!kept.ok) await taken.undo();
    return kept;
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

  /** queue_send: send the items (DR-0062 §11). The comments that may be sent
   * go first, as one prompt in the order given; then the FAB's drafts that
   * may be sent, one prompt each in the order given, none after one that was
   * not put in (P7: nor after comments that were not). The others are
   * refused, each with why. Waits for the session's sends before it. */
  async send(
    sid: string,
    items: readonly QueueSendItem[],
  ): Promise<CommentOutcome<QueueSendResult[]>> {
    const session = await this.#session(sid);
    const marked = await this.#locked(sid, async () => this.#markSending(session, sid, items));
    if (!marked.ok) return marked;
    const { results, sending, drafts } = marked.value;
    if (sending.length > 0 || drafts.length > 0) {
      const sent = await this.inSendLine(sid, async () => {
        const comments =
          sending.length > 0
            ? await this.#sendComments(sid, session, sending)
            : new Map<string, QueueSendResult>();
        let stopped: UserPromptReason | undefined;
        for (const result of comments.values()) {
          if (result.outcome === "not_delivered") stopped = result.reason;
        }
        const sentDrafts = await this.#sendDrafts(sid, session, drafts, stopped);
        return [...comments.values(), ...sentDrafts];
      });
      for (const result of sent) results.set(itemKey(result), result);
    }
    return {
      ok: true,
      value: items.flatMap((item) => {
        const key = keyOf(item);
        const result = results.get(key);
        if (result === undefined) return [];
        results.delete(key);
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

  // --- the FAB's queue (DR-0062 §15) ---

  /** prompt_queue_add: keep a prompt to send later. Its attachments move
   * under the state dir and get the session's next numbers, its text's
   * `[FILE<n>]` with them. */
  async queueAdd(
    sid: string,
    input: { text: string; attachments: readonly PromptDraftAttachment[] },
  ): Promise<CommentOutcome<PromptDraftRecord>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async (): Promise<CommentOutcome<PromptDraftRecord>> => {
      const taken = await this.#takeAttachments(session, sid, input, []);
      if (!taken.ok) return taken;
      const afterUuid = await this.#deps.lastRowUuid(sid);
      const now = this.#deps.now().toISOString();
      const draft: PromptDraftRecord = {
        kind: "draft",
        id: this.#deps.newDraftId(),
        session_id: sid,
        written: { at: now, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) },
        updated_at: now,
        text: taken.value.text,
        attachments: taken.value.attachments,
        status: "queued",
      };
      const kept = await this.#putDrafts(session, sid, [draft], "strict", taken.value.nextFile);
      if (!kept.ok) {
        await taken.value.undo();
        return kept;
      }
      this.#logOp(
        "prompt_queue_add",
        sid,
        draft.id,
        `attachments=${String(draft.attachments.length)}`,
        draft.text,
      );
      return { ok: true, value: draft };
    });
  }

  /** prompt_queue_update: change a queued draft, at the version the person
   * saw. An attachment it holds (the same path) keeps its number. */
  async queueUpdate(
    sid: string,
    input: {
      id: string;
      seenUpdatedAt: string;
      text: string;
      attachments: readonly PromptDraftAttachment[];
    },
  ): Promise<CommentOutcome<PromptDraftRecord>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async (): Promise<CommentOutcome<PromptDraftRecord>> => {
      const found = queuedDraft(session, sid, input.id, input.seenUpdatedAt);
      if (!found.ok) return found;
      const taken = await this.#takeAttachments(session, sid, input, found.value.attachments);
      if (!taken.ok) return taken;
      const changed: PromptDraftRecord = {
        ...found.value,
        text: taken.value.text,
        attachments: taken.value.attachments,
        updated_at: this.#deps.now().toISOString(),
      };
      const kept = await this.#putDrafts(session, sid, [changed], "strict", taken.value.nextFile);
      if (!kept.ok) {
        await taken.value.undo();
        return kept;
      }
      this.#logOp(
        "prompt_queue_update",
        sid,
        changed.id,
        `attachments=${String(changed.attachments.length)}`,
        changed.text,
      );
      return { ok: true, value: changed };
    });
  }

  /** prompt_queue_delete: take a queued draft away. Its record goes; the
   * files it attached stay (the state dir's clean-up takes them). */
  async queueDelete(
    sid: string,
    input: { id: string; seenUpdatedAt: string },
  ): Promise<CommentOutcome<null>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async () => {
      const found = queuedDraft(session, sid, input.id, input.seenUpdatedAt);
      if (!found.ok) return found;
      const removed = await this.#removeDrafts(session, sid, [input.id], "strict");
      if (!removed.ok) return removed;
      this.#logOp("prompt_queue_delete", sid, input.id, "");
      return { ok: true, value: null };
    });
  }

  /** unconfirmed_settle of a draft: queue it again, or take it as sent (its
   * record goes, DR-0062 裁定 3). */
  async settleDraft(
    sid: string,
    input: { id: string; action: "back_to_draft" | "mark_sent"; seenUpdatedAt: string },
  ): Promise<CommentOutcome<null>> {
    const session = await this.#session(sid);
    return this.#locked(sid, async (): Promise<CommentOutcome<null>> => {
      const record = session.drafts.get(input.id);
      if (record === undefined) {
        return { ok: false, code: ErrorCode.not_found, msg: `no draft ${input.id} in ${sid}` };
      }
      if (record.updated_at !== input.seenUpdatedAt) {
        return { ok: false, code: ErrorCode.conflict, msg: `draft ${input.id} changed` };
      }
      if (record.status !== "unconfirmed") {
        return {
          ok: false,
          code: ErrorCode.invalid_args,
          msg: `draft ${input.id} is ${record.status}, not unconfirmed`,
        };
      }
      let kept: CommentOutcome<null>;
      if (input.action === "back_to_draft") {
        const { sent: _sent, ...rest } = record;
        const queued: PromptDraftRecord = {
          ...rest,
          status: "queued",
          updated_at: this.#deps.now().toISOString(),
        };
        kept = await this.#putDrafts(session, sid, [queued], "strict");
      } else {
        kept = await this.#removeDrafts(session, sid, [input.id], "strict");
      }
      if (!kept.ok) return kept;
      this.#logOp("unconfirmed_settle", sid, input.id, `draft action=${input.action}`);
      return { ok: true, value: null };
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
      // The FAB's drafts the same way (DR-0062 §11, P35).
      const droppedDrafts: PromptDraftRecord[] = [];
      for (const draft of session.drafts.values()) {
        if (draft.status !== "sent" || draft.sent === undefined) continue;
        const sentAt = Date.parse(draft.sent.at);
        if (!Number.isFinite(sentAt) || sentAt >= began) continue;
        if (previous !== undefined && sentAt < previous) continue;
        droppedDrafts.push({ ...draft, status: "unconfirmed", updated_at: now });
      }
      if (droppedDrafts.length > 0) {
        await this.#putDrafts(session, sid, droppedDrafts, "lenient");
      }
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
   * `sending` (one line per file for them all), the others get why not. */
  async #markSending(
    session: SessionComments,
    sid: string,
    items: readonly QueueSendItem[],
  ): Promise<
    CommentOutcome<{
      results: Map<string, QueueSendResult>;
      sending: string[];
      drafts: string[];
    }>
  > {
    const results = new Map<string, QueueSendResult>();
    const now = this.#deps.now().toISOString();
    const marks: UserComment[] = [];
    const draftMarks: PromptDraftRecord[] = [];
    for (const item of items) {
      if (item.kind === "draft") {
        const draft = session.drafts.get(item.id);
        const taken = draftMarks.some((mark) => mark.id === item.id);
        if (draft === undefined) {
          results.set(keyOf(item), refusedDraft(item.id, "not_found"));
        } else if (taken || draft.status !== "queued") {
          results.set(
            keyOf(item),
            refusedDraft(item.id, "not_sendable", taken ? "sending" : draft.status),
          );
        } else if (draft.updated_at !== item.seen_updated_at) {
          results.set(keyOf(item), refusedDraft(item.id, "conflict"));
        } else {
          draftMarks.push({ ...draft, status: "sending", updated_at: now });
        }
        continue;
      }
      const record = session.records.get(item.cid);
      const taken = marks.some((mark) => mark.cid === item.cid);
      if (record === undefined || record.author !== "user" || record.status === "deleted") {
        results.set(keyOf(item), refused(item.cid, "not_found"));
      } else if (taken || record.status !== "draft") {
        results.set(
          keyOf(item),
          refused(item.cid, "not_sendable", taken ? "sending" : record.status),
        );
      } else if (record.updated_at !== item.seen_updated_at) {
        results.set(keyOf(item), refused(item.cid, "conflict"));
      } else if (record.anchor.kind === "comment" && !repliable(session, record.anchor.cid)) {
        // What it replies to went back to a draft (or away) after it was
        // written: its block would name a cid the agent never got.
        results.set(keyOf(item), refused(item.cid, "not_found"));
      } else {
        marks.push({ ...record, status: "sending", updated_at: now });
      }
    }
    if (draftMarks.length > 0) {
      const kept = await this.#putDrafts(session, sid, draftMarks, "strict");
      if (!kept.ok) return kept;
    }
    if (marks.length > 0) {
      const kept = await this.#put(session, marks, "strict");
      if (!kept.ok) {
        // The drafts marked go back as they were: nothing is sent.
        const back = draftMarks.flatMap((mark) => {
          const before = items.find((item) => item.kind === "draft" && item.id === mark.id);
          return before === undefined
            ? []
            : [{ ...mark, status: "queued" as const, updated_at: before.seen_updated_at }];
        });
        await this.#putDrafts(session, sid, back, "lenient");
        return kept;
      }
    }
    this.#deps.log.info(
      `queue_send: session_id=${sid} items=${items.map((item) => (item.kind === "comment" ? item.cid : item.id)).join(",")}` +
        ` sending=${String(marks.length + draftMarks.length)} refused=${String(results.size)}`,
    );
    return {
      ok: true,
      value: {
        results,
        sending: marks.map((mark) => mark.cid),
        drafts: draftMarks.map((mark) => mark.id),
      },
    };
  }

  /** Put the drafts in, one prompt each in their order, and keep what came
   * of each. Runs in the session's line of sends. A draft whose attachment is
   * gone is queued again and refused. Once one is not put in (or `stopped`,
   * the comments sent before them were not), the rest are queued again with
   * that reason, not tried (P7). */
  async #sendDrafts(
    sid: string,
    session: SessionComments,
    ids: readonly string[],
    stopped: UserPromptReason | undefined,
  ): Promise<QueueSendResult[]> {
    const results: QueueSendResult[] = [];
    let stop = stopped;
    for (const id of ids) {
      if (stop !== undefined) {
        const reason = stop;
        await this.#locked(sid, async () => {
          const draft = session.drafts.get(id);
          if (draft?.status !== "sending") return;
          const { sent: _sent, ...rest } = draft;
          const queued: PromptDraftRecord = {
            ...rest,
            status: "queued",
            send_error: reason,
            updated_at: this.#deps.now().toISOString(),
          };
          await this.#putDrafts(session, sid, [queued], "lenient");
        });
        results.push({ kind: "draft", id, outcome: "not_delivered", reason });
        continue;
      }
      const turn = await this.#locked(sid, async (): Promise<string | QueueSendResult | null> => {
        const draft = session.drafts.get(id);
        if (draft?.status !== "sending") return null;
        const missing = await missingAttachment(draft.attachments);
        const now = this.#deps.now().toISOString();
        if (missing !== undefined) {
          this.#deps.log.warn(
            `prompt_send: session_id=${sid} id=${id} attachment [FILE${String(missing.n)}] is gone: ${missing.path}`,
          );
          await this.#putDrafts(
            session,
            sid,
            [{ ...draft, status: "queued", updated_at: now }],
            "lenient",
          );
          return refusedDraft(id, "attachment_missing");
        }
        const afterUuid = await this.#deps.lastRowUuid(sid);
        const stamped: PromptDraftRecord = {
          ...draft,
          sent: { at: now, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) },
        };
        await this.#putDrafts(session, sid, [stamped], "lenient");
        return promptDraftText(stamped);
      });
      if (turn === null) continue;
      if (typeof turn !== "string") {
        results.push(turn);
        continue;
      }
      let outcome: PromptOutcome;
      try {
        outcome = await this.#deps.sendPrompt(sid, turn);
      } catch (e) {
        this.#deps.log.warn(`queue: sending to ${sid} failed: ${errorText(e)}`);
        outcome = { outcome: "unconfirmed" };
      }
      this.#deps.log.info(
        `prompt_send: session_id=${sid} id=${id}` +
          ` outcome=${outcome.outcome}${outcome.outcome === "not_delivered" ? ` (${outcome.reason})` : ""}` +
          ` text_bytes=${String(Buffer.byteLength(turn))}`,
      );
      await this.#locked(sid, async () => {
        const draft = session.drafts.get(id);
        // Seen in the transcript (and gone) while the answer was on its way.
        if (draft?.status !== "sending") return;
        const now = this.#deps.now().toISOString();
        let settled: PromptDraftRecord;
        if (outcome.outcome === "accepted") {
          const { send_error: _error, ...rest } = draft;
          settled = { ...rest, status: "sent", updated_at: now };
        } else if (outcome.outcome === "unconfirmed") {
          settled = { ...draft, status: "unconfirmed", updated_at: now };
        } else {
          const { sent: _sent, ...rest } = draft;
          settled = { ...rest, status: "queued", send_error: outcome.reason, updated_at: now };
        }
        await this.#putDrafts(session, sid, [settled], "lenient");
      });
      if (outcome.outcome === "not_delivered") stop = outcome.reason;
      else void this.confirm(sid);
      results.push(draftSendResult(id, outcome));
    }
    return results;
  }

  /** The attachments `given` (numbered as `text` names them) as a draft or
   * a comment keeps them: one `held` holds (the same path) keeps its number and file;
   * a new one is an uploaded file, moved under the state dir and numbered on
   * from the session's next (past the numbers `text` names without an
   * attachment, so a stale `[FILE<n>]` is not taken for it). `text` comes
   * back with the new numbers, with the session's next number after them and
   * a way to move the files back when the draft is not kept. */
  async #takeAttachments(
    session: SessionComments,
    sid: string,
    given: { text: string; attachments: readonly PromptDraftAttachment[] },
    held: readonly PromptDraftAttachment[],
  ): Promise<
    CommentOutcome<{
      text: string;
      attachments: PromptDraftAttachment[];
      nextFile: number;
      undo(): Promise<void>;
    }>
  > {
    const givenNumbers = new Set(given.attachments.map((a) => a.n));
    const givenPaths = new Set(given.attachments.map((a) => a.path));
    if (
      givenNumbers.size !== given.attachments.length ||
      givenPaths.size !== given.attachments.length
    ) {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: "two attachments have the same number or the same file",
      };
    }
    const stale = new Set([...placeholderNumbers(given.text)].filter((n) => !givenNumbers.has(n)));
    const heldByPath = new Map(held.map((a) => [a.path, a] as const));
    let next = session.nextFile;
    const numbers = new Map<number, number>();
    const attachments: PromptDraftAttachment[] = [];
    const moves: { from: string; to: string }[] = [];
    for (const attachment of given.attachments) {
      const kept = heldByPath.get(attachment.path);
      if (kept !== undefined) {
        numbers.set(attachment.n, kept.n);
        attachments.push({ ...attachment, n: kept.n });
        continue;
      }
      const to = draftAttachmentFile(
        this.#deps.stateDir,
        this.#deps.uploadDir,
        sid,
        attachment.path,
      );
      if (to === null) {
        return {
          ok: false,
          code: ErrorCode.invalid_args,
          msg: `attachment [FILE${String(attachment.n)}] is not a file uploaded to this daemon`,
        };
      }
      while (stale.has(next)) next += 1;
      numbers.set(attachment.n, next);
      attachments.push({ ...attachment, n: next, path: to });
      moves.push({ from: attachment.path, to });
      next += 1;
    }
    const undo = async (): Promise<void> => {
      for (const move of moves) {
        await moveFile(move.to, move.from).catch(() => {});
      }
    };
    const done: { from: string; to: string }[] = [];
    for (const move of moves) {
      try {
        await moveFile(move.from, move.to);
        done.push(move);
      } catch (e) {
        for (const back of done) await moveFile(back.to, back.from).catch(() => {});
        return {
          ok: false,
          code: ErrorCode.not_found,
          msg: `the attachment ${move.from} was not moved: ${errorText(e)}`,
        };
      }
    }
    return {
      ok: true,
      value: {
        text: renumberPlaceholders(given.text, numbers),
        attachments,
        nextFile: next,
        undo,
      },
    };
  }

  async #confirmOnce(sid: string): Promise<void> {
    const session = await this.#session(sid);
    const pending = [...session.records.values()].flatMap((record) =>
      record.author === "user" && PENDING_STATUSES.has(record.status) ? [record] : [],
    );
    const pendingDrafts = [...session.drafts.values()].filter(draftPending);
    if (pending.length === 0 && pendingDrafts.length === 0) return;
    // One left by a send that never had its turn has no `sent`: what it was
    // written at bounds it as well.
    const since = Math.min(
      ...[...pending, ...pendingDrafts].map((c) => Date.parse((c.sent ?? c.written).at)),
    );
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
      // A FAB's draft landed is its text (attachments put in) as a person's
      // row written after it was sent, each row taking one draft, the oldest
      // first (DR-0062 §11, DR-0035 §5's parts): its record goes (裁定 3).
      const drafts = [...session.drafts.values()].filter(draftPending).map((draft) => ({
        id: draft.id,
        text: promptDraftText(draft),
        at: (draft.sent ?? draft.written).at,
      }));
      const landedDrafts = pairLandedPrompts(drafts, landed).map((pair) => pair.sent.id);
      if (landedDrafts.length > 0) {
        await this.#removeDrafts(session, sid, landedDrafts, "lenient");
        this.#deps.log.info(`prompt_landed: session_id=${sid} ids=${landedDrafts.join(",")}`);
      }
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
          continue;
        }
        // A file it attaches is gone (DR-0062 §11, as a FAB's draft's): it
        // stays a draft, and the others go without it.
        const missing = await missingAttachment(record.attachments ?? []);
        if (missing !== undefined) {
          this.#deps.log.warn(
            `comment_send: session_id=${sid} cid=${cid} attachment [FILE${String(missing.n)}] is gone: ${missing.path}`,
          );
          orphans.push({ ...record, status: "draft", updated_at: now });
          results.set(cid, refused(cid, "attachment_missing"));
          continue;
        }
        stamped.push({ ...record, sent: point });
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

  /** Keep `drafts` (of session `sid`), and with `nextFile` the session's next
   * attachment number (a `file_seq` line before them): on disk first, then in
   * memory and on the tabs. */
  async #putDrafts(
    session: SessionComments,
    sid: string,
    drafts: readonly PromptDraftRecord[],
    mode: WriteMode,
    nextFile?: number,
  ): Promise<CommentOutcome<null>> {
    const seq: QueueFileLine[] =
      nextFile !== undefined && nextFile !== session.nextFile
        ? [{ kind: "file_seq", next: nextFile }]
        : [];
    if (drafts.length === 0 && seq.length === 0) return { ok: true, value: null };
    const written = await this.#writeQueue(sid, [...seq, ...drafts], mode);
    if (!written.ok) return written;
    if (nextFile !== undefined) session.nextFile = Math.max(session.nextFile, nextFile);
    for (const draft of drafts) {
      session.drafts.set(draft.id, draft);
      this.#broadcast(sid, { ev: "prompt_draft", draft });
    }
    return written;
  }

  /** Take the drafts `ids` of session `sid` away: their records go (one
   * `draft_removed` line each), their files stay. */
  async #removeDrafts(
    session: SessionComments,
    sid: string,
    ids: readonly string[],
    mode: WriteMode,
  ): Promise<CommentOutcome<null>> {
    if (ids.length === 0) return { ok: true, value: null };
    const written = await this.#writeQueue(
      sid,
      ids.map((id) => ({ kind: "draft_removed", id })),
      mode,
    );
    if (!written.ok) return written;
    for (const id of ids) {
      session.drafts.delete(id);
      this.#broadcast(sid, { ev: "prompt_draft_removed", session_id: sid, id });
    }
    return written;
  }

  /** Append `lines` to session `sid`'s queue file in one write. A failure is
   * the op's (`strict`) or a warning (`lenient`). */
  async #writeQueue(
    sid: string,
    lines: readonly QueueFileLine[],
    mode: WriteMode,
  ): Promise<CommentOutcome<null>> {
    const file = queueFile(this.#deps.stateDir, sid);
    try {
      await appendQueueLines(file, lines);
      return { ok: true, value: null };
    } catch (e) {
      const msg = `the queue of session ${sid} was not written to ${file}: ${errorText(e)}`;
      this.#deps.log.warn(`queue: ${msg}`);
      if (mode === "lenient") return { ok: true, value: null };
      return { ok: false, code: ErrorCode.state_not_writable, msg };
    }
  }

  #broadcast(
    sid: string,
    frame:
      | { ev: "comment"; comment: CommentRecord }
      | { ev: "comment_thread"; thread: ThreadState }
      | { ev: "prompt_draft"; draft: PromptDraftRecord }
      | { ev: "prompt_draft_removed"; session_id: string; id: string },
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
      const warn = (msg: string) => this.#deps.log.warn(msg);
      // The queue file is rewritten to what is still there as it is read
      // (P34): no op of the session runs before its load is done.
      const session: SessionComments = {
        ...(await readCommentsFile(commentsFile(this.#deps.stateDir, sid), warn)),
        ...(await readQueueFile(queueFile(this.#deps.stateDir, sid), warn)),
      };
      // A number a comment holds is never given again either: the comments
      // and the FAB's drafts are numbered in one line (DR-0062 §15).
      for (const record of session.records.values()) {
        if (record.author !== "user") continue;
        for (const attachment of record.attachments ?? []) {
          session.nextFile = Math.max(session.nextFile, attachment.n + 1);
        }
      }
      const now = this.#deps.now().toISOString();
      const stopped = [...session.records.values()].flatMap((record): UserComment[] =>
        record.author === "user" && record.status === "sending"
          ? [{ ...record, status: "unconfirmed", updated_at: now }]
          : [],
      );
      await this.#put(session, stopped, "lenient");
      const stoppedDrafts = [...session.drafts.values()].flatMap((draft): PromptDraftRecord[] =>
        draft.status === "sending" ? [{ ...draft, status: "unconfirmed", updated_at: now }] : [],
      );
      await this.#putDrafts(session, sid, stoppedDrafts, "lenient");
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
  for (const draft of session.drafts.values()) {
    if (draftPending(draft)) return true;
  }
  return false;
}

/** The queued draft `id` at the version `seen` (DR-0062 §15): the version is
 * looked at before the status, as a comment's (`#draft`). */
function queuedDraft(
  session: SessionComments,
  sid: string,
  id: string,
  seen: string,
): CommentOutcome<PromptDraftRecord> {
  const draft = session.drafts.get(id);
  if (draft === undefined) {
    return { ok: false, code: ErrorCode.not_found, msg: `no draft ${id} in ${sid}` };
  }
  if (draft.updated_at !== seen) {
    return { ok: false, code: ErrorCode.conflict, msg: `draft ${id} changed` };
  }
  if (draft.status !== "queued") {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: `draft ${id} is ${draft.status}: only a queued draft changes`,
    };
  }
  return { ok: true, value: draft };
}

function draftSendResult(id: string, outcome: PromptOutcome): QueueSendResult {
  switch (outcome.outcome) {
    case "accepted":
      return { kind: "draft", id, outcome: "sent" };
    case "unconfirmed":
      return { kind: "draft", id, outcome: "unconfirmed" };
    case "not_delivered":
      return { kind: "draft", id, outcome: "not_delivered", reason: outcome.reason };
  }
}

function refusedDraft(
  id: string,
  reason: QueueSendRefusal,
  status?: PromptDraftStatus,
): QueueSendResult {
  return {
    kind: "draft",
    id,
    outcome: "refused",
    reason,
    ...(status !== undefined ? { status } : {}),
  };
}

/** The comments and thread states of a comments file, a later line over an
 * earlier one of the same cid (or thread). A missing file is none; a line
 * that does not read is passed over and logged. */
export async function readCommentsFile(
  file: string,
  warn: (msg: string) => void,
): Promise<Pick<SessionComments, "records" | "threads">> {
  const session: Pick<SessionComments, "records" | "threads"> = {
    records: new Map(),
    threads: new Map(),
  };
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
