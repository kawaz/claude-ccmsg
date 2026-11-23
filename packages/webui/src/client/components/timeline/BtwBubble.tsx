/** @jsxImportSource preact */
// A btw comment in the session's Timeline (DR-0062 §12, §14): what the person
// asked, drawn as their comment, and what the session's fork answered, below
// it as the session's answers are, framed together with a dashed line, since
// neither is in the session's conversation. Drawn from the comment records
// the daemon pushes; it holds no position, bookmark or row of its own.
import type { ErrorResponse, ForkUsage } from "@ccmsg/protocol";
import { useState } from "preact/hooks";
import type { PlacedBtw } from "../../btw-slots.ts";
import { commentErrorText, NOT_CONNECTED_TEXT } from "../../comment-view.ts";
import { useApp } from "../../context.ts";
import { MarkdownView } from "../../markdown-view.tsx";
import { useSecondTick } from "../../useSecondTick.ts";
import { formatDuration } from "../../utils.ts";
import {
  CommentBubble,
  CommentReplyRow,
  CommentTargetScope,
  ThreadResolveToggle,
} from "./comments.tsx";

/** What a fork cost, for the footer: the input read from the session's
 * prompt cache first (whether the fork kept the cache), then the rest. */
export function btwUsageText(usage: ForkUsage | undefined): string | null {
  if (usage === undefined) return null;
  const n = (count: number): string => count.toLocaleString("en-US");
  return (
    `cache read ${n(usage.cache_read_input_tokens)} / write ${n(usage.cache_creation_input_tokens)}` +
    ` / in ${n(usage.input_tokens)} / out ${n(usage.output_tokens)}`
  );
}

/** The line under a running btw: how long it has run, the tool its fork runs
 * now, and 取り消し. Its own second tick, mounted only while the btw runs. */
function BtwRunning({
  since,
  tool,
  pending,
  onCancel,
}: {
  since: string;
  tool: string | undefined;
  pending: boolean;
  onCancel: () => void;
}) {
  const now = useSecondTick();
  return (
    <div class="tl-btw-running" role="status">
      <span class="tl-turn-responding-dot" aria-hidden="true" />
      <span>btw 応答中…{formatDuration(now - Date.parse(since))}</span>
      {tool !== undefined ? <span class="tl-btw-tool">({tool})</span> : null}
      <button
        type="button"
        class="tl-turn-abort"
        title="この btw を取り消す"
        disabled={pending}
        onClick={onCancel}
      >
        取り消し
      </button>
    </div>
  );
}

/** A btw comment in the session's Timeline (DR-0062 §12, §14): its question
 * drawn as the person's comment is (what it is on, the text chosen, its
 * text; 送る / 直す / 消す while not sent), and below it the fork's answer as
 * the session's answers are, framed together with a dashed line, since
 * neither is in the session's conversation. An answer that ended takes a
 * reply (返信, and a choice in it); one that failed or was canceled is asked
 * again (もう一度聞く), the attempts before the last folded to their reason
 * (P30). Drawn from the records the daemon pushes. */
export function BtwCommentBubble({ btw, now }: { btw: PlacedBtw; now: number }) {
  const { ws } = useApp();
  const { question, answers } = btw;
  const sid = question.session_id;
  const last = answers.at(-1);
  const earlier = answers.slice(0, -1);
  // A press of 取り消し / もう一度聞く, this tab's only: the records say the rest.
  const [press, setPress] = useState<{ pending: boolean; failure: string | null }>({
    pending: false,
    failure: null,
  });
  // A cancel that went keeps its button off until the answer ends; a retry
  // that went brings a new answer with its own.
  async function run(
    action: () => Promise<{ ok: true } | ErrorResponse>,
    op: "send" | "settle",
    keep: boolean,
  ) {
    setPress({ pending: true, failure: null });
    let failure: string | null = null;
    try {
      const reply = await action();
      if (!reply.ok) failure = commentErrorText(op, reply.error);
    } catch {
      failure = NOT_CONNECTED_TEXT;
    }
    setPress({ pending: failure === null && keep, failure });
  }
  const running = last?.status === "running";
  const ended = last !== undefined && (last.status === "failed" || last.status === "canceled");
  // Sent and no answer recorded yet.
  const waiting = question.status === "sending" && !running;
  const runsAs = [last?.model, last?.effort].filter((part) => part !== undefined).join(" / ");
  const usage = btwUsageText(last?.usage);
  const askedAt = question.sent?.at ?? question.written.at;
  const took =
    last?.ended_at !== undefined
      ? formatDuration(Date.parse(last.ended_at) - Date.parse(last.written.at))
      : null;
  return (
    <div
      class="tl-btw"
      role="group"
      aria-label="btw"
      data-comment-kind="btw"
      data-unsent={question.status === "draft" ? "" : undefined}
      data-btw-status={last?.status}
      data-comment-cid={question.cid}
    >
      <CommentBubble cid={question.cid} ts={askedAt} now={now} />
      {earlier.map((answer) => (
        <p key={answer.cid} class="tl-btw-attempt">
          {answer.error ?? answer.status}
        </p>
      ))}
      {last !== undefined || waiting ? (
        <CommentTargetScope
          target={
            last !== undefined && last.status === "done"
              ? { key: `c:${last.cid}`, anchor: { kind: "comment", cid: last.cid } }
              : undefined
          }
        >
          <div class="tl-bubble tl-bubble-left tl-btw-answer" data-comment-cid={last?.cid}>
            {last !== undefined && last.body !== "" ? (
              <div class="tl-bubble-body">
                <MarkdownView source={last.body} />
                {last.status === "done" ? <CommentReplyRow /> : null}
              </div>
            ) : null}
            {waiting ? (
              <div class="tl-btw-running" role="status">
                <span class="tl-turn-responding-dot" aria-hidden="true" />
              </div>
            ) : null}
            {running ? (
              <BtwRunning
                since={last.written.at}
                tool={last.tool}
                pending={press.pending}
                onCancel={() => {
                  void run(() => ws.commentBtwCancel(sid, last.cid), "settle", true);
                }}
              />
            ) : null}
            {ended ? (
              <div class="tl-btw-ended">
                {last.error !== undefined ? (
                  <p class="tl-btw-error" role="alert">
                    {last.error}
                  </p>
                ) : null}
                <button
                  type="button"
                  class="tl-btw-retry"
                  disabled={press.pending}
                  onClick={() => {
                    void run(() => ws.commentBtwRetry(sid, question.cid), "send", false);
                  }}
                >
                  もう一度聞く
                </button>
              </div>
            ) : null}
            {press.failure !== null ? (
              <p class="tl-btw-error" role="alert">
                {press.failure}
              </p>
            ) : null}
          </div>
        </CommentTargetScope>
      ) : null}
      {last !== undefined ? (
        <div class="tl-btw-footer">
          {runsAs !== "" ? <span>{runsAs}</span> : null}
          {took !== null ? <span>{took}</span> : null}
          {usage !== null ? <span>{usage}</span> : null}
          <ThreadResolveToggle cid={last.cid} />
        </div>
      ) : null}
    </div>
  );
}
