/** @jsxImportSource preact */
// SessionView のセッション宛の入力欄 (DR-0035 §1, §5)。
//
// 右下の "+" FAB を押すとパネルが開き、書いた文を `session_input` でセッションに
// 渡す。セッションの hooks module が入力欄に入れて Enter を押すので、文は人が
// 端末で打ったのと同じ prompt としてセッションに入り、返事はセッションの通常の
// 応答として Timeline に出る。
//
// 文を消すのは daemon が `accepted` を返した時だけ。`not_delivered` は理由と
// 次に取れる行動を示し、`unconfirmed` は「送信済みかもしれない」と示して、
// どちらも入力欄の文と下書きを残す。返事を待つ間 (daemon の待ちが切れるまで
// 数秒) は入力欄と送信ボタンを止め、同じ文が二重に入るのを防ぐ。
//
// 下書き:
//  - 文は localStorage の `<DRAFT_STORAGE_PREFIX><sid>` に保存し、タブ切替や
//    画面遷移で書きかけを失わない。`unconfirmed` に終わった送信の時刻も一緒に
//    保存し、リロード後も「送信済みかもしれない」ことが分かるようにする
//  - mount 時の sweep で古い下書きを消す: (a) sid が peers にも agents にも
//    居ない、(b) 対象セッションが 10 日以上動いていない
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useApp } from "../context.ts";
import type { AppState } from "../store.ts";
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
import {
  classifySessionInputReply,
  sessionInputNotice,
  sessionInputSendFailure,
  shouldClearAfter,
  type SessionInputOutcome,
} from "./session-input.ts";
import { readStorage, removeStorage, sweepStaleBySid, writeStorage } from "../storage.ts";
import { useFabPopup } from "../useFabPopup.ts";
import { isPanelDragHandle, useDraggable, useFabPanelPositionLink } from "../useDraggable.ts";
import { useCacheRing } from "../useCacheRing.ts";
import { CacheRing } from "./CacheRing.tsx";

/** Design rationale: キーの文字列は、ブラウザに既に保存されている未送信の下書きと
 * 同じものを使う。変えるとそれらが読めなくなり、人が書いた文を失わせる
 * (DR-0035 §5 が避けている負担そのもの)。 */
export const DRAFT_STORAGE_PREFIX = "ccmsg.1on1.";
export const CLEANUP_STALE_DAYS = 10;
export const CLEANUP_STALE_MS = CLEANUP_STALE_DAYS * 24 * 60 * 60 * 1000;

export interface StoredDraft {
  text: string;
  /** upload 完了済み (status:"done") の添付メタ。upload は選択時に即完了し
   * ファイルは TMPDIR に残るので、メタを draft に含めれば close→reopen や
   * リロードの後も本文の [FILE<N>] がそのまま送信時に解決できる。uploading /
   * error の途中状態は保存しない (XHR は復元できない)。 */
  attachments?: ComposerAttachment[];
  /** この文を送って `unconfirmed` に終わった時刻 (ISO-8601)。セッションに既に
   * 入っているかもしれないことを、リロード後も入力欄に示すために持つ。 */
  unconfirmedAt?: string;
  /** ISO-8601 wall-clock stamp of the last edit; used by the cleanup sweep
   * as a fallback when peers.last_activity_at isn't available. */
  updatedAt: string;
}

export function keyFor(sid: string): string {
  return `${DRAFT_STORAGE_PREFIX}${sid}`;
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
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as StoredDraft).text !== "string" ||
    typeof (parsed as StoredDraft).updatedAt !== "string"
  ) {
    return null;
  }
  // 付属の項目は shape が崩れていたら黙って落とす (text だけの復元に degrade)
  // — 壊れたメタで送信経路を詰まらせない。
  const { attachments: att, unconfirmedAt, ...rest } = parsed as StoredDraft;
  const draft: StoredDraft = rest;
  if (
    Array.isArray(att) &&
    att.every(
      (a) =>
        a &&
        typeof a === "object" &&
        typeof a.n === "number" &&
        a.status === "done" &&
        typeof a.path === "string",
    )
  ) {
    draft.attachments = att;
  }
  if (typeof unconfirmedAt === "string" && Number.isFinite(Date.parse(unconfirmedAt))) {
    draft.unconfirmedAt = unconfirmedAt;
  }
  return draft;
}

