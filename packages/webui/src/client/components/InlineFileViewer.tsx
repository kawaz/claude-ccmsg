import { useState } from "preact/hooks";
import { MarkdownView } from "../markdown-view.tsx";
import { lineDiff, splitFileLines } from "../inline-file-model.ts";
import { isMarkdownPath } from "../utils.ts";

function CodeBody({ content }: { content: string }) {
  const contentLines = splitFileLines(content);
  return contentLines.length === 0 ? (
    <p class="viewer-empty-file">(空のファイル)</p>
  ) : (
    <pre class="viewer-body tl-inline-file-body">
      {contentLines.map((line, index) => (
        <div class="viewer-line" key={index}>
          <span class="viewer-lineno">{index + 1}</span>
          <span class="viewer-text">{line}</span>
        </div>
      ))}
    </pre>
  );
}

export function InlineFileViewer({ path, content }: { path: string; content: string }) {
  const [mode, setMode] = useState<"code" | "preview">("code");
  return (
    <div class="tl-inline-file-viewer">
      <div class="viewer-mode-toggle" role="tablist" aria-label="表示モード">
        <button
          type="button"
          class={"viewer-mode-btn" + (mode === "code" ? " active" : "")}
          onClick={() => setMode("code")}
        >
          コード
        </button>
        <button
          type="button"
          class={"viewer-mode-btn" + (mode === "preview" ? " active" : "")}
          onClick={() => setMode("preview")}
        >
          プレビュー
        </button>
      </div>
      {mode === "code" ? (
        <CodeBody content={content} />
      ) : isMarkdownPath(path) ? (
        <div class="viewer-preview">
          <MarkdownView source={content} />
        </div>
      ) : (
        <pre class="tl-inline-preview">{content || "(空のファイル)"}</pre>
      )}
    </div>
  );
}

export function InlineDiffViewer({ oldText, newText }: { oldText: string; newText: string }) {
  const [mode, setMode] = useState<"diff" | "raw">("diff");
  const diff = lineDiff(oldText, newText);
  return (
    <div class="tl-inline-file-viewer">
      <div class="viewer-mode-toggle" role="tablist" aria-label="差分表示モード">
        <button
          type="button"
          class={"viewer-mode-btn" + (mode === "diff" ? " active" : "")}
          onClick={() => setMode("diff")}
        >
          プレビュー
        </button>
        <button
          type="button"
          class={"viewer-mode-btn" + (mode === "raw" ? " active" : "")}
          onClick={() => setMode("raw")}
        >
          コード
        </button>
      </div>
      {mode === "diff" ? (
        <pre class="tl-diff-body">
          {diff.map((line, index) => (
            <div class={`tl-diff-line tl-diff-${line.kind}`} key={index}>
              <span class="tl-diff-marker">
                {line.kind === "delete" ? "−" : line.kind === "add" ? "+" : " "}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </pre>
      ) : (
        <div class="tl-diff-raw">
          <section>
            <h4>old</h4>
            <CodeBody content={oldText} />
          </section>
          <section>
            <h4>new</h4>
            <CodeBody content={newText} />
          </section>
        </div>
      )}
    </div>
  );
}
