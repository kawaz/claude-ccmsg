// The Status tab's secret handoff (DR-0052 §3, §7): one row of a field, a
// send button and a delete button. The field and the send button work on the
// value not yet sent; the delete button works on the value the daemon holds
// for the session. Neither reaches into the other's.
//
// The field has two modes, by whether it holds text:
//
// - paste mode (empty): a paste is cancelled and kept in this component's
//   state only (never the field's DOM, the store, storage or the URL); the
//   placeholder then says how much was pasted
// - text mode (anything typed): what is typed is the field's own, shown
//   masked, with an eye to unmask it
//
// What came of a send shows in the tab's result box (`.status-op-result`)
// only when it is not plain: unconfirmed, or not sent. A held value shows as
// the delete button's seconds.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  type ErrorResponse,
  errorText,
  type HeldSecret,
  type SecretPutResponse,
} from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { sameJson, useStoreState } from "../useStore.ts";
import { useSecondTick } from "../useSecondTick.ts";
import { ActionRow } from "./StatusSessionForms.tsx";

/** What a send came to, as the result box says it: its tone (the box's
 * `data-tone`), its title and its line. */
export interface SecretPutResult {
  readonly tone: "running" | "error";
  readonly title: string;
  readonly text: string;
}

/** The result box of a `secret_put` reply; null for a notice that arrived,
 * which the delete button's seconds already show. */
export function secretPutResult(res: SecretPutResponse | ErrorResponse): SecretPutResult | null {
  if (!res.ok) {
    return { tone: "error", title: "送れなかった", text: `(${res.error.code}): ${res.error.msg}` };
  }
  switch (res.notice.outcome) {
    case "delivered":
      return null;
    case "unconfirmed":
      return {
        tone: "running",
        title: "送信した (未確認)",
        text: `${String(res.chars)} 文字を受けた。知らせが届いたかは確かめられなかった。最長 5 分で消える`,
      };
    case "not_delivered":
      return {
        tone: "error",
        title: "送れなかった",
        text: `セッションに知らせが届かなかった (${res.notice.reason}) ので、預からなかった`,
      };
  }
}

/** The lines of `text`: its newline-separated parts, a trailing newline
 * ending the last line rather than starting another (`a\nb\n` is 2). */
export function lineCount(text: string): number {
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** The field's placeholder: what paste mode holds, or that it takes one. */
export function secretPlaceholder(pasted: string | null): string {
  if (pasted === null) return "貼り付けモード (通常入力もできます)";
  const chars = String(Array.from(pasted).length);
  const lines = lineCount(pasted);
  return lines > 1 ? `入力済み: ${chars} 文字 (${String(lines)} 行)` : `入力済み: ${chars} 文字`;
}

/** The whole seconds left of `held` at `now`. */
export function secondsLeft(held: HeldSecret, now: number): number {
  return Math.max(0, Math.ceil((held.expires_at - now) / 1000));
}

/** 削除 with the seconds left, for a value the daemon holds: the clock that
 * counts them down is mounted only while one is held. */
function HeldDeleteButton({
  held,
  busy,
  onDelete,
}: {
  held: HeldSecret;
  busy: boolean;
  onDelete: () => void;
}) {
  const now = useSecondTick();
  return (
    <button type="button" class="status-action-open" disabled={busy} onClick={onDelete}>
      {`削除 (${String(secondsLeft(held, now))}秒)`}
    </button>
  );
}

/** An eye, open (the value shown) or shut (masked), drawn as the copy
 * buttons' icon is. */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      class="status-meta-copy-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
          <circle cx="8" cy="8" r="2" />
        </>
      ) : (
        <path d="M1.5 6.5s2.5 3.5 6.5 3.5 6.5-3.5 6.5-3.5M4 9l-1.2 1.6M8 10v2M12 9l1.2 1.6" />
      )}
    </svg>
  );
}

