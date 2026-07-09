// Outline test for the hono app contract (DR-0004 §4): serves the HTML shell
// and static assets, 404s everything else. Browser/WS integration is covered
// once the daemon mounts this app (out of scope here).
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
    expect(body).toContain('src="/app.js"');
  });

  test("GET /app.js returns the client entry as JS", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const body = await res.text();
    expect(body).toContain("WsClient");
  });

  test("GET /ws-client.js returns the wire-protocol client as JS", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/ws-client.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const body = await res.text();
    expect(body).toContain("export class WsClient");
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
