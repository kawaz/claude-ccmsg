/** @jsxImportSource preact */
// Fenced-code-block renderer for markdown-view.tsx. Reuses FileViewer.tsx's
// async Shiki pipeline (highlight.ts) instead of a second tokenizer: a
// fence's info-string language name (e.g. "ts", "py") is fed through
// `detectLanguage` by treating it as a synthetic file extension, the same
// lookup table FileViewer already uses for real file paths.
import { useEffect, useState } from "preact/hooks";
import {
  detectLanguage,
  isHighlightEligible,
  tokenizeLines,
  type HighlightSpan,
} from "../highlight.ts";
import { useJsonStringCopy } from "../useJsonStringCopy.tsx";
import { CodeCopyFrame } from "./CodeCopyFrame.tsx";

/** `placeholder` は `code` が空の時に代わりに出す文字 (「(空のコマンド)」等)。
 * 写す中身が無いのでコピーボタンは付かない。 */
export function CodeBlock({
  code,
  lang,
  placeholder,
}: {
  code: string;
  lang: string | null;
  placeholder?: string;
}) {
  const jsonCopy = useJsonStringCopy();
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
      <CodeCopyFrame text={code}>
        <pre class="md-code">
          <code>{code === "" ? placeholder : code}</code>
        </pre>
      </CodeCopyFrame>
    );
  }

  return (
    <CodeCopyFrame text={code}>
      <pre class="md-code json-copy-host" {...jsonCopy.hostProps}>
        <code>
          {lines.map((spans, i) => (
            <span class="md-code-line" key={i}>
              {spans.map((span, j) =>
                span.style ? (
                  <span class="shiki-tok" style={span.style} key={j}>
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
        {jsonCopy.overlay}
      </pre>
    </CodeCopyFrame>
  );
}
