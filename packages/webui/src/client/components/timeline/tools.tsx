// ファイル系・Bash の tool の fold とカード。
import { useContext, useEffect, useState } from "preact/hooks";
import { fileHref } from "../../locator.ts";
import { formatClockTime } from "../../utils.ts";
import {
  type AttachmentFile,
  type BashCommandOutput,
  type FileToolResult,
  type Segment,
} from "../../transcript-model.ts";
import { useFilePathCacheTick } from "../../filepath-linker.tsx";
import { enqueueFilePathProbe, getFilePathStatus } from "../../filepath-existence-cache.ts";
import { hrefFromStatEntry, viewerPathForAbsolute } from "../../filepath-ref.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { InlineDiffViewer, InlineFileViewer } from "../InlineFileViewer.tsx";
import { FileToolSidContext, SessionFilePathCtxContext, useCategoryOpen } from "./context.ts";
import { FoldGuide, FoldSummary } from "./folds.tsx";

function fileToolLineRange(segment: Extract<Segment, { kind: "file-read" }>): {
  start: number;
  end: number;
} | null {
  if (segment.offset === null) return null;
  const start = Math.max(1, segment.offset);
  return { start, end: segment.limit === null ? start : start + Math.max(0, segment.limit - 1) };
}

/**
 * Body of a Read card: the file's text, the image it returned, the error it
 * failed with, or a note when no result has been loaded for it.
 *
 * The image is rendered from the base64 the transcript row already carries,
 * as a data URL, rather than from the daemon's /fs-serve endpoint the Files
 * view uses. A Read's subject is often a temp file (a pasted attachment in
 * the per-user ccmsg attachment directory under `$TMPDIR`) that may be gone
 * by the time anyone reads the transcript, and the base64 is exactly what the
 * model was
 * shown — downscaled by the harness, so a full-resolution re-fetch would not
 * be the same picture. Cost of the choice: those bytes (~100-400KB) become a
 * DOM string, so the `<img>` is only mounted once the fold is open.
 */
function FileReadResultView({
  path,
  result,
  open,
}: {
  path: string;
  result: FileToolResult | null;
  open: boolean;
}) {
  if (result === null) {
    return (
      <p class="tl-file-tool-unavailable">
        読み取り結果はまだ読み込まれていません (実行中か、結果の行が読み込み範囲より後)。
        上へスクロールして古い行を読み込むと表示されます。
      </p>
    );
  }
  if (result.kind === "error") {
    return <p class="tl-file-tool-error">{result.message}</p>;
  }
  if (result.kind === "image") {
    return (
      <div class="tl-file-tool-image">
        {open ? (
          <img
            src={`data:${result.mediaType};base64,${result.base64}`}
            width={result.width ?? undefined}
            height={result.height ?? undefined}
            alt={path}
          />
        ) : null}
      </div>
    );
  }
  return <InlineFileViewer path={path} content={result.content} />;
}

/** Read のカード。読んだだけで何も変えないので auto open の対象にせず、既定は閉。 */
export function FileReadFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "file-read" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useState(false);
  return <FileToolFold segment={segment} ts={ts} open={open} setOpen={setOpen} />;
}

/** Edit / Write のカード。開閉の既定は auto open の E に従う。 */
export function FileChangeFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "file-write" | "file-edit" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useCategoryOpen("edit");
  return <FileToolFold segment={segment} ts={ts} open={open} setOpen={setOpen} />;
}

