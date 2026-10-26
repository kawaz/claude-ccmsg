---
title: webui の session_status の購読が読み込み直後の subscribe ×2 → unsubscribe ×1 で切れ、以後 push が来ない
status: open
category: bug
created: 2026-10-26T18:04:59+09:00
last_read:
open_entered: 2026-10-26T18:04:59+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# webui の session_status の購読が読み込み直後の subscribe ×2 → unsubscribe ×1 で切れ、以後 push が来ない

## 概要

webui の session_status の購読が、読み込み直後の subscribe ×2 → unsubscribe ×1 の並びで切れ、以後 push が来ない。

## 背景

起票時点では引数の題名のみ。再現手順・観測結果・原因は未調査。

## 受け入れ条件

- [ ] 読み込み直後に subscribe が重複して unsubscribe が 1 回走っても、購読が維持され session_status の push が届き続ける
