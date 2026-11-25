// hono app for the ccmsg webui (DR-0004 §4, client architecture per DR-0005).
// The daemon mounts this at every path except `/ws`; this package never
// touches the socket/WS layer itself, only serves the HTML shell + the
// preact/TSX client (bundled at serve time) that talks to `/ws`.
import { Hono } from "hono";
import { encodeAsset, encodedResponse, withBrotli, type EncodedAsset } from "./encoded-asset.ts";
import { findMermaidAsset } from "./mermaid-assets.ts";
import { inlineTemmlFont } from "./temml-font-plugin.ts";

// Static assets (HTML shell, CSS) are read straight off disk, once per process
// (no bundler for these, DR-0004 §4) so `bun run` works unmodified whether this package is
// loaded from source or from a plugin install. Resolve relative to this
// module, not process.cwd().
const PUBLIC_DIR = new URL("./public/", import.meta.url);
const CLIENT_ENTRY = new URL("./client/main.tsx", import.meta.url);
const CLIENT_TSCONFIG = new URL("../tsconfig.json", import.meta.url);

export interface WebuiApp {
  fetch(req: Request): Response | Promise<Response>;
  /** Start reading, building and compressing every asset now, so the first
   * page load waits only for what is left of the bundle and its gzip. The
   * brotli bodies follow (~1.7s), and the requests that come after are
   * answered in br. Resolves once they are made; rejects if the load or the
   * brotli fails (a request that comes next starts the failed part again).
   * For when there is an HTTP listener to serve them on: the build and the
   * compression run on the process's pool of threads, and a process that
   * serves no page should not spend it. */
  prepare(): Promise<void>;
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
    plugins: [inlineTemmlFont],
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
async function loadStylesheet(): Promise<Stylesheet> {
  const text = await Bun.file(new URL("app.css", PUBLIC_DIR)).text();
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
  return { path: `/assets/app.${hash}.css`, asset: await encodeAsset(text) };
}

/** Everything the app serves from memory. */
interface Served {
  /** index.html with the bundle's and the stylesheet's hashed paths filled in. */
  shell: EncodedAsset;
  stylesheet: Stylesheet;
  bundle: ClientBundle;
}

async function loadServed(): Promise<Served> {
  const [template, bundle, stylesheet] = await Promise.all([
    Bun.file(new URL("index.html", PUBLIC_DIR)).text(),
    bundleClient(),
    loadStylesheet(),
  ]);
  const shell = await encodeAsset(
    template.replace("/app.css", stylesheet.path).replace("/assets/app.js", bundle.path),
  );
  return { shell, stylesheet, bundle };
}

// Design rationale: brotli one asset at a time, through node:zlib's callback
// form (off the event loop). At quality 11 it takes ~1.7s over the outputs.
// Started all at once (as gzip is), the async file reads of the process waited
// up to ~300ms meanwhile with a pool of 3 threads (~1s on CI's 3-core
// runner); one at a time they waited under 10ms, and nothing else waits for
// it, since every request is answered in gzip until it is done. A Worker
// running the sync form left the reads as free, at the cost of a thread and a
// module of its own (docs/findings/2026-11-20-webui-brotli-later-pool-wait.md).
async function addBrotli(served: Served): Promise<Served> {
  const shell = await withBrotli(served.shell);
  const stylesheet = { ...served.stylesheet, asset: await withBrotli(served.stylesheet.asset) };
  const assets = new Map<string, EncodedAsset>();
  for (const [path, asset] of served.bundle.assets) assets.set(path, await withBrotli(asset));
  return { shell, stylesheet, bundle: { ...served.bundle, assets } };
}

// Serve-time bundle of the preact/TSX client (DR-0005 §3): built and gzipped
// once, starting when the app is asked to prepare (WebuiApp.prepare) or at the
// first request, then kept in memory (no dist/ committed or generated on
// disk). Process-level (vs per-app) matters beyond economy: test suites create
// many app instances, and concurrent Bun.build runs over the client graph have
// been observed to fail flakily on Linux with EBADF/"Unexpected reading file"
// — one shared build removes that surface. A build failure is surfaced as a
// 500 with the error text — never a silent fallback to stale or missing
// content.
const getServedInGzip = loadOnce(loadServed);

// The same assets with their brotli bodies, made once the gzip ones are there.
// Requests switch to them as a whole: the bodies decode to the same bytes in
// either, so a page that loaded part of its assets in gzip and part in br
// gets one version.
let servedInBrotli: Served | null = null;
const makeBrotli = loadOnce(async () => {
  servedInBrotli = await addBrotli(await getServedInGzip());
});

/** What a request is answered from: in br once that is made, else in gzip
 * (which is what a request before the load waits for), starting the brotli. */
async function served(): Promise<Served> {
  if (servedInBrotli !== null) return servedInBrotli;
  const inGzip = await getServedInGzip();
  // A brotli failure leaves gzip served and is not cached: the request that
  // comes next starts it again. prepare's caller is the one told of it.
  makeBrotli().catch(() => {});
  return servedInBrotli ?? inGzip;
}

/** The asset served at `path` under /assets/, with its content type. */
async function findAsset(
  path: string,
): Promise<{ asset: EncodedAsset; contentType: string } | null> {
  // mermaid の配布物 (DR-0010 §13) は本体の build を待たずに配る。
  const mermaid = await findMermaidAsset(path);
  if (mermaid !== null) return mermaid;
  const { bundle, stylesheet } = await served();
  if (path === stylesheet.path) {
    return { asset: stylesheet.asset, contentType: "text/css; charset=utf-8" };
  }
  const script = bundle.assets.get(path);
  return script === undefined
    ? null
    : { asset: script, contentType: "text/javascript; charset=utf-8" };
}

export function createWebuiApp(): WebuiApp {
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
      shell = (await served()).shell;
    } catch (err) {
      // Same surfacing as /assets/*: a build failure must reach the person
      // looking at the browser as its own text, not as Hono's bare
      // "Internal Server Error" — that opaque page is exactly what made a
      // missing-node_modules cache (plugin installs don't run bun install)
      // cost a debugging session instead of a glance.
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`webui failed to serve the app shell:\n\n${message}`, 500);
    }
    // No page may frame the shell (DR-0004 §3): in another site's iframe the
    // webui would run, open /ws with its own Origin, and act on clicks the
    // page around it steers. Nothing frames it on purpose — the webui's own
    // iframes hold other documents (the Terminal tab's gateway, a
    // sandbox-origin preview) — so not even its own origin is allowed.
    return encodedResponse(
      shell,
      c.req.raw,
      {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy": "frame-ancestors 'none'",
      },
      { etag: true },
    );
  });

  return {
    fetch: (req) => app.fetch(req),
    // A request that comes before the load is done awaits the same load (its
    // gzip part). A failure is not cached: the request that asks next loads
    // again and gets that failure as its 500.
    prepare: () => makeBrotli(),
  };
}
