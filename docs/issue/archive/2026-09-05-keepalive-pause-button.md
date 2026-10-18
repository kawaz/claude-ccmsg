---
title: webui からセッション単位で llm-gateway の keepalive を止める
status: resolved
category: request
created: 2026-09-05T19:52:40+09:00
last_read: 2026-10-18T18:31:28+09:00
open_entered: 2026-09-05T19:52:40+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T19:09:01+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","done:daemon op llm_keepalive_pause と webui のセッション行の停止ボタン・停止中の印を実装 (commit lpttnszr)。config は llm_usage_url 等と同じく endpoint URL を独立キー llm_keepalive_pause_url で持つ。gateway は pause を知らせないので daemon が次のリクエストまで cache_paused を配る。使い始めには config.json に llm_keepalive_pause_url が必要"]
blocked_by:
origin: llm-gateway
---

# webui からセッション単位で llm-gateway の keepalive を止める

## 概要

しばらく触らないセッションの cache keepalive を webui から止めたい (kawaz 2026-09-05)。セッションにメッセージを流すのではなく、**ccmsg daemon が llm-gateway の HTTP API を叩く** (止めたいセッションにコンテキストを生やさない)。

## gateway 側の API

- `POST <gateway>/llm-gateway/keepalive/pause` body `{"session_id": "<uuid>"}`、応答 `{session_id, paused: true}`。解除 API は無い (そのセッションの次の実リクエストで再開)
- 停止中の一覧 API は無い。pause しても gateway は event を出さず、request event に `cache_paused` / `keepalive_paused` は載らない (止めた時は保持した request を忘れて再送をやめるだけ)
- gateway の HA (複数 instance) は gateway 側で中継するので、ccmsg は Caddy 経由の URL だけ知ればよい

## 依頼

- daemon の config に gateway の base URL を 1 つ持つ (名前は ccmsg の語彙で)
- webui のセッション行に「keepalive 停止」操作を置き、daemon が上記 POST を叩く
- `keepalive_paused` を cache リング表示と同列で見せる (停止中は延命されないことが分かる形)

## 受け入れ条件

- [x] webui から停止 → gateway に届く (隔離 daemon と stub gateway の /verify で POST body に session_id が載ることを確認。本物の gateway への E2E は実セッションの keepalive を止めるため未検証)
- [x] 停止中の表示が webui で分かる
- [x] 次のリクエストで表示が戻る (/verify とテストで確認)
