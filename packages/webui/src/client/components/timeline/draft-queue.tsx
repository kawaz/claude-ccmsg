/** @jsxImportSource preact */
// The 「FAB の下書き」 section of the 💬 filter's preview area (DR-0062 §13,
// §15): the FAB's queued drafts, each as the prompt it goes as (its
// attachments put in), one by one, since each goes as a prompt of its own.
// A queued one is sent, changed (in the FAB's box) or taken back; one not
// known to have arrived is made a draft again or taken as sent. The section's
// own send and the area's 全部送る are the caller's (CommentsPreview), which
// sends the comments first.
import { promptDraftText, type PromptDraftRecord, type QueueSendItem } from "@ccmsg/protocol";
import { useContext, useState } from "preact/hooks";
import { useApp } from "../../context.ts";
import { draftStatusWord, NOT_CONNECTED_TEXT, promptQueueErrorText } from "../../comment-view.ts";
import { userPromptReasonDetail } from "../session-input.ts";
import { EditDraftContext } from "../SessionInputComposer.tsx";

/** A queued draft as queue_send names it. */
export function draftSendItem(draft: PromptDraftRecord): QueueSendItem {
  return { kind: "draft", id: draft.id, seen_updated_at: draft.updated_at };
}

export function DraftQueueSection({
  sid,
  drafts,
  busy,
  onSend,
}: {
  sid: string;
  /** The drafts listed (not sent), in the order put. */
  drafts: readonly PromptDraftRecord[];
  /** A send of the area is in flight. */
  busy: boolean;
  /** Send these (queue_send), as the area does. */
  onSend: (items: QueueSendItem[]) => void;
}) {
  const queued = drafts.filter((draft) => draft.status === "queued");
  return (
    <section class="tl-drafts-preview" aria-label="FAB の下書き">
      <h3 class="tl-comments-preview-title">FAB の下書き ({drafts.length})</h3>
      {drafts.length === 0 ? (
        <p class="tl-comments-preview-empty">キューに FAB の下書きはありません</p>
      ) : (
        <>
          <p class="tl-drafts-note">
            1 件ずつ別のプロンプトとして送る。続けて送ったものは連結されないが、同じ turn
            に並んで届く
          </p>
          <ol class="tl-drafts-list">
            {drafts.map((draft) => (
              <DraftItem key={draft.id} sid={sid} draft={draft} busy={busy} onSend={onSend} />
            ))}
          </ol>
          {queued.length > 0 ? (
            <button
              type="button"
              class="tl-drafts-send-section"
              disabled={busy}
              onClick={() => onSend(queued.map(draftSendItem))}
            >
              下書きを送る
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function DraftItem({
  sid,
  draft,
  busy,
  onSend,
}: {
  sid: string;
  draft: PromptDraftRecord;
  busy: boolean;
  onSend: (items: QueueSendItem[]) => void;
}) {
  const { ws } = useApp();
  const editDraft = useContext(EditDraftContext);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const disabled = busy || working;
  async function run(op: "delete" | "settle", call: () => ReturnType<typeof ws.promptQueueDelete>) {
    setWorking(true);
    setFailure(null);
    try {
      const reply = await call();
      if (!reply.ok) setFailure(promptQueueErrorText(op, reply.error));
    } catch {
      setFailure(NOT_CONNECTED_TEXT);
    } finally {
      setWorking(false);
    }
  }
  const settle = (action: "back_to_draft" | "mark_sent") =>
    void run("settle", () =>
      ws.unconfirmedSettle(sid, { kind: "draft", id: draft.id }, action, draft.updated_at),
    );
  return (
    <li class="tl-draft-item" data-status={draft.status}>
      {draft.status !== "queued" ? (
        <p class="tl-draft-status">{draftStatusWord(draft.status)}</p>
      ) : null}
      <pre class="tl-comments-preview-text tl-draft-text">{promptDraftText(draft)}</pre>
      {draft.send_error !== undefined && draft.status === "queued" ? (
        <p class="tl-comment-failure">
          前の送信は届けられなかった: {userPromptReasonDetail(draft.send_error)}
        </p>
      ) : null}
      <div class="tl-draft-actions">
        {draft.status === "queued" ? (
          <>
            <button
              type="button"
              class="tl-draft-send"
              disabled={disabled}
              onClick={() => onSend([draftSendItem(draft)])}
            >
              送る
            </button>
            {editDraft !== null ? (
              <button
                type="button"
                class="tl-draft-edit"
                disabled={disabled}
                onClick={() => editDraft(draft)}
              >
                直す
              </button>
            ) : null}
            <button
              type="button"
              class="tl-draft-delete"
              disabled={disabled}
              onClick={() =>
                void run("delete", () => ws.promptQueueDelete(sid, draft.id, draft.updated_at))
              }
            >
              消す
            </button>
          </>
        ) : null}
        {draft.status === "unconfirmed" ? (
          <>
            <button
              type="button"
              class="tl-draft-back"
              disabled={disabled}
              onClick={() => settle("back_to_draft")}
            >
              下書きに戻す
            </button>
            <button
              type="button"
              class="tl-draft-mark-sent"
              disabled={disabled}
              onClick={() => settle("mark_sent")}
            >
              送った扱いにする
            </button>
          </>
        ) : null}
      </div>
      {failure !== null ? <p class="tl-comment-failure">{failure}</p> : null}
    </li>
  );
}
