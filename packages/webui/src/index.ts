// hono app for the ccmsg webui (DR-0004 §4, client architecture per DR-0005).
// The daemon mounts this at every path except `/ws`; this package never
// touches the socket/WS layer itself, only serves the HTML shell + the
// preact/TSX client (bundled at serve time) that talks to `/ws`.
import { Hono } from "hono";
import { encodeAsset, encodedResponse, type EncodedAsset } from "./encoded-asset.ts";

// Static assets (HTML shell, CSS) are read straight off disk, once per process
// (no bundler for these, DR-0004 §4) so `bun run` works unmodified whether this package is
// loaded from source or from a plugin install. Resolve relative to this
// module, not process.cwd().
const PUBLIC_DIR = new URL("./public/", import.meta.url);
const CLIENT_ENTRY = new URL("./client/main.tsx", import.meta.url);
const CLIENT_TSCONFIG = new URL("../tsconfig.json", import.meta.url);

export interface WebuiApp {
  fetch(req: Request): Response | Promise<Response>;
}

interface ClientBundle {
  asset: EncodedAsset;
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
  return { asset: await encodeAsset(code), path: `/assets/app.${hash}.js` };
}

/** One load per PROCESS (a module-level memo, not per createWebuiApp instance),
 * kept for the process lifetime. A failed load is not cached: the failure
 * reaches the request that asked, and the next request loads again. */
function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

// Serve-time bundle of the preact/TSX client (DR-0005 §3): built and compressed
// once, starting when the app is created (see createWebuiApp), then kept in
// memory (no dist/ committed or generated on disk). Process-level (vs per-app) matters
// beyond economy: test suites create many app instances, and concurrent
// Bun.build runs over the client graph have been observed to fail flakily on
// Linux with EBADF/"Unexpected reading file" — one shared build removes that
// surface. A build failure is surfaced as a 500 with the error text — never a
// silent fallback to stale or missing content.
const getBundle = loadOnce(bundleClient);

// The shell is index.html with the bundle's hashed path filled in, so it is
// complete (and compressed) once the bundle is.
const getShell = loadOnce(async () => {
  const [template, bundle] = await Promise.all([
    Bun.file(new URL("index.html", PUBLIC_DIR)).text(),
    getBundle(),
  ]);
  return encodeAsset(template.replace("/assets/app.js", bundle.path));
});

interface StaticFile {
  contentType: string;
  /** null when the file is not there to serve. */
  load: () => Promise<EncodedAsset | null>;
}

function staticFile(file: string, contentType: string): StaticFile {
  return {
    contentType,
    load: loadOnce(async () => {
      const source = Bun.file(new URL(file, PUBLIC_DIR));
      return (await source.exists()) ? encodeAsset(await source.text()) : null;
    }),
  };
}

const STATIC_FILES: ReadonlyMap<string, StaticFile> = new Map([
  ["/app.css", staticFile("app.css", "text/css; charset=utf-8")],
]);

export function createWebuiApp(): WebuiApp {
  // Start reading, building and compressing every asset now, while the daemon
  // starts up, so the first page load waits only for what is left of it
  // (brotli alone takes ~1.7s on the bundle). A request that comes earlier
  // awaits the same load. A failure is dropped here because it is not cached:
  // the request that asks next loads again and gets that failure as its 500.
  for (const load of [getShell, ...Array.from(STATIC_FILES.values(), (f) => f.load)]) {
    load().catch(() => {});
  }

  const app = new Hono();

  app.get("/assets/*", async (c) => {
    try {
      const bundle = await getBundle();
      if (c.req.path !== bundle.path) return c.notFound();
      return encodedResponse(
        bundle.asset,
        c.req.raw,
        {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
        { etag: false },
      );
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
    const staticEntry = STATIC_FILES.get(c.req.path);
    if (staticEntry) {
      const asset = await staticEntry.load();
      if (asset === null) return c.notFound();
      return encodedResponse(
        asset,
        c.req.raw,
        { "content-type": staticEntry.contentType },
        { etag: false },
      );
    }

    let shell: EncodedAsset;
    try {
      shell = await getShell();
    } catch (err) {
      // Same surfacing as /assets/*: a build failure must reach the person
      // looking at the browser as its own text, not as Hono's bare
      // "Internal Server Error" — that opaque page is exactly what made a
      // missing-node_modules cache (plugin installs don't run bun install)
      // cost a debugging session instead of a glance.
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`webui failed to serve the app shell:\n\n${message}`, 500);
    }
    return encodedResponse(
      shell,
      c.req.raw,
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      { etag: true },
    );
  });

  return app;
}
