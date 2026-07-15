/** @jsxImportSource preact */
// DR-0014 §2.6 1on1 floating composer for SessionView.
//
// Renders a persistent "+" FAB in the bottom-right of the Files/Timeline
// tabs. Clicking expands into an inline text panel that composes a priv to
// the currently-viewed session's `kind:"1on1"` room — reused if one exists,
// auto-created via `ws.createOneOnOneRoom` otherwise.
//
// Draft handling (§2.6):
//  - Text is persisted to localStorage under `ccmsg.1on1.<sid>` so switching
//    tabs or navigating away doesn't drop unsent input.
//  - A mount-time sweep purges stale entries: (a) sid no longer in peers,
//    (b) 10+ days of inactivity on the target session (peers.last_activity_at
//    if present, else the draft's own updatedAt as fallback).
//
// Auto-create (§2.2):
//  - `findExistingOneOnOne` looks up an existing room by `kind === "1on1"`
//    AND its single non-u1 member sid matching, per the "判別は kind フィールド
//    で行う (title 文字列一致は typo に弱い)" rule.
//  - When none exists, `createOneOnOneRoom` opens one with title
//    `"<repo> 1on1 <sid8>"` (§4.4), then posts the draft to the fresh room.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useApp } from "../context.ts";
import type { AppState, RoomState } from "../store.ts";
import { Avatar } from "../avatar.tsx";
import { lastPathSegment } from "../utils.ts";
import {
  extractPastedImages,
  hasPendingUpload,
  insertPlaceholder,
  maxPlaceholderNumber,
  nextAttachmentNumber,
  removePlaceholder,
  substitutePlaceholders,
  type ComposerAttachment,
} from "./composer-attachments.ts";
import { ComposerAttachments } from "./ComposerAttachments.tsx";
import { uploadAttachment } from "./composer-upload.ts";

export const LOCAL_STORAGE_PREFIX = "ccmsg.1on1.";
export const CLEANUP_STALE_DAYS = 10;
export const CLEANUP_STALE_MS = CLEANUP_STALE_DAYS * 24 * 60 * 60 * 1000;

export interface StoredDraft {
  text: string;
  /** ISO-8601 wall-clock stamp of the last edit; used by the cleanup sweep
   * as a fallback when peers.last_activity_at isn't available. */
  updatedAt: string;
}

export function keyFor(sid: string): string {
  return `${LOCAL_STORAGE_PREFIX}${sid}`;
}

export function loadDraft(sid: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(keyFor(sid));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as StoredDraft).text === "string" &&
      typeof (parsed as StoredDraft).updatedAt === "string"
    ) {
      return parsed as StoredDraft;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveDraft(sid: string, text: string): void {
  try {
    const payload: StoredDraft = { text, updatedAt: new Date().toISOString() };
    localStorage.setItem(keyFor(sid), JSON.stringify(payload));
  } catch {
    // storage unavailable (private mode / quota): drop silently — the next
    // reopen simply starts with an empty textarea instead of restoring.
  }
}

export function clearDraft(sid: string): void {
  try {
    localStorage.removeItem(keyFor(sid));
  } catch {
    // ignore
  }
}

/** DR-0014 §2.6 mount-time sweep. Two purge rules:
 *  - (a) sid absent from `state.peers`: the target session is gone, the
 *    draft can never be delivered — drop.
 *  - (b) the target session has been idle > 10 days (uses peers'
 *    `last_activity_at` when present, falls back to the draft's own
 *    `updatedAt` if the peer entry has no activity stamp): kawaz's
 *    "10日以上非アクティブなセッションまたは対応するセッションが無ければ消す".
 *
 * Runs once per SessionView mount, guarded by a `state.peers.length > 0`
 * check upstream — a mount that fires before peers arrives skips the sweep
 * (no reference to compare against) and re-runs on the next visit. */
export function cleanupStaleDrafts(state: AppState, now: number = Date.now()): void {
  const keys: string[] = [];
  try {
    const n = localStorage.length;
    for (let i = 0; i < n; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LOCAL_STORAGE_PREFIX)) keys.push(k);
    }
  } catch {
    return;
  }
  const activePeerSids = new Set(state.peers.map((p) => p.sid));
  for (const key of keys) {
    const sid = key.slice(LOCAL_STORAGE_PREFIX.length);
    if (!activePeerSids.has(sid)) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
      continue;
    }
    const draft = loadDraft(sid);
    const peer = state.peers.find((p) => p.sid === sid);
    const peerActivityMs = peer?.last_activity_at ? Date.parse(peer.last_activity_at) : NaN;
    const draftMs = draft ? Date.parse(draft.updatedAt) : NaN;
    // Prefer the peer's own activity stamp — that's the direct signal of
    // "was this session touched recently". Fall back to the draft stamp if
    // the peer entry doesn't carry one (older daemons pre-issue-2026-07-12,
    // or a fresh session that hasn't sent a request yet). Missing both leaves
    // referenceMs as NaN, which fails the comparison below → the entry stays
    // (safe default; a subsequent visit with better data will retry).
    const referenceMs = Number.isFinite(peerActivityMs)
      ? peerActivityMs
      : Number.isFinite(draftMs)
        ? draftMs
        : NaN;
    if (Number.isFinite(referenceMs) && now - referenceMs > CLEANUP_STALE_MS) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }
}

