---
title: "e2e の comment-reply の 6 件が落ちる (💬 のフィルタが返信を既定で隠すようになった後、e2e を直していない)"
status: resolved
category: bug
created: 2026-11-24
origin: "自リポ TODO (worker の e2e の実行の記録)"
close_reason: implemented
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

## 受け入れの確かめ (2026-11-24)

- 見立ての裏取り: v0.360.0 (フィルタの決まりが変わる前、e2e を最後に直した後の版) で `comment-reply.e2e.ts` は 18 件とも通る。v0.369.0 は狭い幅の足元の別の確かめで落ちる (この時点の製品は足元の決まりをまだ満たしていない) ので、比べる版は v0.360.0 にした
- 6 件は、💬 のフィルタの下で返信を見る前に、返信先の人のコメントの頭の「💬 コメント」(開閉のボタン) でスレッドを開く形に直した。開く前は返信が見えないこと、開くと `aria-expanded` が true になること、未送信の返信が開いたスレッドの印を持ちつつ返信先のコメントと返信より下にあること、`comment` を外しても「全部送信 (1)」のまま押せること (隠れた未送信も送る、v0.381.0) も確かめる
- `just e2e` を通しで流すと、この 6 件のほかに 4 件落ちていた。前の決まりのまま残っていたのは btw の点線の枠の 2 件 (v0.362.0 で枠を外した)。残りの 2 件はテストの側の不具合で、chromium と webkit が 1 つの daemon を共有して前のエンジンの記録が残ること (comment-files)、WebKit の pointer の clientX が整数に丸まること (tl-panels) が原因だった。どれも直し、`just e2e` は 131 pass / 0 fail
