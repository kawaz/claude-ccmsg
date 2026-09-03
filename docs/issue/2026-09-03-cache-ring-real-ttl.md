---
title: SESSIONS のキャッシュ残り時間リングを実 TTL (gateway の cache_expires_at) に
status: open
category: request
created: 2026-09-03T16:01:20+09:00
last_read: 2026-09-03T16:23:55+09:00
open_entered: 2026-09-03T16:01:20+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: llm-gateway (r261m32、kawaz 依頼 2026-09-03)
---

# SESSIONS のキャッシュ残り時間リングを実 TTL (gateway の cache_expires_at) に

## 概要

SESSIONS 行のアイコンに巻く prompt cache リングを、現状の「最後の LLM リクエストから 5 分」固定表示から、llm-gateway が返す実 TTL ベースの表示に切り替える。

## 背景

llm-gateway の request event (webhook / SSE) に次のフィールドが additive 追加される (次の minor で出荷):

- `origin` (`"main"` | `"sub"` | `"unknown"`。`metadata.user_id` の `parent_session_id` 有無で判定)
- `cache_ttl_secs` (300 or 3600、cache 無しは null)
- `cache_expires_at` (unix 秒) + `cache_expires_at_iso` (= ts + ttl)

ccmsg 側の要件:

- これらの欄があれば start = ts / end = `cache_expires_at` で円弧を描く
- `origin` が `main` のものだけ主系列 (リングの対象) にする。`sub` / `unknown` は無視
- 欄が無ければ従来の 5 分固定にフォールバック
- keepalive の ping も request event として流れるので、届くたびに end が延びる (最新の event で上書き)

当たり: `packages/daemon/src/llm-events.ts` (request event の正規化)、`packages/webui/src/client/components/SessionList.tsx` の `lastLlmRequestAt` / cache ring、`useCacheRing.ts`。

## 受け入れ条件

- [ ] 新欄ありの event でリングの end が `cache_expires_at` になる (1h の keepalive なら 55 分後まで残る)
- [ ] `origin=sub` の event はリングに影響しない
- [ ] 欄なしの event は従来どおり 5 分
- [ ] テスト: 正規化 (欄あり / なし / null ttl) と view 関数
