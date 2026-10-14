// セッションへの人の入力 (DR-0035 §5) の下書きと送信の記録。入力欄の部品から
// 切り離し、localStorage を正本にする。
//
// 送信ごとに記録を 1 つ作り、送った文 (本文と添付の snapshot) と時刻を ws に
// 送る前に書く。応答はこの記録と下書きに対して処理するので、返事を待つ間に
// 部品が unmount されても、別タブで同じセッションの下書きが書き換わっても、
// 送った文と結果の結び付きが崩れない:
//  - accepted: 記録を消し、保存されている下書きが送った文と同じ時だけ下書きも
//    消す (その後に書かれた別の下書きは消さない)
//  - not_delivered / failed: 記録を消す。下書きは残す
//  - unconfirmed: 記録を未確認にする。下書きは残す
// 送信中のまま残っている記録 (ページが消えて応答を受け取れなかったもの) は、
// このページで返事を待っていない限り未確認として見せる。
import type { ComposerAttachment } from "./composer-attachments.ts";
import type { AppState } from "../store.ts";
import {
  listStorageKeys,
  readStorage,
  removeStorage,
  sweepStaleBySid,
  writeStorage,
} from "../storage.ts";
import {
  classifySessionInputReply,
  sessionInputSendFailure,
  type SessionInputOutcome,
} from "./session-input.ts";
import type { ErrorResponse, SessionInputResponse } from "@ccmsg/protocol";
import { jsonText, type Output, parseWith } from "@ccmsg/protocol";
import * as v from "valibot";

/** 下書きの本文 (`{text, updatedAt}`)。 */
export const DRAFT_STORAGE_PREFIX = "ccmsg.sessionInput.draft.";
/** 下書きの添付 (upload 済みの添付の配列)。本文と別のキーに置くのは、添付の
 * 形が読めなくても本文は残すため (DR-0035 §5: 人が書いた文を失わせない)。 */
export const DRAFT_ATTACHMENTS_STORAGE_PREFIX = "ccmsg.sessionInput.draftAttachments.";
/** 本文と添付を 1 つの値で持っていた頃の下書き。読めれば今のキーへ分けて移し、
 * 読めなければ捨てる (`loadDraft`、1 回限りの移行)。 */
export const LEGACY_DRAFT_STORAGE_PREFIX = "ccmsg.1on1.";
/** 送信の記録 (sid ごとに SendRecord の配列)。 */
export const SENDS_STORAGE_PREFIX = "ccmsg.sessionInput.sends.";
export const CLEANUP_STALE_DAYS = 10;
export const CLEANUP_STALE_MS = CLEANUP_STALE_DAYS * 24 * 60 * 60 * 1000;

/** 入力欄の中身、または送った文の中身。入力欄では upload 中・error の添付も
 * 持つ (保存されるのは upload 済みの添付だけ)。
 *
 * Design rationale: 外から読む値ではなく入力欄が組み立てる値 (upload 中の
 * 添付を含む) なので、保存の形のスキーマからは導かない。保存して読み戻す
 * StoredDraft / SendRecord はスキーマから導く。 */
export interface InputContent {
  readonly text: string;
  readonly attachments?: readonly ComposerAttachment[];
}

/** An attachment as a draft or a send record keeps it: uploaded (`done`), so
 * it has its number and the path it was uploaded to. upload は選択時に即完了
 * しファイルは TMPDIR に残るので、メタを保存すれば close→reopen やリロードの
 * 後も本文の [FILE<N>] がそのまま送信時に解決できる。 */
const StoredAttachmentSchema = v.looseObject({
  n: v.number(),
  name: v.string(),
  status: v.literal("done"),
  progress: v.number(),
  uuid: v.optional(v.string()),
  ext: v.optional(v.string()),
  size: v.optional(v.number()),
  mime: v.optional(v.string()),
  path: v.string(),
  errorMsg: v.optional(v.string()),
});
export type StoredAttachment = Output<typeof StoredAttachmentSchema>;

