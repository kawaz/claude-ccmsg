// How a sandbox-origin URL is opened (DR-0030 §7.2, DR-0067 §3), in a real
// browser: the preview of an .html file (「HTML として開く」) and the 実行 of a
// ```svg block each add exactly one tab, the one holding the sandbox URL, and
// leave no about:blank behind. The opened document has no opener, so it cannot
// reach the webui's document, and it learns nothing of where it was opened
// from (no Referer, an empty document.referrer). When the grant is refused, or
// its answer does not come in time, the tab opened for it is closed again.
//
// The sandbox origin is the daemon's own, answered by the test as in
// svg-run.e2e.ts. The session is the test's own: a hello on the daemon's
// socket with a transcript the test wrote and files in its cwd.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { SANDBOX_GRANT_REPLY_TIMEOUT_MS } from "../src/client/ws.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2e30000-0000-4000-8000-000000000072";
const id = (k: number) => `e2e30000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const SANDBOX_TEMPLATE = "http://ccmsg-files-{gid}.sandbox.test";
const SANDBOX_URL = /^http:\/\/ccmsg-files-[a-z2-7]+\.sandbox\.test\//;

/** Marks its own document with what it can see of where it was opened from,
 * and tries to mark the webui's document through its opener. */
const PROBE = [
  "const root = document.documentElement;",
  'root.setAttribute("data-opener", String(window.opener === null ? "none" : "some"));',
  'root.setAttribute("data-referrer", document.referrer);',
  'try { window.opener.document.documentElement.setAttribute("data-touched", "yes"); } catch {}',
  'root.setAttribute("data-ran", "yes");',
].join(" ");
const PAGE = `<!doctype html><title>preview</title><script>${PROBE}</script>`;
const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><title>開き方の図</title><rect width="60" height="20" fill="teal"/><script>${PROBE}</script></svg>`;
const REPLY = ["```svg", FIGURE, "```"].join("\n");

let dir: string;
let cwd: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-sbxopen-");
  webui = await startWebui({ config: { sandbox_origin_template: SANDBOX_TEMPLATE } });
  cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "page.html"), PAGE);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: SID, cwd };
  fs.writeFileSync(
    transcript,
    [
      userContentRow("図で", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
      assistantContentRow([textBlock(REPLY)], {
        ...head,
        uuid: id(2),
        timestamp: "2020-01-01T00:00:02.000Z",
      }),
    ]
      .map((r) => `${line(r)}\n`)
      .join(""),
  );
  session = await sessionConn({ sock: webui.sock }, SID, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
}, E2E_TIMEOUT_MS);

