// Files the daemon serves from the webui's own origin (`/fs-serve`, a file in
// a session's tree; `/attachment/<name>`, an uploaded or kept attachment) are
// written by a person or an agent, so their contents are not trusted. Opened
// as a page or put in an iframe, an svg or html among them must not run as the
// webui: no script at the webui's origin, so no reading the webui's
// localStorage and no /ws connection with the webui's Origin, which the daemon
// could not tell from the webui itself. The ways tried are the ones a person
// or a document can take: opening the URL in a tab, a sandbox-origin preview
// tab (DR-0030) navigating itself there, and an iframe in a webui page. What
// the webui shows from the same URLs keeps working: an svg in the Files
// viewer and as an attachment image in the Timeline, and a text and an audio
// attachment opened in a tab.
//
// The fixture svg / html only mark, on their own root element, that their
// script ran (the origin it ran at, and what it read from localStorage), and
// open a WebSocket to /ws; nothing else.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript of its own. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AttachmentUploadResponseSchema,
  jsonText,
  parseWith,
  type AttachmentUploadResponse,
} from "@ccmsg/protocol";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { attachmentDir } from "../../daemon/src/attachment.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ef0000-0000-4000-8000-000000000001";
const LS_KEY = "e2e-served-files";

/** Marks on the root element that the script ran, at which origin, and what
 * it read from localStorage, then opens a WebSocket to /ws and marks it open. */
