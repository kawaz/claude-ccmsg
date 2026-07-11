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

async function bundleClient(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [CLIENT_ENTRY.pathname],
    target: "browser",
    tsconfig: CLIENT_TSCONFIG.pathname,
    // Serve-time build ships to a real browser, so minify like a production
    // bundle: with @mizchi/markdown's unminified 456KB parser on board this is
    // the difference between ~74KB and ~40KB gzip for the whole app.js.
    minify: true,
    throw: false,
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const output = result.outputs[0];
  if (!output) throw new Error("Bun.build produced no output for the webui client entry");
  return output.text();
}

export function createWebuiApp(): WebuiApp {
  const app = new Hono();

  // Serve-time bundle of the preact/TSX client (DR-0005 §3): built once per
  // process on the first `/assets/app.js` request, then kept in memory for
  // the process lifetime (no dist/ committed or generated on disk). A build
  // failure is surfaced as a 500 with the error text — never a silent
  // fallback to stale or missing content — and is not cached, so the next
  // request retries the build.
  let bundlePromise: Promise<string> | null = null;
  function getBundle(): Promise<string> {
    bundlePromise ??= bundleClient().catch((err: unknown) => {
      bundlePromise = null;
      throw err;
    });
    return bundlePromise;
  }

  app.get("/assets/app.js", async (c) => {
    try {
      const code = await getBundle();
      return new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`webui client build failed:\n\n${message}`, 500);
    }
  });

  app.get("*", async (c) => {
    const asset = ASSETS[c.req.path];
    if (!asset) return c.notFound();
    const file = Bun.file(new URL(asset.file, PUBLIC_DIR));
    if (!(await file.exists())) return c.notFound();
    return new Response(file, { headers: { "content-type": asset.contentType } });
  });

  return app;
}
