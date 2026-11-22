// The agent's reply to a comment in a real browser (DR-0062 §5, §12): the
// session's `comment_reply` (op comment_reply on the daemon's socket, as the
// module asks it) answers a comment the person sent, and the row of the call
// Claude Code writes is drawn as the reply's bubble: on the agent's side, its
// head (that it is a comment_reply, the cid it answers and that comment's
// start) above its body drawn as markdown, and 返信 and ✔️ in its footer. 返信
// on it keeps a comment that answers the reply (its cid), which the 💬
// filter lists as a reply to the agent's reply.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test writes (rows of the shape Claude Code writes) in a
// config dir under the daemon's HOME, and the comment it answers in the
// daemon's comments file before the daemon reads it. Nothing reaches a
// Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import {
  CCMSG_TOOLS,
  commentBlockText,
  commentReplyRecordedText,
  type UserComment,
} from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  textBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000001";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const COMMENTED = "この関数は呼び出し側で null を返すことがある";
const QUESTION = "ここは undefined を返すのでは？";
const ANSWER = "そう、呼び出し側が **null** を返す時は `undefined` になる";

let dir: string;
let webui: Webui;
let session: TestClient;
let replyCid: string;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-creply-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: SID, cwd };
  // The comment the person sent on the answer, seen delivered in its row.
  const comment: UserComment = {
    kind: "comment",
    author: "user",
    cid: "c0001",
    session_id: SID,
    anchor: { kind: "message", uuid: id(2), on: "応答" },
    quote: COMMENTED,
    body: QUESTION,
    written: { at: "2020-01-01T00:00:03.000Z", after_uuid: id(2) },
    sent: { at: "2020-01-01T00:00:03.000Z", after_uuid: id(2) },
    updated_at: "2020-01-01T00:00:03.000Z",
    btw: false,
    status: "delivered",
    row_uuid: id(3),
  };
  const comments = path.join(path.dirname(webui.sock), "sessions", `${SID}.comments.jsonl`);
  fs.mkdirSync(path.dirname(comments), { recursive: true });
  fs.writeFileSync(comments, `${JSON.stringify(comment)}\n`);
  const rows = [
    userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
    assistantContentRow([textBlock(COMMENTED)], {
      ...head,
      uuid: id(2),
      timestamp: "2020-01-01T00:00:02.000Z",
    }),
    userContentRow(
      commentBlockText({ cid: "c0001", on: "応答", quote: COMMENTED, body: QUESTION }),
      {
        ...head,
        uuid: id(3),
        timestamp: "2020-01-01T00:00:03.000Z",
      },
    ),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
  session = await sessionConn({ sock: webui.sock }, SID, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
  // The model calls comment_reply; the module asks the daemon, and Claude
  // Code writes the call and the text the tool answered.
  const replied = await session.requestOk({
    op: "comment_reply",
    cid: "c0001",
    body: ANSWER,
    tool_use_id: "toolu_e2e_reply",
  });
  replyCid = replied.cid;
  const call = [
    assistantContentRow(
      [toolUseBlock(CCMSG_TOOLS.comment_reply, { cid: "c0001", body: ANSWER }, "toolu_e2e_reply")],
      { ...head, uuid: id(4), timestamp: "2020-01-01T00:00:04.000Z" },
    ),
    userContentRow(
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_e2e_reply",
          content: commentReplyRecordedText("c0001", replied.quote, replied.cid),
        },
      ],
      { ...head, uuid: id(5), timestamp: "2020-01-01T00:00:04.000Z" },
    ),
  ];
  fs.appendFileSync(transcript, call.map((r) => `${line(r)}\n`).join(""));
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const engine of BROWSERS) {
  describe(`the agent's reply in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await page.locator(".tl-bubble-comment-reply").waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "the call's row is the reply's bubble, its head over its markdown body, 返信 and ✔️ at its foot",
      async () => {
        const bubble = page.locator(".tl-bubble-comment-reply");
        const head = bubble.locator(".tl-comment-reply-head");
        expect(await head.textContent()).toContain("c0001 への返信");
        expect(await head.locator(".tl-comment-quote").textContent()).toBe(QUESTION);
        expect(await bubble.locator("strong").textContent()).toBe("null");
        expect(await bubble.locator("code").first().textContent()).toBe("undefined");
        // On the agent's side, as a response is.
        const box = await bubble.boundingBox();
        const lines = await page.locator(".tl-lines").boundingBox();
        expect(box !== null && lines !== null && box.x - lines.x < 40).toBe(true);
        // The head stands above the body.
        const headBox = await head.boundingBox();
        const bodyBox = await bubble.locator(".tl-text").boundingBox();
        expect(
          headBox !== null && bodyBox !== null && headBox.y + headBox.height <= bodyBox.y + 1,
        ).toBe(true);
        await bubble.hover();
        expect(await bubble.locator(".tl-comment-reply").isVisible()).toBe(true);
        expect(await bubble.getByRole("button", { name: "解決済みにする" }).count()).toBe(1);
        // 元のコメントへ goes to the comment's bubble.
        await head.getByRole("button", { name: "元のコメントへ" }).click();
        await page.waitForURL(new RegExp(`/timeline/${id(3)}`));
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "返信 on the reply keeps a comment that answers it, listed under 💬",
      async () => {
        const bubble = page.locator(".tl-bubble-comment-reply");
        await bubble.hover();
        await bubble.locator(".tl-comment-reply").click();
        const body = `${engine.name()} からの返信の返信`;
        const form = page.getByRole("form", { name: "コメント" });
        await form.getByRole("textbox", { name: "コメントの本文" }).fill(body);
        const sendNow = form.getByRole("checkbox", { name: "今すぐ送る" });
        if (await sendNow.isChecked()) await sendNow.uncheck();
        await form.getByRole("button", { name: "保存" }).click();
        await form.waitFor({ state: "detached" });
        await page.goto(`${webui.url}s/${SID}/timeline/head?filter=comment`);
        const card = page.locator(".tl-comment-card").filter({ hasText: body });
        await card.waitFor();
        expect(await card.locator(".tl-comment-reply-to").textContent()).toBe(
          `↩ ${replyCid} への返信`,
        );
        // The preview sends it as a reply to the agent's reply.
        expect(await page.locator(".tl-comments-preview-text").textContent()).toContain(
          `reply_to="${replyCid}" on="エージェントの返信"`,
        );
        // The reply itself stays under the 💬 filter.
        expect(await page.locator(".tl-bubble-comment-reply").isVisible()).toBe(true);
        await card.getByRole("button", { name: "消す" }).click();
        await card.waitFor({ state: "detached" });
      },
      E2E_TIMEOUT_MS,
    );
  });
}
