// DR-0015 §2.2 attachment upload helper. Extracted from Composer.tsx so both
// the room Composer and the 1on1 OneOnOneComposer can share the same XHR
// upload path (kawaz r15 mid=5: 1on1 も添付機能を持つべき、2026-07-14)。
//
// XHR (not fetch) は Composer 側の doc comment 参照 — `fetch` に upload
// progress hook が無いため、`xhr.upload.onprogress` で bytes-sent を chip に
// 反映する用途では XHR しか選択肢が無い。
import type { AttachmentUploadResponse } from "@ccmsg/protocol";

/** POST /attachment に multipart form で `file` を送信し、`AttachmentUploadResponse`
 * を resolve。progress は `onProgress(0..100)` で呼ぶ。非 2xx / transport error
 * では reject し、caller 側で attachment を status="error" に落として chip に
 * 表示する契約 (DR-0015 §2.5)。 */
export function uploadAttachment(
  file: File,
  onProgress: (percent: number) => void,
): Promise<AttachmentUploadResponse> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/attachment", true);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      // total may be 0 on some browsers when Content-Length can't be
      // computed; clamp to 0-100 and only report meaningful values.
      if (!e.lengthComputable || e.total === 0) return;
      onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.response as AttachmentUploadResponse | null;
        if (body && body.ok) resolve(body);
        else reject(new Error(`unexpected response body: ${xhr.responseText}`));
      } else {
        // 413 = size cap、400 = invalid form、500 = write failure。error msg に
        // status を含めて chip の tooltip に載せる。
        reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload transport error"));
    xhr.onabort = () => reject(new Error("upload aborted"));
    xhr.send(form);
  });
}
