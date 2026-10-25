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
  /** The entry the shell loads. The chunks it imports are its siblings under /assets/. */
  path: string;
  /** Every output of the build (entry and chunks) by the path it is served at. */
  assets: ReadonlyMap<string, EncodedAsset>;
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
    // Dynamic imports become chunks the entry fetches when it reaches them,
    // so what the first page load does not run (the syntax highlighter and
    // its grammars, see client/highlight.ts) is not in the first download.
    // The outputs import each other by these names (a chunk imports what it
    // shares with the entry from the entry), so they are served under them
    // unchanged. Bun's [hash] is derived from the output's content, which
    // includes the names of the chunks it imports, so every output can be
    // served as immutable.
    splitting: true,
    naming: { entry: "app.[hash].[ext]", chunk: "[name]-[hash].[ext]" },
    throw: false,
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const servedAt = (output: Bun.BuildArtifact): string =>
    `/assets/${output.path.slice(output.path.lastIndexOf("/") + 1)}`;
  const entries = result.outputs.filter((output) => output.kind === "entry-point");
  const [entry] = entries;
  if (entry === undefined || entries.length !== 1) {
    throw new Error(`Bun.build produced ${entries.length} entry outputs for the webui client`);
  }
  const assets = new Map(
    await Promise.all(
      result.outputs.map(
        async (output) => [servedAt(output), await encodeAsset(await output.text())] as const,
      ),
    ),
  );
  return { path: servedAt(entry), assets };
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

interface Stylesheet {
  /** Where the shell links it: named by its content, like the bundle. */
  path: string;
  asset: EncodedAsset;
}

// Design rationale: app.css is not given to Bun.build. Bun's CSS bundler
// rewrites the stylesheet (it reports `::highlight()` as an invalid selector
// while keeping it), and the stylesheet is plain CSS that needs no build, so
// it is served as written. Only its name follows the bundle: a hash of its
// content under /assets/, so it is cached as immutable like the bundle and a
// reload of the same version does not fetch it again.
const getStylesheet = loadOnce(async (): Promise<Stylesheet> => {
  const text = await Bun.file(new URL("app.css", PUBLIC_DIR)).text();
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
  return { path: `/assets/app.${hash}.css`, asset: await encodeAsset(text) };
});

// The shell is index.html with the bundle's and the stylesheet's hashed paths
// filled in, so it is complete (and compressed) once both are.
const getShell = loadOnce(async () => {
  const [template, bundle, stylesheet] = await Promise.all([
    Bun.file(new URL("index.html", PUBLIC_DIR)).text(),
    getBundle(),
    getStylesheet(),
  ]);
  return encodeAsset(
    template.replace("/app.css", stylesheet.path).replace("/assets/app.js", bundle.path),
  );
});

/** The asset served at `path` under /assets/, with its content type. */
async function findAsset(
  path: string,
): Promise<{ asset: EncodedAsset; contentType: string } | null> {
  const [bundle, stylesheet] = await Promise.all([getBundle(), getStylesheet()]);
  if (path === stylesheet.path) {
    return { asset: stylesheet.asset, contentType: "text/css; charset=utf-8" };
  }
  const script = bundle.assets.get(path);
  return script === undefined
    ? null
    : { asset: script, contentType: "text/javascript; charset=utf-8" };
}

export function createWebuiApp(): WebuiApp {
  // Start reading, building and compressing every asset now, while the daemon
  // starts up, so the first page load waits only for what is left of it
  // (brotli alone takes ~1.7s on the bundle). A request that comes earlier
  // awaits the same load. A failure is dropped here because it is not cached:
  // the request that asks next loads again and gets that failure as its 500.
  getShell().catch(() => {});

  const app = new Hono();

  app.get("/assets/*", async (c) => {
    try {
      const found = await findAsset(c.req.path);
      if (found === null) return c.notFound();
      return encodedResponse(
        found.asset,
        c.req.raw,
        {
          "content-type": found.contentType,
          "cache-control": "public, max-age=31536000, immutable",
        },
        { etag: false },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`webui assets failed to load:\n\n${message}`, 500);
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
