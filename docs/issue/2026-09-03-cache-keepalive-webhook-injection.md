---
title: llm-gateway の cache_keepalive webhook を受けてセッションにマーカーを注入する
status: open
category: request
created: 2026-09-03T12:10:58+09:00
last_read: 2026-09-03T12:23:50+09:00
open_entered: 2026-09-03T12:10:58+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: llm-gateway (依頼 r261m11、2026-09-03、kawaz 合意済み設計 DR-0024)
---

# llm-gateway の cache_keepalive webhook を受けてセッションにマーカーを注入する

## 概要

llm-gateway が prompt cache の idle keepalive (DR-0024 §2) のため、既存 webhook
(`POST /webhook/llm-gateway`) に新 event 種別 `cache_keepalive` を additive に追加する
(次の minor で出荷)。payload: `{type:"cache_keepalive", session_id, prefix, nonce,
deadline (unix), deadline_iso, marker}`。

ccmsg 側はこの event を受けたら `session_id` のセッションに `marker` の文面をそのまま
ユーザ入力として注入する (`notify --as-session` 相当)。文面例:
`[llm-gateway cache keepalive nonce=…] Ignore this message; do not think; reply with
exactly "ok".`

## 背景

仕様正本: `llm-gateway/main/docs/decisions/DR-0024-cache-strategy-and-keepalive.md` §2。

ccmsg 側の当たり:
- webhook 受信: `packages/daemon/src/server.ts` の `recordLlmRequests` / `llm-events.ts`
- セッションへの入力注入: `session-rename.ts` が使う hyoui input 経路 (hyoui session id
  解決含む)

## 受け入れ条件

- [ ] `cache_keepalive` event を受けた daemon が `marker` を該当セッションへ hyoui 経由で注入する
- [ ] `deadline` 超過は注入せず log のみ
- [ ] セッションが busy (ターン実行中) の間は待ち、`deadline` 内に idle になれば注入、超えたら捨てる
      (`session_status` の busy/idle 観測を使う)
- [ ] hyoui session が解決できない (webui 外で起動された等) 場合は log のみで失敗しない
- [ ] テスト: 受信 → 注入 / deadline 超過 / busy 待ち → idle 注入 / 未解決

## payload 確定 (r261m13)

`{"type":"cache_keepalive","session_id":"<uuid>","prefix":"<DR-0012 の prefix と同じ短縮 sha>","nonce":"<base64url 32B>","deadline":<unix 秒 (整数)>,"deadline_iso":"<RFC3339>","marker":"[llm-gateway cache keepalive nonce=<nonce>] Ignore this message; do not think; reply with exactly \"ok\"."}`。既存 request event と同じく `ts` / `ts_iso` も付く。marker は文面そのまま注入。gateway 側の判定は末尾 user ブロック先頭の `[llm-gateway cache keepalive nonce=` と nonce の一致。
