// What a comment form held when it closed (DR-0062 §3), by session and by
// what it is on: the form opened again on the same target goes on from it.
// Kept for the page's life only (a reload forgets it), as the FAB's sends in
// flight are (session-input-store.ts): the form and the screen that opens it
// come and go (another target, another session), the page stays.
import type { AttachmentBoxContent } from "../useAttachmentInput.ts";

const drafts = new Map<string, Map<string, AttachmentBoxContent>>();

/** What the form on `key` of session `sid` held, null when nothing. */
export function loadFormDraft(sid: string, key: string): AttachmentBoxContent | null {
  return drafts.get(sid)?.get(key) ?? null;
}

/** Keep what the form on `key` holds now. The attachments kept are the ones
 * uploaded (an upload not ended, or failed, is not: the form that started it
 * is gone when it ends). Nothing in it (no text, no attachment) keeps
 * nothing. */
export function saveFormDraft(sid: string, key: string, content: AttachmentBoxContent): void {
  const attachments = content.attachments.filter(
    (a) => a.status === "done" && a.path !== undefined,
  );
  if (content.text.trim() === "" && attachments.length === 0) {
    clearFormDraft(sid, key);
    return;
  }
  const session = drafts.get(sid) ?? new Map<string, AttachmentBoxContent>();
  session.set(key, { text: content.text, attachments });
  drafts.set(sid, session);
}

/** Forget what the form on `key` held (its comment was kept). */
export function clearFormDraft(sid: string, key: string): void {
  const session = drafts.get(sid);
  if (session === undefined) return;
  session.delete(key);
  if (session.size === 0) drafts.delete(sid);
}

/** For the tests: a new page. */
export function resetCommentFormDrafts(): void {
  drafts.clear();
}
