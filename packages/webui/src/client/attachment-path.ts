// webui が送る添付 (DR-0015 §2.4 / §2.6) を本文の中で見分ける。Composer は
// 添付を本文に `[FILE<N>:<name>](<TMPDIR の attachment パス>)` のリンクとして
// 入れる。描画 (markdown-view.tsx) と翻訳の既定判定 (translate.ts) が同じ
// 見分け方を使う。

// DR-0015 §2.6 attachment image extensions. Kept as a set (not re-derived
// from the daemon's MIME table) so this file stays browser-only and doesn't
// pull the daemon's node-only helpers via cross-package imports. The daemon
// upload path stores files with the extensions this set filters on, so a
// mismatch would surface immediately as a broken `<img>` — the failure mode
// is loud, not silent.
const ATTACHMENT_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
]);

/**
 * DR-0015 §2.6 attachment path recognizer. Given a Markdown link's `url` from
 * a message body, returns `{url, isImage}` when it points at the daemon's
 * TMPDIR attachment area (`/…/claude-ccmsg-<uid>/attachment/<basename>`), or
 * `null` otherwise. The returned `url` is rewritten to the daemon's HTTP
 * endpoint (`/attachment/<basename>`) — the raw filesystem path a browser
 * cannot fetch (`file://` is sandbox-blocked) becomes a fetchable
 * same-origin URL, which the caller renders as either `<img>` (image mime)
 * or a normal `<a>`.
 *
 * The pattern intentionally matches only trailing basenames — one segment,
 * no slashes — under the `attachment/` directory. Anchoring at the end + the
 * `[^/]+` guard means a path like `/foo/claude-ccmsg-501/attachment/../etc`
 * would not match at all (`..` fails the character class), so a hostile
 * message body can't rewrite arbitrary daemon URLs. The daemon's own GET
 * route does its own uuid/ext re-validation regardless.
 */
export function attachmentUrlFromPath(url: string): { url: string; isImage: boolean } | null {
  const basename = /\/claude-ccmsg-[^/]+\/attachment\/([^/]+)$/.exec(url)?.[1];
  if (basename === undefined) return null;
  const dot = basename.lastIndexOf(".");
  const ext = dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  return {
    url: `/attachment/${basename}`,
    isImage: ATTACHMENT_IMAGE_EXTENSIONS.has(ext),
  };
}

/** `[label](target)` の形 (markdown-view.tsx の plain text のリンクと同じ
 * 字句: label に括弧・改行を含まず、target に空白と丸括弧を含まない)。 */
const LINK_RE = /\[[^[\]\n]+\]\(([^()\s]+)\)/g;

/** 本文から添付のリンク (`[FILE<N>:<name>](<attachment パス>)`) を label ごと
 * 除く。target が添付の置き場でないリンクはそのまま残す。 */
export function withoutAttachmentLinks(text: string): string {
  return text.replace(LINK_RE, (link: string, target: string) =>
    attachmentUrlFromPath(target) === null ? link : "",
  );
}
