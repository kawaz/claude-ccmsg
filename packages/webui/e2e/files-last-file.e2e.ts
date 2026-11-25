// Coming back to the Files tab opens the file last looked at in that session,
// in a real browser (kawaz 2026-11-25): open a file, go to Timeline, come back
// to Files, and the file is open again. It holds while the sweep of the kept
// Files views (files-view-store.ts, run whenever the number of sessions
// changes) runs in between, for a live session, for a session that has ended
// (not in the session list), and for one idle for more than 10 days: the
// sweep leaves the session on screen alone, and still clears the record of a
// session that is gone.
//
// The sessions are the test's own: hellos on the daemon's socket, and one
// transcript with no hello behind it (the ended session, which the daemon
// finds by its transcript). Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { jsonText, parseWith, PeerInfoSchema } from "@ccmsg/protocol";
import type { Browser, Page } from "playwright";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const LIVE = id(771);
const ENDED = id(772);
const IDLE = id(773);
/** A session the sweep is to clear: not in the list, not on screen. */
const GONE = id(774);
const DAY_MS = 24 * 60 * 60 * 1000;
const IN_VIEW = ".session-tab-panel:not([hidden])";
const FILE = "a.txt";
const BODY = "ここが中身";

let dir: string;
let cwd: string;
let configDir: string;
let webui: Webui;
const live: TestClient[] = [];
/** The sids of the sessions a test says hello as to run the sweep. */
let extraSid = 780;

/** Writes the transcript of `sid` (its cwd the test's repo, its rows just
 * written, so the session reads as active now) and returns its path. */
function writeTranscript(sid: string): string {
  const transcript = path.join(configDir, "projects", "-e2e", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: sid, cwd };
  const now = Date.now();
  const rows = [
    userContentRow("質問", {
      ...head,
      uuid: crypto.randomUUID(),
      timestamp: new Date(now - 2000).toISOString(),
    }),
    assistantContentRow([textBlock("答え")], {
      ...head,
      uuid: crypto.randomUUID(),
      timestamp: new Date(now - 1000).toISOString(),
    }),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
  return transcript;
}

async function connectSession(sid: string): Promise<TestClient> {
  return sessionConn({ sock: webui.sock }, sid, {
    cwd,
    transcript_path: writeTranscript(sid),
    config_dir: configDir,
  });
}

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-flast-");
  webui = await startWebui();
  cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, FILE), `${BODY}\n`);
  configDir = path.join(webui.home, ".claude-e2e");
  writeTranscript(ENDED);
  live.push(await connectSession(LIVE), await connectSession(IDLE));
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  for (const c of live) await c.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A line of the daemon's that carries the session list (the `peers` reply
 * and the `ev:"peers"` push). */
const PeersLineSchema = jsonText(v.looseObject({ peers: v.array(PeerInfoSchema) }));

/** Routes the page's WebSocket to the daemon, with `sid`'s last activity put
 * `days` days back in every session list on its way to the page. */
async function routeIdle(page: Page, sid: string, days: number): Promise<void> {
  const idleAt = new Date(Date.now() - days * DAY_MS).toISOString();
  const rewrite = (text: string): string =>
    text
      .split("\n")
      .map((row) => {
        const read = parseWith(PeersLineSchema, row);
        if (!read.ok) return row;
        const peers = read.value.peers.map((p) =>
          p.sid === sid ? { ...p, last_activity_at: idleAt } : p,
        );
        return JSON.stringify({ ...read.value, peers });
      })
      .join("\n");
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) =>
      ws.send(typeof message === "string" ? rewrite(message) : message),
    );
  });
}

const keyOf = (sid: string) => `ccmsg.filesView.${sid}`;

/** How long Files is given to open the file again after coming back to it.
 * Coming back first shows no file and then swaps in the last one, so what
 * shows at once is not the answer. */
const REOPEN_MS = 10_000;

/** Opens FILE in `sid`'s Files, runs the sweep (a session says hello, so the
 * number of sessions changes) and waits for it to have cleared GONE's record,
 * then goes to Timeline and back to Files. Returns what Files shows once it
 * has opened FILE again, or after REOPEN_MS when it has not: the path in the
 * URL and whether the viewer says no file is chosen. */
async function openSweepAndComeBack(
  page: Page,
  sid: string,
): Promise<{ path: string | null; none: boolean }> {
  await page.goto(`${webui.url}s/${sid}/files?path=${FILE}`);
  await page.locator(`${IN_VIEW} .viewer-body`, { hasText: BODY }).waitFor();
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({ path: "gone.md", viewMode: "code", updatedAt: new Date().toISOString() }),
      ),
    keyOf(GONE),
  );
  extraSid += 1;
  const extra = await connectSession(id(extraSid));
  try {
    await page.waitForFunction((key) => localStorage.getItem(key) === null, keyOf(GONE));
  } finally {
    await extra.end();
  }
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.waitForURL(`**/s/${sid}/timeline**`);
  await page.getByRole("tab", { name: "Files" }).click();
  await page.waitForURL(`**/s/${sid}/files**`);
  // Not opening it is what the caller checks, so the wait ending without it is
  // not an error here.
  await page
    .locator(`${IN_VIEW} .viewer-body`, { hasText: BODY })
    .waitFor({ timeout: REOPEN_MS })
    .catch(() => undefined);
  return {
    path: new URL(page.url()).searchParams.get("path"),
    none: (await page.locator(`${IN_VIEW} .viewer-empty`).count()) > 0,
  };
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`Files opens the last file (${engine.name()})`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    const cases = [
      { name: "a live session", sid: LIVE, idleDays: 0 },
      { name: "an ended session (not in the session list)", sid: ENDED, idleDays: 0 },
      { name: "a session idle for more than 10 days", sid: IDLE, idleDays: 11 },
    ];
    for (const { name, sid, idleDays } of cases) {
      test(
        `${name}: Timeline and back to Files opens the file again`,
        async () => {
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          try {
            const page = await context.newPage();
            if (idleDays > 0) await routeIdle(page, sid, idleDays);
            expect(await openSweepAndComeBack(page, sid)).toEqual({ path: FILE, none: false });
          } finally {
            await context.close();
          }
        },
        E2E_TIMEOUT_MS,
      );
    }
  });
}