/** Find an existing `kind:"1on1"` room whose single non-u1 member sid matches
 * `sid`. Distinguished by `room.kind` alone (title strings are display-only
 * per §2.1: "判別は kind フィールドで行う"). Returns null when no such room
 * exists — the caller creates a fresh one. */
export function findExistingOneOnOne(state: AppState, sid: string): RoomState | null {
  for (const room of state.rooms.values()) {
    if (room.kind !== "1on1") continue;
    // u1 is implicit (no member row per DR-0006), so the room's member list
    // is exactly the target session — modulo "left" flags after a kick or
    // leave. Filter to present members and require exactly one, matching sid.
    const present = [...room.membersById.values()].filter((m) => !m.left);
    if (present.length !== 1) continue;
    if (present[0]!.sid === sid) return room;
  }
  return null;
}

export function OneOnOneComposer({ sid, state }: { sid: string; state: AppState }) {
  const { ws } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // DR-0015 attachment 機能 (kawaz r15 mid=5、2026-07-14): 通常 room の
  // Composer と同じ添付経路を 1on1 でも提供。attachments は transient state
  // で localStorage には保存しない — draft は text のみ (§2.6)。close→reopen
  // すると本文の [FILE<N>] プレースホルダは復元されるが attachments 一覧は
  // 空 (未解決の [FILE<N>] は送信時 substitute でリテラル残る)。
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // パネルヘッダの宛先ラベル (kawaz r17 mid=1): repo → ws → cwd 末尾 → sid8。
  const targetPeer = state.peers.find((p) => p.sid === sid);
  const targetLabel =
    targetPeer?.repo || targetPeer?.ws || lastPathSegment(targetPeer?.cwd ?? "") || sid.slice(0, 8);

  // Mount-time cleanup — depends on peers.length so the sweep waits for the
  // peers list to hydrate (empty on the very first render before ws.ts's
  // onOpen finishes the handshake). A later peers push doesn't re-run it —
  // one sweep per component instance is enough; navigating away and back
  // remounts and re-sweeps.
  useEffect(() => {
    if (state.peers.length > 0) cleanupStaleDrafts(state);
    // We deliberately do NOT depend on `state` itself (would re-run on every
    // action) or on `state.peers` array identity (recreated by peers/loaded
    // even when the underlying set didn't change).
  }, [state.peers.length]);

  // Restore draft when the panel opens for this sid — also re-runs when the
  // sid changes while open (e.g. user opened the panel on session A, then
  // navigated to session B before submitting), reloading B's own draft.
  // attachments も同時にリセット: 別 sid の 1on1 に持ち込むと [FILE<N>] が
  // 別 room の相手向けの UUID を指してしまうため。localStorage に attachments
  // を保存しない設計 (§2.6 draft は text のみ) の帰結として、sid 切替は
  // attachments を捨てる必要がある。
  useEffect(() => {
    if (!open) return;
    const draft = loadDraft(sid);
    setText(draft?.text ?? "");
    setAttachments([]);
    setError(null);
  }, [open, sid]);

  // Persist text as the user types. Empty text explicitly clears the entry
  // rather than storing an empty draft — an unused compose that never gets
  // typed shouldn't count as a draft needing later cleanup. A per-keystroke
  // localStorage.setItem is cheap enough not to need debouncing here.
  useEffect(() => {
    if (!open) return;
    if (text === "") {
      clearDraft(sid);
      return;
    }
    saveDraft(sid, text);
  }, [open, sid, text]);

  // DR-0015 §2.5 attachment upload 開始 (通常 Composer と同じロジック)。
  // caret 位置にプレースホルダ挿入 + XHR upload、progress は state に反映、
  // 送信ボタン disable は hasPendingUpload に委ねる。
  const beginUpload = useCallback(
    (file: File) => {
      const el = textareaRef.current;
      const caret = el ? el.selectionStart : text.length;
      // 本文中の [FILE<N>] の max も跨いで採番 (kawaz r17 mid=33): 1on1 は
      // draft 復元 (text は [FILE<N>] 入りで戻るが attachments は空リセット、
      // §2.6) があるため、attachments 配列だけ見た採番は番号を再利用して
      // 送信時 substitute が新旧 placeholder を同じ path に潰してしまう。
      const textFloor = maxPlaceholderNumber(text);
      let assignedN = 0;
      setAttachments((prev) => {
        const n = Math.max(nextAttachmentNumber(prev), textFloor + 1);
        assignedN = n;
        return [...prev, { n, name: file.name || "upload", status: "uploading", progress: 0 }];
      });
      setText((current) => {
        const n = assignedN || nextAttachmentNumber(attachments) || 1;
        return insertPlaceholder(current, caret, n);
      });
      const n = assignedN;
      void (async () => {
        try {
          const meta = await uploadAttachment(file, (percent) => {
            setAttachments((prev) =>
              prev.map((a) => (a.n === n ? { ...a, progress: percent } : a)),
            );
          });
          setAttachments((prev) =>
            prev.map((a) =>
              a.n === n
                ? {
                    ...a,
                    status: "done",
                    progress: 100,
                    uuid: meta.uuid,
                    ext: meta.ext,
                    size: meta.size,
                    mime: meta.mime,
                    path: meta.path,
                    name: meta.name,
                  }
                : a,
            ),
          );
        } catch (err) {
          setAttachments((prev) =>
            prev.map((a) =>
              a.n === n
                ? {
                    ...a,
                    status: "error",
                    errorMsg: err instanceof Error ? err.message : String(err),
                  }
                : a,
            ),
          );
        }
      })();
    },
    [text, attachments],
  );

  const removeAttachment = useCallback((n: number) => {
    setAttachments((prev) => prev.filter((a) => a.n !== n));
    setText((current) => removePlaceholder(current, n));
  }, []);

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const images = extractPastedImages(e.clipboardData.items);
      if (images.length === 0) return; // 通常テキスト paste は default に任せる
      e.preventDefault();
      for (const f of images) beginUpload(f);
    },
    [beginUpload],
  );

  const onFilesPicked = useCallback(
    (input: HTMLInputElement | null) => {
      if (!input?.files) return;
      for (const f of Array.from(input.files)) beginUpload(f);
      input.value = ""; // 同じファイルの再選択を可能に (change event が発火するように)
    },
    [beginUpload],
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);

  // フォーム外の **click** で閉じる (kawaz r17 mid=8,10,11、2026-07-14)。
  // × ボタンは廃止して、パネル外クリックで close する UX (r15 mid=2)。
  // mousedown/touchstart 判定はスクロール目的のタッチ (指を置いた瞬間) でも
  // 閉じてしまい不便なので不可 — click は tap 完了 (押して離す) でだけ発火し、
  // スクロール gesture では発火しない。kawaz 明言「フォーム関連要素以外の
  // click イベントで閉じて」。open 中だけ listener を張る (閉じてる間は
  // 無駄 listener を避ける)。
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel || !(e.target instanceof Node)) return;
      if (!panel.contains(e.target)) handleClose();
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
    };
  }, [open, handleClose]);

  const handleSubmit = useCallback(async () => {
    const body = text.trim();
    if (body === "") return;
    if (hasPendingUpload(attachments)) return; // safety net (ボタン disable 済)
    setSending(true);
    setError(null);
    try {
      // DR-0015 §2.4 送信時 substitute: [FILE<N>] を [FILE<N>:<name>](<path>)
      // に置換してから post。未完了 (upload 中 / error) の entry は substitute
      // が skip するので、text にリテラル [FILE<N>] が残る (pending は上の
      // hasPendingUpload で送信自体を止めているのでここには来ない、error は
      // × で消してから送信する運用)。
      const finalText = substitutePlaceholders(body, attachments);
      const existing = findExistingOneOnOne(state, sid);
      let roomId: string;
      if (existing) {
        roomId = existing.id;
      } else {
        // Pull the target session's repo for the title. Absent = "(unknown)"
        // (display-only; the daemon persists whatever we pass verbatim). sid8
        // gives a stable per-session tag: sids are UUIDs, first 8 chars are
        // distinctive enough to disambiguate the room title in the sidebar.
        const peer = state.peers.find((p) => p.sid === sid);
        const repo = peer?.repo ?? "(unknown)";
        const sid8 = sid.slice(0, 8);
        const title = `${repo} 1on1 ${sid8}`;
        const created = await ws.createOneOnOneRoom(sid, title);
        if (!created.ok) {
          setError(created.error?.msg ?? "1on1 room の作成に失敗しました");
          setSending(false);
          return;
        }
        roomId = created.room;
      }
      const posted = await ws.post(roomId, finalText);
      if (!posted.ok) {
        setError(posted.error?.msg ?? "post に失敗しました");
        setSending(false);
        return;
      }
      clearDraft(sid);
      setText("");
      setAttachments([]);
      setSending(false);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }, [ws, state, sid, text, attachments]);

  if (!open) {
    return (
      <button
        type="button"
        class="one-on-one-fab"
        title="このセッションに 1on1 で priv 送信"
        onClick={() => setOpen(true)}
      >
        +
      </button>
    );
  }

  return (
    <div class="one-on-one-panel" role="dialog" aria-label="1on1 priv composer" ref={panelRef}>
      <header class="one-on-one-panel-header">
        {/* 宛先はセッション ID でなくアイコン + リポ名で示す (kawaz r17
            mid=1、2026-07-14): sid の 8 桁 hex は人間には識別子として
            機能しない。identicon (Sidebar と同じ seed=sid) + repo 名なら
            どのセッション宛か一目で分かる。repo 未 announce のセッション
            は ws / cwd 末尾 / sid8 に fallback。 */}
        <span class="one-on-one-target">
          1on1 to <Avatar seed={sid} size={16} />
          <code>{targetLabel}</code>
        </span>
      </header>
      <textarea
        ref={textareaRef}
        class="one-on-one-textarea"
        placeholder="この session に priv..."
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        onPaste={onPaste}
        disabled={sending}
        rows={4}
      />
      <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
      {error !== null ? <p class="one-on-one-error">{error}</p> : null}
      <div class="one-on-one-actions">
        <div class="composer-attach-buttons">
          {/* DR-0015 §2.5 + kawaz r15 mid=8 (2026-07-14): 画像/ファイルボタン
              の区別は不要、クリップマーク 1 個に統一。paste 経由の image
              mime 添付経路 (§2.5) は独立で残る。 */}
          <label class="composer-attach-btn" aria-label="ファイルを添付">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={() => onFilesPicked(fileInputRef.current)}
              hidden
            />
            <span aria-hidden="true">📎</span>
          </label>
        </div>
        <button
          type="button"
          class="one-on-one-send"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={sending || text.trim() === "" || hasPendingUpload(attachments)}
        >
          {sending ? "送信中..." : hasPendingUpload(attachments) ? "アップロード中..." : "送信"}
        </button>
      </div>
    </div>
  );
}
