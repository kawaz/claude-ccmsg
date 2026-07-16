// Line-number file viewer for SessionView, with syntax highlighting for
// recognized extensions (DR-0008 v1 shipped plain-only and deferred
// highlighting to a follow-up issue over bundle-size concerns; see
// highlight.ts for the fine-grained Shiki bundle that unblocked it). Owns
// the fs_read
// round trip for the currently-selected path (component-effect pattern, same
// division of labor as FileTree for fs_list).
import { useEffect, useRef, useState } from "preact/hooks";
import { FS_READ_MAX_BYTES } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { errorMessage, inboxAutoFilename, isMarkdownPath, resolveInboxFilename } from "../utils.ts";
import { loadFilesView, saveFilesView } from "../files-view-store.ts";
import {
  detectLanguage,
  isHighlightEligible,
  tokenizeLines,
  type HighlightSpan,
} from "../highlight.ts";
import { MarkdownView } from "../markdown-view.tsx";

function splitLines(content: string): string[] {
  const lines = content === "" ? [] : content.split("\n");
  // Drop the single trailing empty segment a `\n`-terminated file produces —
  // editors don't count "the newline after the last line" as its own line.
  if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

/** Full-pane new-memo editor. It deliberately owns only the draft and the
 * fs_write effect; FilesPanes owns the surrounding viewer-vs-editor mode and
 * the post-create tree/navigation transition. This matches the existing
 * component-effect split: FileViewer performs file I/O, while FilesPanes
 * coordinates state that changes both sibling panes. */
function InboxNewEditor({
  sid,
  onCancel,
  onCreated,
}: {
  sid: string;
  onCancel: () => void;
  onCreated: (path: string) => void | Promise<void>;
}) {
  const { ws } = useApp();
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // Freeze the suggested name for this editor instance so unrelated renders
  // cannot change the placeholder while the user is composing.
  const [autoName] = useState(() => inboxAutoFilename(new Date()));

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  async function createMemo(): Promise<void> {
    // State updates are async, so a ref is the immediate duplicate-submit gate
    // for rapid button clicks or repeated Cmd+Enter presses in one render.
    if (creatingRef.current) return;
    const resolved = resolveInboxFilename(name, new Date());
    if ("error" in resolved) {
      setError(resolved.error);
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const res = await ws.fsWrite(sid, `docs/inbox/${resolved.name}`, content);
      if (res.ok) await onCreated(res.path);
      else setError(res.error.msg);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return (
    <form
      class="file-viewer memo-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void createMemo();
      }}
    >
      <header class="viewer-header memo-editor-header">
        <input
          type="text"
          class="memo-editor-name"
          aria-label="メモのファイル名"
          placeholder={`自動命名: ${autoName}`}
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          disabled={creating}
        />
        <div class="memo-editor-actions">
          <button type="button" onClick={onCancel} disabled={creating}>
            キャンセル
          </button>
          <button type="submit" disabled={creating}>
            {creating ? "保存中…" : "保存"}
          </button>
        </div>
      </header>
      {error ? <p class="memo-editor-error">{error}</p> : null}
      <textarea
        ref={bodyRef}
        class="memo-editor-body"
        aria-label="メモ本文"
        placeholder="メモ本文"
        value={content}
        onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.metaKey && e.key === "Enter") {
            e.preventDefault();
            void createMemo();
          }
        }}
        disabled={creating}
      />
    </form>
  );
}

