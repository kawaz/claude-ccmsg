// The Status tab's secret handoff (DR-0052 §3, §7): a field that takes a
// paste and nothing else, which hands the pasted value to the daemon for the
// session at once, and the secrets the daemon holds for the session, each
// with what is left of its five minutes and a button that discards it.
//
// The value is read from the paste event and passed to the request, and is
// kept nowhere else: the paste is cancelled, so the field never holds it
// (DOM), and it is put in no state, store, storage or URL. The rows show the
// value's length and when it came, never the value.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { errorText, type HeldSecret, type SecretPutResponse } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { sameJson, useStoreState } from "../useStore.ts";
import { useSecondTick } from "../useSecondTick.ts";
import { formatDuration } from "../utils.ts";
import { ActionRow } from "./StatusSessionForms.tsx";

/** The line under the list after a paste: what came of the notice. */
export function secretPutResultText(res: SecretPutResponse): string {
  switch (res.notice.outcome) {
    case "delivered":
      return `${String(res.chars)} 文字を受けた。セッションに取り出し方を知らせた`;
    case "unconfirmed":
      return `${String(res.chars)} 文字を受けた。知らせが届いたかは確かめられなかった`;
    case "not_delivered":
      return `セッションに知らせが届かなかった (${res.notice.reason}) ので、預からなかった`;
  }
}

/** One held secret: its length, when it came and what is left, and 破棄. */
function HeldSecretRow({
  secret,
  now,
  discarding,
  onDiscard,
}: {
  secret: HeldSecret;
  now: number;
  discarding: boolean;
  onDiscard: () => void;
}) {
  const received = new Date(secret.received_at).toLocaleTimeString();
  const left = formatDuration(secret.expires_at - now);
  return (
    <ActionRow
      name={`${String(secret.chars)} 文字`}
      description={`${received} に受けた。残り ${left}`}
    >
      <button type="button" class="status-action-open" disabled={discarding} onClick={onDiscard}>
        破棄
      </button>
    </ActionRow>
  );
}

/** The held rows, with the clock that counts their time down: mounted only
 * while there are rows, so no tab ticks for nothing. */
function HeldSecretRows({
  secrets,
  discarding,
  onDiscard,
}: {
  secrets: readonly HeldSecret[];
  discarding: string | null;
  onDiscard: (key: string) => void;
}) {
  const now = useSecondTick();
  return (
    <>
      {secrets.map((secret) => (
        <HeldSecretRow
          key={secret.key}
          secret={secret}
          now={now}
          discarding={discarding === secret.key}
          onDiscard={() => onDiscard(secret.key)}
        />
      ))}
    </>
  );
}

export function SecretHandoff({ sid }: { sid: string }) {
  const { ws, store } = useApp();
  const held = useStoreState(
    store,
    (s) => s.secrets.filter((secret) => secret.session_id === sid),
    sameJson,
  );
  const [sending, setSending] = useState(false);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function hand(value: string): void {
    setSending(true);
    setNote(null);
    ws.secretPut(sid, value)
      .then((res) =>
        setNote(
          res.ok ? secretPutResultText(res) : `送れなかった (${res.error.code}): ${res.error.msg}`,
        ),
      )
      .catch((e: unknown) => setNote(`送れなかった: ${errorText(e)}`))
      .finally(() => setSending(false));
  }

  function discard(key: string): void {
    setDiscarding(key);
    setNote(null);
    ws.secretDiscard(key)
      .then((res) => {
        if (!res.ok) setNote(`破棄できなかった (${res.error.code}): ${res.error.msg}`);
      })
      .catch((e: unknown) => setNote(`破棄できなかった: ${errorText(e)}`))
      .finally(() => setDiscarding(null));
  }

  function onPaste(e: JSX.TargetedClipboardEvent<HTMLInputElement>): void {
    // Cancelled, so the value never becomes the field's, and kept from the
    // elements around the field and the document, so no other paste handler
    // of the page (the composer's, an attachment's) gets it.
    e.preventDefault();
    e.stopPropagation();
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
        {held.length > 0 ? (
          <HeldSecretRows secrets={held} discarding={discarding} onDiscard={discard} />
        ) : null}
      </ul>
      {note !== null ? <p class="status-secret-result">{note}</p> : null}
    </section>
  );
}
