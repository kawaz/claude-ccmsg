---
title: llm-keepalive-pause-op.test.ts の 2 件が、偽の gateway から HTTP 404 を受けて落ちたことがある
status: resolved
category: bug
created: 2026-11-21
close_reason: implemented
---

# llm-keepalive-pause-op.test.ts の 2 件が、偽の gateway から HTTP 404 を受けて落ちたことがある

## 観測 (2026-11-21、v0.307.0 の `just push` の ci の 2 回目)

同じ commit の 1 回目の ci は通り、2 回目で次の 2 件だけが落ちた (5926 pass / 2 fail)。

- `llm_keepalive_pause op > posts the session id to the gateway and answers ok`
- `llm_keepalive_pause op > serves the session's request events as paused until its next request`

どちらも `llm_keepalive_pause_unavailable: keepalive pause endpoint returned HTTP 404`。テストの偽の gateway は `Bun.serve({ port: 0 })` で立ち、`http://127.0.0.1:<port>/llm-gateway/keepalive/pause` には 200 を返す作りなので、404 は別の口に届いたか、パスが食い違ったことを示す。

## 切り分け (2026-11-21、Bun 1.4.4 / macOS)

[Bun の公式ドキュメント](https://bun.sh/docs/api/http#changing-the-port-and-hostname) は `Bun.serve` の `hostname` の既定値を `"0.0.0.0"` と記載する。実機では `Bun.serve({ port: 0 })` の `server.hostname` は `localhost`、`lsof -nP -iTCP:<port> -sTCP:LISTEN` の listen socket は `IPv6 TCP *:<port>` だった。表示はドキュメントと異なるが、少なくとも loopback 限定ではなく全アドレスに bind している。

同一プロセスで、最初のサーバーを `Bun.serve({ port: 0 })` として立て、同じ番号の port に `Bun.serve({ hostname: "127.0.0.1", port })` を重ねると両方 listen できた。後者が常に HTTP 404 を返す状態で `http://127.0.0.1:<port>/llm-gateway/keepalive/pause` に POST すると、後者に届き `HTTP 404` になった。daemon の `pauseLlmKeepalive` でも `llm_keepalive_pause_unavailable: keepalive pause endpoint returned HTTP 404` が再現した。明示した `0.0.0.0` および `::` から先に bind した場合にも同じ結果になった。一方、最初から `127.0.0.1` に bind した場合は後者の bind が `Failed to start server. Is port ... in use?` で失敗した。

この機構は当該テストで観測されたエラーを再現する。ただし当時の 404 を返したプロセスは記録されておらず、その実際の送信先を断定するものではない。

## 対処

偽の gateway の bind 先を、テストが接続する `127.0.0.1` に合わせる。同じ組合せだった `llm-status-op.test.ts` も修正する。`llm-stats-op.test.ts` と `llm-usage-op.test.ts` の gateway、および `http-transport.test.ts` の再起動用 server は既に `hostname: "127.0.0.1"` を指定している。
