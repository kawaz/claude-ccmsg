import { useState } from "preact/hooks";
import { USER_UID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";

export function Composer({ room, mentionTo }: { room: RoomState; mentionTo: Set<number> }) {
  const { store, ws } = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
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
            from: USER_UID,
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

  return (
    <form class="composer" onSubmit={(e) => void submit(e)}>
      <div class="composer-mention">
        {mentionTo.size
          ? `→ ${[...mentionTo].map((u) => memberLabel(u, room)).join(", ")}`
          : "room 全体へ (member chip をクリックで mention)"}
      </div>
      <textarea
        placeholder="メッセージを入力"
        rows={2}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <button type="submit" disabled={sending}>
        送信
      </button>
    </form>
  );
}