/** The text of a draft as `saveDraft` stores it. `updatedAt` (ISO-8601, the
 * last edit) is the cleanup sweep's fallback when peers.last_activity_at isn't
 * available. `rev` names the write, and the attachments saved with it carry
 * the same; a text with no `rev` has no attachments. */
const DraftTextSchema = v.object({
  text: v.string(),
  updatedAt: v.string(),
  rev: v.optional(v.string()),
});
const DraftTextTextSchema = jsonText(DraftTextSchema);

/** The attachments of a draft as `saveDraft` stores them, with the `rev` of
 * the text they were saved with: they belong to the stored text only while
 * the two match, so attachments left over by a failed write are never joined
 * to a newer text.
 *
 * Design rationale: a write is named by `rev`, not by `updatedAt`, because
 * two saves can fall in the same millisecond and a time would then name both. */
const DraftAttachmentsTextSchema = jsonText(
  v.object({
    rev: v.string(),
    attachments: v.array(StoredAttachmentSchema),
  }),
);

/** A draft as it is read back: its text, and its attachments when they read. */
export type StoredDraft = Output<typeof DraftTextSchema> & {
  readonly attachments?: readonly StoredAttachment[];
};

/** A draft of before the split, text and attachments in one value. */
const LegacyDraftTextSchema = jsonText(
  v.object({
    text: v.string(),
    attachments: v.optional(v.array(StoredAttachmentSchema)),
    updatedAt: v.string(),
  }),
);

/** 1 回の送信の記録。`sentAt` は送った時刻 (ISO-8601)。`state` の `sending` は
 * 返事を待っている (はず)、`unconfirmed` は届いたか分からないまま待ちが
 * 終わった。 */
const SendRecordSchema = v.object({
  id: v.string(),
  text: v.string(),
  attachments: v.optional(v.array(StoredAttachmentSchema)),
  sentAt: v.pipe(
    v.string(),
    v.check((at) => Number.isFinite(Date.parse(at)), "sentAt is not a time"),
  ),
  state: v.picklist(["sending", "unconfirmed"]),
});
export type SendRecord = Output<typeof SendRecordSchema>;

/** The send records of a session as `saveSends` stores them, none when
 * nothing is stored. */
const SendRecordsSchema = v.optional(v.array(SendRecordSchema), () => []);
const SendRecordsTextSchema = jsonText(SendRecordsSchema);

export function draftKey(sid: string): string {
  return `${DRAFT_STORAGE_PREFIX}${sid}`;
}

export function draftAttachmentsKey(sid: string): string {
  return `${DRAFT_ATTACHMENTS_STORAGE_PREFIX}${sid}`;
}

function legacyDraftKey(sid: string): string {
  return `${LEGACY_DRAFT_STORAGE_PREFIX}${sid}`;
}

export function sendsKey(sid: string): string {
  return `${SENDS_STORAGE_PREFIX}${sid}`;
}

/** The uploaded attachments of `attachments`, as they are stored. */
function storedAttachments(
  attachments: readonly ComposerAttachment[] | undefined,
): StoredAttachment[] {
  return (attachments ?? []).flatMap((a) =>
    a.status === "done" && a.path !== undefined ? [{ ...a, status: "done", path: a.path }] : [],
  );
}

/** 2 つの中身が同じ文か。本文の完全一致と、upload 済み添付の番号と path の
 * 一致で見る (upload 中・error の添付は送られないので比べない)。 */
export function sameContent(a: InputContent | null, b: InputContent | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.text !== b.text) return false;
  const left = storedAttachments(a.attachments);
  const right = storedAttachments(b.attachments);
  return (
    left.length === right.length &&
    left.every((x, i) => x.n === right[i].n && x.path === right[i].path)
  );
}

/** The draft under the text and attachments keys, or null when there is
 * none or its text does not read. Attachments are taken only when they read
 * and were saved with this text (the same `updatedAt`); otherwise the text
 * stands alone. */
