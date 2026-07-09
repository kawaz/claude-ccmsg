// Outline test for the hono app contract (DR-0004 §4, DR-0005 §3): serves the
// HTML shell, serve-time-bundles the preact/TSX client on first request to
// /assets/app.js, serves static assets, 404s everything else. Full browser/WS
// integration is covered once the daemon mounts this app (out of scope here).
import { describe, expect, test } from "bun:test";
import { createWebuiApp } from "../src/index.ts";

describe("createWebuiApp", () => {
  test("GET / returns the HTML shell", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<title>ccmsg</title>");
    expect(body).toContain('src="/assets/app.js"');
  });

  test("GET /assets/app.js bundles the preact client entry as JS", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    // preact is bundled in (no external <script> import), and the client's
    // own connect-on-load call is present in the output.
    expect(body).toContain("preact");
    expect(body).toContain("hashchange");
  });

  test("GET /assets/app.js is served from an in-memory cache on repeat requests", async () => {
    const app = createWebuiApp();
    const first = await (await app.fetch(new Request("http://localhost/assets/app.js"))).text();
    const second = await (await app.fetch(new Request("http://localhost/assets/app.js"))).text();
    expect(second).toBe(first);
  });

  test("GET /app.css returns the stylesheet as CSS", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/app.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  test("unknown paths 404", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/does-not-exist"));
    expect(res.status).toBe(404);
  });

  test("/ws is not handled by this app (daemon owns it)", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/ws"));
    expect(res.status).toBe(404);
  });
});
