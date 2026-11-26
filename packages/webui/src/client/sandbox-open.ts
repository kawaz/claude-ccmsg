// Opening a sandbox-origin URL (DR-0030 §7.2) in a new tab: the preview of a
// file (FileViewer's SandboxActions) and the run of an svg (DR-0067 §3) open
// it the same way, so the way lives here once.
//
// One empty tab is opened synchronously on the click — a `window.open` after
// the await is what popup blockers exist to stop — and its opener is cut at
// once, so the sandbox document never gets a handle on the webui's window.
// The tab is opened without `noopener`: with it, `window.open` returns null
// while still opening the tab, and the URL could not be put into it.
import type { ReplyOf, SandboxGrantResponse } from "@ccmsg/protocol";
import { errorMessage } from "./utils.ts";

/**
 * Send the empty tab to `url` with no Referer, as `noreferrer` did: the
 * sandbox document learns nothing of the webui's address (its Referer and
 * `document.referrer` stay empty).
 *
 * Design rationale: the navigation is a link followed inside the tab's own
 * (still empty, same-origin) document, with `referrerPolicy = "no-referrer"`,
 * rather than `tab.location` set from the webui. A location set from the
 * webui takes its referrer from the webui's document, and Chromium then sends
 * the webui's origin (observed: Referer and document.referrer both
 * `http://<webui host>/`). The link carries its own policy, the same in every
 * engine, and leaves the webui's own referrer policy alone.
 */
function navigateWithoutReferrer(tab: Window, url: string): void {
  const link = tab.document.createElement("a");
  link.href = url;
  link.referrerPolicy = "no-referrer";
  tab.document.body.append(link);
  link.click();
}

/** Open one new tab now, mint the grant, and send the tab to
 * `urlOf(grant)`. A refused mint or a failed send closes the tab and reports
 * why. */
export function openSandboxTab(
  mint: () => Promise<ReplyOf<"sandbox_grant">>,
  urlOf: (granted: SandboxGrantResponse) => string,
  onError: (message: string) => void,
): void {
  const tab = window.open("", "_blank");
  if (tab !== null) tab.opener = null;
  mint()
    .then((res) => {
      if (!res.ok) {
        tab?.close();
        onError(res.error.msg);
        return;
      }
      const url = urlOf(res);
      if (tab !== null) navigateWithoutReferrer(tab, url);
      else window.open(url, "_blank", "noopener,noreferrer"); // popup blocked: try anyway
    })
    .catch((err: unknown) => {
      tab?.close();
      onError(errorMessage(err));
    });
}
