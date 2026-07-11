/** @jsxImportSource preact */
// Fenced-code-block renderer for markdown-view.tsx. Reuses FileViewer.tsx's
// async speed-highlight pipeline (highlight.ts) instead of a second
// tokenizer: a fence's info-string language name (e.g. "ts", "py") is fed
// through `detectLanguage` by treating it as a synthetic file extension, the
// same lookup table FileViewer already uses for real file paths.
import { useEffect, useState } from "preact/hooks";
import {
  detectLanguage,
  isHighlightEligible,
  tokenizeLines,
  type HighlightSpan,
} from "../highlight.ts";

export function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const shjLang = lang ? detectLanguage(`_.${lang.toLowerCase()}`) : null;
  const eligible = isHighlightEligible(shjLang, code, false);

  // Async tokenization layered on top of the plain text below (same
  // start-null/swap-in-when-ready pattern as FileViewer.tsx), keyed by
  // `code` so a fast re-render with different fence content can't paint
  // stale highlighted spans over new text.
  const [highlighted, setHighlighted] = useState<{ code: string; lines: HighlightSpan[][] } | null>(
    null,
  );
  useEffect(() => {
    if (!eligible || !shjLang) return;
    let cancelled = false;
    void tokenizeLines(code, shjLang).then((lines) => {
      if (!cancelled) setHighlighted({ code, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, code, shjLang]);

  const lines = highlighted && highlighted.code === code ? highlighted.lines : null;

  if (!lines) {
    return (
      <pre class="md-code">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <pre class="md-code">
      <code>
        {lines.map((spans, i) => (
          <span class="md-code-line" key={i}>
            {spans.map((span, j) =>
              span.type ? (
                <span class={`shj-syn-${span.type}`} key={j}>
                  {span.text}
                </span>
              ) : (
                span.text
              ),
            )}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
}
