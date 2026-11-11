// The Status tab's secret handoff (DR-0052 §3, §7): a field that takes a
// paste and nothing else, which hands the pasted value to the daemon for the
// session at once, and what came of it in the result box the tab's launch and
// restart use (`.status-op-result`), until the next paste.
//
// The value is read from the paste event and passed to the request, and is
// kept nowhere else: the paste is cancelled, so the field never holds it
// (DOM), and it is put in no state, store, storage or URL. The result says
// the value's length, never the value.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { type ErrorResponse, errorText, type SecretPutResponse } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { ActionRow } from "./StatusSessionForms.tsx";

/** What a paste came to, as the result box says it: its tone (the box's
 * `data-tone`), its title and its line. */
export interface SecretPutResult {
  readonly tone: "ok" | "running" | "error";
  readonly title: string;
  readonly text: string;
}

/** The result box of a `secret_put` reply. */
export function secretPutResult(res: SecretPutResponse | ErrorResponse): SecretPutResult {
  if (!res.ok) {
    return {
      tone: "error",
      title: "送れなかった",
      text: `送れなかった (${res.error.code}): ${res.error.msg}`,
    };
  }
  const chars = String(res.chars);
  switch (res.notice.outcome) {
    case "delivered":
      return {
        tone: "ok",
        title: "送信成功",
        text: `${chars} 文字を受けた。セッションに取り出し方を知らせた。最長 5 分で消える`,
      };
    case "unconfirmed":
      return {
        tone: "running",
        title: "送信した (未確認)",
        text: `${chars} 文字を受けた。知らせが届いたかは確かめられなかった。最長 5 分で消える`,
      };
    case "not_delivered":
      return {
        tone: "error",
        title: "送れなかった",
        text: `セッションに知らせが届かなかった (${res.notice.reason}) ので、預からなかった`,
      };
  }
}

export function SecretHandoff({ sid }: { sid: string }) {
  const { ws } = useApp();
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SecretPutResult | null>(null);

  function hand(value: string): void {
    setSending(true);
    setResult(null);
    ws.secretPut(sid, value)
      .then((res) => setResult(secretPutResult(res)))
      .catch((e: unknown) =>
        setResult({ tone: "error", title: "送れなかった", text: `送れなかった: ${errorText(e)}` }),
      )
      .finally(() => setSending(false));
  }

  function onPaste(e: JSX.TargetedClipboardEvent<HTMLInputElement>): void {
    // Cancelled, so the value never becomes the field's, and kept from the
    // elements around the field and the document, so no other paste handler
    // of the page (the composer's, an attachment's) gets it.
    e.preventDefault();
    e.stopPropagation();
    // Out of the field, so a touch device's on-screen keyboard goes away; the
    // field takes no typing, and nothing else is focused in its place.
    e.currentTarget.blur();
    if (sending) return;
    const value = e.clipboardData?.getData("text/plain") ?? "";
    if (value !== "") hand(value);
  }

  return (
    <section class="status-section status-secrets">
      <h3 class="status-section-title">シークレット</h3>
      <ul class="status-actions">
        <ActionRow
          name="シークレットを渡す"
          description="貼り付けた値を daemon が 5 分預かり、このセッションに取り出し方を知らせる"
        >
          <input
            type="text"
            class="status-secret-paste"
            aria-label="シークレットを貼り付け"
            aria-busy={sending}
            placeholder="ここに貼り付け"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
            value=""
            // Typing, dropping and the like are refused before they change
            // the field; a paste is taken by onPaste and refused the same.
            onBeforeInput={(e) => e.preventDefault()}
            onDrop={(e) => e.preventDefault()}
            onPaste={onPaste}
            // An IME's composition is not cancellable: whatever got in is
            // cleared again.
            onInput={(e) => {
              e.currentTarget.value = "";
            }}
          />
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
