// DR-0015 attachment endpoints:
//   POST /attachment          — multipart file upload, saved to
//                               TMPDIR/claude-ccmsg-<uid>/attachment/<uuid>.<ext>
//   GET  /attachment/<uuid.ext> — serves it back with the extension's MIME type
//
// Both routes live behind the same-UID trust boundary the /ws socket already
// uses (source-IP + Origin gate in http.ts). This test suite exercises the
// upload/serve happy paths and — critically — the traversal / oversize /
// missing-file failure modes: a traversal-shaped uuid must never leak a file
// outside the attachment dir, an over-cap upload must 413 up-front, and a
// probe for a nonexistent uuid must 404 (not 500). Together those failure
// tests define what "safe endpoint" means at this trust boundary.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";
import {
  attachmentDir,
  extractExtension,
  isValidUuidV4,
  mimeForExtension,
} from "../src/attachment.ts";

const T = 15000;

async function startHttpDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonCtx> {
  return startTestDaemon({ CCMSG_HTTP_BIND: "127.0.0.1:0", ...extraEnv });
}

async function httpAddress(ctx: DaemonCtx): Promise<string> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  const pong = await c.request<{ http: string[] }>({ op: "ping" });
  c.close();
  expect(pong.http.length).toBe(1);
  return pong.http[0]!;
}

describe("attachment pure helpers", () => {
  // extractExtension は path traversal 対策の一次関門。ここが破れると GET 側の
  // uuid.ext マッチが誤動作するので、想定される攻撃形も含めて仕様固定する。
  test("extractExtension: known / unknown / empty / traversal-shaped inputs", () => {
    expect(extractExtension("diagram.png")).toBe(".png");
    expect(extractExtension("photo.JPG")).toBe(".jpg"); // lower-case 正規化
    expect(extractExtension("notes.pdf")).toBe(".pdf");
    // 二重拡張子は最後の 1 個に collapse (browser download 挙動と一致)。
    expect(extractExtension("archive.tar.gz")).toBe(".gz");
    // 拡張子なしは "" を返し、save path は UUID そのままになる。
    expect(extractExtension("Makefile")).toBe("");
    expect(extractExtension("no.ext.here?")).toBe(""); // 英数以外を含むので拒否
    // 攻撃形: dot 直後が空 / 記号を含む / ダブルドット
    expect(extractExtension("evil.")).toBe("");
    expect(extractExtension("evil../evil")).toBe(""); // basename が evil、拡張子なし
    expect(extractExtension("evil.sh;rm")).toBe(""); // 英数以外を拒否
    // 極端に長い拡張子 (16 chars 超え) は拒否 — MIME table にも無いし
    // 実質的なファイル拡張子でもない。
    expect(extractExtension(`x.${"a".repeat(20)}`)).toBe("");
  });

  // MIME テーブルの key と webui 側 image inline 判定 (markdown-view の
  // image mime 拡張子リスト) が同期している必要がある。両者で扱う代表画像 mime
  // が octet-stream にフォールバックしないことを確認。
  test("mimeForExtension: images / documents / unknown fallback", () => {
    expect(mimeForExtension(".png")).toBe("image/png");
    expect(mimeForExtension(".jpg")).toBe("image/jpeg");
    expect(mimeForExtension(".jpeg")).toBe("image/jpeg");
    expect(mimeForExtension(".gif")).toBe("image/gif");
    expect(mimeForExtension(".webp")).toBe("image/webp");
    expect(mimeForExtension(".pdf")).toBe("application/pdf");
    // 未知拡張子は octet-stream に fallback (browser が download を促す)。
    expect(mimeForExtension(".xyz")).toBe("application/octet-stream");
    // 空文字 (拡張子なし upload) も octet-stream。
    expect(mimeForExtension("")).toBe("application/octet-stream");
  });

  // GET 側は uuid が RFC 4122 v4 完全形でないと 404 に倒す。version/variant
  // nibble まで見ているので、`0000...` のような v4 でない UUID や
  // `../secret` のような traversal も uuid check の時点で reject される。
  test("isValidUuidV4: real v4 accepted, non-v4 and traversal rejected", () => {
    // crypto.randomUUID() は v4 を返す — 実際の出力を採用してこの check が
    // 通ることを保証する (自家生成の regex と実際の値が乖離する事故防止)。
    expect(isValidUuidV4(crypto.randomUUID())).toBe(true);
    // v1 nil UUID: 15 桁目が 4 ではないので reject
    expect(isValidUuidV4("00000000-0000-1000-8000-000000000000")).toBe(false);
    // 20 桁目 variant nibble が 8/9/a/b でない (c) → reject
    expect(isValidUuidV4("00000000-0000-4000-c000-000000000000")).toBe(false);
    // traversal / short / random string は当然 reject
    expect(isValidUuidV4("../etc/passwd")).toBe(false);
    expect(isValidUuidV4("evil")).toBe(false);
    expect(isValidUuidV4("")).toBe(false);
  });
});

