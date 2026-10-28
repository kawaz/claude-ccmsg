// The origins the webui is opened at from elsewhere (http.ts webuiUrlsOf),
// which the ping answers as `webui_urls` (the webui's endpoint choices,
// DR-0043 §7) and whose first is `webui_url`, the hooks module's `ccmsg_url`
// in the agent's guidance (DR-0039 §5).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { webuiUrlsOf } from "../src/http.ts";
import { startTestDaemon, stopTestDaemon, userConn } from "./helpers.ts";

describe("webuiUrlsOf", () => {
  test("the trusted origins in order, the env and tailscale ones before the file's", () => {
    expect(webuiUrlsOf(["https://ccmsg.a.example.com"], ["https://ccmsg.b.example.com"])).toEqual([
      "https://ccmsg.a.example.com",
      "https://ccmsg.b.example.com",
    ]);
    expect(webuiUrlsOf([], ["https://ccmsg.b.example.com", "https://c.example.com:8443"])).toEqual([
      "https://ccmsg.b.example.com",
      "https://c.example.com:8443",
    ]);
  });

  // Loopback origins (a dev server, this machine's own names) are not where
  // the webui is opened from elsewhere, and what is not an origin is no URL.
  test("passes over loopback origins and what is not an http(s) origin", () => {
    expect(
      webuiUrlsOf(
        [
          "http://localhost:5173",
          "http://127.0.0.1:8642",
          "http://[::1]:8642",
          "null",
          "https://ccmsg.example.com/path",
          "ftp://files.example.com",
          "ws://ccmsg.example.com",
        ],
        ["http://ccmsg.lan.example.com:8080"],
      ),
    ).toEqual(["http://ccmsg.lan.example.com:8080"]);
  });

  // The env and the file may both name the origin a person set up twice; it
  // is one place to move to, and it keeps the position it was trusted at first.
  test("an origin named twice comes once, where it came first", () => {
    expect(
      webuiUrlsOf(
        ["https://ccmsg.b.example.com", "https://ccmsg.a.example.com"],
        [
          "https://ccmsg.a.example.com",
          "https://ccmsg.c.example.com",
          "https://ccmsg.b.example.com",
        ],
      ),
    ).toEqual([
      "https://ccmsg.b.example.com",
      "https://ccmsg.a.example.com",
      "https://ccmsg.c.example.com",
    ]);
  });

  test("none when nothing but loopback is trusted", () => {
    expect(webuiUrlsOf([], [])).toEqual([]);
    expect(webuiUrlsOf(["http://localhost:5173"], [])).toEqual([]);
  });
});

describe("ping's webui_url and webui_urls", () => {
  const NO_TAILSCALE = { CCMSG_TAILSCALE_BIN: "/nonexistent/definitely-not-a-tailscale-binary" };

  test("names the trusted proxy origins, read when asked", async () => {
    const ctx = await startTestDaemon({ CCMSG_HTTP_BIND: "127.0.0.1:0", ...NO_TAILSCALE });
    try {
      const c = await userConn(ctx);
      const before = await c.requestOk({ op: "ping" });
      expect(before.webui_url).toBeUndefined();
      expect(before.webui_urls).toEqual([]);
      // `ccmsg origins add` writes the file; the next ping reads it.
      fs.writeFileSync(
        path.join(ctx.configDir, "allowed-origins.json"),
        JSON.stringify(["https://ccmsg.host.example.com", "https://ccmsg.v6.example.com"]),
      );
      const after = await c.requestOk({ op: "ping" });
      expect(after.webui_url).toBe("https://ccmsg.host.example.com");
      expect(after.webui_urls).toEqual([
        "https://ccmsg.host.example.com",
        "https://ccmsg.v6.example.com",
      ]);
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("the env origin comes first, and an origin the file repeats comes once", async () => {
    const ctx = await startTestDaemon({
      CCMSG_HTTP_BIND: "127.0.0.1:0",
      CCMSG_HTTP_ALLOW_ORIGIN: "http://localhost:5173, https://ccmsg.env.example.com",
      ...NO_TAILSCALE,
    });
    try {
      fs.writeFileSync(
        path.join(ctx.configDir, "allowed-origins.json"),
        JSON.stringify(["https://ccmsg.file.example.com", "https://ccmsg.env.example.com"]),
      );
      const c = await userConn(ctx);
      const pong = await c.requestOk({ op: "ping" });
      expect(pong.webui_url).toBe("https://ccmsg.env.example.com");
      expect(pong.webui_urls).toEqual([
        "https://ccmsg.env.example.com",
        "https://ccmsg.file.example.com",
      ]);
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // webui_url is the list's first by construction, in each shape the list can
  // take: only loopback trusted, nothing trusted, a repeat, only the file.
  test("webui_url is always the first of webui_urls", async () => {
    const cases: { env?: string; file?: string[] }[] = [
      { env: "http://localhost:5173, http://127.0.0.1:9000" },
      {},
      { env: "https://ccmsg.a.example.com", file: ["https://ccmsg.a.example.com"] },
      { file: ["https://ccmsg.file.example.com", "http://ccmsg.lan.example.com:8080"] },
    ];
    for (const { env, file } of cases) {
      const ctx = await startTestDaemon({
        CCMSG_HTTP_BIND: "127.0.0.1:0",
        ...(env !== undefined ? { CCMSG_HTTP_ALLOW_ORIGIN: env } : {}),
        ...NO_TAILSCALE,
      });
      try {
        if (file !== undefined) {
          fs.writeFileSync(path.join(ctx.configDir, "allowed-origins.json"), JSON.stringify(file));
        }
        const c = await userConn(ctx);
        const pong = await c.requestOk({ op: "ping" });
        expect(pong.webui_urls).toBeDefined();
        expect(pong.webui_url).toBe(pong.webui_urls?.[0]);
        c.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    }
  });

  // No HTTP listener serves the webui, so no proxy in front of one does.
  test("none while HTTP is off", async () => {
    const ctx = await startTestDaemon({ CCMSG_HTTP_ALLOW_ORIGIN: "https://ccmsg.env.example.com" });
    try {
      const c = await userConn(ctx);
      const pong = await c.requestOk({ op: "ping" });
      expect(pong.webui_url).toBeUndefined();
      expect(pong.webui_urls).toEqual([]);
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });
});