function readDraft(sid: string): StoredDraft | null {
  const raw = readStorage(draftKey(sid));
  if (raw === null) return null;
  const read = parseWith(DraftTextTextSchema, raw);
  if (!read.ok) return null;
  const rawAttachments = readStorage(draftAttachmentsKey(sid));
  const attachments =
    rawAttachments === null ? null : parseWith(DraftAttachmentsTextSchema, rawAttachments);
  return attachments?.ok &&
    attachments.value.rev === read.value.rev &&
    attachments.value.attachments.length > 0
    ? { ...read.value, attachments: attachments.value.attachments }
    : read.value;
}

/** Stores a draft under a new `rev`: the attachments first, then the text,
 * both with the `rev`. A write that fails (quota, private mode) leaves the two
 * out of step, and `readDraft` then keeps the text without them. */
function writeDraft(sid: string, draft: StoredDraft): void {
  const rev = newDraftRev();
  const attachments = draft.attachments ?? [];
  if (attachments.length > 0) {
    writeStorage(draftAttachmentsKey(sid), JSON.stringify({ rev, attachments }));
  } else {
    removeStorage(draftAttachmentsKey(sid));
  }
  writeStorage(
    draftKey(sid),
    JSON.stringify({ text: draft.text, updatedAt: draft.updatedAt, rev }),
  );
}

let draftRevCounter = 0;
function newDraftRev(): string {
  draftRevCounter += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? `${Math.random()}`.slice(2);
  return `${draftRevCounter}-${random}`;
}

function sameDraft(a: StoredDraft | null, b: StoredDraft): boolean {
  return a !== null && a.updatedAt === b.updatedAt && sameContent(a, b);
}

/** The stored draft of a session, or null when there is none or its text
 * does not read. Attachments that do not read are left out and the text
 * kept.
 *
 * A draft stored before the split (`ccmsg.1on1.<sid>`, text and attachments
 * in one value) is moved to the text and attachments keys, once. A draft
 * already under those keys wins only when it reads. The old value is removed
 * only after the draft it holds reads back from the new keys; a move that
 * does not (a write failed) is undone and tried again next time, and the old
 * draft is what this returns meanwhile. An old value that does not read is
 * dropped. */
export function loadDraft(sid: string): StoredDraft | null {
  const current = readDraft(sid);
  const legacyRaw = readStorage(legacyDraftKey(sid));
  if (legacyRaw === null) return current;
  if (current !== null) {
    removeStorage(legacyDraftKey(sid));
    return current;
  }
  const legacy = parseWith(LegacyDraftTextSchema, legacyRaw);
  if (!legacy.ok) {
    removeStorage(legacyDraftKey(sid));
    return null;
  }
  writeDraft(sid, legacy.value);
  if (sameDraft(readDraft(sid), legacy.value)) {
    removeStorage(legacyDraftKey(sid));
  } else {
    removeStorage(draftKey(sid));
    removeStorage(draftAttachmentsKey(sid));
  }
  return legacy.value;
}

/** 下書きを保存する。空の本文は保存せず消す。保存済みと同じ中身なら書かない:
 * 別タブへ storage event を撒き直して、タブ同士で書き合い続けるのを防ぐ。 */
export function saveDraft(
  sid: string,
  text: string,
  attachments?: readonly ComposerAttachment[],
): void {
  if (text === "") {
    clearDraft(sid);
    return;
  }
  const stored = storedAttachments(attachments);
  if (sameContent(loadDraft(sid), { text, attachments: stored })) return;
  // storage unavailable (private mode / quota) 時は drop silently。
  writeDraft(sid, { text, updatedAt: new Date().toISOString(), attachments: stored });
}

/** 保存されている下書きが入力欄の中身 `current` と違う時、入力欄に映す中身
 * (下書きが無ければ空)。同じなら null。下書きを保存しない: 別タブの書き込みを
 * 映したタブが保存し直すと、遅れて走った保存が古い文を書き戻し、入力している
 * タブの文を storage event 越しに巻き戻す (DR-0035 §5)。 */
export function storedDraftChange(sid: string, current: InputContent): InputContent | null {
  const draft: InputContent = loadDraft(sid) ?? { text: "" };
  return sameContent(draft, current) ? null : draft;
}

