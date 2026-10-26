/** @jsxImportSource preact */
// SessionView のセッション宛の入力欄 (DR-0035 §1, §5)。
//
// 右下の "+" FAB を押すとパネルが開き、書いた文を `user_prompt` でセッションに
// 渡す。セッションの hooks module が入力欄に入れて Enter を押すので、文は人が
// 端末で打ったのと同じ prompt としてセッションに入り、返事はセッションの通常の
// 応答として Timeline に出る。
//
// 下書きと送信の記録は session-input-store.ts が localStorage に持ち、この部品は
// それを映す。文を消すのは daemon が `accepted` を返し、保存されている下書きが
// 送った文と同じ時だけ。届かなかった・送れなかった時は理由と次の行動を、
// `unconfirmed` は送信ごとに「送信済みかもしれない」と示し、どちらも下書きを
// 残す。返事を待つ間 (daemon の待ちが切れるまで数秒) は本文・添付を変えさせず、
// 同じ文が二重に入るのを防ぐ。下書きは人の編集 (入力・添付の追加と削除) の
// handler で保存し、別タブでの変更は、このタブで編集していない (空か、書き換え
// 前の下書きのまま) 時だけ storage event で映す (映すだけで保存しない)。
// 送る前から届かないと分かっている時 (受け口が無い、hyoui の外で起動した等) は、
// daemon が peers の行と session_status に載せる input_readiness の理由と対処を
// 先に示す。
// 送信には単発の上書き (DR-0041 §4: その送信で始まる、または加わる turn の
// 終わりまでの effort / model) を選んで付けられ、`user_prompt` に乗って文と一緒に
// 届く。既定は「上書きなし」で、`accepted` になったら戻す。届かなかった・未確認の
// 時は文と同じく選択も残す。
import type { RequestOverride } from "@ccmsg/protocol";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useApp } from "../context.ts";
import { useEffectEvent } from "../useEffectEvent.ts";
import { sameJson, useStoreState } from "../useStore.ts";
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
  formatSentAt,
  inputReadinessNotice,
  sendExcerpt,
  sessionInputReadiness,
  sessionInputNotice,
} from "./session-input.ts";
import {
  cleanupStaleSessionInputs,
  clearLastFailure,
  discardSend,
  draftKey,
  isSending,
  lastFailure,
  loadDraft,
  loadSends,
  sameContent,
  saveDraft,
  sendSessionInput,
  sendsKey,
  otherTabDraft,
  storedDraftChange,
  subscribeSessionInput,
  unconfirmedSends,
  type InputContent,
} from "./session-input-store.ts";
import { useFabPopup } from "../useFabPopup.ts";
import { isPanelDragHandle, useDraggable, useFabPanelPositionLink } from "../useDraggable.ts";
import { useCacheRing } from "../useCacheRing.ts";
import { CacheRing } from "./CacheRing.tsx";
import { OverrideFields } from "./RequestOverridePicker.tsx";
import { withPicked } from "../request-override-view.ts";

