// hono app for the ccmsg webui (DR-0004 §4). The daemon mounts this at every
// path except `/ws`; this package never touches the socket/WS layer itself,
// only serves the HTML shell + static vanilla-ESM client that talks to `/ws`.
import { Hono } from "hono";

// Static assets are read straight off disk (no bundler, DR-0004 §4) so `bun run`
// works unmodified whether this package is loaded from source or from a plugin
// install. Resolve relative to this module, not process.cwd().
const PUBLIC_DIR = new URL("./public/", import.meta.url);

interface Asset {
  file: string;
  contentType: string;
}

const ASSETS: Record<string, Asset> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/ws-client.js": { file: "ws-client.js", contentType: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", contentType: "text/css; charset=utf-8" },
};

export interface WebuiApp {
  fetch(req: Request): Response | Promise<Response>;
}

export function createWebuiApp(): WebuiApp {
  const app = new Hono();

  app.get("*", async (c) => {
    const asset = ASSETS[c.req.path];
    if (!asset) return c.notFound();
    const file = Bun.file(new URL(asset.file, PUBLIC_DIR));
    if (!(await file.exists())) return c.notFound();
    return new Response(file, { headers: { "content-type": asset.contentType } });
  });

  return app;
}
