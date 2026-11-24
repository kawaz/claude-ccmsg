---
title: "e2e の comment-reply の 6 件が落ちる (💬 のフィルタが返信を既定で隠すようになった後、e2e を直していない)"
status: open
category: bug
created: 2026-11-24
origin: "自リポ TODO (worker の e2e の実行の記録)"
---

# e2e の comment-reply の 6 件が落ちる (💬 のフィルタが返信を既定で隠すようになった後、e2e を直していない)

## 観測

2026-11-24、`packages/webui/e2e/comment-reply.e2e.ts` を走らせると 12 pass / 6 fail。main (Release v0.382.0) をそのまま走らせても同じ 6 件が落ちる。

| テスト | 落ち方 |
|---|---|
| the agent's reply in chromium > 返信 on the reply keeps a comment that answers it, listed under 💬 | 294 行 `expect(await page.locator(".tl-bubble-comment-reply").isVisible()).toBe(true)` が false |
| the agent's reply in webkit > (同上) | 同上 |
| the footers at a phone's width in chromium > 💬: a footer is the time's line and at most one toolbar line | 419 行 `page.locator(".tl-bubble-comment-reply .tl-msg-toolbar").waitFor()` が 30 秒で timeout (`?filter=comment`) |
| the footers at a phone's width in chromium > 💬 beside the widened agent list: … | 同上 |
| the footers at a phone's width in webkit > 💬: … | 同上 |
| the footers at a phone's width in webkit > 💬 beside the widened agent list: … | 同上 |

6 件とも、💬 のフィルタの下でエージェントの返信の吹き出し (`.tl-bubble-comment-reply`) が見えることを前提にしている。同じフッターのテストでも、フィルタ無しの 2 件は通る。

## 見立て (読みだけ。走らせて確かめてはいない)

v0.370.0 で、💬 のフィルタは人のコメントだけを並べ、エージェントの返信は人のコメントを選んでスレッドを開くまで出さない決まりになった (DR-0062 §13)。落ちている 6 件は、フィルタに入っただけで返信が見える前の決まりのまま。製品の動きでなく、テストが前の決まりのまま残っている可能性が高い。

## 直し方

- 6 件を今の決まりに合わせる: 返信を見る前に、そのスレッドの人のコメントを選んで開く。「未送信の返信がフィルタの下に残る」のテストは、未送信が一番下にまとまる今の並び (v0.384.0) にも合わせる
- 直す前に、v0.369.0 (フィルタの決まりが変わる前) でこの 6 件が通ることを確かめ、見立てを裏取りする

## 背景にある穴

`just test` と push の ci は `*.e2e.ts` を拾わない (`just e2e` で別に走らせる)。この日は TL・フィルタ・コメントのフォーム・吹き出しの見た目を多く変えたが、e2e は変更のたびには走っていない。この 6 件のほかにも、前の決まりのまま残っている e2e があり得る。`just e2e` を通しで 1 回流し、落ちるものを全部洗い出す。
