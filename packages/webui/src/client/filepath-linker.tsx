/** @jsxImportSource preact */
/**
 * Shared filepath-linkifier wiring used by both the ROOM chat's message
 * bubbles (`TimelineItem.tsx`'s `MsgItem`) and the session's own transcript
 * (`components/timeline/segments.tsx`'s ThinkingSegment / assistant text). Both surfaces need
 * the exact same two pieces:
 *
 *   1. `useFilePathProbe` — ask the fs_stat_batch cache about the paths the
 *      body names (in an effect, so a re-render does not ask again), and
 *      re-render when the answer for one of *those* paths lands: it returns a
 *      number that changes then, which threads into the linker's identity to
 *      bust MarkdownView's useMemo. An answer for another body's paths leaves
 *      this one alone, so a Timeline of a thousand bubbles parses again only
 *      the bubble whose link changed.
 *   2. `makeFilePathLinker` — build the per-token linker MarkdownView calls
 *      on every inline-code token and every path-shaped bold run, returning
 *      a `FileViewer` href only when the daemon confirmed a real file.
 *
 * The `LinkedMarkdownView` component packs the two into one call site so
 * consumers just pass `source` + `ctx` (+ optional highlight props). When
 * `ctx` is undefined it degrades to a plain MarkdownView — same as before
 * DR-0028's linker wiring — so callers without a resolvable sender don't
 * need a separate code path.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  containmentRootOf,
  extractInlineCodeTokens,
  extractProsePathTokens,
  extractStrongTokens,
  findProsePaths,
  hrefFromStatEntry,
  parseFilePathRef,
  refLinkTarget,
  refToAbsolutePath,
  viewerPathForAbsolute,
  type FilePathResolveCtx,
  type ParsedFilePathRef,
} from "./filepath-ref.ts";
import {
  enqueueFilePathProbe,
  getFilePathStatus,
  subscribeFilePathCache,
  type FilePathStatus,
} from "./filepath-existence-cache.ts";
import {
  MarkdownView,
  renderPlainTextWithLinks,
  type FilePathLinker,
  type MarkdownPathLinker,
} from "./markdown-view.tsx";
import type { SearchWord } from "./in-view-search.ts";
import { useWebuiUrls } from "./context.ts";

/** Build the per-message linker MarkdownView calls on every inline-code
 * token and every single-text `**bold**` run. See module doc for the semantics of `pending`/missing/declined. */
export function makeFilePathLinker(
  ctx: FilePathResolveCtx | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `_cacheTick` forces closure identity to change on cache updates so MarkdownView's useMemo re-runs
  _cacheTick: number,
): FilePathLinker | undefined {
  if (!ctx) return undefined;
  return (token: string) => {
    const ref = parseFilePathRef(token);
    if (!ref) return null;
    const abs = refToAbsolutePath(ref, ctx);
    if (!abs) return null;
    const status = getFilePathStatus(ctx.sid, abs);
    if (!status || status === "pending") return null;
    return hrefFromStatEntry(ctx.sid, status, ref);
  };
}

/** Build the resolver MarkdownView calls for every markdown *link* whose
 * target is a filesystem path (kawaz r55 m116/m117, reworked in m129).
 *
 * Unlike `makeFilePathLinker` this asks the daemon nothing and always
 * resolves. The two differ because they answer different questions: inline
 * code is a *guess* that a token might be a path, so linking one that doesn't
 * exist would be a false positive, and the existence probe is what keeps that
 * rate down. A markdown link is not a guess — `[text](path)` is the author
 * declaring the target — so the only thing a probe added was latency and a
 * dead-link state that, in practice, read as an ordinary in-app link and left
 * documents unclickable until the batch came back (kawaz: 「そもそも先読みして
 * リンクしない動作自体が不要」). A target that names nothing now lands on the
 * viewer's not-found view, which says so and keeps the sidebar.
 *
 * Returns `null` only when no absolute path can be formed at all (no anchor in
 * `ctx`), where there is nothing to link *to* — still inert, never an
 * origin-relative `<a>`. */
