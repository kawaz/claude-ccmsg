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
import { AvatarLabel } from "../avatar.tsx";
import { lastPathSegment } from "../utils.ts";
import {
  extractTransferFiles,
  hasPendingUpload,
  insertPlaceholder,
  maxPlaceholderNumber,
  nextAttachmentNumber,
  removePlaceholder,
  substitutePlaceholders,
  type ComposerAttachment,
} from "./composer-attachments.ts";
import { shouldSendOnKeyDown } from "./composer-keydown.ts";
import { ComposerAttachments } from "./ComposerAttachments.tsx";
import { uploadAttachment } from "./composer-upload.ts";
import { readStorage, removeStorage, sweepStaleBySid, writeStorage } from "../storage.ts";
import { useFabPopup } from "../useFabPopup.ts";
import { isPanelDragHandle, useDraggable } from "../useDraggable.ts";

export const LOCAL_STORAGE_PREFIX = "ccmsg.1on1.";
export const CLEANUP_STALE_DAYS = 10;
export const CLEANUP_STALE_MS = CLEANUP_STALE_DAYS * 24 * 60 * 60 * 1000;

export interface StoredDraft {
  text: string;
  /** upload 完了済み (status:"done") の添付メタ (kawaz r17 mid=36、
   * 2026-07-15): 以前は text のみ保存で、close→reopen / リロード後に
   * 本文の [FILE<N>] placeholder だけ残って attachments が空になり、送信時
   * substitute の対象を失った placeholder がリテラルのまま届いていた。
   * upload は選択時に即完了しファイルは TMPDIR に残るので、メタを draft に
   * 含めれば復元後もそのまま送信できる。uploading/error の途中状態は保存
   * しない (XHR は復元できない)。旧 draft (attachments 無し) も loadDraft
   * が受理する (optional)。 */
  attachments?: ComposerAttachment[];
  /** ISO-8601 wall-clock stamp of the last edit; used by the cleanup sweep
   * as a fallback when peers.last_activity_at isn't available. */
  updatedAt: string;
}

export function keyFor(sid: string): string {
  return `${LOCAL_STORAGE_PREFIX}${sid}`;
}

export function loadDraft(sid: string): StoredDraft | null {
  const raw = readStorage(keyFor(sid));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as StoredDraft).text === "string" &&
    typeof (parsed as StoredDraft).updatedAt === "string"
  ) {
    // attachments は shape が崩れていたら黙って落とす (text だけの復元に
    // degrade) — 壊れた添付メタで送信経路を詰まらせない。
    const att = (parsed as StoredDraft).attachments;
    if (att !== undefined) {
      const valid =
        Array.isArray(att) &&
        att.every(
          (a) =>
            a &&
            typeof a === "object" &&
            typeof a.n === "number" &&
            a.status === "done" &&
            typeof a.path === "string",
        );
      if (!valid) {
        const { attachments: _drop, ...rest } = parsed as StoredDraft;
        return rest;
      }
    }
    return parsed as StoredDraft;
  }
  return null;
}

