// A prompt the person entered while a tool ran, in a real browser (DR-0058
// §11, DR-0035 §5): it gets no `type:"user"` row, only a `queued_command`
// attachment row of `origin.kind:"human"` after the tool's result. The
// Timeline draws that row as the person's prompt, the right bubble, at the
// row's place (after the tool's result), once (the enqueue copy before it is
// not a second bubble). Under the 👤 filter it is among the person's prompts,
// the one in the window and the one before it alike (prompt_rows).
//
// The rows' shapes and order are Claude Code 2.1.330's
// (docs/findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md §2).
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test wrote in a config dir under the daemon's HOME. Nothing
// reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { TRANSCRIPT_READ_MAX_BYTES } from "@ccmsg/protocol";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ee0000-0000-4000-8000-000000000001";
const uuidOf = (n: number): string => `e2ee0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** The person's prompts: typed ones (`type:"user"`), and ones entered while a
 * tool ran (`queued_command`), one of each before the window. */
const TYPED = [
  { uuid: uuidOf(1), text: "最初に打った質問" },
  { uuid: uuidOf(2), text: "後で打った質問" },
] as const;
const QUEUED = [
  { uuid: uuidOf(11), text: "tool の最中に送った最初の文" },
  { uuid: uuidOf(12), text: "tool の最中に送った後の文" },
] as const;
/** The row of each turn's tool call, whose result the queued prompt comes
 * after. */
const CALLS = [uuidOf(21), uuidOf(22)] as const;
/** How long to wait for the page to settle on a state. */
const SETTLE_MS = 10_000;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-queued-prompt-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  let seq = 100;
  const at = () => {
    seq += 1;
    return `2026-11-22T01:${String(seq - 100).padStart(2, "0")}:00.000Z`;
  };
  const head = (uuid?: string, timestamp = at()) => ({
    uuid: uuid ?? uuidOf(seq + 1000),
    parentUuid: null,
    isSidechain: false,
    timestamp,
    sessionId: SID,
    cwd,
  });
  const prompt = (p: { uuid: string; text: string }) =>
    row({ ...head(p.uuid), type: "user", message: { role: "user", content: p.text } });
  const assistant = (content: object[], uuid?: string) =>
    row({
      ...head(uuid),
      type: "assistant",
      message: {
        model: "claude-opus-5-5",
        role: "assistant",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        content,
      },
    });
  // A turn whose tool ran while the person sent `queued`: the enqueue row at
  // the time it was sent, then the tool's result, the queued_command row
  // (its time is the enqueue's) and the remove row.
  const toolTurn = (
    ask: { uuid: string; text: string },
    queued: { uuid: string; text: string },
    callUuid: string,
    toolUseId: string,
  ) => {
    // Rows' times rise in the file's order, but for the queued_command row's.
    const asked = prompt(ask);
    const call = assistant(
      [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "sleep 5" } }],
      callUuid,
    );
    const enqueuedAt = at();
    return (
      asked +
      call +
      row({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: enqueuedAt,
        sessionId: SID,
        content: queued.text,
      }) +
      row({
        ...head(),
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }],
        },
      }) +
      row({
        ...head(queued.uuid, enqueuedAt),
        type: "attachment",
        attachment: {
          type: "queued_command",
          prompt: queued.text,
          source_uuid: uuidOf(seq + 2000),
          commandMode: "prompt",
          origin: { kind: "human" },
          timestamp: enqueuedAt,
        },
      }) +
      row({
        type: "queue-operation",
        operation: "remove",
        reason: "absorbed_mid_turn",
        timestamp: at(),
        sessionId: SID,
        content: queued.text,
      }) +
      assistant([{ type: "text", text: `「${queued.text}」に答えた` }])
    );
  };
  // Rows that fold away, more than the first page's bytes: the first turn is
  // before the window the Timeline opens with.
  const filler = Array.from({ length: 5 }, () =>
    row({
      ...head(),
      type: "system",
      subtype: "informational",
      level: "info",
      content: "x".repeat(Math.ceil(TRANSCRIPT_READ_MAX_BYTES / 4)),
    }),
  ).join("");
  fs.writeFileSync(
    transcript,
    toolTurn(TYPED[0], QUEUED[0], CALLS[0], "toolu_e2e_q0") +
      filler +
      toolTurn(TYPED[1], QUEUED[1], CALLS[1], "toolu_e2e_q1"),
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

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(
    `a prompt entered while a tool ran, in ${engine.name()}`,
    () => {
      let browser: Browser;
      let page: Page;
      beforeAll(async () => {
        browser = await engine.launch();
        page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      const bubblesOf = (text: string): Locator =>
        page.locator(".tl-lines .tl-bubble-right").filter({ hasText: text });

      test(
        "is the person's bubble at its row, after the tool's result, once",
        async () => {
          await page.goto(`${webui.url}s/${SID}/timeline/head`);
          await page.getByText(`「${QUEUED[1].text}」に答えた`).waitFor({ timeout: SETTLE_MS });
          expect(await bubblesOf(QUEUED[1].text).count()).toBe(1);
          const item = page.locator(`.tl-lines > [data-timeline-uuid="${QUEUED[1].uuid}"]`);
          expect(await item.locator(".tl-bubble-right").count()).toBe(1);
          // The Timeline's items from the typed prompt on: the typed prompt, the
          // fold that holds the tool's call (with its result), then the queued
          // prompt.
          const items = (): Promise<string[]> =>
            page.evaluate(() =>
              [...document.querySelectorAll(".tl-lines > :not(.tl-day)")].map((el) =>
                el.classList.contains("tl-fold-group")
                  ? `fold:${[...el.querySelectorAll("[data-timeline-uuid]")]
                      .map((x) => x.getAttribute("data-timeline-uuid"))
                      .join(",")}`
                  : (el.getAttribute("data-timeline-uuid") ?? el.className),
              ),
            );
          const before = await items();
          const from = before.indexOf(TYPED[1].uuid);
          expect(from).toBeGreaterThanOrEqual(0);
          expect(before[from + 2]).toBe(QUEUED[1].uuid);
          const fold = page
            .locator(".tl-lines > .tl-fold-group")
            .nth(before.slice(0, from + 1).filter((it) => it.startsWith("fold:")).length);
          await fold.locator("summary").first().click();
          await fold.locator(`[data-timeline-uuid="${CALLS[1]}"]`).waitFor({ timeout: SETTLE_MS });
          expect(await fold.getByText("done").count()).toBeGreaterThan(0);
          expect((await items())[from + 2]).toBe(QUEUED[1].uuid);
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "is among the 👤 filter's prompts, in the window and before it",
        async () => {
          await page.goto(`${webui.url}s/${SID}/timeline/head?filter=prompt`);
          const inOrder = [TYPED[0], QUEUED[0], TYPED[1], QUEUED[1]].map(({ text }) => text);
          for (const text of inOrder) {
            await bubblesOf(text).first().waitFor({ state: "visible", timeout: SETTLE_MS });
            expect(await bubblesOf(text).count()).toBe(1);
          }
          const shown = await page
            .locator(".tl-lines .tl-bubble-right")
            .evaluateAll((els) =>
              els.flatMap((el) =>
                el instanceof HTMLElement && el.offsetParent !== null ? [el.innerText] : [],
              ),
            );
          expect(inOrder.map((text) => shown.findIndex((it) => it.includes(text)))).toEqual([
            0, 1, 2, 3,
          ]);
        },
        E2E_TIMEOUT_MS,
      );
    },
  );
}
