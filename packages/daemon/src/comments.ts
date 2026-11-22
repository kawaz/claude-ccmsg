// Comments on a session's Timeline (DR-0062): the person's comments and the
// threads they make, kept in `<stateDir>/sessions/<sid>.comments.jsonl`,
// pushed to the tabs that look at the session (session_status_subscribe),
// sent to the session as the person's prompt (the composer's fill, the
// caller's `sendPrompt`), and seen delivered when the session's transcript
// has their blocks.
//
// A session's records are changed in memory with no wait between reading
// and writing them (the daemon runs one thing at a time), so two ops on the
// same session never write over each other: each line written is made from
// the record as memory holds it at that moment, the op's own fields changed
// (DR-0062 §8). The lines go to the file one after another, in that order.
// What waits — putting a prompt in — runs in the session's one line of
// sends (§11): a send begins once the one before it has its answer, so
// user_prompt's deadline counts from the send's own turn.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  commentBlockOf,
  CommentsFileLineSchema,
  commentsPromptText,
  ErrorCode,
  errorText,
  isKnownContentBlock,
  isKnownTranscriptRow,
  parseCommentBlocks,
  parseWith,
  queuedPersonPrompt,
  TranscriptRowLineSchema,
  type CommentAnchor,
  type CommentRecord,
  type QueueSendItem,
  type QueueSendResult,
  type ThreadState,
  type UserComment,
} from "@ccmsg/protocol";
import { wireLine } from "./wire-line.ts";

