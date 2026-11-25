// The webui's shell is the webui itself. In an iframe of another site's page
// it would run, open /ws with the webui's own Origin (which the daemon
// admits), and act on the clicks it gets while the page around it decides
// what the person sees. So no page may frame it (`frame-ancestors 'none'` on
// the shell): put in another site's iframe, the shell is not shown and opens
// no WebSocket. That header says who may frame the shell, not what the shell
// may frame: the webui's own iframe (the Terminal tab's gateway page, of
// another origin) still loads.
//
// The other site is this test's own server on `localhost` (the webui is on
// `127.0.0.1`, another site). It serves the page that frames the shell and
// the stand-in of the terminal gateway's embed page. The session is the
// test's own: a hello on the daemon's socket, a record of this test's process
// in a config dir of the test's (with the daemon's process registry polling
// it, so the session has a process row), and a run that names a terminal, as
// a session's hooks module does. Nothing reaches a Claude Code session or a
// terminal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ef0000-0000-4000-8000-000000000002";
const HYOUI = "hy-e2e-framing";
const GATEWAY_TEXT = "terminal gateway stand-in";

let dir: string;
let webui: Webui;
let other: ReturnType<typeof Bun.serve>;
let session: TestClient;

/** The other site's origin. */
const otherOrigin = () => `http://localhost:${String(other.port)}`;

beforeAll(async () => {
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/frame") {
        const src = url.searchParams.get("src") ?? "";
        return new Response(`<!doctype html><iframe id="framed" src="${src}"></iframe>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === `/sessions/${HYOUI}`) {
        return new Response(`<!doctype html><p>${GATEWAY_TEXT}</p>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  dir = shortTmpDir("ccmsg-e2e-frame-");
  const configDir = path.join(dir, "claude");
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  fs.mkdirSync(cwd);
  // The session's process is this test's: alive for as long as it runs.
  fs.writeFileSync(
    path.join(configDir, "sessions", `${String(process.pid)}.json`),
    JSON.stringify({
      kind: "interactive",
      startedAt: Date.now(),
      sessionId: SID,
      pid: process.pid,
      cwd,
    }),
  );
  webui = await startWebui({
    config: { terminal_gateway_url: otherOrigin() },
    env: {
      CCMSG_AGENTS_POLL: "on",
      CCMSG_AGENTS_POLL_MS: "150",
      CCMSG_CLAUDE_CONFIG_DIRS: configDir,
    },
  });
  session = await sessionConn({ sock: webui.sock }, SID, { cwd, config_dir: configDir });
  await session.requestOk({
    op: "sidecar_hello",
    run_id: "run1",
    started_at: Date.now(),
    hyoui_session_id: HYOUI,
  });
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await session.end();
  await webui.stop();
  await other.stop(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`shell framing (${engine.name()})`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    // Framed by another site, the shell is refused: once the page (and so its
    // iframe) has loaded, the iframe's document is not the webui (no title
    // "ccmsg"), and no WebSocket has been opened from the page.
    test(
      "another site's iframe does not show the shell, and no /ws is opened",
      async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          let sockets = 0;
          page.on("websocket", () => {
            sockets += 1;
          });
          await page.goto(`${otherOrigin()}/frame?src=${encodeURIComponent(webui.url)}`);
          const framed = await page.locator("#framed").elementHandle();
          const frame = framed === null ? null : await framed.contentFrame();
          const title = frame === null ? "" : await frame.title().catch(() => "");
          expect({ title, sockets }).toEqual({ title: "", sockets: 0 });
        } finally {
          await context.close();
        }
      },
      E2E_TIMEOUT_MS,
    );

    // The webui's own iframe of another origin, the Terminal tab's gateway
    // page, still loads in the shell.
    test(
      "the Terminal tab still shows the gateway page in its iframe",
      async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        try {
          const page = await context.newPage();
          await page.goto(`${webui.url}s/${SID}/terminal`);
          await page.frameLocator(".terminal-iframe").getByText(GATEWAY_TEXT).waitFor();
        } finally {
          await context.close();
        }
      },
      E2E_TIMEOUT_MS,
    );
  });
}
