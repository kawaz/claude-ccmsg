// hono app for the ccmsg webui (DR-0004 §4, client architecture per DR-0005).
// The daemon mounts this at every path except `/ws`; this package never
// touches the socket/WS layer itself, only serves the HTML shell + the
// preact/TSX client (bundled at serve time) that talks to `/ws`.
import { Hono } from "hono";

// Static assets (HTML shell, CSS) are read straight off disk (no bundler for
// these, DR-0004 §4) so `bun run` works unmodified whether this package is
// loaded from source or from a plugin install. Resolve relative to this
// module, not process.cwd().
const PUBLIC_DIR = new URL("./public/", import.meta.url);
const CLIENT_ENTRY = new URL("./client/main.tsx", import.meta.url);
const CLIENT_TSCONFIG = new URL("../tsconfig.json", import.meta.url);

interface Asset {
  file: string;
  contentType: string;
}

const ASSETS: Record<string, Asset> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", contentType: "text/css; charset=utf-8" },
};

export interface WebuiApp {
  fetch(req: Request): Response | Promise<Response>;
}

interface ClientBundle {
  code: string;
  hash: string;
  path: string;
}

async function bundleClient(): Promise<ClientBundle> {
  const result = await Bun.build({
    entrypoints: [CLIENT_ENTRY.pathname],
    target: "browser",
    tsconfig: CLIENT_TSCONFIG.pathname,
    // Serve-time build ships to a real browser, so minify like a production
    // bundle: for the whole app.js this is the difference between ~1.3MB and
    // ~276KB gzip.
    minify: true,
    throw: false,
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const output = result.outputs[0];
  if (!output) throw new Error("Bun.build produced no output for the webui client entry");
  const code = await output.text();
  const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex").slice(0, 16);
  return { code, hash, path: `/assets/app.${hash}.js` };
}

// Serve-time bundle of the preact/TSX client (DR-0005 §3): built once per
// PROCESS (module-level memo, not per createWebuiApp instance) on the first
// `/assets/app.js` request, then kept in memory for the process lifetime (no
// dist/ committed or generated on disk). Process-level (vs per-app) matters
// beyond economy: test suites create many app instances, and concurrent
// Bun.build runs over the client graph have been observed to fail flakily on
// Linux with EBADF/"Unexpected reading file" — one shared build removes that
// surface. A build failure is surfaced as a 500 with the
// error text — never a silent fallback to stale or missing content — and is
// not cached, so the next request retries the build.
let bundlePromise: Promise<ClientBundle> | null = null;
function getBundle(): Promise<ClientBundle> {
  bundlePromise ??= bundleClient().catch((err: unknown) => {
    bundlePromise = null;
    throw err;
  });
  return bundlePromise;
}

export function createWebuiApp(): WebuiApp {
  const app = new Hono();

  app.get("/assets/*", async (c) => {
    try {
      const bundle = await getBundle();
      if (c.req.path !== bundle.path) return c.notFound();
      return new Response(bundle.code, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`webui client build failed:\n\n${message}`, 500);
    }
  });

  // SPA catch-all (kawaz r55m115/m116): 未知パスにも HTML シェルを返す。
  //
  // 素の 404 を返すと standalone webapp (iPad のホーム画面追加) で詰む —
  // アドレスバーも戻るボタンも無いので、フルスクリーンのエラーページから
  // 抜ける手段がアプリ終了しかない。実際に markdown 中の相対リンク
  // (`/fixtures/…json`) を踏んで詰む事故が起きた: `target="_blank"` は
  // standalone では新規タブにならず同一ウィンドウ遷移になるため、リンク先が
  // この webui の 404 に着地する。
  //
  // シェルを返せば少なくともアプリが立ち上がり、サイドバーから復帰できる。
  // 未知パスをどう扱うか (SPA 側でのエラー表示) は URL 再設計側の担当。
  app.get("*", async (c) => {
    const asset = ASSETS[c.req.path];
    if (asset && asset.file !== "index.html") {
      const file = Bun.file(new URL(asset.file, PUBLIC_DIR));
      if (!(await file.exists())) return c.notFound();
      return new Response(file, { headers: { "content-type": asset.contentType } });
    }

    const [template, bundle] = await Promise.all([
      Bun.file(new URL("index.html", PUBLIC_DIR)).text(),
      getBundle(),
    ]);
    const shell = template.replace("/assets/app.js", bundle.path);
    const etag = `"${new Bun.CryptoHasher("sha256").update(shell).digest("hex")}"`;
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      etag,
    };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(shell, { headers });
  });

  return app;
}