const MARK = [
  "var r = document.documentElement;",
  "r.setAttribute('data-ran', location.origin);",
  `try { r.setAttribute('data-ls', String(localStorage.getItem('${LS_KEY}'))); } catch (e) {}`,
  "var w = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');",
  "w.onopen = function () { r.setAttribute('data-ws', 'open'); };",
].join("\n");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/><script><![CDATA[\n${MARK}\n]]></script></svg>\n`;
const HTML = `<!doctype html><title>mark</title><script>\n${MARK}\n</script>\n`;

let dir: string;
let webui: Webui;
let session: TestClient;
/** Attachment names (`<uuid><ext>`) by the name uploaded. */
const attachments = new Map<string, string>();

const UploadTextSchema = jsonText(AttachmentUploadResponseSchema);

async function upload(
  name: string,
  body: string | Uint8Array<ArrayBuffer>,
): Promise<AttachmentUploadResponse> {
  const form = new FormData();
  form.append("file", new File([body], name));
  const res = await fetch(`${webui.url}attachment`, { method: "POST", body: form });
  const text = await res.text();
  const read = parseWith(UploadTextSchema, text);
  if (!read.ok) throw new Error(`upload of ${name} failed: ${text}`);
  return read.value;
}

/** A WAV of a quarter second of silence. */
function wav(): Uint8Array<ArrayBuffer> {
  const n = 2000;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return Uint8Array.from(b);
}

/** A loopback port free now, for a daemon whose configuration names its own
 * port (the sandbox origin's URL) before it starts. */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-served-");
  const port = freePort();
  webui = await startWebui({
    bind: `127.0.0.1:${port}`,
    config: { sandbox_origin_template: `http://ccmsg-files-{gid}.localhost:${port}` },
  });
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "mark.svg"), SVG);
  // The preview: opened in a sandbox-origin tab, it sends that tab to the
  // svg's /fs-serve URL at the webui's origin.
  fs.writeFileSync(
    path.join(cwd, "preview.html"),
    `<!doctype html><script>location.href = ${JSON.stringify(fsServeUrl("mark.svg"))};</script>\n`,
  );
  for (const [name, body] of [
    ["mark.svg", SVG],
    ["mark.html", HTML],
    ["note.txt", "a text attachment"],
    ["tone.wav", wav()],
  ] as const) {
    const meta = await upload(name, body);
    attachments.set(name, `${meta.uuid}${meta.ext}`);
  }
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const link = (name: string, n: number) =>
    `[FILE${n}:${name}](${path.join(attachmentDir(), attachmentName(name))})`;
  // The answer links the attachments the way a message body does; the
  // Timeline draws the svg one as an <img>.
  const head = { sessionId: SID, cwd };
  const now = Date.now();
  const rows = [
    userContentRow("質問", {
      ...head,
      uuid: crypto.randomUUID(),
      timestamp: new Date(now - 2000).toISOString(),
    }),
    assistantContentRow([textBlock(`添付 ${link("mark.svg", 1)} ${link("note.txt", 2)}`)], {
      ...head,
      uuid: crypto.randomUUID(),
      timestamp: new Date(now - 1000).toISOString(),
    }),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
  session = await sessionConn({ sock: webui.sock }, SID, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await session.end();
  await webui.stop();
  fs.rmSync(path.dirname(attachmentDir()), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

function attachmentName(name: string): string {
  const served = attachments.get(name);
  if (served === undefined) throw new Error(`${name} was not uploaded`);
  return served;
}

function fsServeUrl(name: string): string {
  const query = new URLSearchParams({ sid: SID, path: name, kind: "contained" });
  return `${webui.url}fs-serve?${query.toString()}`;
}

/** What the fixture marked on the root element of `frame`'s document. */
async function marks(
  frame: Page | Frame,
): Promise<{ ran: string | null; ls: string | null; ws: string | null }> {
  return frame.evaluate(() => {
    const r = document.documentElement;
    return {
      ran: r.getAttribute("data-ran"),
      ls: r.getAttribute("data-ls"),
      ws: r.getAttribute("data-ws"),
    };
  });
}

const NOTHING_RAN = { ran: null, ls: null, ws: null };

/** A context whose webui origin has a value in localStorage for the fixture
 * to read, were its script to run there. */
async function contextWithStorage(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(webui.url);
  await page.evaluate((key) => localStorage.setItem(key, "seen"), LS_KEY);
  await page.close();
  return context;
}

/** Opens `url` in a tab of its own and returns what the fixture marked and
 * how many WebSockets the tab opened, once the document has loaded. */
async function openAsPage(
  context: BrowserContext,
  url: string,
): Promise<{ marks: Awaited<ReturnType<typeof marks>>; sockets: number }> {
  const page = await context.newPage();
  let sockets = 0;
  page.on("websocket", () => {
    sockets += 1;
  });
  await page.goto(url);
  return { marks: await marks(page), sockets };
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`served files (${engine.name()})`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    // Opened in a tab, each of these is a document at the webui's origin. Its
    // script must not run: it would read the webui's localStorage and open
    // /ws as the webui.
    for (const [label, url] of [
      ["an svg from /fs-serve", () => fsServeUrl("mark.svg")],
      ["an svg attachment", () => `${webui.url}attachment/${attachmentName("mark.svg")}`],
      ["an html attachment", () => `${webui.url}attachment/${attachmentName("mark.html")}`],
    ] as const) {
      test(
        `${label} opened in a tab runs no script at the webui's origin`,
        async () => {
          const context = await contextWithStorage(browser);
          try {
            expect(await openAsPage(context, url())).toEqual({ marks: NOTHING_RAN, sockets: 0 });
          } finally {
            await context.close();
          }
        },
        E2E_TIMEOUT_MS,
      );
    }

    // A sandbox-origin preview (DR-0030: a tab of another site, under the
    // daemon's own CSP) can send its own tab anywhere; sent to the svg's
    // /fs-serve URL, the svg lands as a document at the webui's origin. That
    // the tab gets there at all also shows the preview still runs its
    // script.
    test(
      "a preview tab that sends itself to the svg's /fs-serve URL runs no script there",
      async () => {
        const context = await contextWithStorage(browser);
        try {
          const page = await context.newPage();
          await page.goto(`${webui.url}s/${SID}/files?path=preview.html`);
          // The button opens its tab with noopener, so the tab that gets the
          // preview's URL is not necessarily the first one to appear: take
          // whichever new tab reaches the svg's URL.
          let sockets = 0;
          const reached = new Promise<Page>((resolve) => {
            context.on("page", (tab) => {
              tab.on("websocket", () => {
                sockets += 1;
              });
              tab.waitForURL(/\/fs-serve\?/).then(
                () => resolve(tab),
                () => undefined,
              );
            });
          });
          await page.getByRole("button", { name: "HTML として開く" }).click();
          const preview = await reached;
          await preview.waitForLoadState("load");
          expect({ marks: await marks(preview), sockets }).toEqual({
            marks: NOTHING_RAN,
            sockets: 0,
          });
        } finally {
          await context.close();
        }
      },
      E2E_TIMEOUT_MS,
    );

    // In an iframe of a webui page the svg would be same-origin with the
    // webui; it must not run there either.
    test(
      "an svg from /fs-serve in an iframe of a webui page runs no script",
      async () => {
        const context = await contextWithStorage(browser);
        try {
          const page = await context.newPage();
          await page.goto(webui.url);
          const frame = await page.evaluateHandle((src) => {
            const f = document.createElement("iframe");
            f.src = src;
            const loaded = new Promise<HTMLIFrameElement>((resolve) => {
              f.addEventListener("load", () => resolve(f), { once: true });
            });
            document.body.append(f);
            return loaded;
          }, fsServeUrl("mark.svg"));
          const element = frame.asElement();
          const content = element === null ? null : await element.contentFrame();
          if (content === null) throw new Error("no iframe document");
          expect(await marks(content)).toEqual(NOTHING_RAN);
        } finally {
          await context.close();
        }
      },
      E2E_TIMEOUT_MS,
    );

    // What the webui shows from these URLs: the Files viewer draws the svg as
    // an image (an <img> of /fs-serve), and the Timeline draws an svg
    // attachment as an image (an <img> of /attachment).
    test(
      "the Files viewer and the Timeline still draw the svg as an image",
      async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        try {
          const page = await context.newPage();
          await page.goto(`${webui.url}s/${SID}/files?path=mark.svg`);
          const viewer = page.locator(".viewer-image");
          await viewer.waitFor();
          await page.waitForFunction(
            (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth === 8,
            await viewer.elementHandle(),
          );
          await page.goto(`${webui.url}s/${SID}/timeline/head`);
          const image = page.locator("img.md-attachment-image");
          await image.waitFor();
          await page.waitForFunction(
            (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth === 8,
            await image.elementHandle(),
          );
        } finally {
          await context.close();
        }
      },
      E2E_TIMEOUT_MS,
    );

    // A non-image attachment opens in a tab of its own (the Timeline's link
    // has target=_blank): a text shows its text, and an audio file can play.
    test(
      "a text and an audio attachment still open in a tab",
      async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(`${webui.url}attachment/${attachmentName("note.txt")}`);
          expect(await page.locator("body").innerText()).toBe("a text attachment");
          await page.goto(`${webui.url}attachment/${attachmentName("tone.wav")}`);
          await page.waitForFunction(() => {
            const media = document.querySelector("audio, video");
            return media instanceof HTMLMediaElement && media.readyState >= 3;
          });
        } finally {
          await context.close();
        }
      },
      E2E_TIMEOUT_MS,
    );
  });
}