afterAll(async () => {
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Answers the context's requests to the sandbox origin from the daemon's
 * listener, Host kept, and records the Referer each navigation carried
 * (null for none). */
async function routeSandbox(context: BrowserContext, referers: (string | null)[]): Promise<void> {
  const listener = new URL(webui.url);
  await context.route(SANDBOX_URL, async (route) => {
    const request = route.request();
    if (request.isNavigationRequest()) referers.push(request.headers()["referer"] ?? null);
    const url = new URL(request.url());
    const res = await fetch(`${listener.origin}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { Host: url.host },
    });
    await route.fulfill({
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
}

/** Presses `press` and waits for the new tab that reaches the sandbox URL
 * and has run its script (a popup's navigation request has no frame yet, so
 * the tab is found by its URL). */
async function openAndWait(context: BrowserContext, press: () => Promise<void>): Promise<Page> {
  let onPage: (page: Page) => void = () => {};
  const reached = new Promise<Page>((resolve) => {
    onPage = (page) => {
      page.waitForURL(SANDBOX_URL).then(
        () => resolve(page),
        () => {},
      );
    };
  });
  context.on("page", onPage);
  try {
    await press();
    const tab = await reached;
    await tab.waitForFunction(() => document.documentElement.getAttribute("data-ran") === "yes");
    return tab;
  } finally {
    context.off("page", onPage);
  }
}

/** What the opened document saw. */
async function probeOf(tab: Page): Promise<{ opener: string | null; referrer: string | null }> {
  return tab.evaluate(() => ({
    opener: document.documentElement.getAttribute("data-opener"),
    referrer: document.documentElement.getAttribute("data-referrer"),
  }));
}

/** Settles once the next tab the context opens has closed. Its close may
 * come before the page event reaches the test, so a tab already closed by
 * then counts. */
function nextTabClosed(context: BrowserContext): Promise<void> {
  return context.waitForEvent("page").then(async (tab) => {
    if (!tab.isClosed()) await tab.waitForEvent("close");
  });
}

const runTab = (page: Page) =>
  page
    .locator(".md-figure")
    .filter({ has: page.locator('img[alt="開き方の図"]') })
    .locator('[role=tab]:has(.md-figure-tab-label[data-label="実行"])');

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`opening a sandbox URL in ${engine.name()}`, () => {
    let browser: Browser;
    let context: BrowserContext;
    let referers: (string | null)[];
    beforeAll(async () => {
      browser = await engine.launch();
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      referers = [];
      await routeSandbox(context, referers);
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    /** Opens via `press` on `page` and checks the one-tab, no-opener,
     * no-referrer facts; closes the opened tab. */
    async function opensOneTab(page: Page, press: () => Promise<void>): Promise<void> {
      const before = context.pages().length;
      referers.length = 0;
      const tab = await openAndWait(context, press);
      expect(context.pages().map((p) => p.url())).not.toContain("about:blank");
      expect(context.pages()).toHaveLength(before + 1);
      expect(await probeOf(tab)).toEqual({ opener: "none", referrer: "" });
      expect(referers).toEqual([null]);
      expect(await page.evaluate(() => document.querySelector("[data-touched]"))).toBeNull();
      await tab.close();
    }

    test(
      "「HTML として開く」 adds one tab, with no opener and no referrer",
      async () => {
        const page = await context.newPage();
        await page.goto(`${webui.url}s/${SID}/files?path=page.html`);
        const button = page.getByRole("button", { name: "HTML として開く" });
        await button.waitFor();
        await opensOneTab(page, () => button.click());
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "an svg block's 実行 adds one tab, with no opener and no referrer",
      async () => {
        const page = await context.newPage();
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        await runTab(page).waitFor();
        await opensOneTab(page, () => runTab(page).click());
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a refused preview grant closes the tab it opened",
      async () => {
        const name = `gone-${engine.name()}.html`;
        fs.writeFileSync(path.join(cwd, name), PAGE);
        const page = await context.newPage();
        await page.goto(`${webui.url}s/${SID}/files?path=${name}`);
        const button = page.getByRole("button", { name: "HTML として開く" });
        await button.waitFor();
        // The grant re-reads the file, so a file gone since it was shown is
        // refused (not_found).
        fs.rmSync(path.join(cwd, name));
        const before = context.pages().length;
        const closed = nextTabClosed(context);
        await button.click();
        await closed;
        expect(context.pages()).toHaveLength(before);
        await page.locator(".viewer-banner").filter({ hasText: /./ }).last().waitFor();
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a refused svg grant closes the tab it opened",
      async () => {
        const page = await context.newPage();
        // Make the daemon refuse: the text on its way out is swapped for one
        // over the limit, so the op answers invalid_args.
        await page.routeWebSocket(/\/ws$/, (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((message) =>
            server.send(
              typeof message === "string" && message.includes('"op":"sandbox_grant_svg"')
                ? message.replace(
                    /"content":"(?:[^"\\]|\\.)*"/,
                    `"content":"${"a".repeat(600 * 1024)}"`,
                  )
                : message,
            ),
          );
          server.onMessage((message) => ws.send(message));
        });
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        await runTab(page).waitFor();
        const before = context.pages().length;
        const closed = nextTabClosed(context);
        await runTab(page).click();
        await closed;
        expect(context.pages()).toHaveLength(before);
        await page.locator(".md-figure-note-error").waitFor();
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a grant whose answer never comes closes the tab it opened, once its wait runs out",
      async () => {
        const page = await context.newPage();
        // The connection stays open, but the grant never reaches the daemon.
        await page.routeWebSocket(/\/ws$/, (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((message) => {
            if (typeof message === "string" && message.includes('"op":"sandbox_grant_svg"')) return;
            server.send(message);
          });
          server.onMessage((message) => ws.send(message));
        });
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        await runTab(page).waitFor();
        const before = context.pages().length;
        const closed = nextTabClosed(context);
        await runTab(page).click();
        await closed;
        expect(context.pages()).toHaveLength(before);
        expect(await page.locator(".md-figure-note-error").textContent()).toBe(
          `no reply within ${String(SANDBOX_GRANT_REPLY_TIMEOUT_MS)} ms`,
        );
        await page.close();
      },
      E2E_TIMEOUT_MS,
    );
  });
}
