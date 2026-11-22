// The comments of a session's Timeline (DR-0062 §3, §12, §13): the 返信
// button of a bubble and the form it opens, the 💬 of an item with comments,
// the bubble of a comment sent, the card of one not sent, the ✔️ / ✅ of a
// thread, and the 💬 filter's head (解決済みを表示) and preview area.
//
// What a comment is on (its anchor) is the item's: the item provides it
// (CommentTargetContext) and the bubble's 返信 reads it, so the bubbles take
// no prop for it. What the Timeline holds of the session's comments, and the
// one form open, are the Timeline's (TimelineCommentsContext).
import { createContext, type ComponentChildren } from "preact";
import { useContext, useId, useState } from "preact/hooks";
import {
  type AgentReply,
  type CommentAddAnchor,
  type CommentBlock,
  type CommentRecord,
  type ThreadState,
  type UserComment,
} from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { timelineHref } from "../../locator.ts";
import {
  commentErrorText,
  commentTargetKey,
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
import { formatMsgTime } from "../../utils.ts";
import { StackedLabels } from "../StackedLabels.tsx";
import { userPromptReasonDetail } from "../session-input.ts";
import { BubbleFooter } from "./BubbleFooter.tsx";
import { TimelinePositionContext } from "./context.ts";

/** What the Timeline holds of its session's comments, and the comment form
 * open in it. Null outside a session's own Timeline (an agent's Timeline has
 * no comments, DR-0062 §2). */
export interface TimelineComments {
  sid: string;
  records: ReadonlyMap<string, CommentRecord>;
  threads: ReadonlyMap<string, ThreadState> | undefined;
  /** How many of the person's comments each item has (commentCounts). */
  counts: ReadonlyMap<string, number>;
  /** The target key (CommentTarget.key) whose form is open. */
  formAt: string | null;
  openForm: (key: string) => void;
  closeForm: () => void;
  /** Move to the row `uuid` in the Timeline (DR-0058 §6). */
  jumpToRow: (uuid: string) => void;
  /** The transcript row the comment or reply `cid` is drawn at: a person's
   * comment's once seen delivered, an agent's reply's `comment_reply` call
   * when the window holds it. */
  rowOf: (cid: string) => string | undefined;
  /** The item (its target key) whose 💬 was pressed: its comments are the
   * selected ones in the 💬 filter (DR-0062 §12). */
  selected: string | null;
  select: (key: string) => void;
}
export const TimelineCommentsContext = createContext<TimelineComments | null>(null);

/** What a comment made on this item is on (DR-0062 §2): its key among the
 * item's comments (comment-view.ts commentTargetKey), the anchor, and the
 * block's quote. Provided by the item that can be commented on. */
export interface CommentTarget {
  key: string;
  anchor: CommentAddAnchor;
  quote?: string;
}
export const CommentTargetContext = createContext<CommentTarget | null>(null);

/** What a comment on the whole item of row `uuid` is on (DR-0062 §2). */
export function itemCommentTarget(uuid: string, on: ItemCommentOn): CommentTarget {
  return { key: `u:${uuid}`, anchor: { kind: "message", uuid, on: on.on }, quote: on.quote };
}

/** The 返信 of a bubble (DR-0062 §3): opens the form of a comment on the
 * whole bubble. In the bubble's footer, with the bubble's other buttons; an
 * item with no footer (a tool's call, a say, a fold's row) carries it at its
 * own bottom right (`atItem`). */
export function CommentReplyButton({ atItem = false }: { atItem?: boolean }) {
  const comments = useContext(TimelineCommentsContext);
  const target = useContext(CommentTargetContext);
  if (comments === null || target === null) return null;
  return (
    <button
      type="button"
      class={atItem ? "tl-comment-reply tl-item-reply" : "tl-comment-reply"}
      title="このバブルにコメントする"
      onClick={() => comments.openForm(target.key)}
    >
      返信
    </button>
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

/** Whether a comment or reply on `anchor` is among the selected ones: on the
 * item whose 💬 was pressed (DR-0062 §12). */
function useCommentSelected(anchor: CommentRecord["anchor"] | undefined): boolean {
  const comments = useContext(TimelineCommentsContext);
  const selected = comments?.selected ?? null;
  return anchor !== undefined && selected !== null && commentTargetKey(anchor) === selected;
}

/** The comment form of the item, while it is the one open. */
export function CommentFormSlot() {
  const comments = useContext(TimelineCommentsContext);
  const target = useContext(CommentTargetContext);
  if (comments === null || target === null || comments.formAt !== target.key) return null;
  return <CommentForm sid={comments.sid} target={target} onDone={comments.closeForm} />;
}

/** The form of a new comment (DR-0062 §3): the text, 「今すぐ送る」 (kept per
 * session), and 保存 / 送信. ⌘+Enter (Ctrl+Enter) does the same as the
 * button. It closes once the comment is kept (and, with 今すぐ送る, put in
 * the session). Otherwise it stays with the text and says why: a refusal
 * (nothing kept), a comment kept and not sent (it waits in the 💬 filter),
 * or no answer (it may be kept). The last two hold the text they were asked
 * with, so the same comment is not made twice from the form. */
function CommentForm({
  sid,
  target,
  onDone,
}: {
  sid: string;
  target: CommentTarget;
  onDone: () => void;
}) {
  const { ws } = useApp();
  const [body, setBody] = useState("");
  const [sendNow, setSendNow] = useState(() => readSendNow(sid));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The text a comment was made with (or may have been, no answer coming):
  // not asked for again as it stands.
  const [madeWith, setMadeWith] = useState<string | null>(null);
  const sendNowId = useId();
  const held = madeWith !== null && body === madeWith;
  async function submit() {
    if (busy || held || body.trim() === "") return;
    setBusy(true);
    setFailure(null);
    try {
      const reply = await ws.commentAdd(sid, {
        anchor: target.anchor,
        ...(target.quote !== undefined ? { quote: target.quote } : {}),
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
        onDone();
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
    <form
      class="tl-comment-form"
      aria-label="コメント"
      // A click in the form is the form's, not the item's (which selects the
      // item's position).
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        class="tl-comment-input"
        aria-label="コメントの本文"
        placeholder="コメント… (⌘+Enter で保存)"
        value={body}
        rows={3}
        onInput={(event) => setBody(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
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
        <button type="button" onClick={onDone} disabled={busy}>
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
  );
}

/** What a comment is on, as one line over its text: the kind and the quote,
 * and the way to its place (DR-0062 §12). */
function CommentOn({
  comment,
  block,
}: {
  comment: UserComment | undefined;
  block: CommentBlock | undefined;
}) {
  const comments = useContext(TimelineCommentsContext);
  const anchor = comment?.anchor;
  const on = block?.on ?? (anchor?.kind === "message" ? anchor.on : undefined);
  const quote = block?.quote ?? comment?.quote;
  const replyTo = block?.reply_to ?? (anchor?.kind === "comment" ? anchor.cid : undefined);
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
      {on !== undefined ? <span class="tl-comment-kind">{on}</span> : null}
      {quote !== undefined && quote !== "" ? <q class="tl-comment-quote">{quote}</q> : null}
      {placeUuid !== undefined && comments !== null ? (
        <button
          type="button"
          class="tl-comment-place"
          onClick={() => comments.jumpToRow(placeUuid)}
        >
          コメントした場所へ
        </button>
      ) : null}
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
        comment.cid,
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
 * is on over its text, and its 返信 and ✔️ / ✅. Drawn from the transcript's
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
  const selection = block?.selection;
  const state = comment !== undefined ? sendStateText(comment) : null;
  const resolved = comments !== null && threadResolved(comments.records, comments.threads, cid);
  const selected = useCommentSelected(comment?.anchor);
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
        <p class="tl-comment-body">{body}</p>
        {state !== null ? (
          <p class="tl-comment-state" data-status={comment?.status}>
            {state}
            {comment !== undefined ? <UnconfirmedActions comment={comment} /> : null}
          </p>
        ) : null}
      </div>
      <BubbleFooter ts={ts} now={now} timeAtEnd>
        <CommentReplyButton />
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
  const selected = useCommentSelected({ kind: "comment", cid: replyTo });
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
        <p class="tl-comment-body">{reply.quote ?? ""}</p>
      </div>
      <BubbleFooter ts={reply.written.at} now={now}>
        <CommentReplyButton />
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
  const selected = useCommentSelected(comment.anchor);
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
 * prompt they would reach the agent as, and 全部送る. */
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
  const { ws } = useApp();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function sendAll() {
    if (busy || comments.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const reply = await ws.queueSend(
        sid,
        comments.map((c) => ({ kind: "comment", cid: c.cid, seen_updated_at: c.updated_at })),
      );
      if (!reply.ok) {
        setFailure(commentErrorText("send", reply.error));
        return;
      }
      const notSent = reply.results.flatMap((result) => {
        const text = sendResultText(result);
        return text === null ? [] : [`${result.id}: ${text}`];
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
            class="tl-comments-send-all"
            disabled={busy}
            onClick={() => void sendAll()}
          >
            {busy ? "送信中…" : "全部送る"}
          </button>
        </>
      )}
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