function FileToolFold({
  segment,
  ts,
  open,
  setOpen,
}: {
  segment: Extract<Segment, { kind: "file-read" | "file-write" | "file-edit" }>;
  ts: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const sid = useContext(FileToolSidContext);
  const range = segment.kind === "file-read" ? fileToolLineRange(segment) : null;
  const suffix = range ? `:${range.start}-${range.end}` : "";
  const label = `${segment.kind === "file-read" ? "Read" : segment.kind === "file-write" ? "Write" : "Edit"} ${segment.path}${suffix}`;
  return (
    <details
      class="tl-fold tl-file-tool-fold"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <FoldSummary ts={ts} label={label} open={open} />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-file-tool-card">
          <a class="tl-file-tool-path" href={fileHref(sid, segment.path, range ?? undefined)}>
            {segment.path}
            {suffix}
          </a>
          {segment.kind === "file-edit" ? (
            <InlineDiffViewer oldText={segment.oldString} newText={segment.newString} />
          ) : segment.kind === "file-write" ? (
            <InlineFileViewer path={segment.path} content={segment.content} />
          ) : (
            <FileReadResultView path={segment.path} result={segment.result} open={open} />
          )}
        </div>
      </div>
    </details>
  );
}

function bashAnchor(kind: "command" | "result", toolUseId: string): string {
  return `tl-bash-${kind}-${encodeURIComponent(toolUseId)}`;
}

function BashJumpLink({ target, children }: { target: string; children: string }) {
  return (
    <a
      class="tl-bash-link"
      href={`#${target}`}
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(target)?.scrollIntoView({ block: "center" });
      }}
    >
      {children}
    </a>
  );
}

export function BashUseFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "bash-use" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useState(false);
  const commandLabel = segment.description || segment.command.split("\n", 1)[0] || "command";
  const resultAnchor = bashAnchor("result", segment.toolUseId);
  return (
    <details
      id={bashAnchor("command", segment.toolUseId)}
      class="tl-fold tl-file-tool-fold"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <FoldSummary
        ts={ts}
        label={`Bash ${commandLabel}`}
        open={open}
        decoration={{ kind: "bash" }}
      />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-file-tool-card tl-bash-card">
          <div class="tl-bash-description">command</div>
          <div class="tl-bash-command">
            <CodeBlock code={segment.command || "(空のコマンド)"} lang="bash" />
          </div>
          {segment.background ? (
            <div class="tl-bash-result-status">
              {segment.hasResult ? (
                <BashJumpLink target={resultAnchor}>結果へ</BashJumpLink>
              ) : (
                "実行中 / 結果なし"
              )}
            </div>
          ) : segment.result ? (
            <div class={"tl-bash-output" + (segment.result.isError ? " is-error" : "")}>
              <div class="tl-bash-output-label">{segment.result.isError ? "error" : "output"}</div>
              <pre>{segment.result.text || "(出力なし)"}</pre>
            </div>
          ) : (
            <div class="tl-bash-result-status">実行中 / 結果なし</div>
          )}
        </div>
      </div>
    </details>
  );
}

/**
 * The file body an attachment carried, drawn like a Read card's (kawaz r99
 * m35) — before this, an edited-file or @-mentioned-file row showed only raw
 * JSON with the text as one escaped string.
 *
 * The content comes from the transcript row itself, so the preview works for a
 * file that has since changed or been deleted; the *path* above it links into
 * Files only when the same existence probe the persisted-output link uses says
 * the file is still there. The daemon allowlists these paths for external
 * reads (DR-0024), so an existing file's link resolves rather than 403s.
 */
export function AttachmentFileView({ file }: { file: AttachmentFile }) {
  const ctx = useContext(SessionFilePathCtxContext);
  useFilePathCacheTick();
  const ctxSid = ctx?.sid;
  useEffect(() => {
    if (ctxSid !== undefined) enqueueFilePathProbe(ctxSid, file.path);
  }, [file.path, ctxSid]);
  const stat = ctx ? getFilePathStatus(ctx.sid, file.path) : undefined;
  const href =
    ctx && stat && stat !== "pending"
      ? hrefFromStatEntry(
          ctx.sid,
          { path: viewerPathForAbsolute(file.path, ctx.containmentRoot) },
          { path: file.path },
        )
      : null;
  return (
    <div class="tl-attachment-file">
      {href ? (
        <a class="tl-attachment-file-path" href={href}>
          {file.path}
        </a>
      ) : (
        <div class="tl-attachment-file-path">{file.path}</div>
      )}
      <InlineFileViewer path={file.path} content={file.content} startLine={file.startLine} />
    </div>
  );
}

/** The output half of a `! <cmd>` card. Split out because an output row that
 * arrived without its command renders the same block on its own. */