export function saveDraft(
  sid: string,
  text: string,
  attachments?: ComposerAttachment[],
  unconfirmedAt?: string | null,
): void {
  // 添付は done (upload 完了、path 確定) だけ保存 — uploading の XHR や
  // error 表示は復元不能な transient state。storage unavailable (private
  // mode / quota) 時は drop silently — 次回 reopen が空 textarea に戻る。
  const done = (attachments ?? []).filter((a) => a.status === "done");
  const payload: StoredDraft = {
    text,
    ...(done.length > 0 ? { attachments: done } : {}),
    ...(unconfirmedAt ? { unconfirmedAt } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeStorage(keyFor(sid), JSON.stringify(payload));
}

export function clearDraft(sid: string): void {
  removeStorage(keyFor(sid));
}

/** Mount-time sweep. Two purge rules:
 *  - (a) sid absent from both `state.peers` and `state.agents`: the target
 *    session is gone, the draft can never be delivered — drop.
 *  - (b) the target session has been idle > 10 days (uses peers'
 *    `last_activity_at` when present, falls back to the draft's own
 *    `updatedAt` if the peer entry has no activity stamp).
 *
 * Runs once per SessionView mount, guarded by a `state.peers.length > 0`
 * check upstream — a mount that fires before peers arrives skips the sweep
 * (no reference to compare against) and re-runs on the next visit. */
export function cleanupStaleDrafts(state: AppState, now: number = Date.now()): void {
  sweepStaleBySid(
    DRAFT_STORAGE_PREFIX,
    state,
    CLEANUP_STALE_MS,
    (sid) => loadDraft(sid)?.updatedAt,
    now,
  );
}

/** 時刻を入力欄の注記に出す形 (同じ日なら時:分、日を跨いだら月/日 時:分)。 */
export function formatSentAt(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const hm = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === at.toDateString()
    ? hm
    : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

export function SessionInputComposer({ sid, state }: { sid: string; state: AppState }) {
  const { ws } = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // render をまたがず同期的に見る送信中フラグ。⌘+Enter の連打は再 render の前に
  // 2 回目の handleSubmit を呼びうるので、state だけでは二重送信を止められない。
  const sendingRef = useRef(false);
  // 直前の送信がどう終わったか (accepted 以外)。次の送信を始めるか、人が注記を
  // 閉じるまで出し続ける。
  const [outcome, setOutcome] = useState<SessionInputOutcome | null>(null);
  // `unconfirmed` に終わった送信の時刻。下書きと一緒に保存し、リロード後も
  // 「送信済みかもしれない」と示す。
  const [unconfirmedAt, setUnconfirmedAt] = useState<string | null>(null);
  // 送信中は外側クリックでも閉じない: 返事が来た時にパネルが閉じていると、
  // 届かなかった理由を人が見ないまま終わる。
  const { open, openPanel, closePanel, panelRef } = useFabPopup(sending);
  // FAB とパネルは個別に D&D 移動できる。位置は永続化しない (component state
  // のみ)。useFabPanelPositionLink が open 遷移時に相手の位置を同期する。
  const fabDrag = useDraggable();
  const panelDrag = useDraggable({ handleFilter: isPanelDragHandle });
  const { onFabRef, onPanelRef } = useFabPanelPositionLink({ open, fabDrag, panelDrag });
  // このセッションの prompt cache が生きている間だけ、FAB (閉じている時) と
  // textarea (開いている時) にリングが巻かれ、窓が閉じるまでかけて時計回りに
  // 消える。緑は会話が作った窓、黄は合図で延命している分 (llm-cache-view.ts)。
  // 宛先が sid で一意に決まる入力欄だからこそ「今送るとキャッシュに乗るか」を
  // 送信 UI そのものに出せる。
  const cacheRequest = state.llmRequests.get(sid);
  const cacheRing = useCacheRing(cacheRequest ?? null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const pendingCaretRef = useRef<number | null>(null);
  // placeholder 挿入直後に復元すべき caret 位置: controlled textarea は value が
  // プログラム的に変わると caret が末尾に飛ぶため、DOM 反映後の effect で
  // setSelectionRange して戻す。
  const restoreCaretRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // パネルヘッダの宛先ラベル: repo → ws → cwd 末尾 → sid8。
  const targetPeer = state.peers.find((p) => p.sid === sid);
  // ccmsg 未起動セッション (peers に居ない) でも `claude agents` に居れば
  // プロセスは生きている。ラベルは agents 行の cwd 末尾に fallback。
  const targetAgent = targetPeer ? undefined : state.agents.find((a) => a.sessionId === sid);
  const targetLabel =
    targetPeer?.repo ||
    targetPeer?.ws ||
    lastPathSegment(targetPeer?.cwd ?? targetAgent?.cwd ?? "") ||
    sid.slice(0, 8);

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

  // パネルを開いた時にこの sid の下書きを戻す (SessionView は sid ごとの
  // instance なので sid は変わらない)。直前の送信結果の注記は開閉をまたいで
  // 残し、閉じて開き直した人が理由を読み返せるようにする。
  useEffect(() => {
    if (!open) return;
    const draft = loadDraft(sid);
    setText(draft?.text ?? "");
    setAttachments(draft?.attachments ?? []);
    setUnconfirmedAt(draft?.unconfirmedAt ?? null);
  }, [open, sid]);

  // open 時に textarea へ自動フォーカス + 前回離脱時のカーソル位置を復元。
  // 位置の保存は textarea の onBlur (close 前に必ず発火)。draft 復元 effect の
  // 後に走らせたいので text も deps に含め、setSelectionRange は値長で clamp する。
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
  // 反映された後に復元する。上の open 時 focus effect は focusedForOpenRef
  // ガードで最初の 1 回しか走らないため、以降の text 変化 (= 添付挿入) は
  // こちらの effect が拾う。
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
    saveDraft(sid, text, attachments, unconfirmedAt);
  }, [open, sid, text, attachments, unconfirmedAt]);

  // 添付 upload 開始 (通常 Composer と同じロジック)。caret 位置にプレースホルダ
  // 挿入 + XHR upload、progress は state に反映、送信ボタン disable は
  // hasPendingUpload に委ねる。
  const beginUpload = useCallback(
    (file: File) => {
      const el = textareaRef.current;
      // 複数ファイル同時添付では同一 tick の連続呼び出しが同じ caret を掴み、
      // 後発 placeholder が前に割り込んで逆順になる。直前挿入の直後位置を
      // microtask 寿命の ref で共有する (Composer と同型)。
      const caret = pendingCaretRef.current ?? (el ? el.selectionStart : text.length);
      // 本文中の [FILE<N>] の max も跨いで採番: draft 復元で本文だけ戻り添付が
      // 欠けた場合に、attachments 配列だけ見た採番は番号を再利用して送信時
      // substitute が新旧 placeholder を同じ path に潰してしまう。
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
        // DOM 反映後でないと setSelectionRange が効かないので、上の [text]
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
  // drop は Finder からの drag & drop 添付。
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!e.clipboardData || sendingRef.current) return;
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
      if (!e.dataTransfer || sendingRef.current) return;
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

  // 入力欄と保存済みの下書きを空にする。accepted の後と、人が「送信済みかも
  // しれない」文を Timeline で確かめて捨てる時に使う。下書きは明示的に消す:
  // 保存の effect はパネルが開いている間しか走らない。
  const discard = useCallback(() => {
    clearDraft(sid);
    setText("");
    setAttachments([]);
    setUnconfirmedAt(null);
    setOutcome(null);
  }, [sid]);

  const handleSubmit = useCallback(async () => {
    if (sendingRef.current) return;
    const body = text.trim();
    if (body === "") return;
    if (hasPendingUpload(attachments)) return; // safety net (ボタン disable 済)
    // [FILE<N>] を [FILE<N>:<name>](<path>) に置換してから送る。未完了
    // (upload 中 / error) の entry は substitute が skip するので、text に
    // リテラル [FILE<N>] が残る (upload 中は上で送信自体を止めている。error は
    // × で消してから送る運用)。
    const finalText = substitutePlaceholders(body, attachments);
    sendingRef.current = true;
    setSending(true);
    setOutcome(null);
    let result: SessionInputOutcome;
    try {
      result = classifySessionInputReply(await ws.sessionInput(sid, finalText));
    } catch {
      result = sessionInputSendFailure();
    }
    sendingRef.current = false;
    setSending(false);
    if (shouldClearAfter(result)) {
      discard();
      closePanel();
      return;
    }
    setOutcome(result);
    if (result.kind === "unconfirmed") setUnconfirmedAt(new Date().toISOString());
  }, [ws, sid, text, attachments, closePanel, discard]);

  if (!open) {
    // close 中に下書きが残っていれば FAB を「下書きあり」表示 (色 + 跳ね) に。
    // 下書きは localStorage 保存なので close 中の情報源は loadDraft — render 時
    // 読みで十分 (close 遷移ごとにここを通り、draft は open 中にしか変化しない)。
    const draft = loadDraft(sid);
    const hasDraft = !!draft && draft.text.trim().length > 0;
    return (
      <button
        type="button"
        class={
          "session-input-fab" +
          (hasDraft ? " composer-fab-draft" : "") +
          (cacheRing ? ` ${cacheRing.class}` : "")
        }
        title={
          hasDraft
            ? draft.unconfirmedAt
              ? "送信済みかもしれない下書きがあります"
              : "書きかけの下書きがあります"
            : "このセッションに入力を送る"
        }
        aria-label="このセッションに入力を送る"
        onClick={openPanel}
        ref={onFabRef}
        onPointerDown={fabDrag.onPointerDown}
        // リングの起点 (負 delay) は fab 自身の drag 位置と同じ style に載る。
        // 下書き中の跳ねアニメーションは FAB 本体の transform、リングは中に
        // 重ねた svg の線なので、併発しても互いを打ち消さない。
        style={{ ...fabDrag.style, ...cacheRing?.style }}
      >
        +{cacheRing ? <CacheRing shape="circle" /> : null}
      </button>
    );
  }

  // 直前の結果の注記。結果が無くても、下書きに未確認の印があれば (リロード後・
  // 開き直し後) 未確認の注記を出す。
  const notice = outcome
    ? sessionInputNotice(outcome)
    : unconfirmedAt && text.trim() !== ""
      ? sessionInputNotice({ kind: "unconfirmed" })
      : null;
  const showDiscard =
    !sending && unconfirmedAt !== null && text.trim() !== "" && notice?.tone === "warn";
  const uploading = hasPendingUpload(attachments);
  const sendLabel = sending
    ? "送信中..."
    : uploading
      ? "アップロード中..."
      : unconfirmedAt !== null
        ? "もう一度送信"
        : "送信";

  return (
    <div
      class="session-input-panel"
      role="dialog"
      aria-label="セッションへの入力"
      aria-busy={sending}
      ref={(el) => {
        // useFabPopup と useDraggable (経由: onPanelRef) の両方に同じ DOM を
        // 届ける (ref forwarding で最小限の relay)。callback ref なので
        // mount/unmount 両方で発火。onPanelRef 側で size 計測も行う。
        panelRef.current = el;
        onPanelRef(el);
      }}
      onPointerDown={panelDrag.onPointerDown}
      style={panelDrag.style}
    >
      <header class="session-input-panel-header">
        {/* 宛先はセッション ID でなくアイコン + リポ名で示す: sid の 8 桁 hex は
            人間には識別子として機能しない。identicon (Sidebar と同じ seed=sid)
            + repo 名ならどのセッション宛か一目で分かる。 */}
        <span class="session-input-target">
          入力先{" "}
          <AvatarLabel seed={sid} size={16}>
            <code>{targetLabel}</code>
          </AvatarLabel>
        </span>
        {/* 明示的な閉じるボタン。外側クリックでの close は Terminal タブの
            hyoui iframe 上では成立しにくい (cross-origin iframe 内のクリックは
            親に伝播しない) ため、確実な close 動線を常設する。送信中は閉じない
            (外側クリックと同じ理由)。 */}
        <button
          type="button"
          class="composer-panel-close"
          onClick={closePanel}
          disabled={sending}
          title="閉じる"
          aria-label="入力欄を閉じる"
        >
          ✕
        </button>
      </header>
      {/* 入力欄の枠に cache リングを重ねる (展開中は FAB が消えるので装飾の
       * 置き場が textarea になる)。textarea は子を持てないので重ねる 1 枚の
       * 置き場として入れ物が要る — 余白も背景も持たない。入れ物は常設:
       * リングの有無で包み方を変えると textarea が remount され、入力中の
       * caret とフォーカスが飛ぶ。 */}
      <div
        class={
          cacheRing
            ? `session-input-textarea-ring ${cacheRing.class}`
            : "session-input-textarea-ring"
        }
        style={cacheRing?.style}
      >
        <textarea
          ref={textareaRef}
          class="session-input-textarea"
          placeholder="このセッションに入力... (⌘+Enter で送信)"
          value={text}
          onInput={(e) => {
            const value = (e.currentTarget as HTMLTextAreaElement).value;
            setText(value);
            // 文を全部消したら、未確認の印も結果の注記も対象を失う。次に書く文は
            // 別の文なので引き継がない。
            if (value.trim() === "") {
              setUnconfirmedAt(null);
              setOutcome(null);
            }
          }}
          // close 前に必ず発火する blur でカーソル位置を保存
          onBlur={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            lastCursorRef.current = { start: el.selectionStart, end: el.selectionEnd };
          }}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter 送信: 通常 Composer と同じ shouldSendOnKeyDown 判定
            // (素の Enter / IME 確定は改行のまま)。
            if (!shouldSendOnKeyDown(e)) return;
            e.preventDefault();
            void handleSubmit();
          }}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDrop={onDrop}
          // 返事を待つ間は文を固定する: 送った文と入力欄の文がずれると、
          // accepted で消す対象と届かなかった時に残す対象が曖昧になる。
          readOnly={sending}
          rows={4}
        />
        {cacheRing ? <CacheRing shape="rect" /> : null}
      </div>
      <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
      {sending ? (
        <p class="session-input-status" role="status">
          セッションに渡しています。受け取ったかの確認を待っています...
        </p>
      ) : null}
      {notice ? (
        <div class={`session-input-notice session-input-notice-${notice.tone}`} role="alert">
          <p class="session-input-notice-title">
            {notice.title}
            {notice.tone === "warn" && unconfirmedAt ? (
              <span class="session-input-notice-time"> ({formatSentAt(unconfirmedAt)} の送信)</span>
            ) : null}
          </p>
          <p class="session-input-notice-detail">{notice.detail}</p>
          {showDiscard ? (
            <button
              type="button"
              class="session-input-discard"
              onClick={discard}
              title="入力欄と保存した下書きを消します"
            >
              届いていたので消す
            </button>
          ) : null}
        </div>
      ) : null}
      <div class="session-input-actions">
        <div class="composer-attach-buttons">
          {/* 画像/ファイルボタンの区別は不要、クリップマーク 1 個に統一。
              paste 経由の添付経路は独立で残る。
              `hidden` 属性の file input は Mac Chrome で picker が開かない
              (Composer.tsx 同名注記参照)。visually-hidden CSS で rendering
              ツリーに残しつつ視覚だけ消し、button から明示発火する。 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={() => onFilesPicked(fileInputRef.current)}
            class="composer-attach-file"
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            class="composer-attach-btn"
            aria-label="ファイルを添付"
            disabled={sending}
            onClick={() => {
              const el = fileInputRef.current;
              if (!el) return;
              try {
                el.showPicker();
              } catch {
                el.click();
              }
            }}
          >
            <span aria-hidden="true">📎</span>
          </button>
        </div>
        <button
          type="button"
          class="session-input-send"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={sending || text.trim() === "" || uploading}
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
