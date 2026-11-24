// The comments of a session's Timeline (DR-0062 §3, §12, §13): the 返信
// button of a bubble and the form it opens (floating over the Timeline, not
// among its items), the 💬 of an item with comments, the bubble of a comment
// (sent, or not and marked so), the ✔️ / ✅ of a thread, and the 💬 filter's
// head (what it shows, and 全部送信).
//
// What a comment is on (its anchor) is the item's: the item provides it
// (CommentTargetContext) and the bubble's 返信 reads it, so the bubbles take
// no prop for it. What the Timeline holds of the session's comments, and the
// one form open, are the Timeline's (TimelineCommentsContext).
import type { ComponentChildren } from "preact";
import { useCallback, useContext, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  attachmentLinkedText,
  commentBlockOf,
  commentFileOf,
  type AgentReply,
  type CommentBlock,
  type CommentRecord,
  type QueueSendItem,
  type ReplyOf,
  type UserComment,
} from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { fileHref as fileHrefOf, timelineHref } from "../../locator.ts";
import { fileTreePathOf } from "../../file-comment.ts";
import {
  COMMENT_SHOW_DEFAULT,
  COMMENT_SHOW_KEYS,
  commentErrorText,
  commentSelected,
  commentSendErrorDetail,
  NOT_CONNECTED_TEXT,
  type CommentShow,
  type CommentShowKey,
  recordQuoteOf,
  replyLost,
  sendResultText,
  sendResultsText,
  stockedItems,
  type ItemCommentOn,
  threadLastCid,
  threadOpenOf,
  threadPressKey,
  threadResolvable,
  threadRootOf,
  threadResolved,
} from "../../comment-view.ts";
import { isPanelDragHandle, useDraggable, usePlacedNear } from "../../useDraggable.ts";
import { useResettableState } from "../../useKeyedState.ts";
import { shouldSendOnKeyDown } from "../composer-keydown.ts";
import { StackedLabels } from "../StackedLabels.tsx";
import { boxAttachmentsOf, hasPendingUpload, keptAttachmentsOf } from "../composer-attachments.ts";
import { AttachFileButton, ComposerAttachments } from "../ComposerAttachments.tsx";
import { ComposeTextareaContext } from "../compose-focus.ts";
import { SendSplitButton, type SendMode } from "../SendSplitButton.tsx";
import {
  useAttachmentBox,
  useAttachmentInput,
  type AttachmentBoxContent,
} from "../useAttachmentInput.ts";
import { clearFormDraft, loadFormDraft, saveFormDraft } from "./comment-form-drafts.ts";
import { LinkedPlainText } from "../../filepath-linker.tsx";
import { BubbleFooter } from "./BubbleFooter.tsx";
import {
  CommentTargetContext,
  SessionCommentsContext,
  TimelineCommentsContext,
  formNearOf,
  type CommentTarget,
  type FormAnchor,
  type OpenCommentForm,
} from "./comment-context.ts";
import { QuoteMarks } from "./comment-quotes.tsx";
import {
  SessionFilePathCtxContext,
  TimelineFilterContext,
  TimelinePositionContext,
} from "./context.ts";

export {
  CommentTargetContext,
  TimelineCommentsContext,
  type CommentTarget,
  type OpenCommentForm,
  type TimelineComments,
} from "./comment-context.ts";

/** What a comment on the whole item of row `uuid` is on (DR-0062 §2). */
export function itemCommentTarget(uuid: string, on: ItemCommentOn): CommentTarget {
  return { key: `u:${uuid}`, anchor: { kind: "message", uuid, msg_start_with: on.msg_start_with } };
}

/** The 返信 of an item (DR-0062 §3): opens the form of a comment on the
 * whole item. Only the items a person answers in a thread carry it: the main
 * conversation's response, an agent's comment_reply, a ccmsg message, what
 * is told to a subagent or teammate and what it answers, and a comment of the
 * person's sent to the conversation (a reply to it adds to it). It is a row of
 * its own at the bottom of the bubble's body, the button at its right end,
 * always shown. Nothing where the item cannot be commented on.
 *
 * An agent's reply or a btw answer whose thread goes on further down, apart
 * from it, carries 「↓続きへ↓」 in the middle of the same row (§12).
 *
 * A bubble of a comment thread passes `resolve`, the cid its ✔️ / ✅ resolves
 * the thread by (§6, P14): the button stands just left of 返信.
 *
 * The labels are the CSS `content`, not text of the DOM (as 「! で実行」 is,
 * PermitRequestBubble's BangButton): it is inside the bubble's body, where
 * text would join what is selected and copied, and the body's text. The
 * name read out is its aria-label. */