describe("HTTP attachment endpoints (DR-0015)", () => {
  test(
    "POST /attachment: multipart upload returns uuid/ext/path/mime and writes the bytes to disk",
    async () => {
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const form = new FormData();
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
        form.append("file", new File([bytes], "diagram.png", { type: "image/png" }));

        const res = await fetch(`http://${addr}/attachment`, { method: "POST", body: form });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          ok: boolean;
          uuid: string;
          ext: string;
          size: number;
          mime: string;
          path: string;
          name: string;
        };
        expect(body.ok).toBe(true);
        expect(body.name).toBe("diagram.png");
        expect(body.ext).toBe(".png");
        expect(body.mime).toBe("image/png");
        expect(body.size).toBe(bytes.length);
        expect(isValidUuidV4(body.uuid)).toBe(true);
        // path が attachment dir 配下 + 想定 basename。
        expect(body.path.endsWith(`/attachment/${body.uuid}.png`)).toBe(true);
        expect(body.path.startsWith(attachmentDir())).toBe(true);
        // 実際に bytes がその path に書かれている (Read できる)。
        const written = fs.readFileSync(body.path);
        expect(Array.from(written)).toEqual(Array.from(bytes));
        fs.unlinkSync(body.path); // test 後の後始末 (OS 任せだがすぐ消せる分は消す)
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "POST /attachment: file with no extension is stored as bare UUID and gets octet-stream mime",
    async () => {
      // 拡張子なしの upload (Makefile 等) は元名保持で response.name に載るが、
      // save path は UUID だけ、mime は octet-stream fallback。この経路が GET 側で
      // 拾えるかは下の "GET: extension-less upload" test で検証する。
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const form = new FormData();
        // File.type を空にすることで extension-based lookup 経路を通す。
        form.append("file", new File([new Uint8Array([0x23, 0x21])], "Makefile", { type: "" }));

        const res = await fetch(`http://${addr}/attachment`, { method: "POST", body: form });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          ok: boolean;
          uuid: string;
          ext: string;
          size: number;
          mime: string;
          path: string;
          name: string;
        };
        expect(body.ext).toBe("");
        expect(body.mime).toBe("application/octet-stream");
        expect(body.name).toBe("Makefile");
        expect(body.path.endsWith(`/attachment/${body.uuid}`)).toBe(true);
        fs.unlinkSync(body.path);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "POST /attachment: Content-Length exceeding the cap returns 413 without reading the body",
    async () => {
      // upload cap は default 50MB。test では CCMSG_ATTACHMENT_MAX_BYTES で小さく絞って
      // 過剰 payload を挙げなくても 413 経路を実測する — サイズ上限は保留となっていた
      // 実装時判断 (DR-0015 Open questions §1) の core spec を凍結する意図。
      const ctx = await startHttpDaemon({ CCMSG_ATTACHMENT_MAX_BYTES: "8" });
      try {
        const addr = await httpAddress(ctx);
        const form = new FormData();
        form.append(
          "file",
          new File([new Uint8Array(64)], "big.bin", { type: "application/octet-stream" }),
        );

        const res = await fetch(`http://${addr}/attachment`, { method: "POST", body: form });
        expect(res.status).toBe(413);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "POST /attachment: missing 'file' field returns 400 (not silent success)",
    async () => {
      // multipart は正しいが field 名が違うケース。silently 成功して空ファイルが
      // 作られると webui の UX が壊れるので、明示的に 400 で拒否することを固定。
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const form = new FormData();
        form.append("wrong-field", "hello");

        const res = await fetch(`http://${addr}/attachment`, { method: "POST", body: form });
        expect(res.status).toBe(400);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "GET /attachment/<uuid.ext>: round-trip returns bytes with the expected content-type + inline disposition",
    async () => {
      // POST → GET の連携。同じ prosess 内 upload → 別 HTTP 呼び出しでダウンロード。
      // GET が inline (Content-Disposition) で content-type が保存時の mime、
      // bytes が完全一致することを確認する。webui の <img src> 経路と一致する動作。
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const form = new FormData();
        const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        form.append("file", new File([bytes], "sample.png", { type: "image/png" }));
        const upRes = await fetch(`http://${addr}/attachment`, { method: "POST", body: form });
        expect(upRes.status).toBe(200);
        const meta = (await upRes.json()) as {
          ok: boolean;
          uuid: string;
          ext: string;
          path: string;
          name: string;
          mime: string;
          size: number;
        };

        const getRes = await fetch(`http://${addr}/attachment/${meta.uuid}.png`);
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get("content-type")).toBe("image/png");
        expect(getRes.headers.get("content-disposition")).toBe("inline");
        const got = new Uint8Array(await getRes.arrayBuffer());
        expect(Array.from(got)).toEqual(Array.from(bytes));
        fs.unlinkSync(meta.path);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "GET /attachment: extension-less save (bare UUID) is retrievable as octet-stream",
    async () => {
      // 拡張子なしの upload を GET 側でも取れることを確認。webui の TMPDIR→URL 変換で
      // 拡張子なし path も扱えるようにするための spec。
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const form = new FormData();
        form.append("file", new File([new Uint8Array([9, 9, 9])], "Makefile", { type: "" }));
        const upRes = await fetch(`http://${addr}/attachment`, { method: "POST", body: form });
        const meta = (await upRes.json()) as {
          ok: boolean;
          uuid: string;
          ext: string;
          path: string;
          name: string;
          mime: string;
          size: number;
        };

        const getRes = await fetch(`http://${addr}/attachment/${meta.uuid}`);
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get("content-type")).toBe("application/octet-stream");
        fs.unlinkSync(meta.path);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "GET /attachment: nonexistent uuid returns 404 (not 500)",
    async () => {
      // OS が TMPDIR を消した (DR-0015 §2.1) or 未 upload の uuid を叩かれた場面。
      // 500 だと webui 側の retry ロジックが誤動作するので 404 に倒す。
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const ghost = crypto.randomUUID();
        const res = await fetch(`http://${addr}/attachment/${ghost}.png`);
        expect(res.status).toBe(404);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "GET /attachment: traversal-shaped path segments are rejected with 404 (never a leaked file)",
    async () => {
      // security-critical: uuid が UUID v4 形式でない or 拡張子が英数以外を含む
      // 場合は path を組み立てる前に 404 に倒す。/etc/passwd 等を狙う請求が
      // 一切ファイルシステムに到達しないことを固定。
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        // URL encoding された `..`。fetch が %2E に encode するので実際の
        // pathname は "/attachment/..%2F/etc/passwd" 相当。
        const cases = [
          "/attachment/..%2Fetc%2Fpasswd",
          "/attachment/evil",
          "/attachment/00000000-0000-0000-0000-000000000000.png", // v4 でない UUID
          "/attachment/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sh;rm", // 記号入り拡張子
        ];
        for (const p of cases) {
          const res = await fetch(`http://${addr}${p}`);
          expect(res.status).toBe(404);
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "Origin check applies to /attachment routes too (403 for evil origin)",
    async () => {
      // http.ts の source-IP + Origin gate は WS だけでなく plain HTTP routes 全てに効く。
      // /attachment を追加した変更が gate を通す前に処理してしまう事故を防ぐ regression test。
      const ctx = await startHttpDaemon();
      try {
        const addr = await httpAddress(ctx);
        const form = new FormData();
        form.append("file", new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
        const res = await fetch(`http://${addr}/attachment`, {
          method: "POST",
          body: form,
          headers: { Origin: "http://evil.com" },
        });
        expect(res.status).toBe(403);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
