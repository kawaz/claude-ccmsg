// Running an svg's script, in a real browser (DR-0067): the 実行 of a ```svg
// block and of an .svg file opens the svg on the sandbox origin in a new tab,
// where its script runs; nothing asks the daemon for a grant before 実行 is
// pressed, and the choice stays on 描画. A user's prompt draws its svg block
// as a figure too and has the same 実行; mermaid and math have none, an .svg
// file the image cannot draw cannot be run, and with no sandbox origin there
// is no 実行 anywhere.
//
// The sandbox origin is the daemon's own (`sandbox_origin_template`), under a
// name no resolver knows: the browser's requests to it are answered by the
// test, which hands them to the daemon's listener with their Host, as the
// reverse proxy in front of a real daemon does. The session is the test's own:
// a hello on the daemon's socket with a transcript the test wrote and a file
// in its cwd. Nothing is sent to a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2e67000-0000-4000-8000-000000000001";
const id = (k: number) => `e2e67000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const SANDBOX_TEMPLATE = "http://ccmsg-files-{gid}.sandbox.test";
const SANDBOX_URL = /^http:\/\/ccmsg-files-[a-z2-7]+\.sandbox\.test\//;

/** Marks its own document once its script runs. */
const SCRIPT = '<script>document.documentElement.setAttribute("data-ran", "yes")</script>';
const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><title>動く図</title><rect width="120" height="40" fill="teal"/>${SCRIPT}</svg>`;
/** No xmlns on the root, as agents tend to write it: drawn with the namespace
 * added, and run with it too. */
const BARE = `<svg width="120" height="40"><title>名前空間の無い図</title><rect width="120" height="40" fill="orange"/>${SCRIPT}</svg>`;
const FILE_FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><title>ファイルの図</title><circle cx="40" cy="40" r="30" fill="purple"/>${SCRIPT}</svg>`;
/** A user's prompt with an svg block: its bubble draws it as a figure (DR-0010
 * §6), so it gets 実行 as a reply's does. */
const USER_FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20"><title>発言の図</title><rect width="60" height="20" fill="gray"/>${SCRIPT}</svg>`;
const PROMPT = ["図で説明して", "", "```svg", USER_FIGURE, "```"].join("\n");
const REPLY = [
  "図です。",
  "",
  "```svg",
  FIGURE,
  "```",
  "",
  "```svg",
  BARE,
  "```",
  "",
  "```mermaid",
  "graph LR; A-->B",
  "```",
  "",
  "```math",
  "e^{i\\pi} + 1 = 0",
  "```",
].join("\n");

/** A drawable svg, and the same bytes made unreadable (`<rect/>` left open):
 * an .svg fixed in place without its size changing. */
const FIXABLE = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect/></svg>';
const FIXABLE_BROKEN = FIXABLE.replace("<rect/>", "<rect >");

let dir: string;
let webui: Webui;
let bare: Webui;
const sessions: TestClient[] = [];

/** A session on `on` whose reply holds REPLY and whose cwd holds fig.svg. */
async function startSession(on: Webui, name: string): Promise<void> {
  const cwd = path.join(dir, name);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "fig.svg"), FILE_FIGURE);
  fs.writeFileSync(path.join(cwd, "broken.svg"), "<svg><rect></svg");
  fs.writeFileSync(path.join(cwd, "other.svg"), FILE_FIGURE);
  // UTF-16 with a BOM: NULs in its head, so the daemon reads it as binary.
  fs.writeFileSync(
    path.join(cwd, "utf16.svg"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(FILE_FIGURE, "utf16le")]),
  );
  for (const engine of BROWSERS) {
    fs.writeFileSync(path.join(cwd, `fixable-${engine.name()}.svg`), FIXABLE_BROKEN);
  }
  const configDir = path.join(on.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: SID, cwd };
  fs.writeFileSync(
    transcript,
    [
      userContentRow(PROMPT, {
        ...head,
        uuid: id(1),
        timestamp: "2020-01-01T00:00:01.000Z",
      }),
      assistantContentRow([textBlock(REPLY)], {
        ...head,
        uuid: id(2),
        timestamp: "2020-01-01T00:00:02.000Z",
      }),
    ]
      .map((r) => `${line(r)}\n`)
      .join(""),
  );
  sessions.push(
    await sessionConn({ sock: on.sock }, SID, {
      cwd,
      transcript_path: transcript,
      config_dir: configDir,
    }),
  );
}

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-svgrun-");
  webui = await startWebui({ config: { sandbox_origin_template: SANDBOX_TEMPLATE } });
  bare = await startWebui();
  await startSession(webui, "with-sandbox");
  await startSession(bare, "no-sandbox");
}, E2E_TIMEOUT_MS);

