# JSON の形のコメントが実環境で届き、`comment_reply` で返された (実環境の観測)

- Date: 2026-11-23
- 対象: ccmsg v0.334.0 (コメントの形を JSON の 1 行にした版、protocol 2.16)、Claude Code 2.1.330、このリポの統括のセッション (model は fable、auto mode、対話)
- 動機: [DR-0062](../decisions/DR-0062-comments.md) の「測ること」5。前回の測定 ([2026-11-22-dr62-comment-reply-measure](./2026-11-22-dr62-comment-reply-measure.md)) はブロックが XML 調の形の時のもので、JSON の 1 行 (§4) と、それに合わせた description の 1 文で `comment_reply` を呼ぶかを確かめる
- 方法: 隔離環境を立てた測定ではなく、実環境の観測。セッションは v0.334.0 の push の後に再起動 (resume) して、新しい module と skill を読んだ。skill の一覧の ccmsg の description には JSON の形の合図 (`{"comment":"<cid>",…} の行が届いたら、コメントごとに mcp__ccmsg-v1__comment_reply { cid, body } で返し…`) が載っていた。`mcp__ccmsg-v1__comment_reply` は deferred で、呼ぶ前に ToolSearch で形を読んだ

## 判明した事実

### 1. 3 件まとめてのメッセージ全体へのコメントが、1 件 1 行の JSON で届き、1 回ずつ `comment_reply` で返された

- kawaz が webui で、統括の 1 つの応答に「返信」でコメントを 3 件付けてまとめて送った。セッションには 1 つの人の入力として、1 件 1 行の JSON が 3 行で届いた
- 形は 3 行とも `{"comment":"<cid>","on":"msg_start_with:<その応答の冒頭 30 文字>…","body":"<本文>"}` (cid は c76jj / cv53i / ceca1)。`before` / `select` / `after` は無い。本文に改行は無く、日本語の句読点と半角の英数字を含む
- 統括はコメントごとに `comment_reply` を 1 回ずつ、計 3 回呼んだ。結果は 3 回とも `<cid> (「<本文の冒頭>…」) への返信を記録した。この返信の cid は <新しい cid> (人がこれに返信すると "on":"comment:<新しい cid>" で届く)` の形 (新しい cid は cfsgg / c90za / cjaaq)
- 返信の後、統括は応答の本文も書いた。本文は返信の中身の書き直しではなく、返信に書いた内容から変えた点 1 つ・worker の段取り・JSON 化の実環境での結果の報告だった

### 2. エージェントの返信への返信も 1 行で届き、`comment_reply` で返された

- kawaz が、1 の返信の 1 つ (cid cjaaq) に「返信」でコメントを付けて送った。届いた行は `{"comment":"cfubr","on":"comment:cjaaq","body":"…"}`
- 本文は 2 段落で、JSON の文字列の中で改行が `\n\n` になって 1 行に収まっていた
- 統括は `comment_reply` を 1 回呼び (cid cfubr)、結果は同じ形 (新しい cid cw2if)

### 3. 返信は返信の吹き出しとして webui に描かれた

- kawaz が送った iPhone の画面の画像で確認した。1 の返信 (ceca1 への返信) が、`comment_reply ceca1 への返信` の見出し・元のコメントの引用・「元のコメントへ」のボタン・markdown で描いた本文を持つ吹き出しとして TL に出ていた

### 4. 言えることの範囲

- JSON の形のコメントは、3 件まとめても 1 件 1 行で届き、改行を含む本文も 1 行に収まって届いた
- 届いたコメントの全部 (4 件) に `comment_reply` が 1 回ずつ呼ばれ、返信は返信の吹き出しとして描かれた

## 割り引く点

- このセッションは当日ずっと DR-0062 §4 の書き換えと skill の文を扱っていて、仕様を context に持っていた。「skill の description の 1 文だけで呼ぶか」の測定としては弱い
- 前回のような、何も知らない別のセッション・ccmsg の tool が未ロードの状態・`/compact` の後での測定はしていない

## 未検証

- 範囲選択つきのコメント (`before` / `select` / `after`) への返信
- ファイルの箇所 (`file:`) のコメントへの返信
- 送ったコメントへの返信 (`on:"comment:<人のコメントの cid>"`)
- `/compact` の後に `on:"comment:<cid>"` だけで何の話か辿れるか
- 長い本文 (2000 文字ほど) や JSON に見える行を含む本文
- tool の実行中に送った場合 (`queued_command` の行)
