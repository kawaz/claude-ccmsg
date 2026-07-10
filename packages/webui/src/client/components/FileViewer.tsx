// Plain-text + line-number file viewer for SessionView (DR-0008 v1: no syntax
// highlighting — deferred to a follow-up issue to avoid bundle-size/dependency
// growth in the serve-time Bun.build path, DR-0005 §3). Owns the fs_read
// round trip for the currently-selected path (component-effect pattern, same
// division of labor as FileTree for fs_list).
import { useEffect } from "preact/hooks";
import { FS_READ_MAX_BYTES } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";

export function FileViewer({ sid, tree }: { sid: string; tree: SessionTreeState }) {
  const { store, ws } = useApp();
  const path = tree.selectedPath;
  const file = tree.file;

  // Fetch whenever the locator points at a path this session hasn't already
  // loaded/attempted. Keyed by `file?.path` (not just presence of `file`) so
  // navigating from file A to file B re-fetches, but re-visiting the same
  // path (e.g. duplicate hashchange) does not.
  useEffect(() => {
    if (!path) return;
    if (file && file.path === path) return;
    store.dispatch({ type: "fs/file-loading", sid, path });
    void ws.fsRead(sid, path).then((res) => {
      if (res.ok) store.dispatch({ type: "fs/file-loaded", sid, path, response: res });
      else store.dispatch({ type: "fs/file-loaded", sid, path, error: res.error.msg });
    });
  }, [sid, path, file?.path]);

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

  const res = file.response;
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

  // Drop the single trailing empty segment a `\n`-terminated file produces —
  // editors don't count "the newline after the last line" as its own line.
  const lines = res.content === "" ? [] : res.content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "" && res.content.endsWith("\n")) {
    lines.pop();
  }

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
          {lines.map((line, i) => (
            <div class="viewer-line" key={i}>
              <span class="viewer-lineno">{i + 1}</span>
              <span class="viewer-text">{line}</span>
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
