---
title: webui のピン留めセッションの保存形を protocol の SessionSearchHit から切り離す
status: open
category: design
created: 2026-10-10T13:45:40+09:00
last_read:
open_entered: 2026-10-10T13:45:40+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO (段 C worker の候補)
---

# webui のピン留めセッションの保存形を protocol の SessionSearchHit から切り離す

## 概要

webui のピン留めセッションは localStorage に protocol の `SessionSearchHit` (v.object、必須 field が多い) をそのまま保存し、同じスキーマで読んでいる (DR-0038 §6 どおり 1 要素でも読めなければリスト丸ごと既定値 `[]`)。このため protocol 側で `SessionSearchHit` に必須 field が増えるたびに、保存済みのピンが全部消える。

保存形を「ピンに要る field だけ」の webui 内スキーマに分け、protocol の変更から切り離す。

## 背景

段 C worker の候補 (2026-10-10)。

## 受け入れ条件

- [ ] ピン用の webui 内スキーマが定義され、保存と読み出しがそれを使う
- [ ] protocol の `SessionSearchHit` に必須 field を足しても、保存済みのピンが消えない