/** 別タブが下書きの本文を書き換えた時 (storage event) に入力欄に映す中身。
 * 映すのは、入力欄が空か、書き換え前の本文 (`previousRaw`、storage event の
 * oldValue) のままの時 (このタブでは編集していない) だけ。このタブで書いた文が
 * あれば null で、相手の文を取り込まない (両方で書けば後から保存した方が残る)。 */
export function otherTabDraft(
  sid: string,
  current: InputContent,
  previousRaw: string | null,
): InputContent | null {
  const previous = previousRaw === null ? null : parseWith(DraftTextTextSchema, previousRaw);
  const untouched =
    current.text === "" || (previous?.ok === true && previous.value.text === current.text);
  return untouched ? storedDraftChange(sid, current) : null;
}

export function clearDraft(sid: string): void {
  removeStorage(draftKey(sid));
  removeStorage(draftAttachmentsKey(sid));
  removeStorage(legacyDraftKey(sid));
}

/** The stored send records of a session: none when nothing is stored, or
 * when what is stored does not read as records (it is ignored as a whole,
 * never read in part). */
export function loadSends(sid: string): readonly SendRecord[] {
  const raw = readStorage(sendsKey(sid));
  const read = raw === null ? null : parseWith(SendRecordsTextSchema, raw);
  return read?.ok ? read.value : v.getDefault(SendRecordsSchema);
}

function saveSends(sid: string, records: readonly SendRecord[]): void {
  if (records.length === 0) {
    removeStorage(sendsKey(sid));
    return;
  }
  writeStorage(sendsKey(sid), JSON.stringify(records));
}

/** Mount-time sweep of drafts and send records. Two purge rules (shared with
 * files-view-store via sweepStaleBySid):
 *  - (a) sid absent from both `state.peers` and `state.agents`: the target
 *    session is gone — drop.
 *  - (b) the target session has been idle > 10 days (peers'
 *    `last_activity_at` when present, else the record's own time).
 *
 * Runs once per SessionView mount, guarded by a `state.peers.length > 0`
 * check upstream — a mount that fires before peers arrives skips the sweep
 * (no reference to compare against) and re-runs on the next visit. */
export function cleanupStaleSessionInputs(state: AppState, now: number = Date.now()): void {
  for (const key of listStorageKeys(LEGACY_DRAFT_STORAGE_PREFIX)) {
    loadDraft(key.slice(LEGACY_DRAFT_STORAGE_PREFIX.length));
  }
  // 添付を本文より先に見る: 本文を先に消すと添付の updatedAt が引けなくなる。
  sweepStaleBySid(
    DRAFT_ATTACHMENTS_STORAGE_PREFIX,
    state,
    CLEANUP_STALE_MS,
    (sid) => loadDraft(sid)?.updatedAt,
    now,
  );
  sweepStaleBySid(
    DRAFT_STORAGE_PREFIX,
    state,
    CLEANUP_STALE_MS,
    (sid) => loadDraft(sid)?.updatedAt,
    now,
  );
  sweepStaleBySid(
    SENDS_STORAGE_PREFIX,
    state,
    CLEANUP_STALE_MS,
    (sid) =>
      loadSends(sid)
        .map((r) => r.sentAt)
        .sort()
        .at(-1),
    now,
  );
}

// --- このページで返事を待っている送信 (ページの寿命だけ持つ) ---

const inFlight = new Set<string>();
/** 直近の送信が届かなかった・送れなかった時の結果 (sid ごと)。部品が unmount
 * されて戻ってきても、理由を見せ続けられるようにページの寿命で持つ。 */
const lastFailures = new Map<string, SessionInputOutcome>();
const listeners = new Set<(sid: string) => void>();