export function CommentReplyRow({ resolve }: { resolve?: string }) {
  const comments = useContext(TimelineCommentsContext);
  const target = useContext(CommentTargetContext);
  // The bubble's region (comment-quotes.tsx): the element this row is in.
  const [region, setRegion] = useState<Element | null>(null);
  const rowRef = useCallback((row: HTMLDivElement | null) => {
    setRegion(row?.parentElement ?? null);
  }, []);
  const regions = comments?.regions;
  useLayoutEffect(() => {
    if (region === null || regions === undefined || target === null) return;
    regions.set(region, target);
    return () => {
      if (regions.get(region) === target) regions.delete(region);
    };
  }, [region, regions, target]);
  if (comments === null) return null;
  if (target === null) return resolve !== undefined ? <ThreadResolveRow cid={resolve} /> : null;
  // An agent's reply or a btw answer whose thread goes on apart from it: the
  // way to the person's next comment (§12「↓続きへ↓」).
  const next =
    target.anchor.kind === "comment" ? comments.continuationOf(target.anchor.cid) : undefined;
  return (
    <>
      <div class="tl-comment-reply-row" ref={rowRef}>
        {next !== undefined ? (
          <button
            type="button"
            class="tl-comment-place tl-comment-next"
            aria-label="続きへ"
            onClick={() => comments.jumpToRow(next)}
          />
        ) : null}
        <span class="tl-comment-reply-end">
          {resolve !== undefined ? <ThreadResolveToggle cid={resolve} /> : null}
          <button
            type="button"
            class="tl-comment-reply"
            aria-label="返信"
            title="このバブルにコメントする"
            aria-haspopup="dialog"
            aria-expanded={comments.form?.target.key === target.key}
            onClick={(event) =>
              comments.openForm(
                target,
                event.currentTarget,
                formNearOf(event.currentTarget.getBoundingClientRect(), "reply"),
              )
            }
          />
        </span>
      </div>
      {region !== null ? <QuoteMarks region={region} target={target} /> : null}
    </>
  );
}

/** The ✔️ / ✅ of a bubble of a comment thread without 返信 (DR-0062 §6,
 * P14): the unsent comment, the btw question, the btw answer not ended. Where
 * 返信 stands on the others, at the right end of the bubble body's bottom
 * row. */
export function ThreadResolveRow({ cid }: { cid: string }) {
  const comments = useContext(TimelineCommentsContext);
  // A cid the daemon has no record of is in no thread: no row (it would be a
  // gap at the bottom of the body).
  if (comments === null || !comments.records.has(cid)) return null;
  return (
    <div class="tl-comment-reply-row">
      <span class="tl-comment-reply-end">
        <ThreadResolveToggle cid={cid} />
      </span>
    </div>
  );
}

/** The 💬 of an item with comments, and how many (DR-0062 §12, P8): a way
 * into the 💬 filter with the item's comments selected there. Always shown,
 * outside the bubble beside its top (app.css puts it, by the bubble). The position
 * the Timeline stands at stays (as a toolbar badge's way out of a filter).
 * Nothing on an item without. */
export function CommentMark({ targetKey }: { targetKey: string | undefined }) {
  const comments = useContext(TimelineCommentsContext);
  const position = useContext(TimelinePositionContext)?.position ?? "head";
  const count = targetKey === undefined ? 0 : (comments?.counts.get(targetKey) ?? 0);
  if (comments === null || targetKey === undefined || count === 0) return null;
  return (
    <a
      class="tl-item-comments"
      href={timelineHref(comments.sid, position, "comment")}
      aria-label={`コメント ${count} 件 — 押すとコメントだけを表示`}
      title={`コメント ${count} 件`}
      onClick={() => comments.select(targetKey)}
    >
      💬{count}
    </a>
  );
}

/** Whether the comment or reply `cid` on `anchor` is among the selected
 * ones: on the item whose 💬 was pressed, or the one whose quote's 💬 was
 * (DR-0062 §12). */
function useCommentSelected(
  anchor: CommentRecord["anchor"] | undefined,
  cid: string | undefined,
): boolean {
  const comments = useContext(TimelineCommentsContext);
  return anchor !== undefined && commentSelected(comments?.selected ?? null, anchor, cid);
}

/** The comment form while one on a Timeline item is open (DR-0062 §3): over
 * the Timeline, not among its items. One on a file is the Files tab's
 * (FileCommentFormFloat). */
export function CommentFormFloat() {
  const comments = useContext(TimelineCommentsContext);
  const form = comments?.form ?? null;
  if (comments === null || form === null || form.target.anchor.kind === "file") return null;
  return (
    <CommentFormFloatOf
      sid={comments.sid}
      form={form}
      records={comments.records}
      onClose={comments.closeForm}
    />
  );
}

/** The comment form `form`, floating over the tab it is opened in. A form on
 * another target is a new form, with what was written on that target before
 * (comment-form-drafts.ts). */
export function CommentFormFloatOf({
  sid,
  form,
  records,
  onClose,
}: {
  sid: string;
  form: OpenCommentForm;
  records: ReadonlyMap<string, CommentRecord>;
  onClose: () => void;
}) {
  return (
    <CommentForm key={form.target.key} sid={sid} form={form} records={records} onClose={onClose} />
  );
}

/** What the comment being written is on, as the form's head: the start of
 * the message, the cid it replies to and the start of that comment, or the
 * file and its lines. The form is not next to it, so the head says it. */
