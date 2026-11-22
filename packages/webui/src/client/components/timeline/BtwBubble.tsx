/** @jsxImportSource preact */
// One btw in the session's Timeline (DR-0060 §7): what the person asked, on
// the right as their prompts are, and what the session's fork answered, below
// it as the session's answers are, framed together with a dashed line, since
// neither is in the session's conversation. Drawn from the btw's record the
// daemon pushes; it holds no position, bookmark or row of its own.
import type { BtwRecord, ErrorResponse, BtwCancelResponse } from "@ccmsg/protocol";
import { useState } from "preact/hooks";
import { MarkdownView } from "../../markdown-view.tsx";
import { useSecondTick } from "../../useSecondTick.ts";
import { formatDuration, formatMsgTime } from "../../utils.ts";

/** What a btw_cancel error says to the person. */
function cancelFailureText(reply: ErrorResponse): string {
  return `取り消せませんでした: ${reply.error.msg}`;
}

export function BtwBubble({
  btw,
  now,
  onCancel,
}: {
  btw: BtwRecord;
  /** The Timeline's clock (useNow): what the time and the running time are
   * reckoned against. */
  now: number;
  onCancel: (id: string) => Promise<BtwCancelResponse | ErrorResponse>;
}) {
  // The press of 取り消し, this tab's only: the record's status says the rest.
  const [cancel, setCancel] = useState<{ pending: boolean; failure: string | null }>({
    pending: false,
    failure: null,
  });
  const running = btw.status === "running";
  const press = async (): Promise<void> => {
    setCancel({ pending: true, failure: null });
    let failure: string | null = null;
    try {
      const reply = await onCancel(btw.id);
      if (!reply.ok) failure = cancelFailureText(reply);
    } catch {
      failure = "daemon に繋がっていないため取り消せませんでした";
    }
    setCancel({ pending: failure === null, failure });
  };
  const runsAs = [btw.model, btw.effort].filter((part) => part !== undefined).join(" / ");
  const took =
    btw.ended_at !== undefined
      ? formatDuration(Date.parse(btw.ended_at) - Date.parse(btw.ts))
      : null;
  return (
    <div class="tl-btw" data-btw-status={btw.status} data-btw-id={btw.id}>
      <div class="tl-bubble tl-bubble-right">
        <div class="tl-bubble-body">
          <span class="tl-btw-tag">btw</span>
          <MarkdownView source={btw.prompt} restricted />
        </div>
      </div>
      <div class="tl-bubble tl-bubble-left tl-btw-answer">
        {btw.response !== "" ? (
          <div class="tl-bubble-body">
            <MarkdownView source={btw.response} />
          </div>
        ) : null}
        {running ? (
          <BtwRunning
            since={btw.ts}
            tool={btw.tool}
            pending={cancel.pending}
            onCancel={() => {
              void press();
            }}
          />
        ) : null}
        {btw.error !== undefined && !running ? (
          <p class="tl-btw-error" role="alert">
            {btw.error}
          </p>
        ) : null}
        {cancel.failure !== null ? (
          <p class="tl-btw-error" role="alert">
            {cancel.failure}
          </p>
        ) : null}
      </div>
      <div class="tl-btw-footer">
        <span class="tl-bubble-time">{formatMsgTime(btw.ts, now)}</span>
        {runsAs !== "" ? <span>{runsAs}</span> : null}
        {took !== null ? <span>{took}</span> : null}
      </div>
    </div>
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
