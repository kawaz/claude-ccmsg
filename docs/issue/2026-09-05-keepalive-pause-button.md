---
title: webui からセッション単位で llm-gateway の keepalive を止める
status: open
category: request
created: 2026-09-05T19:52:40+09:00
last_read:
open_entered: 2026-09-05T19:52:40+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: llm-gateway
---

# webui からセッション単位で llm-gateway の keepalive を止める

## 概要

しばらく触らないセッションの cache keepalive を webui から止めたい (kawaz 2026-09-05)。セッションにメッセージを流すのではなく、**ccmsg daemon が llm-gateway の HTTP API を叩く** (止めたいセッションにコンテキストを生やさない)。

## gateway 側の API (llm-gateway で実装中、issue keepalive-pause-per-session)

- `POST <gateway>/llm-gateway/keepalive/pause` body `{"session_id": "<uuid>"}`。解除 API は無い (そのセッションから実リクエストが来たら gateway 側で自動解除)
- `GET <gateway>/llm-gateway/keepalive/paused` → 停止中 session_id の JSON 配列
- request event (webhook) に `keepalive_paused: bool` が載る
- gateway の HA (複数 instance) は gateway 側で中継するので、ccmsg は **Caddy 経由の URL 1 本** だけ知ればよい

## 依頼

- daemon の config に gateway の base URL を 1 つ持つ (名前は ccmsg の語彙で)
- webui のセッション行に「keepalive 停止」操作を置き、daemon が上記 POST を叩く
- `keepalive_paused` を cache リング表示と同列で見せる (停止中は延命されないことが分かる形)

## 受け入れ条件

- [ ] webui から停止 → gateway の `/llm-gateway/keepalive/paused` にその session_id が載る
- [ ] 停止中の表示が webui で分かる
- [ ] 実リクエストで自動解除された後、表示が戻る (event の keepalive_paused=false で追従)
