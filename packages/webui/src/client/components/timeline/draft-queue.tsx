/** @jsxImportSource preact */
// A FAB's draft in the 💬 filter (DR-0062 §13, §15): drawn as the person's
// prompt it goes as (its attachments put in), at the person's side, where it
// was written. One queued (not sent) is marked unsent (its green a shade
// off) and carries 送る / 直す (in the FAB's box) / 消す; one not known to
// have arrived carries 下書きに戻す / 送った扱いにする.
import { promptDraftText, type PromptDraftRecord } from "@ccmsg/protocol";
import { useContext, useState } from "preact/hooks";
import { useApp } from "../../context.ts";
import {
  commentErrorText,
  NOT_CONNECTED_TEXT,
  promptQueueErrorText,
  sendResultText,
} from "../../comment-view.ts";
import { MarkdownView } from "../../markdown-view.tsx";
import { userPromptReasonDetail } from "../session-input.ts";
import { EditDraftContext } from "../SessionInputComposer.tsx";
import { BubbleFooter } from "./BubbleFooter.tsx";

export function DraftBubble({ draft, now }: { draft: PromptDraftRecord; now: number }) {
  const { ws } = useApp();
  const editDraft = useContext(EditDraftContext);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sid = draft.session_id;
  const unsent = draft.status === "queued";
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
      const reply = await ws.queueSend(sid, [
        { kind: "draft", id: draft.id, seen_updated_at: draft.updated_at },
      ]);
      if (!reply.ok) return commentErrorText("send", reply.error);
      const [result] = reply.results;
      return result === undefined ? null : sendResultText(result);
    });
  const remove = () =>
    run(async () => {
      const reply = await ws.promptQueueDelete(sid, draft.id, draft.updated_at);
      return reply.ok ? null : promptQueueErrorText("delete", reply.error);
    });
  const settle = (action: "back_to_draft" | "mark_sent") =>
    run(async () => {
      const reply = await ws.unconfirmedSettle(
        sid,
        { kind: "draft", id: draft.id },
        action,
        draft.updated_at,
      );
      return reply.ok ? null : promptQueueErrorText("settle", reply.error);
    });
  return (
    <div
      class="tl-bubble tl-bubble-right tl-bubble-draft"
      data-comment-kind="draft"
      data-unsent={unsent ? "" : undefined}
      {...(unsent ? { role: "group", "aria-label": "未送信の FAB の下書き" } : {})}
    >
      <div class="tl-bubble-body">
        <MarkdownView source={promptDraftText(draft)} restricted />
        {unsent ? (
          <div class="tl-comment-actions">
            <button type="button" disabled={busy} onClick={() => void remove()}>
              消す
            </button>
            {editDraft !== null ? (
              <button type="button" disabled={busy} onClick={() => editDraft(draft)}>
                直す
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void send()}>
              送る
            </button>
          </div>
        ) : null}
        {draft.status === "unconfirmed" ? (
          <div class="tl-comment-actions">
            <button type="button" disabled={busy} onClick={() => void settle("back_to_draft")}>
              下書きに戻す
            </button>
            <button type="button" disabled={busy} onClick={() => void settle("mark_sent")}>
              送った扱いにする
            </button>
          </div>
        ) : null}
        {unsent && draft.send_error !== undefined ? (
          <p class="tl-comment-failure">
            前の送信は届けられなかった: {userPromptReasonDetail(draft.send_error)}
          </p>
        ) : null}
        {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
      </div>
      <BubbleFooter ts={draft.written.at} now={now} timeAtEnd />
    </div>
  );
}
