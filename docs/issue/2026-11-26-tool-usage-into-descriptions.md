---
title: "tool の使い方を skill から tool の description に移し、skill は tool 名の列挙と短い説明に止める"
status: open
category: request
created: 2026-11-26
origin: "kawaz の結論 (利用側のセッションからの取り次ぎ、2026-11-26)。着手の指示は kawaz から直接受ける"
---

# tool の使い方を skill から tool の description に移す

## kawaz の結論 (取り次ぎ、2026-11-26)

「結論としては description にツールの説明は全部移動して、スキルガイドはツール名の列挙と簡潔な説明文に止めるのが良さそうだな。」

補足: 対策が本当に要るのは comment_reply だけ (返信だけで終わってほしいのに、必ず別の応答が付くので、受け皿の `nothing_to_reply` を置いている。description への追記は済み)。say と permit は、読まずに呼べても困らない。

## 進める前に確かめること

- subagent / teammate で、tool の deferral が効くか。効かなければ、長い description が request のたびに載る ([DR-0039](../decisions/DR-0039-all-mods-and-typed-tools.md) §3 の「description は数語」の理由)

## 進め方の見込み

- DR-0039 §3 の「mods の tool の作り方」(使い方の正本は skill) を改める
- 各 tool の使い方と field の決まりを、その tool の description に移す
- skill に残すもの: tool 名の列挙と短い説明、tool を呼ばない場面の決まり (自分の session id や `ccmsg:daemon` の封筒には返信しない、図の書き方、コメントの JSON の行の読み方)。description に置いても読まれないため

## 観測 (利用側のセッション)

schema を取っていない `say` を引数なしで直接呼ぶと、handler の断りの文が返った (1 回)。形を知っていれば、description を読まずに呼べる。