export function SessionInputComposer({ sid }: { sid: string }) {
  const { ws, store } = useApp();
  // 下書きは初期化の時に同期で読む。SessionView は sid ごとの instance なので
  // sid は変わらない。
  const [initialDraft] = useState(() => loadDraft(sid));
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => [
    ...(initialDraft?.attachments ?? []),
  ]);
  const [sends, setSends] = useState(() => loadSends(sid));
  const [sending, setSending] = useState(() => isSending(sid));
  const [failure, setFailure] = useState(() => lastFailure(sid));
  const [single, setSingle] = useState<RequestOverride>({});
  // 入力欄の最新の中身。編集と復元が render を待たずに更新する: 同じ tick に
  // 続く編集 (複数ファイルの同時添付) が前の編集の結果の上に積めるように。
  const contentRef = useRef<{ text: string; attachments: ComposerAttachment[] }>({
    text,
    attachments,
  });

  // 人の編集: 入力欄を変えて下書きを保存する。
  const edit = useCallback(
    (next: { text: string; attachments: ComposerAttachment[] }) => {
      contentRef.current = next;
      setText(next.text);
      setAttachments(next.attachments);
      saveDraft(sid, next.text, next.attachments);
    },
    [sid],
  );
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
  const cacheRequest = useStoreState(store, (s) => s.llmRequests.get(sid), sameJson);
  const cacheRing = useCacheRing(cacheRequest ?? null);
  const pendingCaretRef = useRef<number | null>(null);
  // placeholder 挿入直後に復元すべき caret 位置: controlled textarea は value が
  // プログラム的に変わると caret が末尾に飛ぶため、DOM 反映後の effect で
  // setSelectionRange して戻す。
  const restoreCaretRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // パネルヘッダの宛先ラベル: repo → ws → cwd 末尾 → sid8。
  const targetPeer = useStoreState(store, (s) => s.peers.find((p) => p.sid === sid), sameJson);
  // ccmsg 未起動セッション (peers に居ない) でも agents の行に居れば
  // プロセスは生きている。ラベルは agents 行の cwd 末尾に fallback。
  const agent = useStoreState(store, (s) => s.agents.find((a) => a.sessionId === sid), sameJson);
  const targetAgent = targetPeer ? undefined : agent;
  const sessionStatus = useStoreState(store, (s) => s.sessionStatuses.get(sid));
  const targetLabel =
    targetPeer?.repo ||
    targetPeer?.ws ||
    lastPathSegment(targetPeer?.cwd ?? targetAgent?.cwd ?? "") ||
    sid.slice(0, 8);

  // Stale-draft sweep. Waits for the peers list to hydrate (empty on the very
  // first render before ws.ts's onOpen finishes the handshake) and sweeps again
  // whenever the number of peers changes — not on every action, and not on a
  // peers push that only replaces the array with the same set. The rest of
  // `state` is read at that moment, so it lives in an Effect Event.
  const sweepStaleInputs = useEffectEvent(() => cleanupStaleSessionInputs(store.getState()));
  const peerCount = useStoreState(store, (s) => s.peers.length);
  useEffect(() => {
    if (peerCount > 0) sweepStaleInputs();
  }, [peerCount]);

  // 保存されている下書きを入力欄に映す。保存はしない: 映した値を保存し直すと、
  // 入力しているタブへ古い文が storage event で戻る。null (映すものが無い) の
  // 時は入力中の state を作り直さない。
  const restoreDraft = useCallback((draft: InputContent | null) => {
    if (draft === null) return;
    const next = { text: draft.text, attachments: [...(draft.attachments ?? [])] };
    contentRef.current = next;
    setText(next.text);
    setAttachments(next.attachments);
  }, []);

  // 送信の記録と直近の結果を映す (この部品が unmount 中に届いた結果、別タブの
  // 記録の変化も)。
  const refreshSends = useCallback(() => {
    setSends(loadSends(sid));
    setSending(isSending(sid));
    setFailure(lastFailure(sid));
  }, [sid]);

  useEffect(() => {
    const off = subscribeSessionInput((changed) => {
      if (changed !== sid) return;
      refreshSends();
      // このページの送信の結果で消えた下書き (accepted、「届いていたので消す」)。
      restoreDraft(storedDraftChange(sid, contentRef.current));
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === sendsKey(sid)) refreshSends();
      // 添付は本文より先に書かれ、本文の書き込みが下書きの 1 回の保存を締める
      // ので、本文のキーで映す。
      if (e.key === null || e.key === draftKey(sid)) {
        restoreDraft(otherTabDraft(sid, contentRef.current, e.oldValue));
      }
    };
    window.addEventListener("storage", onStorage);
    // 初回 render から購読までの間に起きた変化を拾う。
    refreshSends();
    restoreDraft(storedDraftChange(sid, contentRef.current));
    return () => {
      off();
      window.removeEventListener("storage", onStorage);
    };
  }, [sid, refreshSends, restoreDraft]);

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

  // 添付 upload 開始 (通常 Composer と同じロジック)。caret 位置にプレースホルダ
  // 挿入 + XHR upload、progress は state に反映、送信ボタン disable は
  // hasPendingUpload に委ねる。
  const beginUpload = useCallback(
    (file: File) => {
      const el = textareaRef.current;
      // 複数ファイル同時添付では同一 tick の連続呼び出しが同じ caret を掴み、
      // 後発 placeholder が前に割り込んで逆順になる。直前挿入の直後位置を
      // microtask 寿命の ref で共有する (Composer と同型)。
      const current = contentRef.current;
      const caret = pendingCaretRef.current ?? (el ? el.selectionStart : current.text.length);
      // 本文中の [FILE<N>] の max も跨いで採番: draft 復元で本文だけ戻り添付が
      // 欠けた場合に、attachments 配列だけ見た採番は番号を再利用して送信時
      // substitute が新旧 placeholder を同じ path に潰してしまう。
      const n = Math.max(
        nextAttachmentNumber(current.attachments),
        maxPlaceholderNumber(current.text) + 1,
      );
      const at = Math.min(caret, current.text.length);
      const inserted = insertPlaceholder(current.text, at, n);
      const nextCaret = at + (inserted.length - current.text.length);
      pendingCaretRef.current = nextCaret;
      queueMicrotask(() => {
        pendingCaretRef.current = null;
      });
      // 表示上の caret も placeholder の直後に復元する (末尾へ飛ぶのを防ぐ)。
      // DOM 反映後でないと setSelectionRange が効かないので、上の [text]
      // effect に委ねる。
      restoreCaretRef.current = nextCaret;
      edit({
        text: inserted,
        attachments: [
          ...current.attachments,
          { n, name: file.name || "upload", status: "uploading", progress: 0 },
        ],
      });
      // upload の進み具合と結果をこの添付に反映する。done になった添付は下書き
      // に保存される (upload 中・error の添付は saveDraft が保存しない)。
      const update = (change: (a: ComposerAttachment) => ComposerAttachment) => {
        const latest = contentRef.current;
        edit({
          text: latest.text,
          attachments: latest.attachments.map((a) => (a.n === n ? change(a) : a)),
        });
      };
      void (async () => {
        try {
          const meta = await uploadAttachment(file, (percent) => {
            update((a) => ({ ...a, progress: percent }));
          });
          update((a) => ({
            ...a,
            status: "done",
            progress: 100,
            uuid: meta.uuid,
            ext: meta.ext,
            size: meta.size,
            mime: meta.mime,
            path: meta.path,
            name: meta.name,
          }));
        } catch (err) {
          update((a) => ({
            ...a,
            status: "error",
            errorMsg: err instanceof Error ? err.message : String(err),
          }));
        }
      })();
    },
    [edit],
  );

  const removeAttachment = useCallback(
    (n: number) => {
      // 送信中は送る添付を変えさせない (× は disabled だが、ここでも止める)。
      if (isSending(sid)) return;
      const current = contentRef.current;
      edit({
        text: removePlaceholder(current.text, n),
        attachments: current.attachments.filter((a) => a.n !== n),
      });
    },
    [sid, edit],
  );

  // paste は画像に加え Finder コピーのファイル (mime 不問) も添付に、
  // drop は Finder からの drag & drop 添付。
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!e.clipboardData || isSending(sid)) return;
      const files = extractTransferFiles(e.clipboardData.items);
      if (files.length === 0) return; // 通常テキスト paste は default に任せる
      e.preventDefault();
      for (const f of files) beginUpload(f);
    },
    [beginUpload, sid],
  );
  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!e.dataTransfer || isSending(sid)) return;
      const files = extractTransferFiles(e.dataTransfer.items);
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) beginUpload(f);
    },
    [beginUpload, sid],
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
    // 同期で見る: ⌘+Enter の連打は再 render の前に 2 回目を呼びうる。記録は
    // sendSessionInput が最初の await より前に書く。
    if (isSending(sid)) return;
    const body = text.trim();
    if (body === "") return;
    if (hasPendingUpload(attachments)) return; // safety net (ボタン disable 済)
    // [FILE<N>] を [FILE<N>:<name>](<path>) に置換してから送る。未完了
    // (upload 中 / error) の entry は substitute が skip するので、text に
    // リテラル [FILE<N>] が残る (upload 中は上で送信自体を止めている。error は
    // × で消してから送る運用)。
    const finalText = substitutePlaceholders(body, attachments);
    // 送る文を下書きとして確定させてから記録を作る。accepted の時に「下書きが
    // 送った文のままか」を比べる相手になる。
    saveDraft(sid, text, attachments);
    const outcome = await sendSessionInput(sid, { text, attachments }, finalText, (t) =>
      ws.userPrompt(sid, t, single),
    );
    // 単発の上書きはその送信のもの: 受け付けられたら次の送信に持ち越さない。
    if (outcome.kind === "accepted") setSingle({});
    // 下書きが消えた (= 送った文のままだった) 時だけ閉じる。返事を待つ間に
    // 別タブで書き換わっていれば、その文を見せたまま残す。
    if (outcome.kind === "accepted" && loadDraft(sid) === null) closePanel();
  }, [ws, sid, text, attachments, single, closePanel]);

  if (!open) {
    // close 中に下書きか未確認の送信が残っていれば FAB を「下書きあり」表示
    // (色 + 跳ね) にする。
    const hasDraft = text.trim().length > 0;
    const hasUnconfirmed = unconfirmedSends(sends).length > 0;
    return (
      <button
        type="button"
        class={
          "session-input-fab" +
          (hasDraft || hasUnconfirmed ? " composer-fab-draft" : "") +
          (cacheRing ? ` ${cacheRing.class}` : "")
        }
        title={
          hasUnconfirmed
            ? "届いたか確認できていない送信があります"
            : hasDraft
              ? "書きかけの下書きがあります"
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

  // 直近の送信が届かなかった・送れなかった時の注記と、未確認の送信ごとの注記を
  // 並べて出す (失敗の注記が未確認の警告を隠さない)。
  const failureNotice = failure ? sessionInputNotice(failure) : null;
  // 送る前から分かっている届かない理由 (daemon の input_readiness)。直近の送信が
  // 同じ理由で届かなかった時は、その注記が同じ文言を出すので重ねない。
  const readiness = sessionInputReadiness(targetPeer, sessionStatus);
  const readinessNotice =
    failure?.kind === "not_delivered" && failure.reason === readiness?.kind
      ? null
      : inputReadinessNotice(readiness);
  const unconfirmed = unconfirmedSends(sends);
  const unconfirmedNotice = sessionInputNotice({ kind: "unconfirmed" });
  const uploading = hasPendingUpload(attachments);
  // 今の下書きが未確認の送信と同じ文なら、送り直すと二重に入りうることを
  // ボタンの文言でも示す。
  const draftMaybeSent = unconfirmed.some((r) => sameContent(r, { text, attachments }));
  const sendLabel = sending
    ? "送信中..."
    : uploading
      ? "アップロード中..."
      : draftMaybeSent
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
            const value = e.currentTarget.value;
            edit({ text: value, attachments: contentRef.current.attachments });
            // 文を全部消したら、届かなかった理由の注記も対象を失う。未確認の
            // 送信の注記は送った文に付いているので消さない。
            if (value.trim() === "") clearLastFailure(sid);
          }}
          // close 前に必ず発火する blur でカーソル位置を保存
          onBlur={(e) => {
            const el = e.currentTarget;
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
      <ComposerAttachments
        attachments={attachments}
        onRemove={removeAttachment}
        disabled={sending}
      />
      {sending ? (
        <p class="session-input-status" role="status">
          セッションに渡しています。受け取ったかの確認を待っています...
        </p>
      ) : null}
      {readinessNotice ? (
        <div class="session-input-notice session-input-notice-warn" role="status">
          <p class="session-input-notice-detail">{readinessNotice}</p>
        </div>
      ) : null}
      {failureNotice ? (
        <div class={`session-input-notice session-input-notice-${failureNotice.tone}`} role="alert">
          <p class="session-input-notice-title">{failureNotice.title}</p>
          <p class="session-input-notice-detail">{failureNotice.detail}</p>
        </div>
      ) : null}
      {unconfirmedNotice
        ? unconfirmed.map((record) => (
            <div
              key={record.id}
              class={`session-input-notice session-input-notice-${unconfirmedNotice.tone}`}
              role="alert"
            >
              <p class="session-input-notice-title">
                {unconfirmedNotice.title}
                <span class="session-input-notice-time">
                  {" "}
                  ({formatSentAt(record.sentAt)} の送信)
                </span>
              </p>
              <p class="session-input-notice-excerpt">「{sendExcerpt(record.text)}」</p>
              <p class="session-input-notice-detail">{unconfirmedNotice.detail}</p>
              <button
                type="button"
                class="session-input-discard"
                onClick={() => discardSend(sid, record.id)}
                disabled={sending}
                title="この注記を消します。入力欄が送った文のままなら入力欄も空にします"
              >
                届いていたので消す
              </button>
            </div>
          ))
        : null}
      <div class="session-input-override">
        <OverrideFields
          value={single}
          onPick={(field, picked) => setSingle((now) => withPicked(now, field, picked))}
          disabled={sending}
          label="この送信だけの上書き"
        />
      </div>
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