function BashRunOutput({ output }: { output: BashCommandOutput }) {
  const ctx = useContext(SessionFilePathCtxContext);
  const persistedPath = output.persisted?.path ?? null;
  // Gate the link on the same existence probe the inline-code linkifier uses.
  // The sidecar lives beside the transcript rather than inside the session's
  // workspace, so serving it depends on the daemon having folded the stub's
  // path into DR-0024's exact-path `external_files` allowlist. It does, but
  // the probe stays as the affordance's condition: a sidecar that was cleaned
  // up, or a stub the two parsers read differently, then costs a dead link
  // rather than a `path not allowed` error, and the path itself still shows as
  // text the user can open themselves.
  // `useFilePathCacheTick` re-renders this card when the batch answer lands.
  useFilePathCacheTick();
  const ctxSid = ctx?.sid;
  useEffect(() => {
    if (persistedPath && ctxSid !== undefined) enqueueFilePathProbe(ctxSid, persistedPath);
  }, [persistedPath, ctxSid]);
  const persistedStat =
    persistedPath && ctx ? getFilePathStatus(ctx.sid, persistedPath) : undefined;
  const persistedHref =
    persistedPath && ctx && persistedStat && persistedStat !== "pending"
      ? hrefFromStatEntry(
          ctx.sid,
          { path: viewerPathForAbsolute(persistedPath, ctx.containmentRoot) },
          { path: persistedPath },
        )
      : null;
  return (
    <>
      {output.persisted ? (
        <div class="tl-bashrun-persisted">
          <div class="tl-bashrun-persisted-note">{output.persisted.note}</div>
          {persistedHref ? (
            <a
              class="tl-bashrun-persisted-link"
              href={persistedHref}
              target="_blank"
              rel="noopener"
            >
              全文を別タブで開く
            </a>
          ) : null}
          <div class="tl-bash-output-label">preview</div>
          <pre class="tl-bashrun-out">{output.persisted.preview}</pre>
        </div>
      ) : null}
      {output.stdout !== null ? <pre class="tl-bashrun-out">{output.stdout}</pre> : null}
      {output.stderr !== null ? (
        <>
          <div class="tl-bash-output-label">stderr</div>
          <pre class="tl-bashrun-out is-error">{output.stderr}</pre>
        </>
      ) : null}
      {output.persisted === null && output.stdout === null && output.stderr === null ? (
        <div class="tl-bash-result-status">(出力なし)</div>
      ) : null}
    </>
  );
}

/**
 * A TUI `! <cmd>` run, drawn on the user side of the conversation as a
 * terminal execution rather than as speech (kawaz r76m20). Deliberately not a
 * `<details>` fold: unlike the harness plumbing that surrounds it this is
 * something the user typed and expects to see, so it stays open and the
 * *output* is what gets bounded — `max-height` + scroll in CSS, with the
 * oversized case already reduced by Claude Code itself to a preview plus a
 * link to the full bytes (see `BashCommandOutput`).
 */
export function BashRunCard({
  command,
  output,
  ts,
}: {
  command: string | null;
  output: BashCommandOutput | null;
  ts: string | null;
}) {
  return (
    <div class="tl-line tl-bashrun">
      <div class="tl-file-tool-card tl-bash-card">
        <div class="tl-bashrun-head">
          <span class="tl-bashrun-badge">shell</span>
          {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
        </div>
        {command !== null ? (
          <div class="tl-bash-command">
            <CodeBlock code={command || "(空のコマンド)"} lang="bash" />
          </div>
        ) : null}
        {output ? <BashRunOutput output={output} /> : null}
        {command !== null && output === null ? (
          <div class="tl-bash-result-status">実行中 / 結果なし</div>
        ) : null}
      </div>
    </div>
  );
}

export function BashResultFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "bash-result" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      id={bashAnchor("result", segment.toolUseId)}
      class="tl-fold tl-file-tool-fold"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <FoldSummary ts={ts} label={`Bash result${segment.isError ? " (error)" : ""}`} open={open} />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-file-tool-card tl-bash-card">
          {segment.hasCommand ? (
            <div class="tl-bash-result-status">
              <BashJumpLink target={bashAnchor("command", segment.toolUseId)}>
                コマンドへ
              </BashJumpLink>
            </div>
          ) : null}
          <div class={"tl-bash-output" + (segment.isError ? " is-error" : "")}>
            <pre>{segment.text || "(出力なし)"}</pre>
          </div>
        </div>
      </div>
    </details>
  );
}