afterAll(async () => {
  for (const session of sessions) await session.end();
  await webui.stop();
  await bare.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Answers the context's requests to the sandbox origin from the daemon's
 * listener, Host kept. */
async function routeSandbox(context: BrowserContext, on: Webui): Promise<void> {
  const listener = new URL(on.url);
  await context.route(SANDBOX_URL, async (route) => {
    const url = new URL(route.request().url());
    const res = await fetch(`${listener.origin}${url.pathname}${url.search}`, {
      method: route.request().method(),
      headers: { Host: url.host },
    });
    await route.fulfill({
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
}

/** The ops the page has sent the daemon so far. */
function watchOps(page: Page): string[] {
  const ops: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const op = /"op":"([a-z_]+)"/.exec(String(frame.payload))?.[1];
      if (op !== undefined) ops.push(op);
    });
  });
  return ops;
}

const figureOf = (page: Page, alt: string): Locator =>
  page.locator(".md-figure").filter({ has: page.locator(`img[alt="${alt}"]`) });
const tabOf = (scope: Locator, label: string): Locator =>
  scope.locator(`[role=tab]:has(.md-figure-tab-label[data-label="${label}"])`);
/** The labels of a figure box's 描画 / ソース row (mermaid's theme row is
 * another tablist in the same bar). */
async function tabLabels(box: Locator): Promise<string[]> {
  return box
    .getByRole("tablist", { name: "描画 / ソースの切り替え" })
    .locator("[role=tab] .md-figure-tab-label")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-label") ?? ""));
}

/** Presses `press` and waits for the new tab that reaches the sandbox URL
 * (a popup's navigation request has no frame yet, so the tab is found by its
 * URL); returns it once the svg's script has marked its document. */
async function runAndWait(context: BrowserContext, press: () => Promise<void>): Promise<Page> {
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

/** What the run tab holds: its URL's name, the document's type and root. */
async function docOf(tab: Page): Promise<{ name: string; type: string; ns: string | null }> {
  return {
    name: new URL(tab.url()).pathname.split("/").at(-1) ?? "",
    ...(await tab.evaluate(() => ({
      type: document.contentType,
      ns: document.documentElement.namespaceURI,
    }))),
  };
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`running an svg in ${engine.name()}`, () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let ops: string[];
    beforeAll(async () => {
      browser = await engine.launch();
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await routeSandbox(context, webui);
      page = await context.newPage();
      ops = watchOps(page);
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await figureOf(page, "動く図").waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "a ```svg block has 描画 | ソース | 実行, and no grant is asked for before 実行",
      async () => {
        const figure = figureOf(page, "動く図");
        expect(await tabLabels(figure)).toEqual(["描画", "ソース", "実行"]);
        expect(ops.filter((op) => op.startsWith("sandbox_"))).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "実行 opens the svg on the sandbox origin, its script runs there, and the choice stays on 描画",
      async () => {
        const figure = figureOf(page, "動く図");
        const tab = await runAndWait(context, () => tabOf(figure, "実行").click());
        expect(await docOf(tab)).toEqual({
          name: "figure.svg",
          type: "image/svg+xml",
          ns: "http://www.w3.org/2000/svg",
        });
        expect(ops.filter((op) => op.startsWith("sandbox_"))).toEqual(["sandbox_grant_svg"]);
        expect(await tabOf(figure, "描画").getAttribute("aria-selected")).toBe("true");
        expect(await figure.locator("img.md-figure-img").count()).toBe(1);
        // The webui's own document ran nothing of it.
        expect(await page.evaluate(() => document.querySelector("[data-ran]"))).toBeNull();
        await tab.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a block without xmlns runs as the svg it is drawn as",
      async () => {
        const figure = figureOf(page, "名前空間の無い図");
        const tab = await runAndWait(context, () => tabOf(figure, "実行").click());
        expect((await docOf(tab)).ns).toBe("http://www.w3.org/2000/svg");
        await tab.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a user's prompt runs its svg block the same way",
      async () => {
        const figure = page.locator(".tl-bubble-right").locator(".md-figure");
        expect(await tabLabels(figure)).toEqual(["描画", "ソース", "実行"]);
        const tab = await runAndWait(context, () => tabOf(figure, "実行").click());
        expect((await docOf(tab)).name).toBe("figure.svg");
        await tab.close();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "mermaid and math have no 実行",
      async () => {
        // The prompt's svg block, then the reply's two svg blocks, the mermaid
        // and the math each have a box, in the Timeline's order.
        const boxes = page.locator(".md-figure");
        expect(await boxes.count()).toBe(5);
        const all = await Promise.all((await boxes.all()).map(tabLabels));
        expect(all).toEqual([
          ["描画", "ソース", "実行"],
          ["描画", "ソース", "実行"],
          ["描画", "ソース", "実行"],
          ["描画", "ソース"],
          ["描画", "ソース"],
        ]);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "an .svg file has 描画 | ソース | 実行; ソース is its text, 実行 runs it and keeps the choice",
      async () => {
        const files = await context.newPage();
        const fileOps = watchOps(files);
        await files.goto(`${webui.url}s/${SID}/files?path=fig.svg`);
        const toggle = files.getByRole("tablist", { name: "表示モード" });
        await toggle.waitFor();
        expect(await toggle.getByRole("tab").allTextContents()).toEqual(["描画", "ソース", "実行"]);
        await files.locator("img.viewer-image").waitFor();
        expect(fileOps.filter((op) => op.startsWith("sandbox_"))).toEqual([]);

        await toggle.getByRole("tab", { name: "ソース" }).click();
        await files.locator("pre.viewer-body").waitFor();
        expect(await files.locator("pre.viewer-body").textContent()).toContain(
          "<title>ファイルの図</title>",
        );

        const tab = await runAndWait(context, () =>
          toggle.getByRole("tab", { name: "実行" }).click(),
        );
        expect(await docOf(tab)).toEqual({
          name: "fig.svg",
          type: "image/svg+xml",
          ns: "http://www.w3.org/2000/svg",
        });
        expect(fileOps.filter((op) => op.startsWith("sandbox_"))).toEqual(["sandbox_grant"]);
        expect(
          await toggle.getByRole("tab", { name: "ソース" }).getAttribute("aria-selected"),
        ).toBe("true");
        await toggle.getByRole("tab", { name: "描画" }).click();
        await files.locator("img.viewer-image").waitFor();
        await tab.close();
        await files.close();
      },
      E2E_TIMEOUT_MS,
    );
  });

  describe.skipIf(skipsEngine(engine))(
    `an .svg file that cannot be drawn, in ${engine.name()}`,
    () => {
      let browser: Browser;
      let page: Page;
      beforeAll(async () => {
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      test(
        "its 実行 cannot be pressed once the image fails, and says why",
        async () => {
          await page.goto(`${webui.url}s/${SID}/files?path=broken.svg`);
          const run = page
            .getByRole("tablist", { name: "表示モード" })
            .locator('[role=tab][aria-disabled="true"]');
          await run.waitFor();
          expect(await run.textContent()).toBe("実行");
          expect(await run.getAttribute("title")).toBe("この SVG は描画できないので実行できない");
        },
        E2E_TIMEOUT_MS,
      );
    },
  );

  describe.skipIf(skipsEngine(engine))(`the .svg file viewer's choice, in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    const IN_VIEW = ".session-tab-panel:not([hidden])";
    const toggle = () => page.locator(IN_VIEW).getByRole("tablist", { name: "表示モード" });
    const tabNamed = (name: string) =>
      toggle()
        .locator(`[role=tab]`)
        .filter({ hasText: new RegExp(`^${name}$`) });

    test(
      "a file read as binary keeps 描画 | ソース | 実行, and its ソース says why it cannot be shown",
      async () => {
        await page.goto(`${webui.url}s/${SID}/files?path=utf16.svg`);
        await toggle().waitFor();
        // Pressed as a person would, though it reads as not pressable
        // (Playwright waits for an aria-disabled element to be enabled).
        await tabNamed("ソース").click({ force: true });
        // Still the image's view, the three sections still there.
        await page.locator(`${IN_VIEW} img.viewer-image`).waitFor();
        expect(await toggle().locator("[role=tab]").allTextContents()).toEqual([
          "描画",
          "ソース",
          "実行",
        ]);
        expect(await tabNamed("ソース").getAttribute("aria-disabled")).toBe("true");
        expect(await tabNamed("ソース").getAttribute("title")).toBe(
          "このファイルはバイナリなのでソースを表示できない",
        );
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a broken file fixed in place at the same size draws again on ↻, and its 実行 can be pressed",
      async () => {
        const name = `fixable-${engine.name()}.svg`;
        await page.goto(`${webui.url}s/${SID}/files?path=${name}`);
        await toggle().locator('[role=tab][aria-disabled="true"]').waitFor();
        fs.writeFileSync(path.join(dir, "with-sandbox", name), FIXABLE);
        await page.getByRole("button", { name: "ファイルを再取得" }).click();
        await toggle()
          .locator("button[role=tab]")
          .filter({ hasText: /^実行$/ })
          .waitFor();
        expect(
          await page
            .locator(`${IN_VIEW} img.viewer-image`)
            .evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)),
        ).toBeGreaterThan(0);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "ソース on one file, another file, then back: it is on 描画 again",
      async () => {
        await page.goto(`${webui.url}s/${SID}/files?path=fig.svg`);
        await tabNamed("ソース").click();
        await page.locator(`${IN_VIEW} pre.viewer-body`).waitFor();
        const tree = page.locator(`${IN_VIEW} .file-tree`);
        await tree.getByText("other.svg", { exact: true }).click();
        await page.locator(`${IN_VIEW} .viewer-path`).filter({ hasText: "other.svg" }).waitFor();
        await tree.getByText("fig.svg", { exact: true }).click();
        await page.locator(`${IN_VIEW} .viewer-path`).filter({ hasText: "fig.svg" }).waitFor();
        await page.locator(`${IN_VIEW} img.viewer-image`).waitFor();
        expect(await tabNamed("描画").getAttribute("aria-selected")).toBe("true");
        expect(await page.locator(`${IN_VIEW} pre.viewer-body`).count()).toBe(0);
      },
      E2E_TIMEOUT_MS,
    );
  });

  describe.skipIf(skipsEngine(engine))(`no sandbox origin, in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${bare.url}s/${SID}/timeline/head`);
      await figureOf(page, "動く図").waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "a ```svg block has 描画 | ソース only",
      async () => {
        expect(await tabLabels(figureOf(page, "動く図"))).toEqual(["描画", "ソース"]);
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "an .svg file has 描画 | ソース only",
      async () => {
        await page.goto(`${bare.url}s/${SID}/files?path=fig.svg`);
        const toggle = page.getByRole("tablist", { name: "表示モード" });
        await toggle.waitFor();
        expect(await toggle.getByRole("tab").allTextContents()).toEqual(["描画", "ソース"]);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
