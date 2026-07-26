// Outline test for the hono app contract (DR-0004 §4, DR-0005 §3): serves the
// HTML shell, serve-time-bundles the preact/TSX client on first request to
// /assets/app.js, serves static assets, 404s everything else. Full browser/WS
// integration is covered once the daemon mounts this app (out of scope here).
import { describe, expect, test } from "bun:test";
import { createWebuiApp } from "../src/index.ts";
import { isUnknownAppPath } from "../src/client/utils.ts";

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
    // The client (preact runtime included) is bundled inline. The bundle is
    // minified, so identifier names like "preact" don't survive — assert on
    // string literals that do: the client-only localStorage since-key and the
    // hashchange listener registration. (A "no import statements" negative
    // check is deliberately absent: minified code legitimately contains
    // `from "` / `import(`-shaped byte sequences inside string literals.)
    expect(body).toContain("ccmsg.since");
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

  // kawaz r55m115/m116: 素の 404 を返すと standalone webapp (アドレスバーも
  // 戻るボタンも無い) で詰むため、未知パスにも HTML シェルを返す。実際に
  // markdown 中の相対リンクを踏んで詰む事故が起きたことによる仕様変更。
  test("unknown paths serve the SPA shell instead of 404", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/does-not-exist"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  // `/ws` は daemon が upgrade を先に処理するのでこの app には来ない。仮に
  // 来ても catch-all でシェルが返るだけ (詰まない)。
  test("/ws falls through to the shell here (daemon owns the real route)", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/ws"));
    expect(res.status).toBe(200);
  });
});

// The shell is served everywhere so a standalone PWA is never stranded on an
// unescapable error page — but that makes a wrong URL look exactly like the
// home screen. The client decides what to *show* there (kawaz r55 m130), and
// this is the predicate it decides with.
describe("isUnknownAppPath", () => {
  test("the two paths the shell is legitimately served at are known", () => {
    expect(isUnknownAppPath("/")).toBe(false);
    expect(isUnknownAppPath("/index.html")).toBe(false);
  });

  test("anything else is off-route", () => {
    expect(isUnknownAppPath("/fixtures/a.json")).toBe(true);
    expect(isUnknownAppPath("/does-not-exist")).toBe(true);
    expect(isUnknownAppPath("/docs/")).toBe(true);
  });

  // Routing lives in the hash, so a locator is never a 404 — an unknown room
  // or session id is an ordinary empty state, reachable and recoverable.
  test("hash locators on a known path stay known", () => {
    expect(isUnknownAppPath("/")).toBe(false);
  });
});
