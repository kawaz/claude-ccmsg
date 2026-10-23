// The URL the webui is opened at from elsewhere (http.ts webuiUrlOf), which
// the ping answers as `webui_url` and the hooks module puts in the agent's
// guidance as `ccmsg_host` (DR-0039 §5).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { webuiUrlOf } from "../src/http.ts";
import { startTestDaemon, stopTestDaemon, userConn } from "./helpers.ts";

describe("webuiUrlOf", () => {
  test("the first trusted origin, the env and tailscale ones before the file's", () => {
    expect(webuiUrlOf(["https://ccmsg.a.example.com"], ["https://ccmsg.b.example.com"])).toBe(
      "https://ccmsg.a.example.com",
    );
    expect(webuiUrlOf([], ["https://ccmsg.b.example.com", "https://c.example.com:8443"])).toBe(
      "https://ccmsg.b.example.com",
    );
  });

  // Loopback origins (a dev server, this machine's own names) are not where
  // the webui is opened from elsewhere, and what is not an origin is no URL.
  test("passes over loopback origins and what is not an http(s) origin", () => {
    expect(
      webuiUrlOf(
        [
          "http://localhost:5173",
          "http://127.0.0.1:8642",
          "http://[::1]:8642",
          "null",
          "https://ccmsg.example.com/path",
          "ftp://files.example.com",
        ],
        ["http://ccmsg.lan.example.com:8080"],
      ),
    ).toBe("http://ccmsg.lan.example.com:8080");
  });

  test("none when nothing but loopback is trusted", () => {
    expect(webuiUrlOf([], [])).toBeUndefined();
    expect(webuiUrlOf(["http://localhost:5173"], [])).toBeUndefined();
  });
});

describe("ping's webui_url", () => {
  const NO_TAILSCALE = { CCMSG_TAILSCALE_BIN: "/nonexistent/definitely-not-a-tailscale-binary" };

  test("names the trusted proxy origin, read when asked", async () => {
    const ctx = await startTestDaemon({ CCMSG_HTTP_BIND: "127.0.0.1:0", ...NO_TAILSCALE });
    try {
      const c = await userConn(ctx);
      expect((await c.requestOk({ op: "ping" })).webui_url).toBeUndefined();
      // `ccmsg origins add` writes the file; the next ping reads it.
      fs.writeFileSync(
        path.join(ctx.configDir, "allowed-origins.json"),
        JSON.stringify(["https://ccmsg.host.example.com"]),
      );
      expect((await c.requestOk({ op: "ping" })).webui_url).toBe("https://ccmsg.host.example.com");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("the env origin comes first", async () => {
    const ctx = await startTestDaemon({
      CCMSG_HTTP_BIND: "127.0.0.1:0",
      CCMSG_HTTP_ALLOW_ORIGIN: "http://localhost:5173, https://ccmsg.env.example.com",
      ...NO_TAILSCALE,
    });
    try {
      fs.writeFileSync(
        path.join(ctx.configDir, "allowed-origins.json"),
        JSON.stringify(["https://ccmsg.file.example.com"]),
      );
      const c = await userConn(ctx);
      expect((await c.requestOk({ op: "ping" })).webui_url).toBe("https://ccmsg.env.example.com");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // No HTTP listener serves the webui, so no proxy in front of one does.
  test("none while HTTP is off", async () => {
    const ctx = await startTestDaemon({ CCMSG_HTTP_ALLOW_ORIGIN: "https://ccmsg.env.example.com" });
    try {
      const c = await userConn(ctx);
      expect((await c.requestOk({ op: "ping" })).webui_url).toBeUndefined();
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });
});
