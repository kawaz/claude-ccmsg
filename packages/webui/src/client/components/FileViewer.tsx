// Line-number file viewer for SessionView, with syntax highlighting for
// recognized extensions (DR-0008 v1 shipped plain-only and deferred
// highlighting to a follow-up issue over bundle-size concerns; see
// highlight.ts for the fine-grained Shiki bundle that unblocked it). Owns
// the fs_read
// round trip for the currently-selected path (component-effect pattern, same
// division of labor as FileTree for fs_list).
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { FS_READ_MAX_BYTES, type WorkspaceFolder } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import {
  errorMessage,
  inboxAutoFilename,
  isExternalFilePath,
  isImagePath,
  isMarkdownPath,
  isWorkspaceFilePath,
  resolveInboxFilename,
} from "../utils.ts";
import {
  loadFilesView,
  resolveMarkdownViewMode,
  resolveMarkdownViewModePersist,
  saveFilesView,
} from "../files-view-store.ts";
import {
  detectLanguage,
  isHighlightEligible,
  tokenizeLines,
  type HighlightSpan,
} from "../highlight.ts";
import { MarkdownView } from "../markdown-view.tsx";
import {
  highlightRenderedText,
  removeRenderedTextHighlights,
  setRenderedTextCurrent,
} from "../rendered-text-search.ts";
import { loopNextIndex, loopPrevIndex, parseSearchQuery } from "../in-view-search.ts";
import { SearchBar } from "./SearchBar.tsx";

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
  workspaceFolders,
  memoEditorOpen,
  onMemoCancel,
  onMemoCreated,
}: {
  sid: string;
  tree: SessionTreeState;
  /** DR-0026 allowlist used to pick fs_read_workspace over fs_read_external
   * for absolute paths reachable through a `.code-workspace` folder. */
  workspaceFolders: readonly WorkspaceFolder[];
  memoEditorOpen: boolean;
  onMemoCancel: () => void;
  onMemoCreated: (path: string) => void | Promise<void>;
}) {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store).connStatus;
  const path = tree.selectedPath;
  const selectedLineRange = tree.selectedLineRange;
  const selectedLineRef = useRef<HTMLDivElement | null>(null);
  const file = tree.file;
  const res = file?.response;

  useEffect(() => {
    if (!selectedLineRange || !res || res.binary) return;
    const frame = requestAnimationFrame(() =>
      selectedLineRef.current?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [path, selectedLineRange?.start, selectedLineRange?.end, res?.content, res?.binary]);

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
    // Three-way op selection for the currently-selected path:
    // - relative → fs_read (DR-0008 containment root)
    // - absolute, under a workspace folder → fs_read_workspace (DR-0026
    //   directory-prefix allowlist)
    // - absolute, not under a workspace folder → fs_read_external (DR-0024
    //   exact-file allowlist)
    // Workspace check happens first because a workspace folder root can sit
    // anywhere on the filesystem and a transcript may also have Read'd a file
    // under that same root; in that case the workspace op is the correct
    // affordance (directory browsing works, external_files stays as the
    // per-file safety net when the folder isn't listed as a workspace).
    void (
      isWorkspaceFilePath(path, workspaceFolders)
        ? ws.fsReadWorkspace(sid, path)
        : isExternalFilePath(path)
          ? ws.fsReadExternal(sid, path)
          : ws.fsRead(sid, path)
    )
      .then((res) => {
        if (res.ok) store.dispatch({ type: "fs/file-loaded", sid, path, response: res });
        else store.dispatch({ type: "fs/file-loaded", sid, path, error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "fs/file-loaded", sid, path, error: errorMessage(err) });
      });
  }, [sid, path, file?.path, connStatus, workspaceFolders]);

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
  // in the same line-numbered viewer users expect. HTML preview is
  // deliberately not implemented (see comment on the toggle-button block
  // below).
  //
  // 復元規則 (kawaz r17 mid=5 初版 → r26 mid=112 で意味論拡張):
  // 「saved.path === 現 path 一致時のみ preview を復活」だと、A(preview)
  // → B → A で戻ったとき B 選択時に record が {B, code} で上書きされて A
  // に戻ったときは saved.path !== A で復元経路を外れていた (kawaz が「タブ
  // 切り替えのたびにコードビューへ戻る」と感じていた真因)。r26 mid=112 以降
  // は record.viewMode を **per-sid の markdown モードの last choice** として
  // 扱い、markdown を開くたびに saved.viewMode を復元する (resolveMarkdownViewMode)。
  // 非 markdown ファイル選択時は record.viewMode を "code" で上書きせず
  // 継承 (resolveMarkdownViewModePersist) — 途中で .ts を挟んでも記憶を
  // 失わない。同じ effect 内で record も更新する (復元値を含めた確定値を
  // 書くので、初期値 "code" が保存済み preview を先に上書きする race がない)。
  const [viewMode, setViewMode] = useState<"code" | "preview">("code");
  const markdownEligible = path != null && isMarkdownPath(path);
  useEffect(() => {
    if (path === null) return;
    const saved = loadFilesView(sid);
    const restored = resolveMarkdownViewMode(saved, path);
    setViewMode(restored);
    saveFilesView(sid, {
      path,
      viewMode: resolveMarkdownViewModePersist(saved, path, restored),
    });
  }, [sid, path]);
  // viewMode のユーザ操作は state 更新と同時に record へ書く (effect 監視
  // でなく操作起点 — 復元由来の setViewMode と書き込みが交錯しないように)。
  // toggle は markdown ファイルでしか render されない (markdownEligible 判定、
  // FileViewer 本体) ので、ここで書く viewMode は必ず「markdown モードの
  // last choice」の意味論を満たす。
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

  // In-view search (DR-0022 Phase 1): plain content lines (not highlighted
  // spans — see the "showPreview"/render block below for why search
  // deliberately bypasses Shiki tokens while a query is active) computed
  // early so this and the hooks below can run unconditionally before the
  // early-return guards further down (rules-of-hooks).
  const searchLines = useMemo(
    () => (res && !res.binary ? splitLines(res.content) : []),
    [res?.content, res?.binary],
  );
  const [searchQueryText, setSearchQueryText] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const parsedSearch = useMemo(
    () =>
      parseSearchQuery(searchQueryText, { caseSensitive: searchCaseSensitive, regex: searchRegex }),
    [searchQueryText, searchCaseSensitive, searchRegex],
  );
  // Which line indices (0-based, into searchLines) satisfy the query's AND
  // filter, in document order — this is the "M" in "[N/M]" and the order
  // ↑/↓ nav walks (DR-0022 §2.2).
  const [matchingLineIndices, setMatchingLineIndices] = useState<number[]>([]);
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(0);
  // A fresh search (new query text, toggle flip, or file switch) always
  // starts back at the first match — there is no meaningful "keep the old
  // position" once the match set itself has changed.
  // Deps deliberately omit matchingLineIndices: the reset key is "the query
  // changed", not the array's identity.
  useEffect(() => {
    setSearchCurrentIndex(matchingLineIndices.length > 0 ? 1 : 0);
  }, [searchQueryText, searchCaseSensitive, searchRegex, path]);
  useEffect(() => {
    setSearchCurrentIndex((current) => {
      if (matchingLineIndices.length === 0) return 0;
      if (current <= 0) return 1;
      return Math.min(current, matchingLineIndices.length);
    });
  }, [matchingLineIndices.length]);
  const searchLineRefs = useRef(new Map<number, HTMLDivElement>());
  const registerSearchLineRef = useCallback((i: number, el: HTMLDivElement | null) => {
    if (el) searchLineRefs.current.set(i, el);
    else searchLineRefs.current.delete(i);
  }, []);
  useEffect(() => {
    const matched: number[] = [];
    for (let i = 0; i < searchLines.length; i += 1) {
      const container = searchLineRefs.current.get(i);
      const line = container?.matches(".viewer-preview")
        ? container
        : container?.querySelector<HTMLElement>(".viewer-text");
      if (!line) continue;
      if (parsedSearch.words.length === 0 || parsedSearch.hasError) {
        removeRenderedTextHighlights(line);
        continue;
      }
      const isMatch = highlightRenderedText(line, parsedSearch.words, () => {
        const position = matched.indexOf(i);
        if (position >= 0) setSearchCurrentIndex(position + 1);
      });
      if (isMatch) matched.push(i);
    }
    const currentLine = searchCurrentIndex > 0 ? matched[searchCurrentIndex - 1] : undefined;
    for (const [i, container] of searchLineRefs.current) {
      const text = container.matches(".viewer-preview")
        ? container
        : container.querySelector<HTMLElement>(".viewer-text");
      if (text) setRenderedTextCurrent(text, i === currentLine);
    }
    setMatchingLineIndices((current) =>
      current.length === matched.length && current.every((line, i) => line === matched[i])
        ? current
        : matched,
    );
    return () => {
      for (const line of searchLineRefs.current.values()) {
        const text = line.matches(".viewer-preview")
          ? line
          : line.querySelector<HTMLElement>(".viewer-text");
        if (text) removeRenderedTextHighlights(text);
      }
    };
  }, [searchLines, parsedSearch, matchingLineIndices, highlighted, searchCurrentIndex]);
  function scrollToMatch(oneBasedIdx: number) {
    const lineIdx = matchingLineIndices[oneBasedIdx - 1];
    if (lineIdx === undefined) return;
    searchLineRefs.current.get(lineIdx)?.scrollIntoView({ block: "center" });
  }
  // ↑/↓ move + scroll (DR-0022 §2.2: "スクロール動作は既存のユーザメッセージ
  // 移動と同様"); clicking a highlight only updates the index (see the
  // <mark onClick> below) — the loop wrap itself is the shared pure helper
  // also used by Timeline's 👤 nav.
  function searchPrev() {
    const next = loopPrevIndex(searchCurrentIndex, matchingLineIndices.length);
    setSearchCurrentIndex(next);
    scrollToMatch(next);
  }
  function searchNext() {
    const next = loopNextIndex(searchCurrentIndex, matchingLineIndices.length);
    setSearchCurrentIndex(next);
    scrollToMatch(next);
  }

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
    void (
      isWorkspaceFilePath(path, workspaceFolders)
        ? ws.fsReadWorkspace(sid, path)
        : isExternalFilePath(path)
          ? ws.fsReadExternal(sid, path)
          : ws.fsRead(sid, path)
    )
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

  // Image extensions get inline <img> preview regardless of the daemon's
  // binary-sniff verdict: PNG/JPEG/… trip the NUL-byte sniff (res.binary=true,
  // content dropped) while SVG is UTF-8 text (res.binary=false). Serving via
  // the /fs-serve HTTP endpoint sidesteps both the 512 KiB fs_read cap and
  // the base64 blow-up a data: URL would need. SVG is deliberately rendered
  // through <img src> (not inline in the DOM) so SVG-embedded <script> stays
  // inert (browsers do not execute scripts inside SVG loaded as an image).
  const imageMode = isImagePath(path);
  if (imageMode) {
    const kind = isWorkspaceFilePath(path, workspaceFolders)
      ? "workspace"
      : isExternalFilePath(path)
        ? "external"
        : "contained";
    const src = `/fs-serve?sid=${encodeURIComponent(sid)}&path=${encodeURIComponent(path)}&kind=${kind}`;
    return (
      <div class="file-viewer">
        <header class="viewer-header">
          <span class="viewer-path">{path}</span>
          <span class="viewer-banner">画像 ({res.size.toLocaleString()} bytes)</span>
          <RefetchButton />
        </header>
        <div class="viewer-image-wrap">
          <img
            class="viewer-image"
            src={src}
            alt={path}
            // Force reload on ↻ refetch: the loaded response's size/path
            // signature keys the URL fragment so <img> re-fetches after an
            // fs_read refetch reports a new size.
            key={`${path}:${res.size}`}
          />
        </div>
      </div>
    );
  }

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

  const lines = searchLines;
  const highlightedLines = highlighted && highlighted.path === path ? highlighted.lines : null;
  const showPreview = markdownEligible && viewMode === "preview";
  return (
    <div class="file-viewer">
      <header class="viewer-header">
        <span class="viewer-path">{path}</span>
        {res.truncated ? (
          <span class="viewer-banner">
            先頭 {Math.floor(FS_READ_MAX_BYTES / 1024)}KB のみ表示 (全 {res.size.toLocaleString()}{" "}
            bytes)
          </span>
        ) : null}
        <SearchBar
          words={parsedSearch.words}
          queryText={searchQueryText}
          onQueryChange={setSearchQueryText}
          caseSensitive={searchCaseSensitive}
          onToggleCaseSensitive={() => setSearchCaseSensitive((v) => !v)}
          regexMode={searchRegex}
          onToggleRegex={() => setSearchRegex((v) => !v)}
          matchCount={matchingLineIndices.length}
          currentIndex={searchCurrentIndex}
          onPrev={searchPrev}
          onNext={searchNext}
          hasError={parsedSearch.hasError}
        />
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
        <RefetchButton />
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
        <div class="viewer-preview" ref={(el) => registerSearchLineRef(0, el)}>
          <MarkdownView source={res.content} tableOfContents />
        </div>
      ) : lines.length === 0 ? (
        <p class="viewer-empty-file">(空のファイル)</p>
      ) : (
        <pre class="viewer-body">
          {lines.map((line, i) => {
            const spans = highlightedLines?.[i];
            const lineNumber = i + 1;
            const selected =
              selectedLineRange !== null &&
              lineNumber >= selectedLineRange.start &&
              lineNumber <= selectedLineRange.end;
            return (
              <div
                class={"viewer-line" + (selected ? " viewer-line-selected" : "")}
                key={i}
                ref={(el) => {
                  registerSearchLineRef(i, el);
                  if (lineNumber === selectedLineRange?.start) selectedLineRef.current = el;
                }}
              >
                <span class="viewer-lineno">{lineNumber}</span>
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