export function makeMarkdownPathLinker(
  ctx: FilePathResolveCtx | undefined,
): MarkdownPathLinker | undefined {
  if (!ctx) return undefined;
  return (ref: ParsedFilePathRef) => {
    const abs = refLinkTarget(ref, ctx);
    if (!abs) return null;
    return hrefFromStatEntry(
      ctx.sid,
      // The viewer addresses contained files relative to the *containment*
      // root, which is what the daemon serves from; a file outside it stays
      // absolute and reaches the external/workspace read path.
      { path: viewerPathForAbsolute(abs, containmentRootOf(ctx)) },
      ref,
      ctx.docPath,
    );
  };
}

/** The guessed path references in a body, per how the body is shown: a
 * markdown body's inline code, bold runs and prose paths, or a plain body's
 * prose paths (it has no markup to carry the others). */
function probeTokens(source: string, format: "markdown" | "plain"): string[] {
  if (format === "plain") return findProsePaths(source).map((path) => path.token);
  return [
    ...extractInlineCodeTokens(source),
    ...extractStrongTokens(source),
    ...extractProsePathTokens(source),
  ];
}

/** The absolute paths a body's guessed references name, each once. */
function probedPaths(
  source: string,
  anchors: FilePathResolveCtx,
  format: "markdown" | "plain",
): string[] {
  const paths = new Set<string>();
  for (const token of probeTokens(source, format)) {
    const ref = parseFilePathRef(token);
    if (!ref) continue;
    const abs = refToAbsolutePath(ref, anchors);
    if (abs) paths.add(abs);
  }
  return [...paths];
}

/** A number that changes whenever the cache's answer for one of `paths` of
 * `sid` lands or is dropped, and only then: the re-render that lets a linker
 * reading those answers show them. `paths` is compared by identity, so pass
 * the same array while the paths are the same. */
function useFilePathStatusTick(sid: string | undefined, paths: readonly string[]): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (sid === undefined || paths.length === 0) return;
    return subscribeFilePathCache((change) => {
      if (change.sid !== sid) return;
      const answered = change.paths;
      if (answered === "all" || paths.some((path) => answered.has(path))) setTick((n) => n + 1);
    });
  }, [sid, paths]);
  return tick;
}

/** Ask the cache about every path a body's guessed references name, and
 * re-render when the answer for one of them lands (`useFilePathStatusTick`).
 * The asking runs in an effect, so a re-render with the same body asks
 * nothing (the cache dedupes too). */
function useFilePathProbe(
  source: string | undefined,
  ctx: FilePathResolveCtx | undefined,
  format: "markdown" | "plain" = "markdown",
): number {
  // Keyed on the fields the resolution reads, not on the ctx object: callers
  // rebuild it whenever the peer row is replaced, the same anchors included.
  const sid = ctx?.sid;
  const cwd = ctx?.cwd;
  const repoRoot = ctx?.repoRoot;
  const paths = useMemo(
    () =>
      sid === undefined || !source
        ? []
        : probedPaths(
            source,
            {
              sid,
              ...(cwd !== undefined ? { cwd } : {}),
              ...(repoRoot !== undefined ? { repoRoot } : {}),
            },
            format,
          ),
    [source, sid, cwd, repoRoot, format],
  );
  useEffect(() => {
    if (sid === undefined) return;
    for (const path of paths) enqueueFilePathProbe(sid, path);
  }, [sid, paths]);
  return useFilePathStatusTick(sid, paths);
}

/** The cache's answer for one path (`getFilePathStatus`), asked for on mount
 * and re-read when it lands. */
export function useFilePathStatus(
  sid: string | undefined,
  path: string | null,
): FilePathStatus | undefined {
  const paths = useMemo(() => (path === null ? [] : [path]), [path]);
  useEffect(() => {
    if (sid === undefined) return;
    for (const p of paths) enqueueFilePathProbe(sid, p);
  }, [sid, paths]);
  useFilePathStatusTick(sid, paths);
  return sid === undefined || path === null ? undefined : getFilePathStatus(sid, path);
}

/** `ctx` as one object for as long as its fields stay the same. Callers build
 * a new one on every render (from the peers list, which is pushed again
 * whenever a session's activity moves), and a linker made from a new ctx is a
 * new memo key for MarkdownView: the whole body parsed again. */
