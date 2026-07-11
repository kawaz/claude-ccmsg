// Line-number file viewer for SessionView, with syntax highlighting for
// recognized extensions (DR-0008 v1 shipped plain-only and deferred
// highlighting to a follow-up issue over bundle-size concerns; see
// highlight.ts for the size evaluation that unblocked it). Owns the fs_read
// round trip for the currently-selected path (component-effect pattern, same
// division of labor as FileTree for fs_list).
import { useEffect, useState } from "preact/hooks";
import { FS_READ_MAX_BYTES } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { errorMessage } from "../utils.ts";
import {
  detectLanguage,
  isHighlightEligible,
  tokenizeLines,
  type HighlightSpan,
} from "../highlight.ts";

function splitLines(content: string): string[] {
  const lines = content === "" ? [] : content.split("\n");
  // Drop the single trailing empty segment a `\n`-terminated file produces —
  // editors don't count "the newline after the last line" as its own line.
  if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

export function FileViewer({ sid, tree }: { sid: string; tree: SessionTreeState }) {
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
        </header>
        <p class="viewer-binary">バイナリファイル ({res.size.toLocaleString()} bytes)</p>
      </div>
    );
  }

  const lines = splitLines(res.content);
  const highlightedLines = highlighted && highlighted.path === path ? highlighted.lines : null;

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
      </header>
      {lines.length === 0 ? (
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
                        span.type ? (
                          <span class={`shj-syn-${span.type}`} key={j}>
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
