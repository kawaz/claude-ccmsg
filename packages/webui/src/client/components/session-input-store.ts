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
import { readStorage, removeStorage, sweepStaleBySid, writeStorage } from "../storage.ts";
import {
  classifySessionInputReply,
  sessionInputSendFailure,
  type SessionInputOutcome,
} from "./session-input.ts";
import type { ErrorResponse, SessionInputResponse } from "@ccmsg/protocol";
import { jsonText, parseWith } from "@ccmsg/protocol";
import * as v from "valibot";

/** Design rationale: キーの文字列は、ブラウザに既に保存されている未送信の下書きと
 * 同じものを使う。変えるとそれらが読めなくなり、人が書いた文を失わせる
 * (DR-0035 §5 が避けている負担そのもの)。 */
export const DRAFT_STORAGE_PREFIX = "ccmsg.1on1.";
/** 送信の記録 (sid ごとに SendRecord の配列)。 */
export const SENDS_STORAGE_PREFIX = "ccmsg.sessionInput.sends.";
export const CLEANUP_STALE_DAYS = 10;
export const CLEANUP_STALE_MS = CLEANUP_STALE_DAYS * 24 * 60 * 60 * 1000;

/** 下書きや送った文の中身。添付は upload 済み (status:"done") だけを持つ。 */
export interface InputContent {
  text: string;
  attachments?: ComposerAttachment[];
}

export interface StoredDraft extends InputContent {
  /** upload 完了済みの添付メタ。upload は選択時に即完了しファイルは TMPDIR に
   * 残るので、メタを draft に含めれば close→reopen やリロードの後も本文の
   * [FILE<N>] がそのまま送信時に解決できる。uploading / error の途中状態は
   * 保存しない (XHR は復元できない)。 */
  attachments?: ComposerAttachment[];
  /** ISO-8601 wall-clock stamp of the last edit; used by the cleanup sweep
   * as a fallback when peers.last_activity_at isn't available. */
  updatedAt: string;
}

/** 1 回の送信の記録。 */
export interface SendRecord extends InputContent {
  id: string;
  /** 送った時刻 (ISO-8601)。 */
  sentAt: string;
  /** `sending`: 返事を待っている (はず)。`unconfirmed`: 届いたか分からないまま
   * 待ちが終わった。 */
  state: "sending" | "unconfirmed";
}

export function draftKey(sid: string): string {
  return `${DRAFT_STORAGE_PREFIX}${sid}`;
}

export function sendsKey(sid: string): string {
  return `${SENDS_STORAGE_PREFIX}${sid}`;
}

function doneAttachments(attachments: readonly ComposerAttachment[] | undefined) {
  return (attachments ?? []).filter((a) => a.status === "done");
}

/** An attachment as a draft or a send record keeps it: uploaded (`done`), so
 * it has its number and the path it was uploaded to. */
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

/** A draft as `saveDraft` stores it. */
const StoredDraftTextSchema = jsonText(
  v.object({
    text: v.string(),
    attachments: v.optional(v.array(StoredAttachmentSchema)),
    updatedAt: v.string(),
  }),
);

/** The send records of a session as `saveSends` stores them, none when
 * nothing is stored. A record's `sentAt` is a time. */
const SendRecordsSchema = v.optional(
  v.array(
    v.object({
      id: v.string(),
      text: v.string(),
      attachments: v.optional(v.array(StoredAttachmentSchema)),
      sentAt: v.pipe(
        v.string(),
        v.check((at) => Number.isFinite(Date.parse(at)), "sentAt is not a time"),
      ),
      state: v.picklist(["sending", "unconfirmed"]),
    }),
  ),
  () => [],
);
const SendRecordsTextSchema = jsonText(SendRecordsSchema);

/** 2 つの中身が同じ文か。本文の完全一致と、upload 済み添付の番号と path の
 * 一致で見る (upload 中・error の添付は送られないので比べない)。 */
export function sameContent(a: InputContent | null, b: InputContent | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.text !== b.text) return false;
  const left = doneAttachments(a.attachments);
  const right = doneAttachments(b.attachments);
  return (
    left.length === right.length &&
    left.every((x, i) => x.n === right[i].n && x.path === right[i].path)
  );
}

/** The stored draft of a session, or null when there is none or what is
 * stored does not read as one (it is ignored as a whole, never read in
 * part). */
export function loadDraft(sid: string): StoredDraft | null {
  const raw = readStorage(draftKey(sid));
  if (raw === null) return null;
  const read = parseWith(StoredDraftTextSchema, raw);
  if (!read.ok) return null;
  const { text, updatedAt, attachments } = read.value;
  return { text, updatedAt, ...(attachments ? { attachments: [...attachments] } : {}) };
}

/** 下書きを保存する。空の本文は保存せず消す。保存済みと同じ中身なら書かない:
 * 別タブへ storage event を撒き直して、タブ同士で書き合い続けるのを防ぐ。 */
export function saveDraft(sid: string, text: string, attachments?: ComposerAttachment[]): void {
  if (text === "") {
    clearDraft(sid);
    return;
  }
  const done = doneAttachments(attachments);
  const next: InputContent = { text, ...(done.length > 0 ? { attachments: done } : {}) };
  if (sameContent(loadDraft(sid), next)) return;
  // storage unavailable (private mode / quota) 時は drop silently。
  writeStorage(draftKey(sid), JSON.stringify({ ...next, updatedAt: new Date().toISOString() }));
}

export function clearDraft(sid: string): void {
  removeStorage(draftKey(sid));
}

/** The stored send records of a session: none when nothing is stored, or
 * when what is stored does not read as records (it is ignored as a whole,
 * never read in part). */
export function loadSends(sid: string): SendRecord[] {
  const raw = readStorage(sendsKey(sid));
  const read = raw === null ? null : parseWith(SendRecordsTextSchema, raw);
  const records = read?.ok ? read.value : v.getDefault(SendRecordsSchema);
  return records.map(({ id, text, sentAt, state, attachments }) => ({
    id,
    text,
    sentAt,
    state,
    ...(attachments ? { attachments: [...attachments] } : {}),
  }));
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
  const done = doneAttachments(content.attachments);
  const record: SendRecord = {
    id: newSendId(now),
    text: content.text,
    ...(done.length > 0 ? { attachments: done } : {}),
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