function CommentFormOn({
  anchor,
  records,
}: {
  anchor: FormAnchor;
  records: ReadonlyMap<string, CommentRecord>;
}) {
  const quote =
    anchor.kind === "comment"
      ? recordQuoteOf(records, anchor.cid)
      : anchor.kind === "file"
        ? undefined
        : anchor.msg_start_with;
  // A quote in it (DR-0062 §3): the text chosen.
  const chosen = anchor.kind === "message" ? undefined : anchor.text;
  return (
    <div class="tl-comment-on">
      <span class="tl-comment-label">💬 コメント</span>
      {anchor.kind === "comment" ? (
        <span class="tl-comment-reply-to">↩ {anchor.cid} への返信</span>
      ) : null}
      {anchor.kind === "file" ? <span class="tl-comment-kind">{commentFileOf(anchor)}</span> : null}
      {quote !== undefined && quote !== "" ? <q class="tl-comment-quote">{quote}</q> : null}
      {chosen !== undefined ? <q class="tl-comment-chosen">{chosen}</q> : null}
    </div>
  );
}

/** The form of a new comment (DR-0062 §3): what it is on, the text, its
 * attachments (📎, a paste or a drop, the FAB's box's parts), the FAB's pill
 * of btw and 後で (kept nowhere: both off, the comment sent now, unless
 * opened from a choice's btw) and 送る / btw / 後で, in a panel floating over
 * the Timeline as the session's input is (SessionInputComposer): near what it
 * was opened from (usePlacedNear: its top at the 返信's top or at the text
 * chosen's bottom, going up when it does not fit), staying there as the Timeline scrolls
 * under it, moved by dragging its margin. Opening it focuses the text without scrolling anything. ⌘+Enter
 * (Ctrl+Enter) does the same as the button; ✕ and Esc close it, and closing
 * gives the focus back to the button that opened it. Closed, what it holds is
 * kept for its target while the page is open (comment-form-drafts.ts): opened
 * on the same target again, it goes on from there; closed empty, nothing is
 * kept; a comment kept from it forgets it. It closes once the comment is
 * kept (and, unless 後で, put in the session or asked of a fork). Otherwise it stays with
 * the text and says why: a refusal (nothing kept), a comment kept and not
 * sent (it waits in the 💬 filter), or no answer (it may be kept). The last
 * two hold the text they were asked with, so the same comment is not made
 * twice from the form. A click outside does not close it (the person reads
 * and scrolls the Timeline while writing). */