/** sid の送信の状態が変わった時に呼ばれる関数を登録する。戻り値で解除。 */
export function subscribeSessionInput(listener: (sid: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(sid: string): void {
  for (const listener of listeners) listener(sid);
}

/** このページで sid への送信の返事を待っているか。 */
export function isSending(sid: string): boolean {
  return loadSends(sid).some((r) => inFlight.has(r.id));
}

export function lastFailure(sid: string): SessionInputOutcome | null {
  return lastFailures.get(sid) ?? null;
}

export function clearLastFailure(sid: string): void {
  if (lastFailures.delete(sid)) notify(sid);
}

/** 未確認として見せる記録。送信中の記録でも、このページが返事を待っていない
 * もの (送信中にページが消えた、他のタブが送っている) は届いたか分からないので
 * 未確認に入れる。新しい送信が先。 */
export function unconfirmedSends(
  records: readonly SendRecord[],
  waiting: ReadonlySet<string> = inFlight,
): SendRecord[] {
  return records
    .filter((r) => r.state === "unconfirmed" || !waiting.has(r.id))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

let idCounter = 0;
function newSendId(now: number): string {
  idCounter += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? `${Math.random()}`.slice(2);
  return `${now.toString(36)}-${idCounter}-${random}`;
}

/** 送信を始める: 記録を送信中として書き、このページで待っている印を付ける。 */
export function beginSend(
  sid: string,
  content: InputContent,
  now: number = Date.now(),
): SendRecord {
  const stored = storedAttachments(content.attachments);
  const record: SendRecord = {
    id: newSendId(now),
    text: content.text,
    ...(stored.length > 0 ? { attachments: stored } : {}),
    sentAt: new Date(now).toISOString(),
    state: "sending",
  };
  saveSends(sid, [...loadSends(sid), record]);
  inFlight.add(record.id);
  lastFailures.delete(sid);
  notify(sid);
  return record;
}

/** 送信の結果を記録と下書きに反映する。`record` は beginSend の戻り値 (送った
 * 文の snapshot)。記録が既に消されていても (人が「届いていたので消す」を押した)
 * 下書きの扱いは snapshot で判断する。 */
export function finishSend(sid: string, record: SendRecord, outcome: SessionInputOutcome): void {
  inFlight.delete(record.id);
  const records = loadSends(sid);
  switch (outcome.kind) {
    case "accepted":
      saveSends(
        sid,
        records.filter((r) => r.id !== record.id),
      );
      if (sameContent(loadDraft(sid), record)) clearDraft(sid);
      lastFailures.delete(sid);
      break;
    case "not_delivered":
    case "failed":
      saveSends(
        sid,
        records.filter((r) => r.id !== record.id),
      );
      lastFailures.set(sid, outcome);
      break;
    case "unconfirmed":
      if (records.some((r) => r.id === record.id)) {
        saveSends(
          sid,
          records.map((r) => (r.id === record.id ? { ...r, state: "unconfirmed" as const } : r)),
        );
      }
      lastFailures.delete(sid);
      break;
  }
  notify(sid);
}

/** 人が「届いていたので消す」を押した: その記録を消し、下書きが送った文と同じ
 * 時だけ下書きも消す (送った後に書き換えた文は消さない)。 */
export function discardSend(sid: string, id: string): void {
  const records = loadSends(sid);
  const record = records.find((r) => r.id === id);
  if (!record) return;
  saveSends(
    sid,
    records.filter((r) => r.id !== id),
  );
  if (sameContent(loadDraft(sid), record)) clearDraft(sid);
  notify(sid);
}

/** 1 回の送信をはじめから終わりまで行う。部品から切り離してあるので、返事を
 * 待つ間に呼び出し元の部品が消えても結果は記録と下書きに反映される。
 * `request` は送る本文 (添付の placeholder を解決済み) を受けて daemon に渡す。 */
export async function sendSessionInput(
  sid: string,
  content: InputContent,
  finalText: string,
  request: (text: string) => Promise<SessionInputResponse | ErrorResponse>,
  now: number = Date.now(),
): Promise<SessionInputOutcome> {
  const record = beginSend(sid, content, now);
  let outcome: SessionInputOutcome;
  try {
    outcome = classifySessionInputReply(await request(finalText));
  } catch {
    outcome = sessionInputSendFailure();
  }
  finishSend(sid, record, outcome);
  return outcome;
}

/** テスト用: ページの寿命で持つ状態を初期化する (新しいページを開いた状態)。 */
export function resetSessionInputPageState(): void {
  inFlight.clear();
  lastFailures.clear();
}