/** `<stateDir>/sessions/<sid>.comments.jsonl`. */
export function commentsFile(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.comments.jsonl`);
}

/** What putting a prompt into a session came to (user_prompt's outcome). */
export type PromptOutcome =
  | { outcome: "accepted" }
  | { outcome: "unconfirmed" }
  | { outcome: "not_delivered"; reason: string };

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

const SENDABLE_STATUS = "draft";
const PENDING_STATUSES: ReadonlySet<string> = new Set(["sending", "sent", "unconfirmed"]);

export class CommentStore {
  readonly #deps: CommentStoreDeps;
  readonly #sessions = new Map<string, SessionComments>();
  /** A session's read of its file in flight. */
  readonly #loading = new Map<string, Promise<SessionComments>>();
  readonly #watchers = new Map<string, Set<CommentConn>>();
  /** Appends to one session's file, one after another. */
  readonly #writes = new Map<string, Promise<void>>();
  /** A session's line of sends (DR-0062 §11). */
  readonly #sends = new Map<string, Promise<unknown>>();
  /** A session's look for delivered blocks in flight, and whether another
   * is asked for after it. */
  readonly #confirming = new Map<string, { again: boolean; done: Promise<void> }>();

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

  // --- the ops (DR-0062 §9) ---

  /** comment_add: keep a new comment, and with `sendNow` send it. */
  async add(
    sid: string,
    input: { anchor: CommentAnchor; quote?: string; body: string; sendNow: boolean },
  ): Promise<CommentOutcome<{ comment: UserComment; outcome?: QueueSendResult }>> {
    const session = await this.#session(sid);
    if (input.anchor.kind === "comment") {
      const replied = session.records.get(input.anchor.cid);
      if (
        replied === undefined ||
        (replied.author === "user" && (replied.status === "draft" || replied.status === "deleted"))
      ) {
        return {
          ok: false,
          code: ErrorCode.not_found,
          msg: `comment ${input.anchor.cid} is not one of session ${sid}'s sent comments`,
        };
      }
    }
    const afterUuid = await this.#deps.lastRowUuid(sid);
    const now = this.#deps.now().toISOString();
    const comment: UserComment = {
      kind: "comment",
      author: "user",
      cid: this.#newCid(session),
      session_id: sid,
      anchor: input.anchor,
      ...(input.quote !== undefined ? { quote: input.quote } : {}),
      body: input.body,
      written: { at: now, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) },
      updated_at: now,
      btw: false,
      status: "draft",
    };
    this.#put(session, comment);
    this.#deps.log.info(
      `comment_add: session_id=${sid} cid=${comment.cid} anchor=${comment.anchor.kind}` +
        ` body_bytes=${String(Buffer.byteLength(comment.body))}`,
    );
    // A thread that comes alive again is not left hidden (DR-0062 P18).
    this.#reopen(session, comment.cid);
    if (!input.sendNow) return { ok: true, value: { comment } };
    const [outcome] = await this.send(sid, [
      { kind: "comment", cid: comment.cid, seen_updated_at: comment.updated_at },
    ]);
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
    const found = this.#draft(session, sid, input.cid, input.seenUpdatedAt);
    if (!found.ok) return found;
    const changed: UserComment = {
      ...found.value,
      body: input.body,
      updated_at: this.#deps.now().toISOString(),
    };
    this.#put(session, changed);
    return { ok: true, value: changed };
  }

  /** comment_delete: take an unsent comment back. */
  async delete(
    sid: string,
    input: { cid: string; seenUpdatedAt: string },
  ): Promise<CommentOutcome<null>> {
    const session = await this.#session(sid);
    const found = this.#draft(session, sid, input.cid, input.seenUpdatedAt);
    if (!found.ok) return found;
    this.#put(session, {
      ...found.value,
      status: "deleted",
      updated_at: this.#deps.now().toISOString(),
    });
    return { ok: true, value: null };
  }

  /** comment_resolve: mark the thread `cid` is in resolved, or take the mark
   * off (DR-0062 §6). */
  async resolve(
    sid: string,
    input: { cid: string; resolved: boolean; seenCid: string },
  ): Promise<CommentOutcome<ThreadState>> {
    const session = await this.#session(sid);
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
    this.#putThread(session, thread);
    return { ok: true, value: thread };
  }

  /** queue_send: send the items, in their order (DR-0062 §11). The comments
   * that may be sent go as one prompt; the others are refused, each with
   * why. Waits for the session's sends before it. */
  async send(sid: string, items: readonly QueueSendItem[]): Promise<QueueSendResult[]> {
    const session = await this.#session(sid);
    const results = new Map<string, QueueSendResult>();
    const sendable: UserComment[] = [];
    for (const item of items) {
      const record = session.records.get(item.cid);
      if (record === undefined || record.author !== "user" || record.status === "deleted") {
        results.set(item.cid, refused(item.cid, "not_found"));
      } else if (record.status !== SENDABLE_STATUS) {
        results.set(item.cid, refused(item.cid, `not_sendable: ${record.status}`));
      } else if (record.updated_at !== item.seen_updated_at) {
        results.set(item.cid, refused(item.cid, "conflict"));
      } else if (sendable.every((c) => c.cid !== record.cid)) {
        // Marked before anything waits: a second send of it now finds it
        // being sent.
        const sending: UserComment = {
          ...record,
          status: "sending",
          updated_at: this.#deps.now().toISOString(),
        };
        this.#put(session, sending);
        sendable.push(sending);
      }
    }
    if (sendable.length > 0) {
      const outcome = await this.#inLine(sid, () => this.#sendComments(sid, session, sendable));
      for (const comment of sendable) results.set(comment.cid, { ...outcome, id: comment.cid });
    }
    return items.flatMap((item) => {
      const result = results.get(item.cid);
      if (result === undefined) return [];
      results.delete(item.cid);
      return [result];
    });
  }

  /** unconfirmed_settle: make an unconfirmed comment a draft again, or take
   * it as sent (DR-0062 §11, P32). */
  async settle(
    sid: string,
    input: { cid: string; action: "back_to_draft" | "mark_sent"; seenUpdatedAt: string },
  ): Promise<CommentOutcome<UserComment>> {
    const session = await this.#session(sid);
    const record = session.records.get(input.cid);
    if (record === undefined || record.author !== "user" || record.status === "deleted") {
      return { ok: false, code: ErrorCode.not_found, msg: `no comment ${input.cid} in ${sid}` };
    }
    if (record.status !== "unconfirmed") {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: `comment ${input.cid} is ${record.status}, not unconfirmed`,
      };
    }
    if (record.updated_at !== input.seenUpdatedAt) {
      return { ok: false, code: ErrorCode.conflict, msg: `comment ${input.cid} changed` };
    }
    const now = this.#deps.now().toISOString();
    let settled: UserComment;
    if (input.action === "back_to_draft") {
      const { sent: _sent, ...rest } = record;
      settled = { ...rest, status: "draft", updated_at: now };
    } else {
      settled = { ...record, status: "sent", updated_at: now };
    }
    this.#put(session, settled);
    return { ok: true, value: settled };
  }

  // --- what the session does ---

  /** Rows went into session `sid`'s conversation: when a comment waits to be
   * seen delivered, look for it. */
  rowsPushed(sid: string): void {
    const session = this.#sessions.get(sid);
    if (session === undefined || !hasPending(session)) return;
    void this.confirm(sid);
  }

  /** Session `sid`'s turn that began at `began` (ms since the epoch) ended:
   * what was sent before it began and is still not seen in the transcript is
   * unconfirmed (DR-0062 P35). The transcript is looked at first. */
  async turnEnded(sid: string, began: number): Promise<void> {
    const session = this.#sessions.get(sid);
    if (session === undefined || !hasPending(session)) return;
    await this.confirm(sid);
    // Replacing a record of the map while going through it keeps its place.
    for (const record of session.records.values()) {
      if (record.author !== "user" || record.status !== "sent" || record.sent === undefined) {
        continue;
      }
      const sentAt = Date.parse(record.sent.at);
      if (!Number.isFinite(sentAt) || sentAt >= began) continue;
      this.#put(session, {
        ...record,
        status: "unconfirmed",
        updated_at: this.#deps.now().toISOString(),
      });
    }
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

  /** Resolves once the sends in line have their answers and every line
   * written so far is on disk. */
  async settled(): Promise<void> {
    await Promise.all(this.#sends.values());
    await Promise.all([...this.#confirming.values()].map((entry) => entry.done));
    await this.written();
  }

  /** Resolves once every line written so far is on disk. */
  async written(): Promise<void> {
    await Promise.all(this.#writes.values());
  }

  // --- inside ---

  async #confirmOnce(sid: string): Promise<void> {
    const session = await this.#session(sid);
    const pending = [...session.records.values()].filter(
      (record): record is UserComment =>
        record.author === "user" &&
        PENDING_STATUSES.has(record.status) &&
        record.sent !== undefined,
    );
    if (pending.length === 0) return;
    const since = Math.min(...pending.map((c) => Date.parse(c.sent?.at ?? "")));
    if (!Number.isFinite(since)) return;
    let landed: LandedPrompt[];
    try {
      landed = await this.#deps.landedPrompts(sid, since);
    } catch (e) {
      this.#deps.log.warn(`comments: ${sid}'s transcript was not read: ${errorText(e)}`);
      return;
    }
    for (const prompt of landed) {
      for (const block of parseCommentBlocks(prompt.text)) {
        const record = session.records.get(block.cid);
        if (record?.author !== "user" || !PENDING_STATUSES.has(record.status)) continue;
        this.#put(session, {
          ...record,
          status: "delivered",
          row_uuid: prompt.uuid,
          updated_at: this.#deps.now().toISOString(),
        });
      }
    }
  }

  /** Put the comments in as one prompt and keep what came of it. Runs in the
   * session's line of sends. */
  async #sendComments(
    sid: string,
    session: SessionComments,
    comments: readonly UserComment[],
  ): Promise<Omit<QueueSendResult, "id">> {
    const afterUuid = await this.#deps.lastRowUuid(sid);
    const sentAt = this.#deps.now().toISOString();
    const point = { at: sentAt, ...(afterUuid !== undefined ? { after_uuid: afterUuid } : {}) };
    for (const comment of comments) {
      const record = session.records.get(comment.cid);
      if (record?.author === "user") this.#put(session, { ...record, sent: point });
    }
    const text = commentsPromptText(
      comments.map((comment) => commentBlockOf(comment, (cid) => session.records.get(cid))),
    );
    let outcome: PromptOutcome;
    try {
      outcome = await this.#deps.sendPrompt(sid, text);
    } catch (e) {
      this.#deps.log.warn(`comments: sending to ${sid} failed: ${errorText(e)}`);
      outcome = { outcome: "unconfirmed" };
    }
    this.#deps.log.info(
      `comment_send: session_id=${sid} cids=${comments.map((c) => c.cid).join(",")}` +
        ` outcome=${outcome.outcome}${outcome.outcome === "not_delivered" ? ` (${outcome.reason})` : ""}` +
        ` text_bytes=${String(Buffer.byteLength(text))}`,
    );
    const now = this.#deps.now().toISOString();
    for (const comment of comments) {
      const record = session.records.get(comment.cid);
      // Seen in the transcript while the answer was on its way: it stays so.
      if (record?.author !== "user" || record.status !== "sending") continue;
      if (outcome.outcome === "accepted") {
        const { send_error: _error, ...rest } = record;
        this.#put(session, { ...rest, status: "sent", updated_at: now });
      } else if (outcome.outcome === "unconfirmed") {
        this.#put(session, { ...record, status: "unconfirmed", updated_at: now });
      } else {
        const { sent: _sent, ...rest } = record;
        this.#put(session, {
          ...rest,
          status: "draft",
          send_error: outcome.reason,
          updated_at: now,
        });
      }
    }
    if (outcome.outcome !== "not_delivered") void this.confirm(sid);
    return outcome.outcome === "not_delivered"
      ? { kind: "comment", outcome: "not_delivered", reason: outcome.reason }
      : { kind: "comment", outcome: outcome.outcome === "accepted" ? "sent" : "unconfirmed" };
  }

  /** Run `send` after the session's sends before it. */
  #inLine<T>(sid: string, send: () => Promise<T>): Promise<T> {
    const before = this.#sends.get(sid) ?? Promise.resolve();
    const next = before.catch(() => {}).then(send);
    this.#sends.set(sid, next);
    void next
      .catch(() => {})
      .then(() => {
        if (this.#sends.get(sid) === next) this.#sends.delete(sid);
      });
    return next;
  }

  /** The unsent comment `cid` at the version `seen`. */
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
    if (record.status !== "draft") {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: `comment ${cid} is ${record.status}: only an unsent comment changes`,
      };
    }
    if (record.updated_at !== seen) {
      return { ok: false, code: ErrorCode.conflict, msg: `comment ${cid} changed` };
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
  #reopen(session: SessionComments, cid: string): void {
    const root = this.#rootOf(session, cid);
    if (root === cid) return;
    const held = session.threads.get(root);
    if (held?.resolved_at === undefined) return;
    const { resolved_at: _resolvedAt, seen_cid: _seenCid, ...rest } = held;
    this.#putThread(session, rest);
  }

  /** Keep `record` (in memory, on disk, and on the tabs). */
  #put(session: SessionComments, record: CommentRecord): void {
    session.records.set(record.cid, record);
    this.#append(record.session_id, record);
    this.#broadcast(record.session_id, { ev: "comment", comment: record });
  }

  #putThread(session: SessionComments, thread: ThreadState): void {
    session.threads.set(thread.root, thread);
    this.#append(thread.session_id, thread);
    this.#broadcast(thread.session_id, { ev: "comment_thread", thread });
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

  /** Append one line to session `sid`'s file, after what is being appended
   * there. A failure is logged: memory keeps the record. */
  #append(sid: string, line: CommentRecord | ThreadState): void {
    const file = commentsFile(this.#deps.stateDir, sid);
    const previous = this.#writes.get(sid) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.appendFile(file, `${JSON.stringify(line)}\n`);
      } catch (e) {
        this.#deps.log.warn(`comments: ${file} not written: ${errorText(e)}`);
      }
    });
    this.#writes.set(sid, next);
    void next.then(() => {
      if (this.#writes.get(sid) === next) this.#writes.delete(sid);
    });
  }

  /** Session `sid`'s comments, read once from its file. A comment the file
   * leaves being sent was sent by a daemon that stopped before its answer:
   * whether it went in is not known (DR-0062 §8). */
  #session(sid: string): Promise<SessionComments> {
    const held = this.#sessions.get(sid);
    if (held !== undefined) return Promise.resolve(held);
    const loading = this.#loading.get(sid);
    if (loading !== undefined) return loading;
    const load = (async () => {
      const session = await readCommentsFile(commentsFile(this.#deps.stateDir, sid), (msg) =>
        this.#deps.log.warn(msg),
      );
      this.#sessions.set(sid, session);
      this.#loading.delete(sid);
      for (const record of session.records.values()) {
        if (record.author === "user" && record.status === "sending") {
          this.#put(session, {
            ...record,
            status: "unconfirmed",
            updated_at: this.#deps.now().toISOString(),
          });
        }
      }
      return session;
    })();
    this.#loading.set(sid, load);
    return load;
  }
}

function refused(cid: string, reason: string): QueueSendResult {
  return { kind: "comment", id: cid, outcome: "refused", reason };
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

/** The person's prompt a transcript line holds (a user row's text, or a
 * `queued_command` row's prompt: DR-0062 §11's three shapes), null for any
 * other line. */
export function promptTextOfLine(line: string): string | null {
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok || !isKnownTranscriptRow(read.value)) return null;
  const row = read.value;
  if (row.type === "attachment") return queuedPersonPrompt(row);
  if (row.type !== "user") return null;
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
