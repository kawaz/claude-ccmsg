// The comments of a session's Timeline (DR-0062 §3, §12, §13): the 返信
// button of a bubble and the form it opens (floating over the Timeline, not
// among its items), the 💬 of an item with comments,
// the bubble of a comment sent, the card of one not sent, the ✔️ / ✅ of a
// thread, and the 💬 filter's head (解決済みを表示) and preview area.
//
// What a comment is on (its anchor) is the item's: the item provides it
// (CommentTargetContext) and the bubble's 返信 reads it, so the bubbles take
// no prop for it. What the Timeline holds of the session's comments, and the
// one form open, are the Timeline's (TimelineCommentsContext).
import type { ComponentChildren } from "preact";
import { useCallback, useContext, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  commentBlockOf,
  type AgentReply,
  type CommentAddAnchor,
  type CommentBlock,
  type CommentRecord,
  type QueueSendItem,
  type UserComment,
} from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { timelineHref } from "../../locator.ts";
import {
  commentErrorText,
  commentSelected,
  listedDrafts,
  NOT_CONNECTED_TEXT,
  readSendNow,
  recordQuoteOf,
  replyLost,
  sendResultText,
  type ItemCommentOn,
  threadLastCid,
  threadResolvable,
  threadResolved,
  writeSendNow,
} from "../../comment-view.ts";
import { isPanelDragHandle, useDraggable } from "../../useDraggable.ts";
import { sameJson, useStoreState } from "../../useStore.ts";
import { DraftQueueSection, draftSendItem } from "./draft-queue.tsx";
import { formatMsgTime } from "../../utils.ts";
import { shouldSendOnKeyDown } from "../composer-keydown.ts";
import { StackedLabels } from "../StackedLabels.tsx";
import { userPromptReasonDetail } from "../session-input.ts";
import { BubbleFooter } from "./BubbleFooter.tsx";
import {
  CommentTargetContext,
  TimelineCommentsContext,
  type CommentTarget,
  type OpenCommentForm,
} from "./comment-context.ts";
import { QuoteMarks } from "./comment-quotes.tsx";
import { TimelineFilterContext, TimelinePositionContext } from "./context.ts";

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
 * The label is the CSS `content`, not text of the DOM (as 「! で実行」 is,
 * PermitRequestBubble's BangButton): it is inside the bubble's body, where
 * text would join what is selected and copied, and the body's text. The
 * name read out is its aria-label. */
export function CommentReplyRow() {
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
  if (comments === null || target === null) return null;
  return (
    <>
      <div class="tl-comment-reply-row" ref={rowRef}>
        <button
          type="button"
          class="tl-comment-reply"
          aria-label="返信"
          title="このバブルにコメントする"
          aria-haspopup="dialog"
          aria-expanded={comments.form?.target.key === target.key}
          onClick={(event) => comments.openForm(target, event.currentTarget)}
        />
      </div>
      {region !== null ? <QuoteMarks region={region} target={target} /> : null}
    </>
  );
}

/** The 💬 of an item with comments, and how many (DR-0062 §12, P8): a way
 * into the 💬 filter with the item's comments selected there. The position
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

/** The comment form while one is open (DR-0062 §3): over the Timeline, not
 * among its items. A form on another target is a new form (its text starts
 * empty). */
export function CommentFormFloat() {
  const comments = useContext(TimelineCommentsContext);
  const form = comments?.form ?? null;
  if (comments === null || form === null) return null;
  return (
    <CommentForm
      key={form.target.key}
      sid={comments.sid}
      form={form}
      records={comments.records}
      onClose={comments.closeForm}
    />
  );
}

/** What the comment being written is on, as the form's head: the start of
 * the message, or the cid it replies to and the start of that comment. The
 * form is not next to it, so the head says it. */
function CommentFormOn({
  anchor,
  records,
}: {
  anchor: CommentAddAnchor;
  records: ReadonlyMap<string, CommentRecord>;
}) {
  const quote =
    anchor.kind === "comment" ? recordQuoteOf(records, anchor.cid) : anchor.msg_start_with;
  // A quote in it (DR-0062 §3): the text chosen.
  const chosen = anchor.kind === "message" ? undefined : anchor.text;
  return (
    <div class="tl-comment-on">
      <span class="tl-comment-label">💬 コメント</span>
      {anchor.kind === "comment" ? (
        <span class="tl-comment-reply-to">↩ {anchor.cid} への返信</span>
      ) : null}
      {quote !== undefined && quote !== "" ? <q class="tl-comment-quote">{quote}</q> : null}
      {chosen !== undefined ? <q class="tl-comment-chosen">{chosen}</q> : null}
    </div>
  );
}

/** The form of a new comment (DR-0062 §3): what it is on, the text,
 * 「今すぐ送る」 (kept per session), and 保存 / 送信, in a panel floating over
 * the Timeline as the session's input is (SessionInputComposer): at the
 * bottom right, moved by dragging its margin, the Timeline seen and scrolled
 * under it. Opening it focuses the text without scrolling anything. ⌘+Enter
 * (Ctrl+Enter) does the same as the button, Esc closes it, and closing gives
 * the focus back to the button that opened it. It closes once the comment is
 * kept (and, with 今すぐ送る, put in the session). Otherwise it stays with
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
  const { ws } = useApp();
  const { target } = form;
  const [body, setBody] = useState("");
  const [sendNow, setSendNow] = useState(() => readSendNow(sid));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The text a comment was made with (or may have been, no answer coming):
  // not asked for again as it stands.
  const [madeWith, setMadeWith] = useState<string | null>(null);
  const sendNowId = useId();
  const held = madeWith !== null && body === madeWith;
  const drag = useDraggable({ handleFilter: isPanelDragHandle });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const close = () => {
    const opener = form.opener;
    onClose();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  async function submit() {
    if (busy || held || body.trim() === "") return;
    setBusy(true);
    setFailure(null);
    try {
      const reply = await ws.commentAdd(sid, {
        anchor: target.anchor,
        body,
        sendNow,
      });
      if (!reply.ok) {
        if (replyLost(reply.error)) setMadeWith(body);
        setFailure(commentErrorText("add", reply.error));
        return;
      }
      const notSent = reply.outcome === undefined ? null : sendResultText(reply.outcome);
      if (notSent === null) {
        close();
        return;
      }
      setMadeWith(body);
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
      ref={drag.setElement}
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
      <form
        class="tl-comment-form"
        aria-label="コメント"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={inputRef}
          class="tl-comment-input"
          aria-label="コメントの本文"
          placeholder="コメント… (⌘+Enter で保存)"
          value={body}
          rows={3}
          onInput={(event) => setBody(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (shouldSendOnKeyDown(event)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div class="tl-comment-form-row">
          <label for={sendNowId}>
            <input
              id={sendNowId}
              type="checkbox"
              checked={sendNow}
              onChange={(event) => {
                const on = event.currentTarget.checked;
                setSendNow(on);
                writeSendNow(sid, on);
              }}
            />
            今すぐ送る
          </label>
          <button type="button" onClick={close} disabled={busy}>
            {madeWith !== null ? "閉じる" : "やめる"}
          </button>
          <button
            type="submit"
            disabled={busy || held || body.trim() === ""}
            title={held ? "この本文のコメントは保存済み (または保存されたか分からない)" : undefined}
          >
            {sendNow ? "送信" : "保存"}
          </button>
        </div>
        {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
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
  const placeUuid =
    anchor?.kind === "message" || anchor?.kind === "selection"
      ? anchor.uuid
      : anchor?.kind === "comment"
        ? comments?.rowOf(anchor.cid)
        : undefined;
  return (
    <div class="tl-comment-on">
      <span class="tl-comment-label">💬 コメント</span>
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
      {lost ? <span class="tl-comment-lost">元の場所が見つからない</span> : null}
    </div>
  );
}

/** How far a comment sent has gone, in words (DR-0062 §11). */
function sendStateText(comment: UserComment): string | null {
  switch (comment.status) {
    case "sending":
      return "送信中…";
    case "sent":
      return "送った (transcript に出るのを待っている)";
    case "unconfirmed":
      return "届いたか分からない";
    case "draft":
    case "delivered":
    case "deleted":
      return null;
  }
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
export function ThreadResolveToggle({ cid }: { cid: string }) {
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
        <StackedLabels labels={["✔️", "✅"]} shown={resolved ? 1 : 0} />
      </button>
      {failure !== null ? <span class="tl-comment-failure">{failure}</span> : null}
    </>
  );
}

/** The 「下書きに戻す」 / 「送った扱いにする」 of a comment whose sending is
 * not known (DR-0062 §11). What is done comes back as the comment's new
 * state; a refusal says why. */
function UnconfirmedActions({ comment }: { comment: UserComment }) {
  const { ws } = useApp();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (comment.status !== "unconfirmed") return null;
  const settle = async (action: "back_to_draft" | "mark_sent") => {
    setBusy(true);
    setFailure(null);
    try {
      const reply = await ws.unconfirmedSettle(
        comment.session_id,
        { kind: "comment", cid: comment.cid },
        action,
        comment.updated_at,
      );
      if (!reply.ok) setFailure(commentErrorText("settle", reply.error));
    } catch {
      setFailure(NOT_CONNECTED_TEXT);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="tl-comment-unconfirmed">
      <button type="button" disabled={busy} onClick={() => void settle("back_to_draft")}>
        下書きに戻す
      </button>
      <button type="button" disabled={busy} onClick={() => void settle("mark_sent")}>
        送った扱いにする
      </button>
      {failure !== null ? <span class="tl-comment-failure">{failure}</span> : null}
    </span>
  );
}

/** The bubble of a comment sent (DR-0062 §12): at the person's side, what it
 * is on over its text, its 返信 (once sent, repliableComment) and ✔️ / ✅. Drawn from the transcript's
 * block once its row is there, and from its record before. A block whose cid
 * the daemon has no record of (cleaned away) is drawn alone: there is no
 * comment to reply to or thread to resolve (the item gives it no target). */
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
  const body = block?.body ?? comment?.body ?? "";
  const selection =
    block !== undefined
      ? block.select
      : comment !== undefined
        ? commentBlockOf(comment, (at) => comments?.records.get(at)).select
        : undefined;
  const state = comment !== undefined ? sendStateText(comment) : null;
  const resolved = comments !== null && threadResolved(comments.records, comments.threads, cid);
  const selected = useCommentSelected(comment?.anchor, cid);
  return (
    <div
      class="tl-bubble tl-bubble-right tl-bubble-comment"
      data-resolved={resolved ? "" : undefined}
      data-comment-selected={selected ? "" : undefined}
    >
      <div class="tl-bubble-body">
        <CommentOn comment={comment} block={block} />
        {selection !== undefined ? (
          <blockquote class="tl-comment-selection">{selection}</blockquote>
        ) : null}
        <p class="tl-comment-body" data-comment-text="">
          {body}
        </p>
        {state !== null ? (
          <p class="tl-comment-state" data-status={comment?.status}>
            {state}
            {comment !== undefined ? <UnconfirmedActions comment={comment} /> : null}
          </p>
        ) : null}
        {comment !== undefined && repliableComment(comment) ? <CommentReplyRow /> : null}
      </div>
      <BubbleFooter ts={ts} now={now} timeAtEnd>
        {comment !== undefined ? <ThreadResolveToggle cid={cid} /> : null}
      </BubbleFooter>
    </div>
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
      data-resolved={resolved ? "" : undefined}
      data-comment-selected={selected ? "" : undefined}
    >
      <div class="tl-bubble-body">
        {replyTo !== undefined ? <CommentReplyHead replyTo={replyTo} /> : null}
        <p class="tl-comment-body">{reply.body_start ?? ""}</p>
        <CommentReplyRow />
      </div>
      <BubbleFooter ts={reply.written.at} now={now}>
        <ThreadResolveToggle cid={reply.cid} />
      </BubbleFooter>
    </div>
  );
}

/** The card of a comment not sent (the 💬 filter's, DR-0062 §13): what it is
 * on, its text, and 送信 / 直す / 消す. A refusal says why and keeps it. */
export function CommentCard({ comment }: { comment: UserComment }) {
  const { ws } = useApp();
  const comments = useContext(TimelineCommentsContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolved =
    comments !== null && threadResolved(comments.records, comments.threads, comment.cid);
  const selected = useCommentSelected(comment.anchor, comment.cid);
  const selection = commentBlockOf(comment, (at) => comments?.records.get(at)).select;
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
  const send = () =>
    run(async () => {
      const reply = await ws.queueSend(comment.session_id, [
        { kind: "comment", cid: comment.cid, seen_updated_at: comment.updated_at },
      ]);
      if (!reply.ok) return commentErrorText("send", reply.error);
      const [result] = reply.results;
      return result === undefined ? null : sendResultText(result);
    });
  const save = () =>
    run(async () => {
      const reply = await ws.commentUpdate(
        comment.session_id,
        comment.cid,
        comment.updated_at,
        draft,
      );
      if (!reply.ok) return commentErrorText("update", reply.error);
      setEditing(false);
      return null;
    });
  const remove = () =>
    run(async () => {
      const reply = await ws.commentDelete(comment.session_id, comment.cid, comment.updated_at);
      return reply.ok ? null : commentErrorText("delete", reply.error);
    });
  return (
    <div
      class="tl-comment-card"
      data-resolved={resolved ? "" : undefined}
      data-comment-selected={selected ? "" : undefined}
    >
      <CommentOn comment={comment} block={undefined} />
      {selection !== undefined ? (
        <blockquote class="tl-comment-selection">{selection}</blockquote>
      ) : null}
      {editing ? (
        <textarea
          class="tl-comment-input"
          aria-label="コメントの本文"
          value={draft}
          rows={3}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
      ) : (
        <p class="tl-comment-body">{comment.body}</p>
      )}
      <div class="tl-comment-card-row">
        <span class="tl-comment-state">
          未送信
          {comment.send_error !== undefined
            ? ` (送れなかった: ${userPromptReasonDetail(comment.send_error)})`
            : ""}
          <span class="tl-bubble-time">{formatMsgTime(comment.written.at)}</span>
        </span>
        {editing ? (
          <>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              やめる
            </button>
            <button
              type="button"
              disabled={busy || draft.trim() === ""}
              onClick={() => void save()}
            >
              保存
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void remove()}>
              消す
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
            >
              直す
            </button>
            <button type="button" disabled={busy} onClick={() => void send()}>
              送信
            </button>
          </>
        )}
      </div>
      {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
    </div>
  );
}

/** The head of the 💬 filter (DR-0062 §13; the place is U10's, put as its
 * leaning): 「解決済みを表示」. Not kept: the filter opens with resolved
 * threads hidden (P19). */
export function CommentsFilterHead({
  hidden,
  showResolved,
  onToggle,
}: {
  hidden: boolean;
  showResolved: boolean;
  onToggle: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div class="tl-comments-head" hidden={hidden}>
      <label for={id}>
        <input
          id={id}
          type="checkbox"
          checked={showResolved}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
        解決済みを表示
      </label>
    </div>
  );
}

/** The 💬 filter's preview area (DR-0062 §13): the unsent comments as the one
 * prompt they would reach the agent as, and under them the FAB's drafts
 * (P11: the order they are sent in, read from the top). Each section sends
 * on its own; 全部送る sends the comments first, then the drafts. */
export function CommentsPreview({
  hidden,
  sid,
  comments,
  prompt,
}: {
  hidden: boolean;
  sid: string;
  /** The unsent comments, in the order they would be sent. */
  comments: readonly UserComment[];
  prompt: string;
}) {
  const { ws, store } = useApp();
  const drafts = useStoreState(store, (s) => listedDrafts(s.promptDrafts.get(sid)), sameJson);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const commentItems: QueueSendItem[] = comments.map((c) => ({
    kind: "comment",
    cid: c.cid,
    seen_updated_at: c.updated_at,
  }));
  const draftItems = drafts.filter((d) => d.status === "queued").map(draftSendItem);
  async function send(items: QueueSendItem[]) {
    if (busy || items.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const reply = await ws.queueSend(sid, items);
      if (!reply.ok) {
        setFailure(commentErrorText("send", reply.error));
        return;
      }
      const notSent = reply.results.flatMap((result) => {
        const text = sendResultText(result);
        return text === null
          ? []
          : [`${result.kind === "comment" ? result.id : "FAB の下書き"}: ${text}`];
      });
      if (notSent.length > 0) setFailure(notSent.join(" / "));
    } catch {
      setFailure(NOT_CONNECTED_TEXT);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="tl-comments-preview" hidden={hidden} aria-label="送る前のプレビュー">
      <h3 class="tl-comments-preview-title">コメント ({comments.length})</h3>
      {comments.length === 0 ? (
        <p class="tl-comments-preview-empty">未送信のコメントはありません</p>
      ) : (
        <>
          <pre class="tl-comments-preview-text">{prompt}</pre>
          <button
            type="button"
            class="tl-comments-send-section"
            disabled={busy}
            onClick={() => void send(commentItems)}
          >
            コメントを送る
          </button>
        </>
      )}
      <DraftQueueSection
        sid={sid}
        drafts={drafts}
        busy={busy}
        onSend={(items) => void send(items)}
      />
      {commentItems.length + draftItems.length > 0 ? (
        <button
          type="button"
          class="tl-comments-send-all"
          disabled={busy}
          onClick={() => void send([...commentItems, ...draftItems])}
        >
          {busy ? "送信中…" : "全部送る"}
        </button>
      ) : null}
      {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
    </section>
  );
}

/** Wraps an item that can be commented on: provides what its comment is on
 * (CommentTargetContext). */
export function CommentTargetScope({
  target,
  children,
}: {
  target: CommentTarget | undefined;
  children: ComponentChildren;
}) {
  if (target === undefined) return <>{children}</>;
  return <CommentTargetContext.Provider value={target}>{children}</CommentTargetContext.Provider>;
}
