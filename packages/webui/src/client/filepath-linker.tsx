/** @jsxImportSource preact */
/**
 * Shared filepath-linkifier wiring used by both the ROOM chat's message
 * bubbles (`TimelineItem.tsx`'s `MsgItem`) and the session's own transcript
 * (`Timeline.tsx`'s ThinkingSegment / assistant text). Both surfaces need
 * the exact same three hooks:
 *
 *   1. `useFilePathProbeEnqueue` — walk the body source once per render into
 *      the fs_stat_batch cache. Runs in an effect so unrelated re-renders
 *      don't re-enqueue (the cache dedupes but skipping the extraction pass
 *      keeps the render path cheap).
 *   2. `useFilePathCacheTick` — subscribe to cache updates so batch responses
 *      trigger a re-render (the monotonic tick threads into the linker's
 *      identity to bust MarkdownView's useMemo).
 *   3. `makeFilePathLinker` — build the per-token linker MarkdownView calls
 *      on every inline-code token, returning a `FileViewer` href only when
 *      the daemon confirmed a real file.
 *
 * The `LinkedMarkdownView` component packs the three into one call site so
 * consumers just pass `source` + `ctx` (+ optional highlight props). When
 * `ctx` is undefined it degrades to a plain MarkdownView — same as before
 * DR-0028's linker wiring — so callers without a resolvable sender don't
 * need a separate code path.
 *
 * Previously duplicated inline in `TimelineItem.tsx` (kawaz r46 m55-m58);
 * extracted here for the TL rich-unify task so both surfaces stay in lockstep.
 */
import { useEffect, useState } from "preact/hooks";
import {
  extractInlineCodeTokens,
  hrefFromStatEntry,
  parseFilePathRef,
  refLinkCandidates,
  refToAbsolutePath,
  type FilePathResolveCtx,
  type ParsedFilePathRef,
} from "./filepath-ref.ts";
import { classifyMarkdownLinkUrl, extractMarkdownLinkUrls } from "./markdown-link.ts";
import {
  enqueueFilePathProbe,
  getFilePathStatus,
  subscribeFilePathCache,
} from "./filepath-existence-cache.ts";
import {
  attachmentUrlFromPath,
  MarkdownView,
  type FilePathLinker,
  type MarkdownPathLinker,
} from "./markdown-view.tsx";
import type { SearchWord } from "./in-view-search.ts";

/** Build the per-message linker MarkdownView calls on every inline-code
 * token. See module doc for the semantics of `pending`/missing/declined. */
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
 * target is a filesystem path (kawaz r55 m116/m117).
 *
 * Structurally identical to `makeFilePathLinker` — same `refToAbsolutePath` →
 * `fs_stat_batch` cache → `hrefFromStatEntry` pipeline, same "pending and
 * declined are indistinguishable" contract — differing only in that the ref
 * arrives already parsed (markdown link syntax declared the intent, so no
 * token-shape guess is needed) and in what `null` costs: an unresolved inline
 * code token merely stays `<code>`, whereas an unresolved link **must** stay
 * unlinked, since the alternative is navigating the webui origin. */
export function makeMarkdownPathLinker(
  ctx: FilePathResolveCtx | undefined,
  // oxlint-disable-next-line no-unused-vars -- `_cacheTick` forces closure identity to change on cache updates so MarkdownView's useMemo re-runs
  _cacheTick: number,
): MarkdownPathLinker | undefined {
  if (!ctx) return undefined;
  return (ref: ParsedFilePathRef) => {
    // First *confirmed* candidate wins; a pending or declined one falls
    // through to the next reading rather than settling the link.
    for (const abs of refLinkCandidates(ref, ctx)) {
      const status = getFilePathStatus(ctx.sid, abs);
      if (!status || status === "pending") continue;
      return hrefFromStatEntry(ctx.sid, status, ref);
    }
    return null;
  };
}

/** Enqueue every markdown link target that resolves to an absolute path.
 * Split from `useFilePathProbeEnqueue` rather than folded into it because the
 * two extractors answer different questions about the same source (which
 * inline-code tokens *look* like paths vs. which link targets *are* declared
 * as paths) and callers enable them independently — the file preview probes
 * links but has no sender to attribute inline code to. */
export function useMarkdownLinkProbeEnqueue(
  source: string | undefined,
  ctx: FilePathResolveCtx | undefined,
): void {
  useEffect(() => {
    if (!ctx || !source) return;
    for (const url of extractMarkdownLinkUrls(source)) {
      // Same classifier the renderer runs, so the set of URLs probed here and
      // the set that will ask the cache for an href cannot drift apart.
      // Attachment targets are excluded because the renderer rewrites them to
      // a daemon HTTP endpoint before classification ever runs.
      if (attachmentUrlFromPath(url)) continue;
      const target = classifyMarkdownLinkUrl(url);
      if (target.kind !== "path") continue;
      for (const abs of refLinkCandidates(target.ref, ctx)) enqueueFilePathProbe(ctx.sid, abs);
    }
  }, [source, ctx?.sid, ctx?.cwd, ctx?.repoRoot, ctx?.docRoot]);
}

/** Enqueue every candidate absolute path from a message body into the
 * filepath-existence-cache. Runs in an effect so a re-render (streaming
 * event addition, unrelated store change) does not re-enqueue — the cache
 * itself dedupes, but skipping the extraction pass when nothing changed
 * keeps the render path cheap. */
export function useFilePathProbeEnqueue(
  source: string | undefined,
  ctx: FilePathResolveCtx | undefined,
): void {
  useEffect(() => {
    if (!ctx || !source) return;
    for (const token of extractInlineCodeTokens(source)) {
      const ref = parseFilePathRef(token);
      if (!ref) continue;
      const abs = refToAbsolutePath(ref, ctx);
      if (!abs) continue;
      enqueueFilePathProbe(ctx.sid, abs);
    }
  }, [source, ctx?.sid, ctx?.cwd, ctx?.repoRoot]);
}

/** Subscribe to cache updates so a batch response triggers a re-render;
 * returns a monotonic tick that changes on every notification, letting
 * MarkdownView's useMemo re-evaluate (via the linker identity). */
export function useFilePathCacheTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeFilePathCache(() => setTick((n) => n + 1)), []);
  return tick;
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
}) {
  const probeTarget = restricted ? undefined : probeSource === undefined ? source : probeSource;
  const probeCtx = restricted ? undefined : ctx;
  useFilePathProbeEnqueue(probeTarget, probeCtx);
  useMarkdownLinkProbeEnqueue(probeTarget, probeCtx);
  const cacheTick = useFilePathCacheTick();
  const linker = restricted ? undefined : makeFilePathLinker(ctx, cacheTick);
  const pathLinker = restricted ? undefined : makeMarkdownPathLinker(ctx, cacheTick);
  return (
    <MarkdownView
      source={source}
      highlightWords={highlightWords}
      onMatchClick={onMatchClick}
      filePathLinker={linker}
      pathLinker={pathLinker}
      restricted={restricted}
    />
  );
}
