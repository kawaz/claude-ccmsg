---
title: "comment_reply の後に本文を `comment_reply_done` の 1 語で終える決まりが、skill を読まないと届かない"
status: open
category: bug
created: 2026-11-26
origin: "利用側 (別のプロジェクトの統括のセッション) からの共有、2026-11-26"
---

# comment_reply の後に本文を `comment_reply_done` の 1 語で終える決まりが、skill を読まないと届かない

## 観測 (利用側のセッション)

web UI のコメント 1 件に tool `comment_reply` で返した後、応答の本文に「コメントに返信しました。」と書いて turn を終えた。skill の「返信で言い切れたら、本文は `comment_reply_done` の 1 語だけで終える」が守られなかった。

届かなかった経路:

- この決まりは skill の本文にしか無い。skill の一覧の description は「コメントごとに comment_reply で返し、同じ内容を応答の本文に書き直さない」までで、これだけで足りると読めたので skill を開かなかった
- tool の description は `Reply to a comment` だけ
- tool の結果の文は「`<cid>` への返信を記録した。この返信の cid は …」で、その後の本文の終え方を言っていない
- 最初の turn の前の案内が「先に skill を読む」場面として挙げるのは、送信・返信・知らせ・起動で、コメントへの返信が入っていない
- ccmsg の tool が deferred の環境では、ToolSearch で schema を取る手順が入り、skill の「ToolSearch で探さなくてよい」と合わない。schema を取る手順が skill を読む手順の代わりになった

## やること

- tool の結果の文に、返信で言い切れた時の本文の終え方 (`comment_reply_done` の 1 語) を入れる (利用側の所感: 最後に読まれるのは tool の結果の文)
- 上の他の経路 (skill の description、案内の場面の列挙、skill の「ToolSearch で探さなくてよい」) を、実物で確かめて合わせる
