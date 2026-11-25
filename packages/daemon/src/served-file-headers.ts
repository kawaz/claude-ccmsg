// The headers of a file a person or an agent wrote, served from the webui's
// own origin: a file in a session's tree (`/fs-serve`) and an attachment
// (`/attachment/<name>`). The contents are not trusted, and the origin is the
// webui's, so a document among them that ran script would run it as the
// webui: read the webui's storage and open /ws with the webui's Origin, which
// the daemon cannot tell from the webui itself. Whoever opens the URL as a
// page (a link, a new tab, another site's page sending its own tab there) or
// puts it in an iframe gets that document, so the guard has to be the
// browser's, on the response, not the webui's care in how it links.
//
// `Content-Security-Policy: sandbox` (no allow-* tokens) makes the document an
// opaque origin with no script, forms, popups or plugins. It applies to the
// response read as a document only: the same file read as an <img>, which is
// how the webui shows an image, draws as before. `nosniff` keeps the browser
// to the type the extension names, so bytes served as text or an image are
// never read as html.
//
// Design rationale: audio and video are served without the CSP. A media file
// opened in a tab of its own is shown in a page the browser makes around it,
// and under `sandbox` Chromium's never loads the media (Chromium 159; WebKit
// plays it). A file served as audio/* or video/* with nosniff is never made a
// document that runs script, so for them the sandbox would only break opening
// one in a tab. Every other type gets the sandbox, the image types and text
// included: it costs them nothing, and the rule then does not depend on
// knowing which types can carry script.

/** The headers to serve a user's file of MIME type `mime` with. */
export function servedFileHeaders(mime: string): Record<string, string> {
  const nosniff = { "x-content-type-options": "nosniff" };
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return nosniff;
  return { ...nosniff, "content-security-policy": "sandbox" };
}
