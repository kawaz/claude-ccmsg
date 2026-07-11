import { useState } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";

export function Composer({ room, mentionTo }: { room: RoomState; mentionTo: Set<string> }) {
  const { store, ws } = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const to = [...mentionTo];
      const res = await ws.post(room.id, trimmed, to);
      if (res.ok) {
        store.dispatch({
          type: "protocol-event",
          event: {
            type: "msg",
            mid: res.mid,
            from: ADMIN_ID,
            ...(to.length ? { to } : {}),
            ts: new Date().toISOString(),
            msg: trimmed,
            r: room.id,
          },
        });
        setText("");
      }
    } finally {
      setSending(false);
    }
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    await send();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Enter") return;
    // IME 変換確定の Enter は isComposing が true になるため送信しない
    if (e.isComposing) return;
    // Shift+Enter のみ送信、素の Enter は textarea 既定の改行に任せる
    if (!e.shiftKey) return;
    e.preventDefault();
    void send();
  }

  return (
    <form class="composer" onSubmit={(e) => void submit(e)}>
      <div class="composer-mention">
        {mentionTo.size
          ? `→ ${[...mentionTo].map((id) => memberLabel(id, room)).join(", ")}`
          : "room 全体へ (member chip をクリックで mention)"}
      </div>
      <textarea
        placeholder="メッセージを入力 (Shift+Enter で送信)"
        rows={2}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" disabled={sending}>
        送信
      </button>
    </form>
  );
}
