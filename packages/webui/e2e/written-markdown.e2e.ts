// A FAB's draft and a person's comment drawn as the person's prompt is, in a
// real browser (DR-0010 §6, DR-0062 §12, §13): their text is the markdown
// (headings, lists, tables and code drawn, a single line break inside a
// paragraph shown as a new line), and the md | source tabs at the bubble's
// foot show the text as typed under source. In a comment drawn as markdown a
// choice of its text brings the 💬 out and a quote on it is found again and
// highlighted; under source no choice does. Under the 💬 filter a closed
// thread's comment holds its text to its height and an open one shows it
// whole. At a phone's width (390) the comment's footer and its bottom row
// stay within the bubble. With `WRITTEN_MD_SHOTS` set to a directory, a
// screenshot of each state is written there.
//
// The session is the test's own: a hello on the daemon's socket with a
// transcript, the comments and the FAB's queue the test wrote before the
// daemon reads them. Nothing is sent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import {
  commentBlockText,
  msgStartWithOf,
  type BtwAnswer,
  type PromptDraftRecord,
  type UserComment,
} from "@ccmsg/protocol";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2e71000-0000-4000-8000-000000000001";
const id = (k: number) => `e2e71000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const ANSWER = "起動手順を終えました。次は状態ファイルを書き直すことです。";
const BODY = [
  "## 見出し",
  "",
  "- 項目 **太字**",
  "- 二つ目",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "1 行目",
  "2 行目",
].join("\n");
const DRAFT = `# 下書きの見出し\n\n${BODY}`;
const SHOTS = process.env.WRITTEN_MD_SHOTS;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-wmd-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: SID, cwd };
  const at = (s: number) => `2020-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;
  const point = (s: number) => ({ at: at(s), after_uuid: id(2) });
  const onAnswer = {
    kind: "message" as const,
    uuid: id(2),
    msg_start_with: msgStartWithOf(ANSWER),
  };
  const person = (
    patch: Partial<UserComment> & Pick<UserComment, "cid" | "body">,
  ): UserComment => ({
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: onAnswer,
    written: point(3),
    updated_at: at(3),
    btw: false,
    status: "draft",
    ...patch,
  });
  const comments: Array<UserComment | BtwAnswer> = [
    // Sent and seen in its row.
    person({
      cid: "c0001",
      body: BODY,
      sent: point(3),
      status: "delivered",
      row_uuid: id(3),
    }),
    // Not sent, on a quote of the answer.
    person({
      cid: "c0002",
      anchor: {
        kind: "selection",
        uuid: id(2),
        msg_start_with: msgStartWithOf(ANSWER),
        text: "状態ファイル",
        before: "起動手順を終えました。次は",
        after: "を書き直すことです。",
        start: 13,
        end: 19,
      },
      body: "選んだ所について\n\n- **一つ目**\n- 二つ目",
      written: point(5),
      updated_at: at(5),
    }),
    // A btw's question and its answer.
    person({
      cid: "c0003",
      body: "btw の質問 **太字**\n次の行",
      btw: true,
      written: point(6),
      sent: point(6),
      updated_at: at(6),
      status: "sent",
    }),
    {
      kind: "comment",
      author: "btw",
      cid: "c0004",
      session_id: SID,
      anchor: { kind: "comment", cid: "c0003" },
      body: "btw の答え",
      written: point(7),
      updated_at: at(7),
      status: "done",
      ended_at: at(8),
    },
    // Not sent, on a quote of the comment sent (its drawn markdown).
    person({
      cid: "c0005",
      anchor: { kind: "comment", cid: "c0001", text: "太字", before: "項目 ", after: "\n二つ目" },
      body: "引用へのコメント",
      written: point(9),
      updated_at: at(9),
    }),
  ];
  const draft: PromptDraftRecord = {
    kind: "draft",
    id: "11111111-2222-4333-8444-555555555555",
    session_id: SID,
    written: point(4),
    updated_at: at(4),
    text: DRAFT,
    attachments: [],
    status: "queued",
  };
  const sessions = path.join(path.dirname(webui.sock), "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, `${SID}.comments.jsonl`),
    comments.map((c) => `${JSON.stringify(c)}\n`).join(""),
  );
  fs.writeFileSync(path.join(sessions, `${SID}.queue.jsonl`), `${JSON.stringify(draft)}\n`);
  fs.writeFileSync(
    transcript,
    [
      userContentRow("質問 1", { ...head, uuid: id(1), timestamp: at(1) }),
      assistantContentRow([textBlock(ANSWER)], { ...head, uuid: id(2), timestamp: at(2) }),
      userContentRow(
        commentBlockText({
          comment: "c0001",
          on: { kind: "msg_start_with", value: msgStartWithOf(ANSWER) },
          body: BODY,
        }),
        { ...head, uuid: id(3), timestamp: at(3) },
      ),
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

/** What `body` (a bubble's text) draws: a table, the code, and the tops of
 * "1 行目" and "2 行目" on screen (a single line break kept). */
async function drawnOf(
  body: Locator,
): Promise<{ tables: number; code: string; tops: [number, number] | null }> {
  return body.evaluate((root) => {
    const topOf = (word: string): number | null => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!(node instanceof Text)) continue;
        const at = node.data.indexOf(word);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        return range.getBoundingClientRect().top;
      }
      return null;
    };
    const first = topOf("1 行目");
    const second = topOf("2 行目");
    return {
      tables: root.querySelectorAll("table").length,
      code: root.querySelector("pre")?.textContent ?? "",
      tops: first === null || second === null ? null : [first, second],
    };
  });
}

/** Chooses `words` in `scope`'s text, as a person's drag does. */
async function choose(scope: Locator, words: string): Promise<void> {
  await scope.evaluate((root, target) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.nodeValue?.indexOf(target) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + target.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`no ${target} below the scope`);
  }, words);
}

/** How far `bubble`'s footer toolbar and its body's bottom row reach past
 * the bubble's right edge or are cut, in pixels (0 when within it). */
async function overflowOf(bubble: Locator): Promise<number> {
  return bubble.evaluate((el) => {
    const right = el.getBoundingClientRect().right;
    const parts = [
      el.querySelector(":scope > .tl-bubble-footer"),
      el.querySelector(":scope > .tl-bubble-footer > .tl-msg-toolbar"),
      el.querySelector(".tl-comment-reply-row"),
      el.querySelector(".tl-comment-actions"),
    ].filter((part) => part !== null);
    return Math.max(
      0,
      ...parts.map((part) => part.getBoundingClientRect().right - right),
      ...parts.map((part) => part.scrollWidth - part.clientWidth),
      el.getBoundingClientRect().right - window.innerWidth,
    );
  });
}

for (const engine of BROWSERS) {
  for (const width of [1280, 390] as const) {
    describe.skipIf(skipsEngine(engine))(
      `a draft's and a comment's text as markdown, ${String(width)} wide, in ${engine.name()}`,
      () => {
        let browser: Browser;
        let page: Page;
        beforeAll(async () => {
          browser = await engine.launch();
          page = await browser.newPage({ viewport: { width, height: 900 } });
        }, E2E_TIMEOUT_MS);
        afterAll(async () => {
          await browser.close();
        });

        async function shot(name: string, target?: Locator): Promise<void> {
          if (SHOTS === undefined) return;
          fs.mkdirSync(SHOTS, { recursive: true });
          const file = path.join(SHOTS, `${engine.name()}-${String(width)}-${name}.png`);
          if (target === undefined) {
            await page.screenshot({ path: file });
            return;
          }
          // Clear of the sticky toolbar at the top and of the floating buttons at
          // the bottom, its footer's toolbar shown.
          await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
          await target.hover();
          await target.screenshot({ path: file });
        }

        test(
          "a comment sent: md draws its markdown, source its text as typed; a choice in md brings the 💬, in source not; its quote is highlighted",
          async () => {
            await page.goto(`${webui.url}s/${SID}/timeline/head`);
            const bubble = page.locator(".tl-bubble-comment").filter({ hasText: "見出し" });
            const body = bubble.locator(".tl-comment-body");
            await body.locator("h2").waitFor();
            const drawn = await drawnOf(body);
            expect(drawn.tables).toBe(1);
            expect(drawn.code).toContain("const x = 1;");
            const [first, second] = drawn.tops ?? [0, 0];
            expect(second).toBeGreaterThan(first);
            expect(
              await body.evaluate(
                (el) => getComputedStyle(el.querySelector("p:last-child") ?? el).whiteSpace,
              ),
            ).toBe("pre-wrap");
            // The quote of the comment on it is found again in the markdown
            // and highlighted, with its 💬.
            await page.waitForFunction(() =>
              [...(CSS.highlights.get("ccmsg-comment") ?? [])].some(
                (range) => range instanceof Range && range.toString() === "太字",
              ),
            );
            expect(await bubble.locator(".tl-comment-quote-mark").count()).toBe(1);
            await bubble.hover();
            await shot("comment-md", bubble);
            expect(await overflowOf(bubble)).toBeLessThanOrEqual(1);

            await choose(body.locator("[data-comment-text]"), "二つ目");
            await page.getByRole("button", { name: "選んだ箇所にコメントする" }).waitFor();
            await page.evaluate(() => document.getSelection()?.removeAllRanges());

            await bubble.getByRole("tab", { name: "source" }).click();
            const source = body.locator(".tl-bubble-source");
            expect(await source.textContent()).toBe(BODY);
            expect(await source.locator("a").count()).toBe(0);
            expect(await body.locator("[data-comment-text]").count()).toBe(0);
            await choose(source, "二つ目");
            // The selection is read on selectionchange; give it the turn.
            await page.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
            );
            expect(
              await page.getByRole("button", { name: "選んだ箇所にコメントする" }).count(),
            ).toBe(0);
            await page.evaluate(() => document.getSelection()?.removeAllRanges());
            await bubble.hover();
            await shot("comment-source", bubble);
            await bubble.getByRole("tab", { name: "md" }).click();
            await body.locator("h2").waitFor();
          },
          E2E_TIMEOUT_MS,
        );

        test(
          "under the 💬 filter: the draft and the comments drawn as markdown, a closed thread's comment held to its height, an open one whole",
          async () => {
            await page.goto(`${webui.url}s/${SID}/timeline/head?filter=comment`);
            const draft = page.locator(".tl-bubble-draft");
            await draft.locator("h1").waitFor();
            // Held to its height at first; a press shows it whole (DR-0058 §6).
            const draftItem = page.locator(".tl-lines > .tl-item").filter({ has: draft });
            await draft.locator("h1").click();
            await page.waitForFunction(
              () =>
                document.querySelector(".tl-lines > .tl-item[data-expanded] .tl-bubble-draft") !==
                null,
            );
            expect(await draftItem.getAttribute("data-expanded")).not.toBeNull();
            const draftBody = draft.locator(".tl-bubble-body");
            const drawn = await drawnOf(draftBody);
            expect(drawn.tables).toBe(1);
            expect(drawn.code).toContain("const x = 1;");
            const [first, second] = drawn.tops ?? [0, 0];
            expect(second).toBeGreaterThan(first);
            await draft.hover();
            await shot("draft-md", draft);
            expect(await overflowOf(draft)).toBeLessThanOrEqual(1);
            await draft.getByRole("tab", { name: "source" }).click();
            expect(await draftBody.locator(".tl-bubble-source").textContent()).toBe(DRAFT);
            await draft.hover();
            await shot("draft-source", draft);
            await draft.getByRole("tab", { name: "md" }).click();

            // The comment on a quote: the quote over its markdown.
            const quoted = page
              .locator(".tl-bubble-comment")
              .filter({ hasText: "選んだ所について" });
            expect(await quoted.locator(".tl-comment-selection").textContent()).toBe(
              "状態ファイル",
            );
            expect(await quoted.locator(".tl-comment-body li strong").textContent()).toBe("一つ目");
            await quoted.hover();
            await shot("comment-quoted", quoted);
            expect(await overflowOf(quoted)).toBeLessThanOrEqual(1);

            // The btw's question.
            const question = page
              .locator(".tl-btw .tl-bubble-comment")
              .filter({ hasText: "btw の質問" });
            expect(await question.locator(".tl-comment-body strong").textContent()).toBe("太字");
            await question.hover();
            await shot("btw-question", question);
            expect(await overflowOf(question)).toBeLessThanOrEqual(1);

            // The thread of the comment sent, closed: its text held, the
            // head and 返信 outside it.
            const sent = page.locator(".tl-bubble-comment").filter({ hasText: "見出し" });
            const item = page.locator(".tl-lines > .tl-item").filter({ has: sent });
            const maxHeight = () =>
              sent.locator(".tl-comment-body").evaluate((el) => getComputedStyle(el).maxHeight);
            expect(await maxHeight()).not.toBe("none");
            expect(await item.getAttribute("data-clamped")).not.toBeNull();
            await page.mouse.move(0, 0);
            await shot("filter-closed");
            await sent.getByRole("button", { name: "💬 コメント" }).click();
            await page.waitForFunction(
              () => document.querySelector(".tl-lines > .tl-item[data-thread-open]") !== null,
            );
            expect(await maxHeight()).toBe("none");
            expect((await drawnOf(sent.locator(".tl-comment-body"))).tables).toBe(1);
            await sent.hover();
            await shot("filter-open");
            expect(await overflowOf(sent)).toBeLessThanOrEqual(1);
          },
          E2E_TIMEOUT_MS,
        );
      },
    );
  }
}