function CommentForm({
  sid,
  form,
  records,
  onClose,
}: {
  sid: string;
  form: OpenCommentForm;
  records: ReadonlyMap<string, CommentRecord>;
  onClose: () => void;
}) {
  const { ws, store } = useApp();
  const { target } = form;
  // What was written on this target before and closed goes on (DR-0062 §3).
  const box = useAttachmentBox(
    () => loadFormDraft(sid, target.key) ?? { text: "", attachments: [] },
  );
  const body = box.text;
  // Each edit is kept as the target's draft while the form is open: an
  // upload that ends after the form closed is not (the draft is what the
  // form showed).
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const boxEdit = box.edit;
  const edit = useCallback(
    (next: AttachmentBoxContent) => {
      boxEdit(next);
      if (live.current) saveFormDraft(sid, target.key, next);
    },
    [boxEdit, sid, target.key],
  );
  // btw (DR-0062 §14) asks a fork now, not the session; 後で keeps the
  // comment unsent (it waits in the 💬 filter). A btw is never kept unsent.
  const [mode, setMode] = useState<SendMode>(form.target.btw === true ? "btw" : "now");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The text and files a comment was made with (or may have been, no answer
  // coming): not asked for again as they stand.
  const [madeWith, setMadeWith] = useState<string | null>(null);
  const kept = keptAttachmentsOf(box.attachments);
  const contentKey = JSON.stringify([body, kept]);
  const held = madeWith !== null && contentKey === madeWith;
  const uploading = hasPendingUpload(box.attachments);
  const drag = useDraggable({ handleFilter: isPanelDragHandle });
  // By what it was opened from, before it is first drawn (DR-0062 §3): over
  // the 返信 (tops lined up, right ends lined up), or just under the text
  // chosen (its top at the choice's bottom, left ends lined up).
  const fromReply = form.near.from === "reply";
  const placeRef = usePlacedNear({
    drag,
    near: form.near,
    cover: fromReply,
    align: fromReply ? "right" : "left",
    // Within the session's screen: the tab's content, not over the sidebar.
    within: (el) => el.closest(".session-tab-panel"),
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachLocked = useCallback(() => busy, [busy]);
  const attach = useAttachmentInput({
    textareaRef: inputRef,
    content: box.content,
    edit,
    locked: attachLocked,
    text: body,
  });
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const close = () => {
    const opener = form.opener;
    onClose();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  /** Send everything stocked with `comment` last (DR-0062 §11): the unsent
   * comments and the FAB's queued drafts in the order written, then it. What
   * came of `comment` in words, null when the session took it in. */
  async function sendWithStocked(comment: UserComment): Promise<string | null> {
    const state = store.getState();
    const items: QueueSendItem[] = [
      ...stockedItems(
        state.comments.get(sid)?.values() ?? [],
        state.promptDrafts.get(sid)?.values() ?? [],
      ).filter((item) => item.kind !== "comment" || item.cid !== comment.cid),
      { kind: "comment", cid: comment.cid, seen_updated_at: comment.updated_at },
    ];
    let reply: ReplyOf<"queue_send">;
    try {
      reply = await ws.queueSend(sid, items);
    } catch {
      return NOT_CONNECTED_TEXT;
    }
    if (!reply.ok) return commentErrorText("send", reply.error);
    const own = reply.results.find(
      (result) => result.kind === "comment" && result.id === comment.cid,
    );
    return own === undefined ? null : sendResultText(own);
  }
  async function submit() {
    if (busy || held || uploading || body.trim() === "") return;
    setBusy(true);
    setFailure(null);
    try {
      // A plain 送る keeps the comment, then sends it after everything
      // stocked (DR-0062 §3, §11); a btw is asked alone, now (§14).
      const reply = await ws.commentAdd(sid, {
        anchor: target.anchor,
        body,
        btw: mode === "btw",
        attachments: kept,
        sendNow: mode === "btw",
      });
      if (!reply.ok) {
        if (replyLost(reply.error)) setMadeWith(contentKey);
        setFailure(commentErrorText("add", reply.error));
        return;
      }
      // Kept: what was written is a comment now, not this target's draft.
      clearFormDraft(sid, target.key);
      const notSent =
        mode === "now"
          ? await sendWithStocked(reply.comment)
          : reply.outcome === undefined
            ? null
            : sendResultText(reply.outcome);
      if (notSent === null) {
        close();
        return;
      }
      setMadeWith(contentKey);
      setFailure(`保存した。送信は: ${notSent}`);
    } catch {
      setFailure(NOT_CONNECTED_TEXT);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      class="tl-comment-float"
      role="dialog"
      aria-label="コメントを書く"
      aria-busy={busy}
      ref={placeRef}
      onPointerDown={drag.onPointerDown}
      style={drag.style}
      onKeyDown={(event) => {
        // While a word is being converted, Esc is the IME's (it undoes the
        // conversion), not the form's.
        if (event.key !== "Escape" || event.isComposing || busy) return;
        event.preventDefault();
        close();
      }}
    >
      <header class="tl-comment-float-header">
        <CommentFormOn anchor={target.anchor} records={records} />
        <button
          type="button"
          class="composer-panel-close"
          onClick={close}
          disabled={busy}
          title="閉じる"
          aria-label="コメントのフォームを閉じる"
        >
          ✕
        </button>
      </header>
      <form class="tl-comment-form" aria-label="コメント">
        <ComposeTextareaContext.Provider value={inputRef}>
          <textarea
            ref={inputRef}
            class="tl-comment-input"
            aria-label="コメントの本文"
            placeholder="コメント… (⌘+Enter で保存)"
            value={body}
            rows={3}
            onInput={(event) =>
              edit({
                text: event.currentTarget.value,
                attachments: box.content.current.attachments,
              })
            }
            onKeyDown={(event) => {
              if (shouldSendOnKeyDown(event)) {
                event.preventDefault();
                void submit();
              }
            }}
            onPaste={attach.onPaste}
            onDragOver={attach.onDragOver}
            onDrop={attach.onDrop}
          />
          <ComposerAttachments
            attachments={box.attachments}
            onRemove={attach.removeAttachment}
            disabled={busy}
          />
          <div class="tl-comment-form-row">
            <AttachFileButton onFiles={attach.attachFiles} disabled={busy} />
            <SendSplitButton
              chosen={mode}
              offered
              runnable={!held && !uploading && body.trim() !== ""}
              busy={busy}
              onChoose={setMode}
              onRun={() => void submit()}
              runNote={uploading ? "アップロード中..." : undefined}
              runTitle={
                held ? "この本文のコメントは保存済み (または保存されたか分からない)" : undefined
              }
            />
          </div>
          {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
        </ComposeTextareaContext.Provider>
      </form>
    </div>
  );
}

/** What a comment is on, as one line over its text: what it replies to, the
 * start of the message or the file it is on (the block's `on`), and the way
 * to its place (DR-0062 §12). */
function CommentOn({
  comment,
  block,
}: {
  comment: UserComment | undefined;
  block: CommentBlock | undefined;
}) {
  const comments = useContext(TimelineCommentsContext);
  const anchor = comment?.anchor;
  // What the block says it is on: the transcript's, else the one its record
  // is sent as.
  const records = comments?.records;
  const on =
    block !== undefined
      ? block.on
      : comment !== undefined
        ? commentBlockOf(comment, (cid) => records?.get(cid)).on
        : undefined;
  const replyTo = on?.kind === "comment" || on?.kind === "btw" ? on.value : undefined;
  // A quote not found again in its bubble drawn now (DR-0062 §2), said in
  // the 💬 filter.
  const filter = useContext(TimelineFilterContext);
  const lost =
    filter === "comment" && comment !== undefined && comments?.lost.has(comment.cid) === true;
  // A comment on a file (DR-0062 §13): its place is the file in the Files
  // tab, its quote found again there, and said gone when the file drawn
  // there does not have it (P20).
  const host = useContext(SessionCommentsContext);
  const fileTreePath =
    anchor?.kind === "file" && host !== null
      ? fileTreePathOf(anchor.path, host.root, host.cwd)
      : null;
  const fileHref =
    fileTreePath === null || comments === null ? null : fileHrefOf(comments.sid, fileTreePath);
  const fileLost =
    filter === "comment" && comment !== undefined && host?.lostFiles.has(comment.cid) === true;
  const placeUuid =
    anchor?.kind === "message" || anchor?.kind === "selection"
      ? anchor.uuid
      : anchor?.kind === "comment"
        ? comments?.rowOf(anchor.cid)
        : undefined;
  return (
    <div class="tl-comment-on">
      {comment?.btw === true ? <BtwBadge /> : null}
      <CommentLabel cid={comment?.cid} />
      <ThreadNumberMark cid={comment?.cid} />
      {replyTo !== undefined ? <span class="tl-comment-reply-to">↩ {replyTo} への返信</span> : null}
      {on?.kind === "file" ? <span class="tl-comment-kind">{on.value}</span> : null}
      {on?.kind === "msg_start_with" && on.value !== "" ? (
        <q class="tl-comment-quote">{on.value}</q>
      ) : null}
      {placeUuid !== undefined && comments !== null ? (
        <button
          type="button"
          class="tl-comment-place"
          onClick={() => comments.jumpToRow(placeUuid)}
        >
          コメントした場所へ
        </button>
      ) : null}
      {fileHref !== null && comment !== undefined ? (
        <a class="tl-comment-place" href={fileHref} onClick={() => host?.revealFile(comment.cid)}>
          コメントした場所へ
        </a>
      ) : null}
      {lost ? <span class="tl-comment-lost">元の場所が見つからない</span> : null}
      {fileLost ? <span class="tl-comment-lost">元の場所が無くなった</span> : null}
    </div>
  );
}

/** 「1 / 3」 at a head (DR-0062 §12, §13): the number of the person's comment
 * `cid` in its thread, when the thread has two or more (threadNumbers). An
 * agent's reply or a btw answer shows the number of the comment it answers.
 * The text is the CSS `content` (as 「返信」's), read out as its label. */
export function ThreadNumberMark({ cid }: { cid: string | undefined }) {
  const comments = useContext(TimelineCommentsContext);
  const number = cid === undefined ? undefined : comments?.numbers.get(cid);
  if (number === undefined) return null;
  return (
    <span
      class="tl-thread-number"
      role="img"
      aria-label={`${String(number.of)} 件中 ${String(number.at)} 件目`}
      data-label={`${String(number.at)} / ${String(number.of)}`}
    />
  );
}

/** The 「💬 コメント」 at the head of a person's comment. In the 💬 filter it
 * is the disclosure button of the comment's thread (DR-0062 §13): while the
 * thread is closed, on each of its comments (`aria-expanded="false"`, any of
 * them opens it); while it is open, on its first comment only
 * (`aria-expanded="true"`, which closes it), the later ones a label (a press
 * of them moves the selection and closes nothing, so they are not shown as a
 * disclosure that does not close). Pressed (Enter / Space from the keyboard)
 * it does what a press of the item does (threadPressKey).
 * Design rationale: the item's own press is a pointer's only, see
 * useThreadPress in bookmark.tsx. */
function CommentLabel({ cid }: { cid: string | undefined }) {
  const comments = useContext(TimelineCommentsContext);
  const filter = useContext(TimelineFilterContext);
  const open =
    comments !== null &&
    cid !== undefined &&
    threadOpenOf(comments.records, comments.selected, cid);
  if (
    filter !== "comment" ||
    comments === null ||
    cid === undefined ||
    (open && threadRootOf(comments.records, cid) !== cid)
  ) {
    return <span class="tl-comment-label">💬 コメント</span>;
  }
  return (
    <button
      type="button"
      class="tl-comment-label"
      aria-expanded={open}
      onClick={(event) =>
        comments.press(
          threadPressKey(comments.records, comments.selected, cid),
          event.currentTarget,
        )
      }
    >
      💬 コメント
    </button>
  );
}

/** Whether a person's comment takes a reply (DR-0062 §3): one sent to the
 * session's own conversation (put in, seen there, or not known), whose cid
 * the conversation holds. Not one unsent or still waiting its turn, nor a
 * btw, which goes to a fork. */
function repliableComment(comment: UserComment): boolean {
  return (
    !comment.btw &&
    (comment.status === "sent" ||
      comment.status === "delivered" ||
      comment.status === "unconfirmed")
  );
}

/** The ✔️ / ✅ of a thread (DR-0062 §6, P14): resolves the thread the comment
 * `cid` is in, or takes the mark off. A thread that cannot be resolved now
 * (its first comment unsent, an unsent comment in it) shows ✔️ disabled. */
function ThreadResolveToggle({ cid }: { cid: string }) {
  const { ws } = useApp();
  const comments = useContext(TimelineCommentsContext);
  const [failure, setFailure] = useState<string | null>(null);
  // A cid the daemon has no record of (cleaned away) is in no thread.
  if (comments === null || !comments.records.has(cid)) return null;
  const { records, threads, sid } = comments;
  const resolved = threadResolved(records, threads, cid);
  const disabled = !resolved && !threadResolvable(records, cid);
  return (
    <>
      <button
        type="button"
        class="tl-comment-resolve"
        aria-pressed={resolved}
        disabled={disabled}
        aria-label={resolved ? "解決済みを外す" : "解決済みにする"}
        title={
          disabled
            ? "未送信のコメントがあるスレッドは解決済みにできない"
            : resolved
              ? "解決済みを外す"
              : "解決済みにする"
        }
        onClick={() => {
          setFailure(null);
          void ws
            .commentResolve(sid, cid, !resolved, threadLastCid(records, cid))
            .then((reply) => {
              if (!reply.ok) setFailure(commentErrorText("resolve", reply.error));
            })
            .catch(() => setFailure(NOT_CONNECTED_TEXT));
        }}
      >
        <StackedLabels labels={["✔️解決済み", "✅解決済み"]} shown={resolved ? 1 : 0} />
      </button>
      {failure !== null ? <span class="tl-comment-failure">{failure}</span> : null}
    </>
  );
}

/** The buttons of a person's comment drawn from its record (DR-0062 §11,
 * §13): one not sent is sent, changed or taken back (送る / 直す / 消す); one
 * not known to have arrived is made unsent again or taken as sent (下書きに
 * 戻す / 送った扱いにする). Buttons only: the bubble says nothing of its
 * state. A refusal says why and keeps the comment. */
function CommentActions({
  comment,
  onEdit,
}: {
  comment: UserComment;
  onEdit: (() => void) | null;
}) {
  const { ws } = useApp();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Runs one operation; it answers with why it was not done, or null. */
  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setFailure(null);
    try {
      setFailure(await action());
    } catch {
      setFailure(NOT_CONNECTED_TEXT);
    } finally {
      setBusy(false);
    }
  }
  const sid = comment.session_id;
  const send = () =>
    run(async () => {
      const reply = await ws.queueSend(sid, [
        { kind: "comment", cid: comment.cid, seen_updated_at: comment.updated_at },
      ]);
      if (!reply.ok) return commentErrorText("send", reply.error);
      const [result] = reply.results;
      return result === undefined ? null : sendResultText(result);
    });
  const remove = () =>
    run(async () => {
      const reply = await ws.commentDelete(sid, comment.cid, comment.updated_at);
      return reply.ok ? null : commentErrorText("delete", reply.error);
    });
  const settle = (action: "back_to_draft" | "mark_sent") =>
    run(async () => {
      const reply = await ws.unconfirmedSettle(
        sid,
        { kind: "comment", cid: comment.cid },
        action,
        comment.updated_at,
      );
      return reply.ok ? null : commentErrorText("settle", reply.error);
    });
  if (comment.status !== "draft" && comment.status !== "unconfirmed") return null;
  return (
    <>
      <div class="tl-comment-actions">
        {comment.status === "draft" ? (
          <>
            <button type="button" disabled={busy} onClick={() => void remove()}>
              消す
            </button>
            {onEdit !== null ? (
              <button type="button" disabled={busy} onClick={onEdit}>
                直す
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void send()}>
              送る
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void settle("back_to_draft")}>
              下書きに戻す
            </button>
            <button type="button" disabled={busy} onClick={() => void settle("mark_sent")}>
              送った扱いにする
            </button>
          </>
        )}
      </div>
      {comment.status === "draft" && comment.send_error !== undefined ? (
        <p class="tl-comment-failure">
          前の送信は届けられなかった: {commentSendErrorDetail(comment.send_error)}
        </p>
      ) : null}
      {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
    </>
  );
}

/** The text of an unsent comment being changed (直す), and its attachments
 * (📎, a paste or a drop, a chip's ×): 保存 puts them at the version shown,
 * 閉じる leaves it as it was. */
function CommentEdit({ comment, onDone }: { comment: UserComment; onDone: () => void }) {
  const { ws } = useApp();
  const box = useAttachmentBox(() => ({
    text: comment.body,
    attachments: boxAttachmentsOf(comment.attachments ?? []),
  }));
  const text = box.text;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attachLocked = useCallback(() => busy, [busy]);
  const attach = useAttachmentInput({
    textareaRef: inputRef,
    content: box.content,
    edit: box.edit,
    locked: attachLocked,
    text,
  });
  const uploading = hasPendingUpload(box.attachments);
  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      const reply = await ws.commentUpdate(
        comment.session_id,
        comment.cid,
        comment.updated_at,
        text,
        keptAttachmentsOf(box.attachments),
      );
      if (reply.ok) onDone();
      else setFailure(commentErrorText("update", reply.error));
    } catch {
      setFailure(NOT_CONNECTED_TEXT);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ComposeTextareaContext.Provider value={inputRef}>
      <textarea
        ref={inputRef}
        class="tl-comment-input"
        aria-label="コメントの本文"
        value={text}
        rows={3}
        onInput={(event) =>
          box.edit({
            text: event.currentTarget.value,
            attachments: box.content.current.attachments,
          })
        }
        onPaste={attach.onPaste}
        onDragOver={attach.onDragOver}
        onDrop={attach.onDrop}
      />
      <ComposerAttachments
        attachments={box.attachments}
        onRemove={attach.removeAttachment}
        disabled={busy}
      />
      <div class="tl-comment-actions">
        <AttachFileButton onFiles={attach.attachFiles} disabled={busy} />
        <button type="button" disabled={busy} onClick={onDone}>
          閉じる
        </button>
        <button
          type="button"
          disabled={busy || uploading || text.trim() === ""}
          onClick={() => void save()}
        >
          {uploading ? "アップロード中..." : "保存"}
        </button>
      </div>
      {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
    </ComposeTextareaContext.Provider>
  );
}

/** The bubble of a person's comment (DR-0062 §12, §13): at the person's
 * side, what it is on over its text, its 返信 (once sent, repliableComment)
 * and ✔️ / ✅ in the body's bottom row (P14). Drawn from the transcript's block once its row is there, and
 * from its record before, as it is when not sent (the 💬 filter's): the same
 * bubble, marked unsent (its green a shade off, and named so), with 送る /
 * 直す / 消す. A block whose cid the daemon has no record of is drawn alone:
 * there is no comment to reply to or thread to resolve (the item gives it no
 * target). */
export function CommentBubble({
  cid,
  block,
  ts,
  now,
}: {
  cid: string;
  /** The block as the transcript has it; absent when drawn from the record. */
  block?: CommentBlock;
  ts: string | null;
  now: number;
}) {
  const comments = useContext(TimelineCommentsContext);
  const record = comments?.records.get(cid);
  const comment = record?.author === "user" ? record : undefined;
  const [editing, setEditing] = useState(false);
  // The body as it went (its attachments' links put in), drawn as the
  // person's prompt is: verbatim, its links (an attachment, a URL, a file)
  // links (DR-0062 §12). One not sent yet is drawn as it will go.
  const body =
    block?.body ??
    (comment !== undefined ? attachmentLinkedText(comment.body, comment.attachments ?? []) : "");
  const filePathCtx = useContext(SessionFilePathCtxContext);
  const selection =
    block !== undefined
      ? block.select
      : comment !== undefined
        ? commentBlockOf(comment, (at) => comments?.records.get(at)).select
        : undefined;
  const resolved = comments !== null && threadResolved(comments.records, comments.threads, cid);
  const selected = useCommentSelected(comment?.anchor, cid);
  // Drawn from the record while not sent; the transcript's block is sent.
  const unsent = block === undefined && comment?.status === "draft";
  return (
    <div
      class="tl-bubble tl-bubble-right tl-bubble-comment"
      data-comment-kind={comment?.btw === true ? "btw" : "comment"}
      data-unsent={unsent ? "" : undefined}
      data-resolved={resolved ? "" : undefined}
      data-comment-selected={selected ? "" : undefined}
      {...(unsent ? { role: "group", "aria-label": "未送信のコメント" } : {})}
    >
      <div class="tl-bubble-body">
        <CommentOn comment={comment} block={block} />
        {selection !== undefined ? (
          <blockquote class="tl-comment-selection">{selection}</blockquote>
        ) : null}
        {unsent && editing && comment !== undefined ? (
          <CommentEdit comment={comment} onDone={() => setEditing(false)} />
        ) : (
          <p class="tl-comment-body" data-comment-text="">
            <LinkedPlainText text={body} ctx={filePathCtx} />
          </p>
        )}
        {block === undefined && comment !== undefined && !editing ? (
          <CommentActions comment={comment} onEdit={() => setEditing(true)} />
        ) : null}
        {comment === undefined ? null : repliableComment(comment) ? (
          <CommentReplyRow resolve={cid} />
        ) : (
          <ThreadResolveRow cid={cid} />
        )}
      </div>
      <BubbleFooter ts={ts} now={now} timeAtEnd />
    </div>
  );
}

/** The badge of a btw (DR-0062 §12): at the head of its question and of its
 * answer, saying they are not in the session's conversation. */
export function BtwBadge() {
  return (
    <span class="tl-btw-badge" title="btw: 本体の会話に入らない横道の質問と答え">
      btw
    </span>
  );
}

/** The head of an agent's reply (DR-0062 §12): that it is a `comment_reply`,
 * what it answers (the cid and the start of its text), and the way to it. */
export function CommentReplyHead({ replyTo }: { replyTo: string }) {
  const comments = useContext(TimelineCommentsContext);
  const quote = comments === null ? undefined : recordQuoteOf(comments.records, replyTo);
  const place = comments?.rowOf(replyTo);
  return (
    <div class="tl-comment-on tl-comment-reply-head">
      <span class="tl-comment-label">↩ comment_reply</span>
      <ThreadNumberMark cid={replyTo} />
      <span class="tl-comment-reply-to">{replyTo} への返信</span>
      {quote !== undefined && quote !== "" ? <q class="tl-comment-quote">{quote}</q> : null}
      {place !== undefined && comments !== null ? (
        <button type="button" class="tl-comment-place" onClick={() => comments.jumpToRow(place)}>
          元のコメントへ
        </button>
      ) : null}
    </div>
  );
}

/** Whether the agent's reply `cid` (to `replyTo`) is resolved and selected,
 * as its bubble marks itself. */
export function useReplyMarks(
  cid: string,
  replyTo: string,
): { resolved: boolean; selected: boolean } {
  const comments = useContext(TimelineCommentsContext);
  const resolved = comments !== null && threadResolved(comments.records, comments.threads, cid);
  const selected = useCommentSelected({ kind: "comment", cid: replyTo }, cid);
  return { resolved, selected };
}

/** An agent's reply drawn from its record (the 💬 filter's, outside the
 * window, DR-0062 §13): its head and its quote, the text being the
 * transcript's row the window does not hold. */
export function CommentReplyRecordBubble({ reply, now }: { reply: AgentReply; now: number }) {
  const replyTo = reply.anchor.kind === "comment" ? reply.anchor.cid : undefined;
  const { resolved, selected } = useReplyMarks(reply.cid, replyTo ?? "");
  return (
    <div
      class="tl-bubble tl-bubble-left tl-bubble-comment-reply"
      data-comment-kind="comment"
      data-resolved={resolved ? "" : undefined}
      data-comment-selected={selected ? "" : undefined}
    >
      <div class="tl-bubble-body">
        {replyTo !== undefined ? <CommentReplyHead replyTo={replyTo} /> : null}
        <p class="tl-comment-body">{reply.body_start ?? ""}</p>
        <CommentReplyRow resolve={reply.cid} />
      </div>
      <BubbleFooter ts={reply.written.at} now={now} />
    </div>
  );
}

/** What the 💬 filter's head shows (DR-0062 §13), and the way to change it:
 * not kept, back to COMMENT_SHOW_DEFAULT whenever `key` changes (the filter
 * entered again, another session). */
export function useCommentShow(
  key: readonly unknown[],
): [CommentShow, (which: CommentShowKey, on: boolean) => void] {
  const [sent, setSent] = useResettableState(key, () => COMMENT_SHOW_DEFAULT.sent);
  const [comment, setComment] = useResettableState(key, () => COMMENT_SHOW_DEFAULT.comment);
  const [btw, setBtw] = useResettableState(key, () => COMMENT_SHOW_DEFAULT.btw);
  const [resolved, setResolved] = useResettableState(key, () => COMMENT_SHOW_DEFAULT.resolved);
  const set = useCallback(
    (which: CommentShowKey, on: boolean) => {
      const setters = { sent: setSent, comment: setComment, btw: setBtw, resolved: setResolved };
      setters[which](on);
    },
    [setSent, setComment, setBtw, setResolved],
  );
  return [{ sent, comment, btw, resolved }, set];
}

/** The head of the 💬 filter (DR-0062 §13), in the Timeline's toolbar: the
 * check boxes of what is shown, and 全部送信, which sends everything stocked
 * (`items`, in the order written, whatever the boxes hide) and is not pressed
 * with none. */
export function CommentsFilterHead({
  hidden,
  sid,
  show,
  onShow,
  items,
}: {
  hidden: boolean;
  sid: string;
  show: CommentShow;
  onShow: (which: CommentShowKey, on: boolean) => void;
  items: readonly QueueSendItem[];
}) {
  const { ws } = useApp();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function sendAll() {
    if (busy || items.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const reply = await ws.queueSend(sid, [...items]);
      if (!reply.ok) {
        setFailure(commentErrorText("send", reply.error));
        return;
      }
      setFailure(sendResultsText(reply.results));
    } catch {
      setFailure(NOT_CONNECTED_TEXT);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="tl-comments-head" hidden={hidden}>
      {COMMENT_SHOW_KEYS.map((which) => (
        <label key={which}>
          <input
            type="checkbox"
            checked={show[which]}
            onChange={(event) => onShow(which, event.currentTarget.checked)}
          />
          {which}
        </label>
      ))}
      <button
        type="button"
        class="tl-comments-send-all"
        disabled={busy || items.length === 0}
        onClick={() => void sendAll()}
      >
        全部送信 ({items.length})
      </button>
      {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
    </div>
  );
}

/** Wraps an item that can be commented on: provides what its comment is on
 * (CommentTargetContext), none while `target` is undefined. The provider is
 * there either way, so the item's elements stay the same ones when its
 * target comes or goes (the comments' records arriving after its row): a
 * position landed on and held (usePositionPin) is not let go. */
export function CommentTargetScope({
  target,
  children,
}: {
  target: CommentTarget | undefined;
  children: ComponentChildren;
}) {
  return (
    <CommentTargetContext.Provider value={target ?? null}>{children}</CommentTargetContext.Provider>
  );
}
