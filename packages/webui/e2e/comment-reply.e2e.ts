// The agent's reply to a comment in a real browser (DR-0062 §5, §12): the
// session's `comment_reply` (op comment_reply on the daemon's socket, as the
// module asks it) answers a comment the person sent, and the row of the call
// Claude Code writes is drawn as the reply's bubble: on the agent's side, its
// head (that it is a comment_reply, the cid it answers and that comment's
// start) above its body drawn as markdown, and 返信 and ✔️ in its footer. 返信
// on it opens the comment form floating over the Timeline (not among its
// items: the items and where the Timeline is scrolled stay, DR-0062 §3) and
// keeps a comment that answers the reply (its cid), which the 💬 filter lists
// as a reply to the agent's reply, unsent, among what is sent; the boxes of
// the filter's head hide what is sent (sent) and the comments (comment). A
// file attached in the form goes up to the daemon (POST /attachment) and is
// kept under its state dir with the comment.
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
import { attachmentDir } from "../../daemon/src/attachment.ts";
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
    anchor: { kind: "message", uuid: id(2), msg_start_with: COMMENTED },
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
  // Earlier exchanges, so the Timeline is taller than the page and scrolls.
  const earlier = Array.from({ length: 6 }, (_, i) => [
    userContentRow(`前の質問 ${i}`, {
      ...head,
      uuid: id(100 + 2 * i),
      timestamp: `2019-12-31T23:59:${String(10 + 2 * i)}.000Z`,
    }),
    assistantContentRow([textBlock(`前の答え ${i}\n\n${"長い答えの段落。".repeat(40)}`)], {
      ...head,
      uuid: id(101 + 2 * i),
      timestamp: `2019-12-31T23:59:${String(11 + 2 * i)}.000Z`,
    }),
  ]).flat();
  const rows = [
    ...earlier,
    userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
    assistantContentRow([textBlock(COMMENTED)], {
      ...head,
      uuid: id(2),
      timestamp: "2020-01-01T00:00:02.000Z",
    }),
    userContentRow(
      commentBlockText({
        comment: "c0001",
        on: { kind: "msg_start_with", value: COMMENTED },
        body: QUESTION,
      }),
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
  // Where POST /attachment put the uploads (the daemon's TMPDIR is the run's).
  fs.rmSync(path.dirname(attachmentDir()), { recursive: true, force: true });
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
      "返信 shows without a hover at the bottom right of a response's, a reply's and a delivered comment's body",
      async () => {
        // DR-0062 §3: a row of its own at the bottom of the body, the button
        // at its right end. A comment the person sent to the conversation
        // (delivered here) carries it too.
        await page.mouse.move(0, 0);
        for (const selector of [
          ".tl-bubble-assistant:not(.tl-bubble-comment-reply)",
          ".tl-bubble-comment-reply",
          ".tl-bubble-comment",
        ]) {
          const body = page.locator(selector).first().locator(".tl-bubble-body");
          const reply = body.locator(".tl-comment-reply");
          expect(await reply.isVisible()).toBe(true);
          const box = await body.boundingBox();
          const at = await reply.boundingBox();
          expect(box !== null && at !== null).toBe(true);
          if (box === null || at === null) return;
          // Inside the box, at its right end and its bottom.
          expect(at.x >= box.x && at.x + at.width <= box.x + box.width).toBe(true);
          expect(box.x + box.width - (at.x + at.width)).toBeLessThan(24);
          expect(box.y + box.height - (at.y + at.height)).toBeLessThan(24);
        }
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "返信 floats the form over the Timeline: the items and the scroll stay, Esc gives the focus back",
      async () => {
        const bubble = page.locator(".tl-bubble-comment-reply");
        const reply = bubble.locator(".tl-comment-reply");
        await reply.scrollIntoViewIfNeeded();
        const view = page.locator(".timeline-view");
        const before = await view.evaluate((el) => ({
          top: el.scrollTop,
          room: el.scrollHeight - el.clientHeight,
          items: el.querySelectorAll(".tl-lines *").length,
        }));
        // The Timeline scrolls here, so a move of it would show.
        expect(before.room).toBeGreaterThan(0);
        await reply.click();
        const float = page.getByRole("dialog", { name: "コメントを書く" });
        await float.waitFor();
        const after = await view.evaluate((el) => ({
          top: el.scrollTop,
          items: el.querySelectorAll(".tl-lines *").length,
        }));
        expect(after).toEqual({ top: before.top, items: before.items });
        expect(await view.locator(".tl-comment-float").count()).toBe(0);
        // Placed against #app as the session's input is: kept within what is
        // seen of the page while a software keyboard is up (visible-area.ts).
        expect(
          await float.evaluate((el) => (el instanceof HTMLElement ? el.offsetParent?.id : null)),
        ).toBe("app");
        expect(await float.locator(".tl-comment-reply-to").textContent()).toBe(
          `↩ ${replyCid} への返信`,
        );
        const text = float.getByRole("textbox", { name: "コメントの本文" });
        expect(await text.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press("Escape");
        await float.waitFor({ state: "detached" });
        expect(await view.evaluate((el) => el.scrollTop)).toBe(before.top);
        expect(await reply.evaluate((el) => el === document.activeElement)).toBe(true);
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
        const unsent = page.getByRole("group", { name: "未送信のコメント" }).filter({
          hasText: body,
        });
        await unsent.waitFor();
        expect(await unsent.getAttribute("class")).toContain("tl-bubble-comment");
        // What it is on is the block's `on` it is sent with: a reply to the
        // agent's reply.
        expect(await unsent.locator(".tl-comment-reply-to").textContent()).toBe(
          `↩ ${replyCid} への返信`,
        );
        // The reply itself stays under the 💬 filter, and with it the unsent
        // one, marked by its green a shade off what is sent.
        const reply = page.locator(".tl-bubble-comment-reply");
        expect(await reply.isVisible()).toBe(true);
        const green = (at: typeof unsent) =>
          at
            .locator(":scope > .tl-bubble-body")
            .evaluate((el) => getComputedStyle(el).backgroundColor);
        const sentComment = page
          .locator(".tl-bubble-comment:not([data-unsent])")
          .filter({ hasText: QUESTION });
        expect(await green(unsent)).not.toBe(await green(sentComment));
        // The head's boxes: without sent only the unsent one stays, without
        // comment it goes too.
        const head = page.locator(".tl-comments-head");
        expect(await head.getByRole("button", { name: "全部送信 (1)" }).isEnabled()).toBe(true);
        await head.getByRole("checkbox", { name: "sent" }).uncheck();
        await reply.waitFor({ state: "hidden" });
        expect(await sentComment.isVisible()).toBe(false);
        expect(await unsent.isVisible()).toBe(true);
        await head.getByRole("checkbox", { name: "comment" }).uncheck();
        await unsent.waitFor({ state: "hidden" });
        expect(await head.getByRole("button", { name: "全部送信 (0)" }).isDisabled()).toBe(true);
        await head.getByRole("checkbox", { name: "comment" }).check();
        await head.getByRole("checkbox", { name: "sent" }).check();
        await reply.waitFor();
        await unsent.getByRole("button", { name: "消す" }).click();
        await unsent.waitFor({ state: "detached" });
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "a file attached in the form goes up to the daemon, and the comment keeps it under the state dir",
      async () => {
        // DR-0062 §3, §15: the form attaches as the FAB's box does (📎 here),
        // and the daemon moves the file the upload left under its state dir
        // as it keeps the comment, its body's [FILE<n>] the session's number.
        // The unsent comment's bubble shows the body as it goes: that file.
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        const bubble = page.locator(".tl-bubble-comment-reply");
        await bubble.hover();
        await bubble.locator(".tl-comment-reply").click();
        const form = page.getByRole("form", { name: "コメント" });
        const text = form.getByRole("textbox", { name: "コメントの本文" });
        const body = `${engine.name()} の添付つき`;
        await text.fill(body);
        await form.locator('input[type="file"]').setInputFiles({
          name: `${engine.name()}.png`,
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        });
        const chip = form.locator(".composer-attachment-label");
        await chip.filter({ hasText: `${engine.name()}.png` }).waitFor();
        expect(await text.inputValue()).toMatch(new RegExp(`^${body}\\[FILE\\d+\\]$`));
        const sendNow = form.getByRole("checkbox", { name: "今すぐ送る" });
        if (await sendNow.isChecked()) await sendNow.uncheck();
        await form.getByRole("button", { name: "保存" }).click();
        await form.waitFor({ state: "detached" });
        await page.goto(`${webui.url}s/${SID}/timeline/head?filter=comment`);
        const unsent = page.getByRole("group", { name: "未送信のコメント" }).filter({
          hasText: body,
        });
        await unsent.waitFor();
        // A kept image is drawn as an image, by its name (DR-0062 P29).
        const image = unsent.locator(".tl-comment-body img.md-attachment-image");
        await image.waitFor();
        const name = new RegExp(`${SID}\\.att-[0-9a-f-]+\\.png`).exec(
          (await image.getAttribute("src")) ?? "",
        )?.[0];
        expect(name).toBeDefined();
        const kept = path.join(path.dirname(webui.sock), "sessions", name ?? "");
        expect(fs.existsSync(kept)).toBe(true);
        // The daemon serves the kept file by its name (DR-0062 P29), as the
        // webui links it: the bytes uploaded, an image.
        const served = await page.request.get(`${webui.url}attachment/${path.basename(kept)}`);
        expect(served.status()).toBe(200);
        expect(served.headers()["content-type"]).toBe("image/png");
        expect([...(await served.body())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        await unsent.getByRole("button", { name: "消す" }).click();
        await unsent.waitFor({ state: "detached" });
        // Taken back, the comment's file stays (the state dir's clean-up takes it).
        expect(fs.existsSync(kept)).toBe(true);
      },
      E2E_TIMEOUT_MS,
    );
  });
}

// The footers at a phone's width (DR-0049 §8): the hover toolbar (the
// translation tabs, md|source, ✔️ or ☰) stays one line, on the time's line
// or on the one line below it, so a toolbar not shown leaves at most one
// line of room under the time, and all its buttons are seen without moving
// it sideways. Measured with no hover (the toolbar is not shown), in the
// whole Timeline and under 💬, where the reply's footer had wrapped to three
// lines (docs/issue/2026-11-23-bubble-footer-toolbar-wraps-on-narrow-width.md).
// The Timeline is the phone's width with the agent list hidden; with the list
// shown and widened (the Timeline at its floor, 17rem) the toolbar is still
// one line and what does not fit is sent sideways, reachable by scrolling it
// (kawaz 2026-11-23).
for (const engine of BROWSERS) {
  describe(`the footers at a phone's width in ${engine.name()}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    for (const filter of ["", "?filter=comment"]) {
      for (const listShown of [false, true]) {
        test(
          `${filter === "" ? "the Timeline" : "💬"}${listShown ? " beside the widened agent list" : ""}: a footer is the time's line and at most one toolbar line`,
          async () => {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            try {
              await page.addInitScript((shown) => {
                if (shown) localStorage.setItem("ccmsg.timelinePaneRatio", "0.95");
                else sessionStorage.setItem("ccmsg.timelineTreeOpen", "0");
              }, listShown);
              await page.goto(`${webui.url}s/${SID}/timeline/head${filter}`);
              await page.locator(".tl-bubble-comment-reply .tl-msg-toolbar").waitFor();
              await page.mouse.move(0, 0);
              const footers = await page.evaluate(() =>
                [...document.querySelectorAll(".tl-lines .tl-bubble-footer")]
                  .filter((footer) => footer.getClientRects().length > 0)
                  .map((footer) => {
                    const height = (el: Element | null) => el?.getBoundingClientRect().height ?? 0;
                    const toolbar = footer.querySelector(":scope > .tl-msg-toolbar");
                    const time = footer.querySelector(":scope > .tl-bubble-time");
                    const timeStyle = time === null ? null : getComputedStyle(time);
                    const tallest = Math.max(
                      0,
                      ...[...(toolbar?.children ?? [])].map((el) => height(el)),
                    );
                    return {
                      reply: footer.parentElement?.classList.contains("tl-bubble-comment-reply"),
                      footer: height(footer),
                      // With its margin (the room it keeps under the bubble).
                      time:
                        height(time) +
                        Number.parseFloat(timeStyle?.marginTop ?? "0") +
                        Number.parseFloat(timeStyle?.marginBottom ?? "0"),
                      rowGap: Number.parseFloat(getComputedStyle(footer).rowGap),
                      toolbar: height(toolbar),
                      tallest,
                      hidden: toolbar === null ? 0 : toolbar.scrollWidth - toolbar.clientWidth,
                      // Scrolled to its end, the last button's right edge is in the toolbar.
                      lastOut: (() => {
                        if (toolbar === null) return 0;
                        toolbar.scrollLeft = toolbar.scrollWidth;
                        const last = toolbar.lastElementChild?.getBoundingClientRect().right ?? 0;
                        const out = last - toolbar.getBoundingClientRect().right;
                        toolbar.scrollLeft = 0;
                        return out;
                      })(),
                    };
                  }),
              );
              const tl = await page.evaluate(
                () =>
                  document
                    .querySelector(".session-tab-panel:not([hidden]) .session-pane-viewer")
                    ?.getBoundingClientRect().width ?? 0,
              );
              // The list hidden: the phone's width; shown and widened: the floor.
              expect(tl).toBeCloseTo(listShown ? 272 : 390, 0);
              expect(footers.some((f) => f.reply)).toBe(true);
              for (const f of footers) {
                // One line: as tall as its tallest button.
                expect(f.toolbar).toBeLessThanOrEqual(f.tallest + 1);
                // The time's line, then the toolbar's on the same or the next line.
                expect(f.footer).toBeLessThanOrEqual(f.time + f.rowGap + f.toolbar + 1);
                if (listShown) {
                  // What does not fit is sent sideways, reachable by scrolling.
                  expect(f.lastOut).toBeLessThanOrEqual(1);
                } else {
                  // Nothing of it out of sight to the side.
                  expect(f.hidden).toBeLessThanOrEqual(1);
                }
              }
            } finally {
              await page.close();
            }
          },
          E2E_TIMEOUT_MS,
        );
      }
    }
  });
}
