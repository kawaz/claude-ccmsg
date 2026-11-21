---
title: llm-keepalive-pause-op.test.ts の 2 件が、偽の gateway から HTTP 404 を受けて落ちたことがある
status: open
category: bug
created: 2026-11-21
---

# llm-keepalive-pause-op.test.ts の 2 件が、偽の gateway から HTTP 404 を受けて落ちたことがある

## 観測 (2026-11-21、v0.307.0 の `just push` の ci の 2 回目)

同じ commit の 1 回目の ci は通り、2 回目で次の 2 件だけが落ちた (5926 pass / 2 fail)。

- `llm_keepalive_pause op > posts the session id to the gateway and answers ok`
- `llm_keepalive_pause op > serves the session's request events as paused until its next request`

どちらも `llm_keepalive_pause_unavailable: keepalive pause endpoint returned HTTP 404`。テストの偽の gateway は `Bun.serve({ port: 0 })` で立ち、`http://127.0.0.1:<port>/llm-gateway/keepalive/pause` には 200 を返す作りなので、404 は別の口に届いたか、パスが食い違ったことを示す。

## 分かっていないこと

- 404 を返したのが偽の gateway 自身か、別のプロセスか
- 候補 (裏付け無し): `Bun.serve` は hostname を指定しないと全アドレスに bind する。同じ番号の port を 127.0.0.1 に限って bind している別のプロセスがあると、`127.0.0.1:<port>` への接続はそちらへ届きうる。同じ時間帯に、隔離の daemon や playwright を手元で立てていた

## 切り分けに要る観測

- 偽の gateway が受けた request を数え、404 の時に偽の gateway まで届いていたかを残す
- `hostname: "127.0.0.1"` で bind した時に再現しなくなるかを確かめる
