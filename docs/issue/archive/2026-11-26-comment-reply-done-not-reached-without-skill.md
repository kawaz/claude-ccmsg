---
title: "comment_reply の後に本文を `comment_reply_done` の 1 語で終える決まりが、skill を読まないと届かない"
status: resolved
category: bug
created: 2026-11-26
origin: "利用側 (別のプロジェクトの統括のセッション) からの共有、2026-11-26"
close_reason: implemented
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

## 方向の案 (2026-11-26、裁定はまだ)

kawaz と利用側のセッションの話で出た方向: tool ごとの使い方は、skill でなく tool の description に移す。deferred なら description は schema を取った時にだけ載り、使わない tool の説明を読まされない。入力の読み方 (封筒、コメントの JSON の行、図の書き方) は tool を取る前に要るので skill に残る。困るのは「呼んだ後の振る舞いに決まりがある tool」(comment_reply の終え方など) で、permit と say は読まずに呼べても困らない。

利用側の観測: schema を取っていない `say` を引数なしで直接呼ぶと、handler の断りの文が返った (1 回。DR-0039 §3 の「読み込んでいない deferred の tool を名前で呼んでも handler に届く」と同じ)。形を知っていれば description を読まずに呼べる。

未確認: subagent / teammate で deferral が効くか (効かなければ、長い description が request のたびに載る)。DR-0039 §3 の「description は数語」の理由 (request のたびに context に載る) は、deferral が効く場面では成り立たない。

この issue では comment_reply の description だけを直す。他の tool の使い方を description に移すかは、裁定を待つ。
