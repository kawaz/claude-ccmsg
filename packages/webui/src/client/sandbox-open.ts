// Opening a sandbox-origin URL (DR-0030 §7.2) in a new tab: the preview of a
// file (FileViewer's SandboxActions) and the run of an svg (DR-0067 §3) open
// it the same way, so the way lives here once.
//
// The tab is opened synchronously on the click and its location is filled in
// once the grant resolves — a `window.open` after the await is what popup
// blockers exist to stop.
import type { ReplyOf, SandboxGrantResponse } from "@ccmsg/protocol";
import { errorMessage } from "./utils.ts";

/** Open a new tab now, mint the grant, and send the tab to `urlOf(grant)`.
 * A refused mint or a failed send closes the tab and reports why. */
export function openSandboxTab(
  mint: () => Promise<ReplyOf<"sandbox_grant">>,
  urlOf: (granted: SandboxGrantResponse) => string,
  onError: (message: string) => void,
): void {
  const tab = window.open("", "_blank", "noopener,noreferrer");
  mint()
    .then((res) => {
      if (!res.ok) {
        tab?.close();
        onError(res.error.msg);
        return;
      }
      const url = urlOf(res);
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer"); // popup blocked: try anyway
    })
    .catch((err: unknown) => {
      tab?.close();
      onError(errorMessage(err));
    });
}