export function SecretHandoff({ sid }: { sid: string }) {
  const { ws, store } = useApp();
  const held = useStoreState(
    store,
    (s) => s.secrets.find((secret) => secret.session_id === sid),
    sameJson,
  );
  // The value not yet sent: pasted (paste mode) or typed (text mode, the
  // field's own value as well).
  const [pasted, setPasted] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<SecretPutResult | null>(null);
  const textMode = typed !== "";
  const toSend = textMode ? typed : (pasted ?? "");

  function send(): void {
    if (toSend === "" || sending) return;
    setSending(true);
    setResult(null);
    ws.secretPut(sid, toSend)
      .then((res) => {
        // A value that may have arrived is the daemon's now: the field goes
        // back to paste mode. One that was not sent stays, to send again.
        if (res.ok && res.notice.outcome !== "not_delivered") {
          setPasted(null);
          setTyped("");
          setRevealed(false);
        }
        setResult(secretPutResult(res));
      })
      .catch((e: unknown) =>
        setResult({ tone: "error", title: "送れなかった", text: errorText(e) }),
      )
      .finally(() => setSending(false));
  }

  function remove(): void {
    setDeleting(true);
    ws.secretDiscard(sid)
      .then((res) => {
        if (!res.ok) {
          setResult({
            tone: "error",
            title: "削除できなかった",
            text: `(${res.error.code}): ${res.error.msg}`,
          });
        }
      })
      .catch((e: unknown) =>
        setResult({ tone: "error", title: "削除できなかった", text: errorText(e) }),
      )
      .finally(() => setDeleting(false));
  }

  function onPaste(e: JSX.TargetedClipboardEvent<HTMLInputElement>): void {
    // Kept from the elements around the field and the document, so no other
    // paste handler of the page (the composer's, an attachment's) gets it.
    e.stopPropagation();
    // Text mode takes a paste as any field does, into what was typed.
    if (textMode) return;
    // Paste mode: cancelled, so the value never becomes the field's, and out
    // of the field, so a touch device's on-screen keyboard goes away.
    e.preventDefault();
    e.currentTarget.blur();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text === "") return;
    setPasted(text);
    setResult(null);
  }

  function onInput(e: JSX.TargetedEvent<HTMLInputElement, Event>): void {
    const value = e.currentTarget.value;
    setTyped(value);
    // Typing starts text mode, and what paste mode held is let go; emptied,
    // the field is back in paste mode, masked again.
    setPasted(null);
    if (value === "") setRevealed(false);
    setResult(null);
  }

  function onKeyDown(e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void {
    // Enter, ⌘Enter and Ctrl+Enter send; an IME's confirming Enter is the
    // IME's.
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    send();
  }

  return (
    <section class="status-section status-secrets">
      <h3 class="status-section-title">シークレット</h3>
      <ul class="status-actions">
        <ActionRow
          name="シークレットを渡す"
          description="送った値を daemon が 5 分預かり、このセッションに取り出し方を知らせる"
        >
          <span class="status-secret-controls">
            <span class="status-secret-field">
              <input
                type="text"
                class={
                  "status-secret-paste" + (textMode && !revealed ? " status-secret-masked" : "")
                }
                aria-label="シークレット"
                aria-busy={sending}
                placeholder={secretPlaceholder(pasted)}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck={false}
                value={typed}
                readOnly={sending}
                onDrop={(e) => e.preventDefault()}
                onPaste={onPaste}
                onInput={onInput}
                onKeyDown={onKeyDown}
              />
              {textMode ? (
                <button
                  type="button"
                  class="status-meta-copy status-secret-eye"
                  aria-pressed={revealed}
                  aria-label={revealed ? "伏せる" : "表示する"}
                  title={revealed ? "伏せる" : "表示する"}
                  onClick={() => setRevealed(!revealed)}
                >
                  <EyeIcon open={revealed} />
                </button>
              ) : null}
            </span>
            <button
              type="button"
              class="status-action-open"
              disabled={toSend === "" || sending}
              onClick={send}
            >
              送信
            </button>
            {held !== undefined ? (
              <HeldDeleteButton held={held} busy={deleting} onDelete={remove} />
            ) : (
              <button type="button" class="status-action-open" disabled>
                削除
              </button>
            )}
          </span>
        </ActionRow>
      </ul>
      {result !== null ? (
        <div class="status-op-result" data-tone={result.tone}>
          <p class="status-op-result-title">{result.title}</p>
          <p>{result.text}</p>
        </div>
      ) : null}
    </section>
  );
}