export function saveDraft(sid: string, text: string, attachments?: ComposerAttachment[]): void {
  // 添付は done (upload 完了、path 確定) だけ保存 — uploading の XHR や
  // error 表示は復元不能な transient state。storage unavailable (private
  // mode / quota) 時は drop silently — 次回 reopen が空 textarea に戻る。
  const done = (attachments ?? []).filter((a) => a.status === "done");
  const payload: StoredDraft = {
    text,
    ...(done.length > 0 ? { attachments: done } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeStorage(keyFor(sid), JSON.stringify(payload));
}

export function clearDraft(sid: string): void {
  removeStorage(keyFor(sid));
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
  sweepStaleBySid(
    LOCAL_STORAGE_PREFIX,
    state,
    CLEANUP_STALE_MS,
    (sid) => loadDraft(sid)?.updatedAt,
    now,
  );
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
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // フォーム外の click で閉じる配管 (RoomComposerFab と同じ pattern) は
  // useFabPopup 共有。OneOnOneComposer は元々 sending ガードを持たなかった
  // ので `blocked: false` 固定 (挙動不変)。onClose で従来の handleClose が
  // 兼ねていた `setError(null)` を維持する。
  const { open, openPanel, closePanel, panelRef } = useFabPopup(false, () => setError(null));
  // kawaz r46 m44: FAB とパネルを個別に D&D 移動可能に。位置は永続化しない
  // (component state のみ) — open/close や tab 切替を跨いでも SessionView が
  // OneOnOneComposer instance を維持するため位置は残るが、リロードで初期化。
  const fabDrag = useDraggable();
  const panelDrag = useDraggable({ handleFilter: isPanelDragHandle });
  // DR-0015 attachment 機能 (kawaz r15 mid=5、2026-07-14): 通常 room の
  // Composer と同じ添付経路を 1on1 でも提供。attachments は transient state
  // で localStorage には保存しない — draft は text のみ (§2.6)。close→reopen
  // すると本文の [FILE<N>] プレースホルダは復元されるが attachments 一覧は
  // 空 (未解決の [FILE<N>] は送信時 substitute でリテラル残る)。
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const pendingCaretRef = useRef<number | null>(null);
  // placeholder 挿入直後に復元すべき caret 位置 (kawaz r46 mid=33、Composer.tsx
  // と同型): controlled textarea は value がプログラム的に変わると caret が
  // 末尾に飛ぶため、DOM 反映後の effect で setSelectionRange して戻す。
  const restoreCaretRef = useRef<number | null>(null);
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
  // 添付も draft から復元する (kawaz r17 mid=36): draft は per-sid 保存
  // なので、復元される添付メタが別 sid の相手に混ざることはない。draft の
  // 無い sid では空リセット。
  useEffect(() => {
    if (!open) return;
    const draft = loadDraft(sid);
    setText(draft?.text ?? "");
    setAttachments(draft?.attachments ?? []);
    setError(null);
  }, [open, sid]);

  // kawaz r26 mid=20: open 時に textarea へ自動フォーカス + 前回離脱時の
  // カーソル位置を復元 (通常 Composer と同挙動)。位置の保存は textarea の
  // onBlur (close 前に必ず発火)。draft 復元 effect の後に走らせたいので
  // text も deps に含め、setSelectionRange は値長で clamp する。
  const lastCursorRef = useRef<{ start: number; end: number } | null>(null);
  const focusedForOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedForOpenRef.current = false;
      return;
    }
    if (focusedForOpenRef.current) return;
    const el = textareaRef.current;
    if (!el) return;
    focusedForOpenRef.current = true;
    el.focus();
    const pos = lastCursorRef.current;
    const start = pos ? Math.min(pos.start, el.value.length) : el.value.length;
    const end = pos ? Math.min(pos.end, el.value.length) : el.value.length;
    el.setSelectionRange(start, end);
  }, [open, text]);

  // beginUpload が placeholder 挿入直後に予約した caret 位置を、DOM へ text が
  // 反映された後に復元する (kawaz r46 mid=33)。上の open 時 focus effect は
  // focusedForOpenRef ガードで最初の 1 回しか走らないため、以降の text 変化
  // (= 添付挿入) はこちらの effect が拾う。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (restoreCaretRef.current !== null) {
      const pos = Math.min(restoreCaretRef.current, el.value.length);
      el.setSelectionRange(pos, pos);
      restoreCaretRef.current = null;
    }
  }, [text]);

  // Persist text + done attachments as the user types/uploads. Empty text
  // explicitly clears the entry rather than storing an empty draft — an
  // unused compose that never gets typed shouldn't count as a draft needing
  // later cleanup. A per-keystroke localStorage.setItem is cheap enough not
  // to need debouncing here.
  useEffect(() => {
    if (!open) return;
    if (text === "") {
      clearDraft(sid);
      return;
    }
    saveDraft(sid, text, attachments);
  }, [open, sid, text, attachments]);

  // DR-0015 §2.5 attachment upload 開始 (通常 Composer と同じロジック)。
  // caret 位置にプレースホルダ挿入 + XHR upload、progress は state に反映、
  // 送信ボタン disable は hasPendingUpload に委ねる。
  const beginUpload = useCallback(
    (file: File) => {
      const el = textareaRef.current;
      // 複数ファイル同時添付では同一 tick の連続呼び出しが同じ caret を掴み、
      // 後発 placeholder が前に割り込んで逆順になる (kawaz r38 mid=37)。直前
      // 挿入の直後位置を microtask 寿命の ref で共有する (Composer と同型)。
      const caret = pendingCaretRef.current ?? (el ? el.selectionStart : text.length);
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
        const at = Math.min(caret, current.length);
        const inserted = insertPlaceholder(current, at, n);
        const nextCaret = at + (inserted.length - current.length);
        pendingCaretRef.current = nextCaret;
        queueMicrotask(() => {
          pendingCaretRef.current = null;
        });
        // 表示上の caret も placeholder の直後に復元する (末尾へ飛ぶのを防ぐ)。
        // DOM 反映後でないと setSelectionRange が効かないので、下の [text]
        // effect に委ねる。
        restoreCaretRef.current = nextCaret;
        return inserted;
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

  // paste は画像に加え Finder コピーのファイル (mime 不問) も添付に、
  // drop は Finder からの drag & drop 添付 (kawaz r17 mid=51)。
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const files = extractTransferFiles(e.clipboardData.items);
      if (files.length === 0) return; // 通常テキスト paste は default に任せる
      e.preventDefault();
      for (const f of files) beginUpload(f);
    },
    [beginUpload],
  );
  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const files = extractTransferFiles(e.dataTransfer.items);
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) beginUpload(f);
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
      closePanel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }, [ws, state, sid, text, attachments, closePanel]);

  if (!open) {
    // kawaz r26 mid=15: close 中に下書きが残っていれば fab を「下書きあり」
    // 表示 (色 + 跳ね) に。1on1 の draft は localStorage 保存 (§2.6) なので
    // close 中の情報源は loadDraft — render 時読みで十分 (close 遷移ごとに
    // ここを通り、draft は open 中にしか変化しないため)。
    const draft = loadDraft(sid);
    const hasDraft = !!draft && draft.text.trim().length > 0;
    return (
      <button
        type="button"
        class={"one-on-one-fab" + (hasDraft ? " composer-fab-draft" : "")}
        title={hasDraft ? "書きかけの下書きがあります" : "このセッションに 1on1 で priv 送信"}
        onClick={openPanel}
        ref={fabDrag.setElement}
        onPointerDown={fabDrag.onPointerDown}
        style={fabDrag.style}
      >
        +
      </button>
    );
  }

  return (
    <div
      class="one-on-one-panel"
      role="dialog"
      aria-label="1on1 priv composer"
      ref={(el) => {
        // useFabPopup と useDraggable の両方に同じ DOM を届ける (ref forwarding
        // で最小限の relay)。callback ref なので mount/unmount 両方で発火。
        panelRef.current = el;
        panelDrag.setElement(el);
      }}
      onPointerDown={panelDrag.onPointerDown}
      style={panelDrag.style}
    >
      <header class="one-on-one-panel-header">
        {/* 宛先はセッション ID でなくアイコン + リポ名で示す (kawaz r17
            mid=1、2026-07-14): sid の 8 桁 hex は人間には識別子として
            機能しない。identicon (Sidebar と同じ seed=sid) + repo 名なら
            どのセッション宛か一目で分かる。repo 未 announce のセッション
            は ws / cwd 末尾 / sid8 に fallback。アイコンと名前の間隔は
            AvatarLabel が一体管理 (kawaz 2026-07-15)。 */}
        <span class="one-on-one-target">
          1on1 to{" "}
          <AvatarLabel seed={sid} size={16}>
            <code>{targetLabel}</code>
          </AvatarLabel>
        </span>
      </header>
      <textarea
        ref={textareaRef}
        class="one-on-one-textarea"
        placeholder="この session に priv... (⌘+Enter で送信)"
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        // kawaz r26 mid=20: close 前に必ず発火する blur でカーソル位置を保存
        onBlur={(e) => {
          const el = e.currentTarget as HTMLTextAreaElement;
          lastCursorRef.current = { start: el.selectionStart, end: el.selectionEnd };
        }}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter 送信 (kawaz r20、2026-07-15): 通常 Composer と同じ
          // shouldSendOnKeyDown 判定 (素の Enter / IME 確定は改行のまま)。
          // 1on1 panel には従来この配線が無く「送信できない」と報告された。
          if (!shouldSendOnKeyDown(e)) return;
          e.preventDefault();
          void handleSubmit();
        }}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
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