function useSameFilePathCtx(ctx: FilePathResolveCtx | undefined): FilePathResolveCtx | undefined {
  const sid = ctx?.sid;
  const cwd = ctx?.cwd;
  const containmentRoot = ctx?.containmentRoot;
  const repoRoot = ctx?.repoRoot;
  const docPath = ctx?.docPath;
  const repo = ctx?.repo;
  return useMemo(
    () =>
      sid === undefined
        ? undefined
        : {
            sid,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(containmentRoot !== undefined ? { containmentRoot } : {}),
            ...(repoRoot !== undefined ? { repoRoot } : {}),
            ...(docPath !== undefined ? { docPath } : {}),
            ...(repo !== undefined ? { repo } : {}),
          },
    [sid, cwd, containmentRoot, repoRoot, docPath, repo],
  );
}

/** MarkdownView wrapper that owns the linker + probe wiring. Callers pass
 * the sender-scoped `ctx` (undefined = no sender attribution = plain
 * MarkdownView) plus the usual MarkdownView props. Hooks are always called
 * so React's call-order stays stable regardless of whether `ctx` resolved.
 *
 * `probeSource` defaults to `source` — override only when the probe target
 * differs from what's rendered (e.g. ROOM's `MsgItem` skips probing for
 * user-authored plaintext by passing `undefined`). */
export function LinkedMarkdownView({
  source,
  ctx,
  probeSource,
  highlightWords,
  onMatchClick,
  restricted = false,
  issueRepo,
}: {
  source: string;
  ctx: FilePathResolveCtx | undefined;
  probeSource?: string | undefined;
  highlightWords?: readonly SearchWord[];
  onMatchClick?: () => void;
  /** kawaz r55 m12: forward MarkdownView's restricted mode. In restricted
   * mode we skip filepath probing entirely — user-authored inline code isn't
   * a session-scoped path reference (that channel is agent-only per DR-0028
   * / TimelineItem's existing pattern), and the linker's cache would be
   * churned by noise. Hooks stay called unconditionally so React's call
   * order is stable regardless of the flag. */
  restricted?: boolean;
  /** Repository for `#N` issue links when the sender has none to derive it
   * from (a user-authored room message, `ctx` undefined). Falls back to
   * `ctx.repo` when omitted. */
  issueRepo?: string;
}) {
  const sameCtx = useSameFilePathCtx(ctx);
  const probeTarget = restricted ? undefined : probeSource === undefined ? source : probeSource;
  const probeCtx = restricted ? undefined : sameCtx;
  // Only guessed references (inline code, bold runs, prose paths) are probed. Markdown
  // link targets are declared, not guessed, so they link without asking (see
  // `makeMarkdownPathLinker`).
  const cacheTick = useFilePathProbe(probeTarget, probeCtx);
  // Kept the same across renders while ctx's fields and the cache are: the
  // linkers are MarkdownView's memo keys, and a new one re-parses the whole
  // body.
  const linker = useMemo(
    () => (restricted ? undefined : makeFilePathLinker(sameCtx, cacheTick)),
    [restricted, sameCtx, cacheTick],
  );
  const pathLinker = useMemo(
    () => (restricted ? undefined : makeMarkdownPathLinker(sameCtx)),
    [restricted, sameCtx],
  );
  return (
    <MarkdownView
      source={source}
      highlightWords={highlightWords}
      onMatchClick={onMatchClick}
      filePathLinker={linker}
      pathLinker={pathLinker}
      restricted={restricted}
      issueRepo={issueRepo ?? ctx?.repo}
    />
  );
}

/** A user's own words, verbatim, with bare URLs and daemon-confirmed absolute
 * / `~/` paths linked (`renderPlainTextWithLinks`). The plain-text sibling of
 * `LinkedMarkdownView`, wired to the same probe and cache. */
export function LinkedPlainText({
  text,
  ctx,
}: {
  text: string;
  ctx: FilePathResolveCtx | undefined;
}) {
  const sameCtx = useSameFilePathCtx(ctx);
  const cacheTick = useFilePathProbe(text, sameCtx, "plain");
  const linker = useMemo(() => makeFilePathLinker(sameCtx, cacheTick), [sameCtx, cacheTick]);
  const webuiUrls = useWebuiUrls();
  return useMemo(
    () => <>{renderPlainTextWithLinks(text, linker, webuiUrls)}</>,
    [text, linker, webuiUrls],
  );
}
