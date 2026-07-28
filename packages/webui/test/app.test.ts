import { describe, expect, test } from "bun:test";
import { createWebuiApp } from "../src/index.ts";
import { isUnknownAppPath } from "../src/client/utils.ts";

async function shellAndBundlePath(): Promise<{
  app: ReturnType<typeof createWebuiApp>;
  path: string;
}> {
  const app = createWebuiApp();
  const body = await (await app.fetch(new Request("http://localhost/"))).text();
  const path = body.match(/src="([^"]+)"/)?.[1];
  if (!path) throw new Error("shell did not contain a script src");
  return { app, path };
}

describe("createWebuiApp", () => {
  test("the shell points at a content-hashed bundle and requires revalidation", async () => {
    const { app, path } = await shellAndBundlePath();
    expect(path).toMatch(/^\/assets\/app\.[0-9a-f]{16}\.js$/);
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const etag = res.headers.get("etag");
    expect(etag).not.toBeNull();
    const revalidated = await app.fetch(
      new Request("http://localhost/s/s1/status", { headers: { "if-none-match": etag! } }),
    );
    expect(revalidated.status).toBe(304);
  });

  test("the hashed bundle is immutable and an unrecognized hash is not executable", async () => {
    const { app, path } = await shellAndBundlePath();
    const res = await app.fetch(new Request(`http://localhost${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = await res.text();
    expect(body).toContain("ccmsg.since");
    expect(body).toContain("navigate");

    const missing = await app.fetch(new Request("http://localhost/assets/app.deadbeefdeadbeef.js"));
    expect(missing.status).toBe(404);
  });

  test("GET /app.css returns the stylesheet as CSS", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request("http://localhost/app.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  test("real SPA paths and unknown paths both serve the recoverable shell", async () => {
    const app = createWebuiApp();
    for (const path of ["/s/s1/files?path=a.ts", "/r/r1/m4", "/does-not-exist"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});

describe("isUnknownAppPath", () => {
  test("root, session tabs, agent timelines, and room messages are known", () => {
    for (const path of [
      "/",
      "/index.html",
      "/s/s1",
      "/s/s1/files",
      "/s/s1/timeline/head",
      "/s/s1/timeline/agent/sub/a1",
      "/s/s1/terminal",
      "/s/s1/status",
      "/s/s1/rooms",
      "/r/r1",
      "/r/r1/m42",
    ]) {
      expect(isUnknownAppPath(path)).toBe(false);
    }
  });

  test("non-app and malformed paths are unknown", () => {
    for (const path of ["/fixtures/a.json", "/does-not-exist", "/s/s1/nope", "/r/r1/nope"]) {
      expect(isUnknownAppPath(path)).toBe(true);
    }
  });
});