export function FileViewer({
  sid,
  tree,
  memoEditorOpen,
  onMemoCancel,
  onMemoCreated,
}: {
  sid: string;
  tree: SessionTreeState;
  memoEditorOpen: boolean;
  onMemoCancel: () => void;
  onMemoCreated: (path: string) => void | Promise<void>;
}) {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store).connStatus;
  const path = tree.selectedPath;
  const file = tree.file;
  const res = file?.response;

  // Fetch whenever the locator points at a path this session hasn't already
  // loaded/attempted. Keyed by `file?.path` (not just presence of `file`) so
  // navigating from file A to file B re-fetches, but re-visiting the same
  // path (e.g. duplicate hashchange) does not. Gated on connStatus so a
  // direct `#s<sid>:<path>` link opened before the WS handshake completes
  // doesn't race ws.send() (rejects synchronously while not open, see
  // ws.ts) — the "読み込み中…" fallback below just holds until connStatus
  // flips to "connected", which re-evaluates this effect via the dep list.
  useEffect(() => {
    if (!path) return;
    if (file && file.path === path) return;
    if (connStatus !== "connected") return;
    store.dispatch({ type: "fs/file-loading", sid, path });
    void ws
      .fsRead(sid, path)
      .then((res) => {
        if (res.ok) store.dispatch({ type: "fs/file-loaded", sid, path, response: res });
        else store.dispatch({ type: "fs/file-loaded", sid, path, error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "fs/file-loaded", sid, path, error: errorMessage(err) });
      });
  }, [sid, path, file?.path, connStatus]);

  // Highlighting is a separate, best-effort layer on top of the plain lines
  // rendered below: `tokenize()` is async, so this starts as `null` (plain
  // text shown immediately) and swaps in colored spans once ready, keyed by
  // path so a fast file-to-file switch can't paint highlights for the
  // previous file over the new one.
  const lang = path ? detectLanguage(path) : null;
  const highlightEligible = res != null && isHighlightEligible(lang, res.content, res.binary);
  const [highlighted, setHighlighted] = useState<{ path: string; lines: HighlightSpan[][] } | null>(
    null,
  );

  // Markdown preview toggle (kawaz spec): only offered for .md / .markdown
  // paths (isMarkdownPath), default is "code" so a new file always opens
  // in the same line-numbered viewer users expect. Reset to "code" on
  // every path change — leaving "preview" sticky would render the next
  // file (which might not even be markdown) as an empty/garbled preview
  // for one frame before the toggle re-hid itself, which is worse than a
  // small extra click when navigating md→md. HTML preview is deliberately
  // not implemented (see comment on the toggle-button block below).
  //
  // 例外 (kawaz r17 mid=5): localStorage に保存された per-sid record
  // (files-view-store.ts) の path が現 path と一致するなら viewMode を復元
  // する — タブ切替やリロードで「さっき preview で見ていた md」に戻った時
  // だけ preview が復活し、別ファイルへの遷移は従来通り "code" に戻る。
  // 同じ effect 内で record も更新する (復元値を含めた確定値を書くので、
  // 初期値 "code" が保存済み preview を先に上書きする race がない)。
  const [viewMode, setViewMode] = useState<"code" | "preview">("code");
  const markdownEligible = path != null && isMarkdownPath(path);
  useEffect(() => {
    if (path === null) return;
    const saved = loadFilesView(sid);
    const restored = saved && saved.path === path && isMarkdownPath(path) ? saved.viewMode : "code";
    setViewMode(restored);
    saveFilesView(sid, { path, viewMode: restored });
  }, [sid, path]);
  // viewMode のユーザ操作は state 更新と同時に record へ書く (effect 監視
  // でなく操作起点 — 復元由来の setViewMode と書き込みが交錯しないように)。
  const selectViewMode = (mode: "code" | "preview") => {
    setViewMode(mode);
    if (path !== null) saveFilesView(sid, { path, viewMode: mode });
  };
  useEffect(() => {
    if (!highlightEligible || !res || !lang || !path) return;
    let cancelled = false;
    void tokenizeLines(res.content, lang).then((lines) => {
      if (!cancelled) setHighlighted({ path, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [highlightEligible, res?.content, lang, path]);

  // 開いているファイルを強制再取得する (kawaz 2026-07-14、task #23)。fs_read は
  // 別プロセスによる更新を picking しないため (現在の DR-0008 は push notify を
  // 持たない)、viewer が古い内容を掴んだままになりうる。↻ ボタンで明示的に
  // 現 path を再フェッチする。useEffect の deps に依らず直接叩くのは
  // 「path 不変で content だけ更新したい」意図を通すため — 通常の path 遷移
  // 経路 (dispatch(fs/file-loading) → useEffect が fs_read) と同じ action を
  // 手で発火する形にして、reducer/state 遷移の一貫性を保つ。
  const canRefetch = path != null && connStatus === "connected";
  const handleRefetch = () => {
    if (!canRefetch) return;
    store.dispatch({ type: "fs/file-loading", sid, path });
    void ws
      .fsRead(sid, path)
      .then((r) => {
        if (r.ok) store.dispatch({ type: "fs/file-loaded", sid, path, response: r });
        else store.dispatch({ type: "fs/file-loaded", sid, path, error: r.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "fs/file-loaded", sid, path, error: errorMessage(err) });
      });
  };
  const RefetchButton = () =>
    canRefetch ? (
      <button
        type="button"
        class="viewer-refetch"
        aria-label="ファイルを再取得"
        title="ファイルを再取得"
        onClick={handleRefetch}
      >
        {"↻"}
      </button>
    ) : null;

  if (memoEditorOpen) {
    return <InboxNewEditor sid={sid} onCancel={onMemoCancel} onCreated={onMemoCreated} />;
  }

  if (!path) {
    return (
      <div class="file-viewer">
        <p class="viewer-empty">ファイルを選んでください</p>
      </div>
    );
  }

  if (!file || file.path !== path || file.status === "loading") {
    return (
      <div class="file-viewer">
        <p class="viewer-loading">読み込み中…</p>
      </div>
    );
  }

  if (file.status === "error") {
    return (
      <div class="file-viewer">
        <header class="viewer-header">
          <span class="viewer-path">{path}</span>
          <RefetchButton />
        </header>
        <p class="viewer-error">{file.error}</p>
      </div>
    );
  }

  if (!res) return null; // unreachable: status "loaded" always carries a response (store.ts invariant)

  if (res.binary) {
    return (
      <div class="file-viewer">
        <header class="viewer-header">
          <span class="viewer-path">{path}</span>
          <RefetchButton />
        </header>
        <p class="viewer-binary">バイナリファイル ({res.size.toLocaleString()} bytes)</p>
      </div>
    );
  }

  const lines = splitLines(res.content);
  const highlightedLines = highlighted && highlighted.path === path ? highlighted.lines : null;
  const showPreview = markdownEligible && viewMode === "preview";

  return (
    <div class="file-viewer">
      <header class="viewer-header">
        <span class="viewer-path">{path}</span>
        <RefetchButton />
        {res.truncated ? (
          <span class="viewer-banner">
            先頭 {Math.floor(FS_READ_MAX_BYTES / 1024)}KB のみ表示 (全 {res.size.toLocaleString()}{" "}
            bytes)
          </span>
        ) : null}
        {/* Preview/Code toggle: rendered only for markdown-eligible paths
         * (isMarkdownPath) so non-markdown files don't get a dead button.
         * Deliberately not offered for .html (kawaz decision, security
         * scope: an HTML preview would need a sandbox we haven't built
         * yet — a separate-origin iframe / CSP scaffolding is the topic
         * of a future issue, and shipping raw innerHTML in the same
         * origin as the daemon UI is not acceptable). */}
        {markdownEligible ? (
          <div class="viewer-mode-toggle" role="tablist" aria-label="表示モード">
            <button
              type="button"
              class={"viewer-mode-btn" + (viewMode === "code" ? " active" : "")}
              role="tab"
              aria-selected={viewMode === "code"}
              onClick={() => selectViewMode("code")}
            >
              コード
            </button>
            <button
              type="button"
              class={"viewer-mode-btn" + (viewMode === "preview" ? " active" : "")}
              role="tab"
              aria-selected={viewMode === "preview"}
              onClick={() => selectViewMode("preview")}
            >
              プレビュー
            </button>
          </div>
        ) : null}
      </header>
      {showPreview ? (
        // Feed the full loaded content to MarkdownView (which parses and
        // walks mdast → JSX, DR-0010). For truncated files, that's the
        // head bytes the daemon actually sent — the banner above already
        // tells the user why the tail is missing, so rendering "the
        // markdown of the head" is more useful than refusing to preview.
        // The trailing chunk may parse as an unclosed fence or half a
        // paragraph; that's a visible cue matching the banner, not a
        // silent truncation.
        <div class="viewer-preview">
          <MarkdownView source={res.content} />
        </div>
      ) : lines.length === 0 ? (
        <p class="viewer-empty-file">(空のファイル)</p>
      ) : (
        <pre class="viewer-body">
          {lines.map((line, i) => {
            const spans = highlightedLines?.[i];
            return (
              <div class="viewer-line" key={i}>
                <span class="viewer-lineno">{i + 1}</span>
                <span class="viewer-text">
                  {spans
                    ? spans.map((span, j) =>
                        span.style ? (
                          <span class="shiki-tok" style={span.style} key={j}>
                            {span.text}
                          </span>
                        ) : (
                          span.text
                        ),
                      )
                    : line}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}
